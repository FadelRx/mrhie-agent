// ============================================================================
//  Supervisor — รัน agent daemon (src/index.js) แล้ว "respawn" อัตโนมัติเมื่อ process ออก
//
//  ทำไม: ให้กด "🔄 รีสตาร์ท" ในหน้า UI (:7070) แล้วโหลด config ใหม่ได้เลย โดยไม่ต้องแตะ terminal
//    - ปุ่มรีสตาร์ท -> ลูกออกด้วย exit 0 -> ตัวนี้ spawn ใหม่ (อ่าน .env/config ใหม่หมด — ไม่มีบั๊ก stale)
//    - ลูก crash (exit!=0 / signal) -> spawn ใหม่ให้ด้วย (agent ต้องรัน 24/7)
//    - ลูกออกด้วย exit 77 = ตั้งใจหยุดถาวร -> ไม่ respawn
//
//  ใช้:  npm start           (= node run.js)  แนะนำสำหรับรันจริง
//        เอา run.js ไปทำเป็น Windows service (nssm) / pm2 ได้เลย — ดู README
// ============================================================================
const { spawn } = require('child_process');
const path = require('path');

const STOP_CODE = 77;                 // ลูกออกด้วยรหัสนี้ = หยุดถาวร ไม่ respawn
const RESPAWN_DELAY_MS = 1000;
const CHILD = path.join(__dirname, 'src', 'index.js');

let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [CHILD, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, AGENT_SUPERVISED: '1' },   // ให้ src/index.js/setup รู้ว่ามีตัว respawn คุมอยู่
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    if (code === STOP_CODE) { console.log('[run] agent สั่งหยุดถาวร (exit 77) — จบ supervisor'); process.exit(0); }
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    console.log(`[run] agent ปิด (${why}) — เริ่มใหม่ใน ${RESPAWN_DELAY_MS / 1000}s ...`);
    setTimeout(start, RESPAWN_DELAY_MS);
  });

  child.on('error', (e) => console.error('[run] spawn error:', e.message));
}

function shutdown(sig) {
  stopping = true;
  if (child) { try { child.kill(sig); } catch {} }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[run] supervisor เริ่มทำงาน — คุม src/index.js (respawn อัตโนมัติ; ปุ่มรีสตาร์ทใน UI = exit 0 -> เริ่มใหม่)');
start();
