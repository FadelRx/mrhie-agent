const WebSocket = require('ws');
const URL = 'ws://localhost:8080/agent/ws';

function auth(key) { return { headers: { Authorization: `Bearer TEST01:${key}` } }; }

// 1) bad key -> expect 401 (unexpected-response)
function badKey() {
  return new Promise((res) => {
    const ws = new WebSocket(URL, auth('WRONG_KEY'));
    ws.on('unexpected-response', (_req, r) => { console.log(`[badkey] HTTP ${r.statusCode} (expect 401) ✅`); ws.terminate(); res(); });
    ws.on('open', () => { console.log('[badkey] ❌ opened but should have been rejected'); ws.terminate(); res(); });
    ws.on('error', (e) => { console.log(`[badkey] error: ${e.message}`); res(); });
  });
}

// 2) good key -> echo round-trip
function echo() {
  return new Promise((res) => {
    const ws = new WebSocket(URL, auth('testkey123'));
    const sent = { t: 'echo', ping: 'phase1', n: 42 };
    let timer;
    ws.on('open', () => { ws.send(JSON.stringify(sent)); timer = setTimeout(() => { console.log('[echo] ❌ timeout, no reply'); ws.terminate(); res(); }, 4000); });
    ws.on('message', (raw) => {
      clearTimeout(timer);
      const m = JSON.parse(raw.toString());
      const ok = m.t === 'echo' && m.ping === 'phase1' && m.n === 42;
      console.log(`[echo] got back: ${raw.toString()} ${ok ? '✅' : '❌'}`);
      ws.terminate(); res();
    });
    ws.on('error', (e) => { console.log(`[echo] error: ${e.message}`); res(); });
  });
}

(async () => { await badKey(); await echo(); process.exit(0); })();
