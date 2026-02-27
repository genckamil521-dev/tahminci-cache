/**
 * Canlı Tahminci — Cache Sunucusu
 * ================================
 * API-Football'u 30sn'de bir çeker, sonucu RAM'de saklar.
 * Tüm kullanıcılar bu sunucudan okur → API isteği patlamaz.
 *
 * Kurulum: node server.js
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────
// ⚙️  AYARLAR
// ─────────────────────────────────────────────
const API_KEY       = 'f3ccf91cf086e59284f51f352ca37f1d';
const API_BASE      = 'v3.football.api-sports.io';
const PORT          = process.env.PORT || 3001;
const FETCH_INTERVAL= 30 * 1000; // 30 saniye
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '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';

// ─────────────────────────────────────────────
// Cache deposu
// ─────────────────────────────────────────────
let cache = {
  fixtures:   [],
  stats:      {},
  events:     {},
  lastUpdate: null,
  updating:   false
};

// ─────────────────────────────────────────────
// Claude API çağrısı
// ─────────────────────────────────────────────
function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          // ── Hata kontrolü ──
          if (json.error) {
            console.error('[AI] Anthropic API hatası:', json.error.type, json.error.message);
            reject(new Error(json.error.message || 'Anthropic API error'));
            return;
          }

          const text = (json.content || []).map(b => b.text || '').join('').trim();
          if (!text) {
            console.warn('[AI] Boş yanıt geldi. Tam response:', JSON.stringify(json).slice(0, 300));
          }
          resolve(text);
        } catch(e) {
          console.error('[AI] JSON parse hatası:', e.message, 'Raw:', data.slice(0, 200));
          reject(e);
        }
      });
    });

    req.on('error', err => {
      console.error('[AI] Request hatası:', err.message);
      reject(err);
    });
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('Claude API timeout (20s)'));
    });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// API-Football isteği
// ─────────────────────────────────────────────
function apiGet(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path: apiPath,
      method: 'GET',
      headers: { 'x-apisports-key': API_KEY }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json.response || []);
        } catch(e) {
          resolve([]);
        }
      });
    });

    req.on('error', err => {
      console.error('API hata:', err.message);
      resolve([]);
    });

    req.setTimeout(8000, () => {
      req.destroy();
      resolve([]);
    });

    req.end();
  });
}

// ─────────────────────────────────────────────
// Cache güncelleme döngüsü
// ─────────────────────────────────────────────
async function updateCache() {
  if (cache.updating) return;
  cache.updating = true;

  try {
    console.log(`[${new Date().toLocaleTimeString('tr-TR')}] Cache güncelleniyor...`);

    const fixtures = await apiGet('/fixtures?live=all');
    if (!fixtures.length) {
      console.log('  Canlı maç yok.');
      cache.fixtures   = [];
      cache.lastUpdate = new Date().toISOString();
      cache.updating   = false;
      return;
    }

    console.log(`  ${fixtures.length} canlı maç bulundu.`);

    const BATCH = 5;
    const newStats  = {};
    const newEvents = {};

    for (let i = 0; i < fixtures.length; i += BATCH) {
      const batch = fixtures.slice(i, i + BATCH);

      await Promise.all(batch.map(async fx => {
        const fid = fx.fixture.id;
        const [stats, events] = await Promise.all([
          apiGet(`/fixtures/statistics?fixture=${fid}`),
          apiGet(`/fixtures/events?fixture=${fid}`)
        ]);
        newStats[fid]  = stats;
        newEvents[fid] = events;
      }));

      if (i + BATCH < fixtures.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    cache.fixtures   = fixtures;
    cache.stats      = newStats;
    cache.events     = newEvents;
    cache.lastUpdate = new Date().toISOString();

    const reqCount = 1 + fixtures.length * 2;
    console.log(`  ✅ Tamamlandı. ${reqCount} API isteği kullanıldı.`);

  } catch(e) {
    console.error('Cache güncelleme hatası:', e.message);
  } finally {
    cache.updating = false;
  }
}

// ─────────────────────────────────────────────
// Yardımcı: POST body oku
// ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // 50KB limit — kötüye kullanımı önle
      if (body.length > 50000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// URL parse (query string temizle)
// ─────────────────────────────────────────────
function getPathname(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split('?')[0];
  }
}

// ─────────────────────────────────────────────
// HTTP Sunucusu
// ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const pathname = getPathname(req.url);

  // ── CORS — tüm isteklerde (GET, POST, OPTIONS) ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // JSON content type varsayılan
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // ── /live — Canlı maç verisi ──
  if (pathname === '/live' && req.method === 'GET') {
    const response = {
      lastUpdate: cache.lastUpdate,
      fixtures: cache.fixtures.map(fx => ({
        fixture: fx,
        stats:   cache.stats[fx.fixture.id]  || [],
        events:  cache.events[fx.fixture.id] || []
      }))
    };
    res.writeHead(200);
    res.end(JSON.stringify(response));
    return;
  }

  // ── /ai-analysis — Claude API proxy ──
  if (pathname === '/ai-analysis' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { prompt } = JSON.parse(body);

      if (!prompt || typeof prompt !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'prompt alanı gerekli' }));
        return;
      }

      if (!ANTHROPIC_KEY || ANTHROPIC_KEY.includes('BURAYA')) {
        console.error('[AI] ANTHROPIC_KEY tanımlı değil!');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'API key tanımlı değil' }));
        return;
      }

      console.log(`[AI] İstek alındı — prompt: ${prompt.length} karakter`);
      const aiText = await callAnthropic(prompt);
      console.log(`[AI] ✅ Yanıt geldi — ${aiText.length} karakter`);

      res.writeHead(200);
      res.end(JSON.stringify({ text: aiText }));

    } catch(e) {
      console.error('[AI] ❌ Hata:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /ai-analysis GET — bilgilendirme ──
  if (pathname === '/ai-analysis' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      message: 'AI Analysis endpoint çalışıyor. POST isteği gönderin.',
      usage: 'POST /ai-analysis { "prompt": "..." }'
    }));
    return;
  }

  // ── /health — Sağlık kontrolü ──
  if (pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status:     'ok',
      lastUpdate: cache.lastUpdate,
      fixtures:   cache.fixtures.length,
      uptime:     Math.floor(process.uptime()) + 's',
      aiReady:    !!(ANTHROPIC_KEY && !ANTHROPIC_KEY.includes('BURAYA'))
    }));
    return;
  }

  // ── / veya /index.html — Dashboard ──
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html bulunamadi');
    }
    return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─────────────────────────────────────────────
// Başlat
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('🚀 Canlı Tahminci Cache Sunucusu başladı');
  console.log(`   Port     : ${PORT}`);
  console.log(`   Endpoint : http://localhost:${PORT}/live`);
  console.log(`   AI       : http://localhost:${PORT}/ai-analysis (POST)`);
  console.log(`   Sağlık   : http://localhost:${PORT}/health`);
  console.log(`   AI Ready : ${!!(ANTHROPIC_KEY && !ANTHROPIC_KEY.includes('BURAYA'))}`);
  console.log('');

  updateCache();
  setInterval(updateCache, FETCH_INTERVAL);
});

process.on('uncaughtException', err => {
  console.error('Beklenmeyen hata:', err.message);
});
