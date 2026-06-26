// ============================================================================
//  หน้าตั้งค่า agent ผ่านเว็บ (local) — สำหรับเจ้าหน้าที่ รพ. ที่ไม่อยากแก้ JSON เอง
//    รัน:  node src/index.js --setup            (เปิดที่ http://127.0.0.1:7070)
//          node src/index.js --setup --host 0.0.0.0 --port 8090
//
//  ทำอะไร:
//    - กรอกค่า HOSxP / Hub / sync / ตารางเวลา ผ่านฟอร์ม
//    - ปุ่ม "ทดสอบเชื่อมต่อ" : HOSxP (ลอง connect + SELECT 1), Hub (ยิง /api/agent/pack เช็ค API key)
//    - เซฟ -> เขียน config.json (ค่าทั่วไป) + .env (รหัส) ให้อัตโนมัติ
//
//  *** ความปลอดภัย ***
//    - ผูกกับ 127.0.0.1 เป็น default (เครื่องเดียวกันเท่านั้น). ถ้าจะเข้าจากเครื่องอื่นใน LAN
//      ต้องสั่ง --host 0.0.0.0 เอง — รหัสจะวิ่งผ่าน HTTP ธรรมดา ให้ใช้ในวงปิดเท่านั้น
//    - รหัส (HOSxP password / hub apiKey) ถูกเขียนลง .env ไม่เก็บ plaintext ใน config.json
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { CONFIG_PATH, loadDotEnv } = require('./config');

const ENV_PATH = process.env.AGENT_ENV || path.join(__dirname, '..', '.env');
const MASK = '__KEEP__';   // ส่งกลับมาแทนค่าเดิม = ไม่เปลี่ยนรหัส

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- อ่านค่าปัจจุบัน (รวม secret จาก .env เพื่อรู้ว่า "ตั้งไว้แล้วไหม") ----------
function readCurrent() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  loadDotEnv();   // เอา HOSXP_PASSWORD / HUB_API_KEY เข้าระบบ process.env (ไม่ทับที่ตั้งไว้)
  const hub = cfg.hub || {}, hosxp = cfg.hosxp || {}, sync = cfg.sync || {}, schedule = cfg.schedule || {};
  const hasHubKey   = !!(process.env.HUB_API_KEY    || hub.apiKey);
  const hasHosxpPwd = !!(process.env.HOSXP_PASSWORD || hosxp.password);
  return {
    hospitalCode: cfg.hospitalCode || '', hospitalName: cfg.hospitalName || '',
    hub: { url: hub.url || '' },
    hosxp: { host: hosxp.host || '', port: hosxp.port || 3306, user: hosxp.user || '', database: hosxp.database || 'hos' },
    sync: {
      mode: sync.mode || 'incremental', sinceDays: sync.sinceDays ?? 180, overlapDays: sync.overlapDays ?? 2,
      batchSize: sync.batchSize ?? 50, concurrency: sync.concurrency ?? 4,
    },
    schedule: { enabled: !!schedule.enabled, cron: schedule.cron || '0 3 * * *' },
    hasHubKey, hasHosxpPwd,
    _raw: cfg,   // เก็บไว้ merge ตอนเซฟ (กัน overrides/config/labCodes หาย)
  };
}

