// ============================================================================
//  Med Reconciliation HIE — Sync Agent (generic runner)
//  ติดตั้งที่แต่ละ รพ. : อ่าน HOSxP slave -> รัน "jobs" จาก Hub -> push raw rows ขึ้น Hub
//
//  *** agent ไม่รู้จักโดเมน ***  งานทั้งหมด (med recon, ANC, ฯลฯ) นิยามด้วย pack ที่ Hub
//  เพิ่มงานใหม่ = เพิ่ม pack + job module ที่ Hub เท่านั้น — ไฟล์ฝั่ง agent ไม่ต้องแก้
//
//  รัน:  node src/index.js          (ตั้ง cron ตาม config + เปิดหน้าสถานะที่ :7070)
//        node src/index.js --once   (รันรอบเดียวแล้วจบ — ไว้ทดสอบ)
//        node src/index.js --full   (sync เต็ม เพิกเฉย watermark)
//        node src/index.js --job medrecon   (รันเฉพาะบาง job)
//        node src/index.js --setup  (เปิดเฉพาะหน้าตั้งค่า ไม่รัน cron)
//
//  logic การ sync จริงอยู่ใน src/sync.js (แชร์กับหน้าเว็บ setup/สถานะ)
// ============================================================================
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { runSync } = require('./sync');
const { loadConfig, defaultCron } = require('./config');
const { startWsClient } = require('./wsclient');

// ---------- single-instance lock: 1 เครื่อง = 1 agent daemon ----------
//  กันเปิด npm start / node src/index.js ซ้อนกันหลายตัว — ถ้ามีหลาย worker แต่ละตัวจะเปิด WS
//  ไปหา hub ด้วยรหัส รพ. เดียวกัน แล้ว hub เตะกันเอง (กติกา "ต่อใหม่เตะตัวเก่า") จน WS หลุด/ต่อวนไม่จบ
const LOCK_PATH = process.env.AGENT_LOCK || path.join(__dirname, '..', '.agent.lock');
const STOP_CODE = 77;   // ตรงกับ run.js — ลูกออกด้วยรหัสนี้ = หยุดถาวร supervisor ไม่ respawn

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }   // signal 0 = แค่เช็คว่ามี process นี้อยู่จริง (ไม่ได้ฆ่า)
  catch (e) { return e.code === 'EPERM'; }     // EPERM = มีอยู่แต่คนละสิทธิ์ = ถือว่ายังรัน
}

// ยึด lock: คืน { ok:true } ถ้าได้ / { ok:false, pid, startedAt } ถ้ามี agent ตัวอื่นรันอยู่แล้ว
function acquireLock() {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');   // สร้างใหม่แบบ atomic — ถ้ามีอยู่แล้วจะ throw EEXIST
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
      fs.closeSync(fd);
      const release = () => { try { const c = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); if (c.pid === process.pid) fs.unlinkSync(LOCK_PATH); } catch {} };
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0); });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = {}; try { info = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch {}
      if (info.pid && info.pid !== process.pid && pidAlive(info.pid)) return { ok: false, pid: info.pid, startedAt: info.startedAt };
      try { fs.unlinkSync(LOCK_PATH); } catch {}   // lock ค้างจาก process ที่ตายไปแล้ว — ลบทิ้งแล้ววนไปยึดใหม่
    }
  }
  return { ok: false, pid: '?' };
}

(async () => {
  // หน้าตั้งค่าผ่านเว็บ — ไม่ต้องมี config ครบก็เปิดได้ (ไว้กรอกค่าครั้งแรก)
  if (process.argv.includes('--setup')) {
    require('./setup').startSetup();
    return;   // ค้างเป็น server ไม่ออก
  }

  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  const forceFull = process.argv.includes('--full');
  const ji = process.argv.indexOf('--job');
  const onlyJob = ji >= 0 ? process.argv[ji + 1] : null;
  const li = process.argv.indexOf('--limit');
  if (li >= 0) cfg._maxKeys = parseInt(process.argv[li + 1], 10) || null;   // จำกัดจำนวนคนไข้ (smoke test)

  if (once || !(cfg.schedule && cfg.schedule.enabled)) {
    await runSync(cfg, forceFull, onlyJob).catch(e => { console.error('[agent] fatal:', e.message); process.exit(1); });
    process.exit(0);
  }

  // กันเปิดซ้อน (โหมด daemon เท่านั้น — --once/--setup ไม่ต้องล็อก): ถ้ามี agent daemon ตัวอื่นรันอยู่แล้ว
  // ให้หยุดถาวรด้วย exit 77 (supervisor จะไม่ respawn) — กัน WS ชนกันเองจนต่อวนไม่จบ
  const lock = acquireLock();
  if (!lock.ok) {
    console.error(`[agent] ❌ มี agent รันอยู่แล้ว (PID ${lock.pid}${lock.startedAt ? `, เริ่ม ${lock.startedAt}` : ''}) — ไม่เปิดซ้ำเพื่อกัน WebSocket ชนกันเอง`);
    console.error(`[agent]    ต้องการรีสตาร์ท: ปิดตัวเก่าก่อน หรือใช้ปุ่ม 🔄 ในหน้า http://127.0.0.1:7070`);
    process.exit(STOP_CODE);
  }

  const expr = (cfg.schedule && cfg.schedule.cron) || defaultCron(cfg.hospitalCode);
  console.log(`[agent] scheduled: ${expr}  (--once = รันทันที, --full = sync เต็ม, --job <name> = เฉพาะงาน)`);
  cron.schedule(expr, () => runSync(cfg, false, onlyJob).catch(e => console.error('[agent] sync error:', e.message)));

  // ท่อ on-demand: ต่อ WS ค้างไปหา hub รอรับคำสั่งดึงข้อมูลสด (ทะลุ NAT — agent ต่อออกเสมอ)
  if (cfg.hub && cfg.hub.url && cfg.hub.apiKey) startWsClient(cfg);
  else console.warn('[agent] ข้าม WS: ยังไม่ได้ตั้ง hub.url / hub.apiKey');

  // เปิดหน้าสถานะ/ตั้งค่าค้างไว้ด้วย (ผูก 127.0.0.1 เป็น default) — เจ้าหน้าที่ดูผล sync/สั่งรันได้โดยไม่ต้องใช้ terminal
  require('./setup').startSetup({ cronActive: true });
})();
