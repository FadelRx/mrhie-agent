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
const cron = require('node-cron');
const { runSync } = require('./sync');
const { loadConfig, defaultCron } = require('./config');
const { startWsClient } = require('./wsclient');

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

  const expr = (cfg.schedule && cfg.schedule.cron) || defaultCron(cfg.hospitalCode);
  console.log(`[agent] scheduled: ${expr}  (--once = รันทันที, --full = sync เต็ม, --job <name> = เฉพาะงาน)`);
  cron.schedule(expr, () => runSync(cfg, false, onlyJob).catch(e => console.error('[agent] sync error:', e.message)));

  // ท่อ on-demand: ต่อ WS ค้างไปหา hub รอรับคำสั่งดึงข้อมูลสด (ทะลุ NAT — agent ต่อออกเสมอ)
  if (cfg.hub && cfg.hub.url && cfg.hub.apiKey) startWsClient(cfg);
  else console.warn('[agent] ข้าม WS: ยังไม่ได้ตั้ง hub.url / hub.apiKey');

  // เปิดหน้าสถานะ/ตั้งค่าค้างไว้ด้วย (ผูก 127.0.0.1 เป็น default) — เจ้าหน้าที่ดูผล sync/สั่งรันได้โดยไม่ต้องใช้ terminal
  require('./setup').startSetup({ cronActive: true });
})();
