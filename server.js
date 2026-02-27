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

// ─────────────────────────────────────────────
// Cache deposu
// ─────────────────────────────────────────────
let cache = {
  fixtures:   [],   // Canlı maçlar
  stats:      {},   // fixture_id → istatistik
  events:     {},   // fixture_id → olaylar
  lastUpdate: null, // Son güncelleme zamanı
  updating:   false // Güncelleme devam ediyor mu
};

// ─────────────────────────────────────────────
// API isteği yapıcı
// ─────────────────────────────────────────────
// Claude API çağrısı
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
          const text = (json.content || []).map(b => b.text || '').join('').trim();
          resolve(text);
        } catch(e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_BASE,
      path,
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
  if (cache.updating) return; // Önceki bitmeden başlama
  cache.updating = true;

  try {
    console.log(`[${new Date().toLocaleTimeString('tr-TR')}] Cache güncelleniyor...`);

    // 1. Canlı maçları çek
    const fixtures = await apiGet('/fixtures?live=all');
    if (!fixtures.length) {
      console.log('  Canlı maç yok.');
      cache.fixtures   = [];
      cache.lastUpdate = new Date().toISOString();
      cache.updating   = false;
      return;
    }

    console.log(`  ${fixtures.length} canlı maç bulundu.`);

    // 2. Her maç için stats + events paralel çek
    // Aynı anda max 5 istek (rate limit aşmamak için)
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

      // Batch'ler arasında kısa bekle
      if (i + BATCH < fixtures.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 3. Atomik güncelleme (aynı anda yaz)
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
// HTTP Sunucusu
// ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS — her istekte header'ları set et
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.url === '/live') {
    // Tüm veriyi tek seferde ver
    const response = {
      lastUpdate: cache.lastUpdate,
      fixtures:   cache.fixtures.map(fx => ({
        fixture: fx,
        stats:   cache.stats[fx.fixture.id]  || [],
        events:  cache.events[fx.fixture.id] || []
      }))
    };
    res.writeHead(200);
    res.end(JSON.stringify(response));

  } else if (req.url === '/ai-analysis' && req.method === 'POST') {
    // Claude API proxy — key sunucuda kalır, tarayıcıda görünmez
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { prompt } = JSON.parse(body);
        const aiResp = await callAnthropic(prompt);
        res.writeHead(200);
        res.end(JSON.stringify({ text: aiResp }));
      } catch(e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.url === '/health') {
    // Sağlık kontrolü
    res.writeHead(200);
    res.end(JSON.stringify({
      status:     'ok',
      lastUpdate: cache.lastUpdate,
      fixtures:   cache.fixtures.length,
      uptime:     Math.floor(process.uptime()) + 's'
    }));

  } else if (req.url === '/' || req.url === '/index.html') {
    // Dashboard HTML'i serve et
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end('index.html bulunamadı');
    }
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// ─────────────────────────────────────────────
// Başlat
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('🚀 Canlı Tahminci Cache Sunucusu başladı');
  console.log(`   Port    : ${PORT}`);
  console.log(`   Endpoint: http://localhost:${PORT}/live`);
  console.log(`   Sağlık  : http://localhost:${PORT}/health`);
  console.log('');

  // Hemen bir kere çalıştır, sonra 30sn'de bir
  updateCache();
  setInterval(updateCache, FETCH_INTERVAL);
});

// Beklenmeyen hataları yakala, sunucu çökmesin
process.on('uncaughtException', err => {
  console.error('Beklenmeyen hata:', err.message);
});