// ---------- เขียน .env แบบรักษาบรรทัด/คอมเมนต์เดิม (อัปเดตเฉพาะคีย์ที่ส่งค่ามา) ----------
function upsertEnv(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n'); } catch {}
  for (const [key, val] of Object.entries(updates)) {
    if (val == null) continue;   // ไม่เปลี่ยน
    const re = new RegExp(`^\\s*${key}\\s*=`);
    const idx = lines.findIndex(l => re.test(l));
    const line = `${key}=${val}`;
    if (idx >= 0) lines[idx] = line; else lines.push(line);
  }
  // กันบรรทัดว่างซ้อนท้ายไฟล์
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

// ---------- บันทึก: config.json (ไม่มี secret) + .env (secret) ----------
function save(input) {
  const cur = {};
  try { Object.assign(cur, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch {}

  cur.hospitalCode = String(input.hospitalCode || '').trim();
  cur.hospitalName = String(input.hospitalName || '').trim();
  cur.hub = { ...(cur.hub || {}), url: String(input.hub.url || '').trim(), apiKey: '' };
  cur.hosxp = {
    ...(cur.hosxp || {}),
    host: String(input.hosxp.host || '').trim(),
    port: Number(input.hosxp.port) || 3306,
    user: String(input.hosxp.user || '').trim(),
    password: '',   // รหัสอยู่ใน .env เท่านั้น
    database: String(input.hosxp.database || 'hos').trim(),
  };
  cur.sync = {
    ...(cur.sync || {}),
    mode: input.sync.mode === 'full' ? 'full' : 'incremental',
    sinceDays: Number(input.sync.sinceDays) || 180,
    overlapDays: Number(input.sync.overlapDays) || 2,
    batchSize: Number(input.sync.batchSize) || 50,
    concurrency: Number(input.sync.concurrency) || 4,
  };
  cur.schedule = { ...(cur.schedule || {}), enabled: !!input.schedule.enabled, cron: String(input.schedule.cron || '0 3 * * *').trim() };
  cur.overrides = cur.overrides || {}; cur.config = cur.config || {}; cur.labCodes = cur.labCodes || {};

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2) + '\n');

  // secret -> .env (เฉพาะที่ส่งค่าจริงมา; MASK = คงเดิม)
  const env = {};
  if (input.hosxp.password && input.hosxp.password !== MASK) env.HOSXP_PASSWORD = input.hosxp.password;
  if (input.hub.apiKey && input.hub.apiKey !== MASK) env.HUB_API_KEY = input.hub.apiKey;
  if (Object.keys(env).length) upsertEnv(env);
}

// ---------- ทดสอบเชื่อมต่อ ----------
async function resolveSecret(sent, envKey, fallback) {
  if (sent && sent !== MASK) return sent;
  loadDotEnv();
  return process.env[envKey] || fallback || '';
}

async function testHosxp(h) {
  const password = await resolveSecret(h.password, 'HOSXP_PASSWORD', (readCurrent()._raw.hosxp || {}).password);
  let conn;
  try {
    conn = await mysql.createConnection({
      host: h.host, port: Number(h.port) || 3306, user: h.user, password,
      database: h.database, charset: 'utf8', connectTimeout: 8000,
    });
    const [rows] = await conn.query('SELECT VERSION() AS v');
    return { ok: true, message: `เชื่อมต่อสำเร็จ — MariaDB/MySQL ${rows[0]?.v || '?'}` };
  } catch (e) {
    return { ok: false, message: `เชื่อมต่อไม่ได้: ${e.message}` };
  } finally { if (conn) try { await conn.end(); } catch {} }
}

async function testHub(h) {
  const apiKey = await resolveSecret(h.apiKey, 'HUB_API_KEY', (readCurrent()._raw.hub || {}).apiKey);
  const code = String(h.hospitalCode || '').trim();
  if (!h.url) return { ok: false, message: 'ยังไม่ได้ใส่ URL ของ Hub' };
  if (!code) return { ok: false, message: 'ยังไม่ได้ใส่รหัส รพ. (hospitalCode)' };
  if (!apiKey) return { ok: false, message: 'ยังไม่ได้ใส่ API key' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(h.url.replace(/\/+$/, '') + '/api/agent/pack', {
      headers: { 'Authorization': `Bearer ${code}:${apiKey}` }, signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = {}; }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'API key หรือรหัส รพ. ไม่ถูกต้อง (Hub ปฏิเสธ)' };
    if (res.status === 404) return { ok: true, message: 'เชื่อมต่อ Hub ได้ (API key ใช้ได้) — แต่ยังไม่มี query pack ที่ active' };
    if (!res.ok) return { ok: false, message: `Hub ตอบ ${res.status}: ${(body && body.error) || text.slice(0, 120)}` };
    const n = (body.packs || []).length;
    return { ok: true, message: `เชื่อมต่อ Hub สำเร็จ — API key ใช้ได้ (เห็น ${n} งาน/job)` };
  } catch (e) {
    return { ok: false, message: `เชื่อมต่อ Hub ไม่ได้: ${e.name === 'AbortError' ? 'หมดเวลา (timeout)' : e.message}` };
  }
}

// ---------- หน้าเว็บ ----------
const CSS = `:root{--ink:#14302b;--bg:#f4f2e9;--surface:#fff;--accent:#13a085;--accent-dk:#0c6f5d;--warn:#e08a2f;--danger:#d8432c;--muted:#5f726f;--sh:5px 5px 0 var(--ink);--sh-sm:3px 3px 0 var(--ink)}
*{box-sizing:border-box}body{margin:0;font-family:'IBM Plex Sans Thai',system-ui,sans-serif;background:var(--bg);color:var(--ink);background-image:radial-gradient(var(--ink) .5px,transparent .5px);background-size:22px 22px}
.wrap{max-width:760px;margin:0 auto;padding:22px 18px 70px}
h1{font-size:19px;font-weight:700;margin:0 0 3px}.sub{font-size:12.5px;color:var(--muted);margin:0 0 18px}
.card{background:var(--surface);border:3px solid var(--ink);border-radius:14px;box-shadow:var(--sh);padding:20px;margin-bottom:18px}
.card h2{font-size:15px;font-weight:700;margin:0 0 14px;display:flex;align-items:center;gap:8px}
label{display:block;font-size:12px;font-weight:700;margin:10px 0 5px}
input,select{width:100%;height:42px;border:2px solid var(--ink);border-radius:9px;padding:0 11px;font-family:inherit;font-size:14px;outline:none;background:var(--surface)}
input:focus,select:focus{box-shadow:var(--sh-sm)}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:140px}
button{height:42px;border:2px solid var(--ink);border-radius:9px;background:var(--accent);color:#fff;font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer;padding:0 16px;box-shadow:var(--sh-sm);transition:transform .08s,box-shadow .08s}
button:hover{background:var(--accent-dk)}button:active{transform:translate(3px,3px);box-shadow:none}
button.ghost{background:#e7e3d6;color:var(--ink)}button.ghost:hover{background:#dcd7c6}
.note{font-size:11.5px;color:var(--muted);margin-top:4px}
.status{font-size:12.5px;font-weight:700;margin-top:10px;padding:9px 12px;border:2px solid var(--ink);border-radius:9px;display:none}
.status.show{display:block}.status.ok{background:#bfe9dd;color:#0c5547}.status.bad{background:#fbd0c6;color:#a3331f}.status.run{background:#f3ead0;color:#7a5b16}
.chk{display:flex;align-items:center;gap:9px;margin-top:12px}.chk input{width:20px;height:20px}
.save{position:sticky;bottom:0;background:var(--bg);padding:14px 0 0;margin-top:6px}
.save button{width:100%;height:50px;font-size:15px}`;
const FONT = `<link rel='preconnect' href='https://fonts.googleapis.com'><link href='https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&display=swap' rel='stylesheet'>`;

function page() {
  const c = readCurrent();
  const pwdPh = c.hasHosxpPwd ? 'ตั้งไว้แล้ว — เว้นว่าง=คงเดิม' : 'รหัสผ่าน HOSxP';
  const keyPh = c.hasHubKey ? 'ตั้งไว้แล้ว — เว้นว่าง=คงเดิม' : 'วาง API key จาก Hub';
  const opt = (v, t, sel) => `<option value='${v}'${sel === v ? ' selected' : ''}>${t}</option>`;
  return `<!DOCTYPE html><html lang='th'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>ตั้งค่า agent</title>${FONT}<style>${CSS}</style></head>
<body><div class='wrap'>
  <h1>ตั้งค่า Sync Agent</h1>
  <p class='sub'>กรอกค่าให้ครบ → กดทดสอบเชื่อมต่อ → บันทึก. รหัสจะถูกเก็บใน <span class='note'>.env</span> ไม่ปนใน config.json</p>

  <div class='card'>
    <h2>🏥 ข้อมูลโรงพยาบาล</h2>
    <div class='row'>
      <div><label>รหัส รพ. (hospitalCode) *</label><input id='hospitalCode' value='${esc(c.hospitalCode)}' placeholder='เช่น 10681'></div>
      <div><label>ชื่อ รพ.</label><input id='hospitalName' value='${esc(c.hospitalName)}' placeholder='โรงพยาบาล...'></div>
    </div>
  </div>

  <div class='card'>
    <h2>🗄️ ฐานข้อมูล HOSxP <span class='note'>(ควรชี้ slave/replica)</span></h2>
    <div class='row'>
      <div style='flex:3'><label>Host / IP *</label><input id='hosxp_host' value='${esc(c.hosxp.host)}' placeholder='10.0.0.9'></div>
      <div style='flex:1'><label>Port</label><input id='hosxp_port' type='number' value='${esc(c.hosxp.port)}'></div>
    </div>
    <div class='row'>
      <div><label>User *</label><input id='hosxp_user' value='${esc(c.hosxp.user)}' placeholder='readonly'></div>
      <div><label>Database</label><input id='hosxp_database' value='${esc(c.hosxp.database)}' placeholder='hos'></div>
    </div>
    <label>รหัสผ่าน ${c.hasHosxpPwd ? "<span class='note'>(ตั้งไว้แล้ว)</span>" : '*'}</label>
    <input id='hosxp_password' type='password' autocomplete='new-password' placeholder='${pwdPh}'>
    <button class='ghost' style='margin-top:12px' onclick="testConn('hosxp')">🔌 ทดสอบเชื่อมต่อ HOSxP</button>
    <div id='st_hosxp' class='status'></div>
  </div>

  <div class='card'>
    <h2>🌐 Hub (ส่วนกลาง)</h2>
    <label>URL ของ Hub *</label><input id='hub_url' value='${esc(c.hub.url)}' placeholder='https://medrecon-hie.pmkhospital.go.th'>
    <label>API key ${c.hasHubKey ? "<span class='note'>(ตั้งไว้แล้ว)</span>" : '*'}</label>
    <input id='hub_apiKey' type='password' autocomplete='new-password' placeholder='${keyPh}'>
    <p class='note'>ขอ API key จากผู้ดูแล Hub (หน้า /admin/hospitals)</p>
    <button class='ghost' style='margin-top:12px' onclick="testConn('hub')">📡 ทดสอบเชื่อมต่อ Hub</button>
    <div id='st_hub' class='status'></div>
  </div>

  <div class='card'>
    <h2>🔄 การ sync</h2>
    <div class='row'>
      <div><label>โหมด</label><select id='sync_mode'>${opt('incremental', 'incremental (ส่งเฉพาะที่เปลี่ยน)', c.sync.mode)}${opt('full', 'full (ดึงย้อนหลังทุกครั้ง)', c.sync.mode)}</select></div>
      <div><label>ย้อนหลัง (วัน) รอบแรก/full</label><input id='sync_sinceDays' type='number' value='${esc(c.sync.sinceDays)}'></div>
    </div>
    <div class='row'>
      <div><label>overlap (วัน)</label><input id='sync_overlapDays' type='number' value='${esc(c.sync.overlapDays)}'></div>
      <div><label>batch size</label><input id='sync_batchSize' type='number' value='${esc(c.sync.batchSize)}'></div>
      <div><label>concurrency</label><input id='sync_concurrency' type='number' value='${esc(c.sync.concurrency)}'></div>
    </div>
  </div>

  <div class='card'>
    <h2>⏰ ตารางเวลา (cron)</h2>
    <div class='chk'><input type='checkbox' id='sched_enabled' ${c.schedule.enabled ? 'checked' : ''}><label style='margin:0'>เปิดรันอัตโนมัติตามเวลา</label></div>
    <label>cron expression</label><input id='sched_cron' value='${esc(c.schedule.cron)}' placeholder='0 3 * * *'>
    <p class='note'>ค่าเริ่มต้น 0 3 * * * = ทุกวัน 03:00 น. (เวลาเครื่อง). ปิดสวิตช์ = รันเองด้วย <span class='note'>npm run once</span></p>
  </div>

  <div class='save'><button onclick='saveAll()'>💾 บันทึกการตั้งค่า</button><div id='st_save' class='status'></div></div>
</div>
<script>
const $ = id => document.getElementById(id);
function collect(){
  return {
    hospitalCode: $('hospitalCode').value, hospitalName: $('hospitalName').value,
    hub: { url: $('hub_url').value, apiKey: $('hub_apiKey').value || '__KEEP__' },
    hosxp: { host: $('hosxp_host').value, port: $('hosxp_port').value, user: $('hosxp_user').value,
             database: $('hosxp_database').value, password: $('hosxp_password').value || '__KEEP__' },
    sync: { mode: $('sync_mode').value, sinceDays: $('sync_sinceDays').value, overlapDays: $('sync_overlapDays').value,
            batchSize: $('sync_batchSize').value, concurrency: $('sync_concurrency').value },
    schedule: { enabled: $('sched_enabled').checked, cron: $('sched_cron').value },
  };
}
function show(el, cls, msg){ el.className = 'status show ' + cls; el.textContent = msg; }
async function testConn(which){
  const el = $('st_' + which); show(el, 'run', 'กำลังทดสอบ...');
  const d = collect();
  const payload = which === 'hosxp'
    ? d.hosxp
    : { url: d.hub.url, apiKey: d.hub.apiKey, hospitalCode: d.hospitalCode };
  try {
    const r = await fetch('/api/test-' + which, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    show(el, j.ok ? 'ok' : 'bad', (j.ok ? '✅ ' : '⚠️ ') + j.message);
  } catch(e){ show(el, 'bad', '⚠️ เรียกทดสอบไม่ได้: ' + e.message); }
}
async function saveAll(){
  const el = $('st_save'); show(el, 'run', 'กำลังบันทึก...');
  try {
    const r = await fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(collect()) });
    const j = await r.json();
    if (j.ok){ show(el, 'ok', '✅ บันทึกแล้ว — รีสตาร์ท agent เพื่อใช้ค่าใหม่'); $('hosxp_password').value=''; $('hub_apiKey').value=''; }
    else show(el, 'bad', '⚠️ ' + (j.message || 'บันทึกไม่สำเร็จ'));
  } catch(e){ show(el, 'bad', '⚠️ บันทึกไม่ได้: ' + e.message); }
}
</script>
</body></html>`;
}

// ---------- HTTP server ----------
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

function startSetup() {
  const args = process.argv;
  const host = (args[args.indexOf('--host') + 1] && args.includes('--host')) ? args[args.indexOf('--host') + 1] : (process.env.SETUP_HOST || '127.0.0.1');
  const port = Number((args.includes('--port') && args[args.indexOf('--port') + 1]) || process.env.SETUP_PORT || 7070);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page());
      }
      if (req.method === 'POST' && req.url === '/api/test-hosxp') return json(res, 200, await testHosxp(await readBody(req)));
      if (req.method === 'POST' && req.url === '/api/test-hub')   return json(res, 200, await testHub(await readBody(req)));
      if (req.method === 'POST' && req.url === '/api/save') {
        const body = await readBody(req);
        if (!String(body.hospitalCode || '').trim()) return json(res, 200, { ok: false, message: 'ต้องระบุรหัส รพ.' });
        try { save(body); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 200, { ok: false, message: e.message }); }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { json(res, 500, { ok: false, message: e.message }); }
  });

  server.listen(port, host, () => {
    console.log(`\n[setup] หน้าตั้งค่า agent เปิดที่:  http://${host === '0.0.0.0' ? '<ip-เครื่องนี้>' : host}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost')
      console.log('[setup] ⚠️ เปิดให้เครื่องอื่นเข้าถึงได้ — รหัสวิ่งผ่าน HTTP ธรรมดา ใช้ในวงปิด/LAN ที่เชื่อถือได้เท่านั้น');
    console.log('[setup] กด Ctrl+C เพื่อปิดเมื่อตั้งค่าเสร็จ\n');
  });
}

module.exports = { startSetup };
