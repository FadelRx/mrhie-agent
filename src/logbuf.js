// เก็บ log ล่าสุดไว้ในหน่วยความจำ (ring buffer) ให้หน้าเว็บสถานะของ agent อ่านได้
// install() ครอบ console.log/warn/error — พฤติกรรมเดิมคงอยู่ทุกอย่าง แค่ tee สำเนาเข้า buffer
const MAX = 500;
const lines = [];
let installed = false;

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function push(level, args) {
  lines.push({ ts: new Date().toISOString(), level, text: args.map(fmt).join(' ') });
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

function install() {
  if (installed) return;
  installed = true;
  for (const m of ['log', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { try { push(m, a); } catch {} orig(...a); };
  }
}

function recent(n = 300) { return lines.slice(-n); }

module.exports = { install, recent };
