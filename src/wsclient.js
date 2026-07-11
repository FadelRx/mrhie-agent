// ============================================================================
//  WS client — ต่อค้างไปหา hub เพื่อรอรับคำสั่ง "ดึงข้อมูลสด" (on-demand fetch)
//
//  agent เป็นฝ่ายต่อ "ออก" ไปหา hub เสมอ -> ทะลุ NAT/firewall ของ รพ. ได้
//  โดยไม่ต้องมี public IP และไม่ต้องเปิดพอร์ตขาเข้า (เหมือนเปิดเว็บทั่วไป)
//
//  Phase 1 (ตอนนี้): ต่อติด + auth (Bearer code:apiKey เดิม) + heartbeat + reconnect
//    ยังไม่ยุ่งกับ HOSxP — รับแค่ echo ไว้ทดสอบ round-trip
//  Phase 2 จะเติม handler สำหรับ {t:'fetch'} -> รัน on-demand pack -> ตอบ {t:'result', enc}
// ============================================================================
const WebSocket = require('ws');

const VER = require('../package.json').version;
const BACKOFF = [5000, 15000, 45000];   // reconnect backoff (ล้อเลียนกับ retry ของ push.js)

// http(s)://hub  ->  ws(s)://hub/agent/ws
function toWsUrl(hubUrl) {
  return String(hubUrl).replace(/\/+$/, '').replace(/^http/i, 'ws') + '/agent/ws';
}

function startWsClient(cfg) {
  const url = toWsUrl(cfg.hub.url);
  const hisType = (cfg.hosxp && cfg.hosxp.hisType) || 'hosxp';   // Phase 3 ค่อยแยก v3/v4
  let attempt = 0;
  let stopped = false;

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${cfg.hospitalCode}:${cfg.hub.apiKey}` },
    });

    ws.on('open', () => {
      attempt = 0;
      console.log(`[ws] connected to hub: ${url}`);
      ws.send(JSON.stringify({ t: 'hello', code: cfg.hospitalCode, his_type: hisType, ver: VER }));
    });

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      // Phase 1: ยังไม่มีคำสั่งให้ทำ — Phase 2 จะ handle m.t === 'fetch' (ดึง HOSxP -> ตอบ result)
      void m;
    });

    // ws ตอบ pong ให้ ping ของ hub อัตโนมัติอยู่แล้ว — ไม่ต้องทำเอง

    ws.on('close', (code) => {
      console.log(`[ws] disconnected from hub (code ${code})`);
      scheduleReconnect();
    });

    ws.on('error', (e) => {
      console.error('[ws] error:', e.message);
      // event 'close' จะตามมาเสมอ -> ไป reconnect ที่นั่น (กัน reconnect ซ้อน)
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt++;
    console.log(`[ws] reconnect in ${delay / 1000}s (attempt ${attempt})`);
    const t = setTimeout(connect, delay);
    if (t.unref) t.unref();
  }

  connect();
  return { stop() { stopped = true; } };
}

module.exports = { startWsClient };
