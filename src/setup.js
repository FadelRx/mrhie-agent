// ============================================================================
//  หน้าเว็บของ agent (local) — Dashboard 2 แท็บ: 📊 สถานะ + ⚙️ ตั้งค่า
//    รัน:  npm start                    (agent ตาม cron + เปิดหน้านี้ค้างไว้ที่ http://127.0.0.1:7070)
//          node src/index.js --setup    (เปิดเฉพาะหน้านี้ ไม่รัน cron — ไว้ติดตั้งครั้งแรก)
//          node src/index.js --setup --host 0.0.0.0 --port 8090
//
//  แท็บสถานะ:  ผล sync ล่าสุดราย job (จาก .sync-state.json) + ปุ่ม "Sync ตอนนี้" + log ล่าสุด
//  แท็บตั้งค่า: wizard 4 ขั้น — ① โรงพยาบาล & Hub  ② HOSxP  ③ ทดสอบส่งข้อมูล  ④ ตารางเวลา & บันทึก
//    - ปุ่ม "ทดสอบเชื่อมต่อ" : HOSxP (ลอง connect + SELECT), Hub (ยิง /api/agent/pack เช็ค API key)
//    - ปุ่ม "ทดสอบส่งข้อมูล" : dry-run ดึงข้อมูลจริงจำนวนตัวอย่าง แสดงว่าจะส่งอะไร/กี่แถว/ขนาดเท่าไหร่
//                              (ไม่ push ขึ้น Hub เว้นแต่ติ๊ก "ส่งจริง 1 batch")
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
const { CONFIG_PATH, loadDotEnv, loadConfig } = require('./config');
const { runJob } = require('./runner');
const { fetchPacks } = require('./pack');
const { pushItems } = require('./push');
const { runSync, isRunning, connectHosxp, loadState, computeCutoff, makeMapLimit, PACK_PATH } = require('./sync');
const logbuf = require('./logbuf');

const ENV_PATH = process.env.AGENT_ENV || path.join(__dirname, '..', '.env');
const MASK = '__KEEP__';   // ส่งกลับมาแทนค่าเดิม = ไม่เปลี่ยนรหัส

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d) => { const n = Number(v); return (v !== '' && v != null && Number.isFinite(n)) ? n : d; };

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
  try { const raw = fs.readFileSync(ENV_PATH, 'utf8'); if (raw.trim()) lines = raw.split('\n'); } catch {}
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
    overlapDays: num(input.sync.overlapDays, 2),
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
    // แยก "hub จริง" ออกจาก "ต่อผิดเซิร์ฟเวอร์": hub ตอบ JSON เสมอ — ได้ HTML/parse ไม่ได้ = URL ชี้ผิดตัว
    // (เช่นเผลอใส่พอร์ตของเว็บเจ้าหน้าที่ — Express ตอบ 404 HTML "Cannot GET" ซึ่งเดิมถูกมองเป็น "ยังไม่มี pack")
    const text = await res.text(); let body = null; try { body = JSON.parse(text); } catch {}
    if (!body || typeof body !== 'object')
      return { ok: false, message: `URL นี้ไม่ใช่ Hub (ตอบ ${res.status} เป็น ${/^\s*</.test(text) ? 'HTML' : 'ข้อมูลที่ไม่ใช่ JSON'}) — ตรวจสอบ URL/พอร์ตให้ชี้ hub ไม่ใช่เว็บเจ้าหน้าที่` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'API key หรือรหัส รพ. ไม่ถูกต้อง (Hub ปฏิเสธ)' };
    if (res.status === 404) return { ok: true, message: 'เชื่อมต่อ Hub ได้ (API key ใช้ได้) — แต่ยังไม่มี query pack ที่ active' };
    if (!res.ok) return { ok: false, message: `Hub ตอบ ${res.status}: ${body.error || text.slice(0, 120)}` };
    if (!Array.isArray(body.packs))
      return { ok: false, message: 'URL นี้ตอบไม่เหมือน Hub (ไม่มีรายการ pack) — ตรวจสอบ URL/พอร์ตให้ชี้ hub' };
    return { ok: true, message: `เชื่อมต่อ Hub สำเร็จ — API key ใช้ได้ (เห็น ${body.packs.length} งาน/job)` };
  } catch (e) {
    return { ok: false, message: `เชื่อมต่อ Hub ไม่ได้: ${e.name === 'AbortError' ? 'หมดเวลา (timeout)' : e.message}` };
  }
}

// ---------- ทดสอบส่งข้อมูล (dry-run) ----------
//  ดึง pack จาก Hub -> รัน driver + datasets กับตัวอย่าง N คนแรก (ข้อมูลจริงจาก HOSxP)
//  -> สรุปว่าจะส่งอะไร กี่แถว ขนาดเท่าไหร่ + ประมาณการทั้งรอบจากจำนวนคนทั้งหมดที่ driver เห็น
//  *** ไม่ push ขึ้น Hub *** เว้นแต่สั่ง pushOne = ส่งจริง 1 batch แรก (พิสูจน์ครบวงจรถึง Hub)
let testRunning = false;

async function testSync(input) {
  if (testRunning || isRunning()) return { ok: false, message: 'มี sync/ทดสอบกำลังทำงานอยู่ — รอให้เสร็จก่อน' };
  testRunning = true;
  const t0 = Date.now();
  let conn;
  try {
    const raw = readCurrent()._raw;
    const inHub = input.hub || {}, inHosxp = input.hosxp || {}, inSync = input.sync || {};
    const cfg = {
      ...raw,   // คง overrides/config/labCodes ของ รพ. ไว้ ให้ dry-run เหมือนของจริง
      hospitalCode: String(input.hospitalCode || '').trim(),
      hub: {
        url: String(inHub.url || '').trim().replace(/\/+$/, ''),
        apiKey: await resolveSecret(inHub.apiKey, 'HUB_API_KEY', (raw.hub || {}).apiKey),
      },
      hosxp: {
        ...(raw.hosxp || {}),
        host: String(inHosxp.host || '').trim(),
        port: Number(inHosxp.port) || 3306,
        user: String(inHosxp.user || '').trim(),
        password: await resolveSecret(inHosxp.password, 'HOSXP_PASSWORD', (raw.hosxp || {}).password),
        database: String(inHosxp.database || 'hos').trim(),
      },
      sync: {
        ...(raw.sync || {}),
        mode: inSync.mode === 'full' ? 'full' : 'incremental',
        sinceDays: Number(inSync.sinceDays) || 180,
        overlapDays: num(inSync.overlapDays, 2),
        batchSize: Number(inSync.batchSize) || 50,
        concurrency: Number(inSync.concurrency) || 4,
      },
    };
    if (!cfg.hospitalCode) return { ok: false, message: 'ต้องระบุรหัส รพ. ก่อน (ขั้น ①)' };
    if (!cfg.hub.url) return { ok: false, message: 'ต้องระบุ URL ของ Hub ก่อน (ขั้น ①) — ใช้ดึงนิยามงาน/query pack' };
    if (!cfg.hub.apiKey) return { ok: false, message: 'ยังไม่มี API key — วาง API key ที่ได้จากผู้ดูแล Hub ก่อน (ขั้น ①)' };
    if (!cfg.hosxp.host || !cfg.hosxp.user) return { ok: false, message: 'ต้องกรอกข้อมูล HOSxP ก่อน (ขั้น ②)' };

    const sample = Math.min(Math.max(parseInt(input.sample, 10) || 20, 1), 200);
    const state = loadState();
    const { packs, source } = await fetchPacks(cfg, PACK_PATH);
    if (!packs.length) return { ok: false, message: 'Hub ไม่มีงาน (query pack) ที่ active' };

    conn = await connectHosxp(cfg);
    const mapLimit = makeMapLimit(cfg.sync.concurrency || 4);
    const results = [];
    for (const pack of packs) {
      const job = pack.job || 'default';
      const jobState = (state.jobs && state.jobs[job]) || {};
      // ใช้ cutoff เดียวกับรอบ sync จริงรอบถัดไป — ตัวเลขที่เห็น = สิ่งที่จะเกิดจริง
      const { mode, cutoff } = computeCutoff(cfg, pack, jobState, false);
      const since = cutoff.toISOString().slice(0, 10);
      const jt0 = Date.now();
      const { items, total, errors, skipped, driverTotal } = await runJob(conn, pack, cfg, since, mapLimit, sample);

      // นับแถวต่อ dataset + วัดขนาด payload ของตัวอย่าง แล้วประมาณการทั้งรอบ
      const datasets = {};
      for (const it of items) {
        for (const [name, rows] of Object.entries(it.datasets || {})) {
          datasets[name] = (datasets[name] || 0) + (Array.isArray(rows) ? rows.length : 0);
        }
      }
      const sampleBytes = Buffer.byteLength(JSON.stringify(items));
      const avgBytes = items.length ? sampleBytes / items.length : 0;
      const buildRatio = total ? items.length / total : 0;   // สัดส่วนที่ส่งได้จริง (หัก skip/error)
      const estItems = Math.round(driverTotal * buildRatio);
      const batchSize = cfg.sync.batchSize || 50;

      const r = {
        job, version: pack.version ?? null, mode, since,
        driverTotal, sampled: total, built: items.length, buildErrors: errors, skipped,
        datasets, sampleBytes,
        estItems, estBytes: Math.round(avgBytes * estItems), estBatches: Math.ceil(estItems / batchSize) || 0,
        elapsedMs: Date.now() - jt0,
      };
      // ส่งจริง 1 batch แรก — Hub รับเข้าเหมือน sync ปกติ (นับเป็นข้อมูลจริง)
      if (input.pushOne && items.length) {
        const batch = items.slice(0, Math.min(batchSize, items.length));
        try {
          const pr = await pushItems(cfg.hub, cfg.hospitalCode, job, batch);
          r.push = { ok: true, sent: batch.length, ingested: pr.ingested || 0, errors: (pr.errors || []).slice(0, 3) };
        } catch (e) { r.push = { ok: false, message: e.message }; }
      }
      results.push(r);
    }
    return { ok: true, source, sample, jobs: results, totalElapsedMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    if (conn) try { await conn.end(); } catch {}
    testRunning = false;
  }
}

// ---------- หน้าเว็บ ----------
const CSS = `:root{--ink:#14302b;--bg:#f4f2e9;--surface:#fff;--accent:#13a085;--accent-dk:#0c6f5d;--warn:#e08a2f;--danger:#d8432c;--muted:#5f726f;--sh:5px 5px 0 var(--ink);--sh-sm:3px 3px 0 var(--ink)}
*{box-sizing:border-box}body{margin:0;font-family:'IBM Plex Sans Thai',system-ui,sans-serif;background:var(--bg);color:var(--ink);background-image:radial-gradient(var(--ink) .5px,transparent .5px);background-size:22px 22px}
.wrap{max-width:760px;margin:0 auto;padding:22px 18px 70px}
h1{font-size:19px;font-weight:700;margin:0 0 3px}.sub{font-size:12.5px;color:var(--muted);margin:0 0 16px}
.card{background:var(--surface);border:3px solid var(--ink);border-radius:14px;box-shadow:var(--sh);padding:20px;margin-bottom:18px}
.card h2{font-size:15px;font-weight:700;margin:0 0 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
label{display:block;font-size:12px;font-weight:700;margin:10px 0 5px}
input,select{width:100%;height:42px;border:2px solid var(--ink);border-radius:9px;padding:0 11px;font-family:inherit;font-size:14px;outline:none;background:var(--surface)}
input:focus,select:focus{box-shadow:var(--sh-sm)}
input[type=checkbox]{width:20px;height:20px}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:140px}
button{height:42px;border:2px solid var(--ink);border-radius:9px;background:var(--accent);color:#fff;font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer;padding:0 16px;box-shadow:var(--sh-sm);transition:transform .08s,box-shadow .08s}
button:hover{background:var(--accent-dk)}button:active{transform:translate(3px,3px);box-shadow:none}
button.ghost{background:#e7e3d6;color:var(--ink)}button.ghost:hover{background:#dcd7c6}
button:disabled{background:#cfcabc;color:#7d7a6e;cursor:not-allowed;box-shadow:none;transform:none}
.note{font-size:11.5px;color:var(--muted);margin-top:4px}
.status{font-size:12.5px;font-weight:700;margin-top:10px;padding:9px 12px;border:2px solid var(--ink);border-radius:9px;display:none}
.status.show{display:block}.status.ok{background:#bfe9dd;color:#0c5547}.status.bad{background:#fbd0c6;color:#a3331f}.status.run{background:#f3ead0;color:#7a5b16}
.chk{display:flex;align-items:center;gap:9px;margin-top:12px}.chk input{width:20px;height:20px}
.save{position:sticky;bottom:0;background:var(--bg);padding:14px 0 0;margin-top:6px}
.save button{width:100%;height:50px;font-size:15px}
.tabs{display:flex;gap:8px;margin-bottom:18px}
.tabs button{background:#e7e3d6;color:var(--ink);height:40px}
.tabs button.on{background:var(--accent);color:#fff}
.tag{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;border:2px solid var(--ink)}
.tag.ok{background:#bfe9dd;color:#0c5547}.tag.mutedtag{background:#e7e3d6;color:#5f5a4c}.tag.bad{background:#fbd0c6;color:#a3331f}.tag.runy{background:#f3ead0;color:#7a5b16}
.stepnum{display:inline-flex;width:26px;height:26px;border:2px solid var(--ink);border-radius:50%;align-items:center;justify-content:center;background:var(--accent);color:#fff;font-size:13px;flex:none}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
.tbl th,.tbl td{padding:7px 8px;border-bottom:2px solid var(--ink);text-align:left}
.tbl thead th{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px}
.tbl tbody tr:last-child td{border-bottom:0}
.kpis{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
.kpi{flex:1;min-width:120px;border:2px solid var(--ink);border-radius:10px;padding:10px 12px;box-shadow:var(--sh-sm);background:#fdfcf7}
.kpi b{display:block;font-size:18px}.kpi span{font-size:11px;color:var(--muted)}
.testjob{border:2px solid var(--ink);border-radius:12px;padding:14px;margin-top:12px;background:#fff}
.jobrow{border:2px solid var(--ink);border-radius:10px;padding:10px 12px;margin-top:10px;background:#fdfcf7}
.logbox{background:var(--ink);color:#cfe9e0;border-radius:10px;border:2px solid var(--ink);padding:12px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.6;max-height:320px;overflow:auto;white-space:pre-wrap;margin:0}
details{margin-top:14px;border:2px solid var(--ink);border-radius:10px;padding:10px 14px;background:#fdfcf7}
details summary{font-size:12.5px;font-weight:700;cursor:pointer}`;
const FONT = `<link rel='preconnect' href='https://fonts.googleapis.com'><link href='https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&family=IBM+Plex+Mono:wght@500&display=swap' rel='stylesheet'>`;

function page() {
  const c = readCurrent();
  const st = loadState();
  const everSync = Object.values(st.jobs || {}).some(j => j && j.lastSuccessAt);
  const pwdPh = c.hasHosxpPwd ? 'ตั้งไว้แล้ว — เว้นว่าง=คงเดิม' : 'รหัสผ่าน HOSxP';
  const keyPh = c.hasHubKey ? 'ตั้งไว้แล้ว — เว้นว่าง=คงเดิม' : 'วาง API key จาก Hub';
  const opt = (v, t, sel) => `<option value='${v}'${sel === v ? ' selected' : ''}>${t}</option>`;
  const badge = (done, yes, no) => `<span class='tag ${done ? 'ok' : 'mutedtag'}'>${done ? '✅ ' + yes : no}</span>`;
  const step1Done = !!(c.hospitalCode && c.hasHubKey);
  const step2Done = !!(c.hasHosxpPwd && c.hosxp.host);
  const step4Done = !!(c.schedule.enabled && c.hospitalCode);
  const startTab = (step1Done && step2Done) ? 'status' : 'settings';

  return `<!DOCTYPE html><html lang='th'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Sync Agent — ${esc(c.hospitalName || 'ตั้งค่า')}</title>${FONT}<style>${CSS}</style></head>
<body><div class='wrap'>
  <h1>Sync Agent ${c.hospitalName ? '· ' + esc(c.hospitalName) : ''}</h1>
  <p class='sub'>ดูสถานะการส่งข้อมูลเข้าเครือข่าย หรือแก้การตั้งค่า · รหัสถูกเก็บใน <span class='note'>.env</span> ไม่ปนใน config.json</p>

  <div class='tabs'>
    <button id='tabbtn_status' onclick="showTab('status')">📊 สถานะ</button>
    <button id='tabbtn_settings' onclick="showTab('settings')">⚙️ ตั้งค่า</button>
  </div>

  <!-- ================= แท็บสถานะ ================= -->
  <div id='tab_status' style='display:none'>
    <div class='card'>
      <h2>📊 สถานะการ sync</h2>
      <div id='status_body' class='note'>กำลังโหลด...</div>
      <div style='display:flex;gap:12px;margin-top:16px;align-items:center;flex-wrap:wrap'>
        <button id='btn_sync' onclick='syncNow()'>▶ Sync ตอนนี้</button>
        <label class='chk' style='margin:0;font-weight:400;font-size:12.5px'><input type='checkbox' id='sync_full_chk'> sync เต็ม (ย้อนหลังตามที่ตั้งไว้ ไม่ใช่เฉพาะที่เปลี่ยน)</label>
      </div>
      <div id='st_sync' class='status'></div>
    </div>
    <div class='card'>
      <h2>📜 Log ล่าสุด <span class='note' style='font-weight:400'>(รีเฟรชอัตโนมัติ · เก็บเฉพาะช่วงที่โปรเซสนี้ทำงาน)</span></h2>
      <pre id='logbox' class='logbox'>—</pre>
    </div>
  </div>

  <!-- ================= แท็บตั้งค่า (wizard 4 ขั้น) ================= -->
  <div id='tab_settings' style='display:none'>

    <div class='card'>
      <h2><span class='stepnum'>1</span> โรงพยาบาล &amp; เชื่อมต่อ Hub ${badge(step1Done, 'พร้อมแล้ว', 'ยังไม่ครบ')}</h2>
      <div class='row'>
        <div><label>รหัส รพ. (hospitalCode) *</label><input id='hospitalCode' value='${esc(c.hospitalCode)}' placeholder='เช่น 10681'></div>
        <div><label>ชื่อ รพ.</label><input id='hospitalName' value='${esc(c.hospitalName)}' placeholder='โรงพยาบาล...'></div>
      </div>
      <label>URL ของ Hub *</label><input id='hub_url' value='${esc(c.hub.url)}' placeholder='https://medrecon-hie.pmkhospital.go.th'>
      <label>API key ${c.hasHubKey ? "<span class='note'>(ตั้งไว้แล้ว)</span>" : '*'}</label>
      <input id='hub_apiKey' type='password' autocomplete='new-password' placeholder='${keyPh}'>
      <p class='note'>API key ออกโดยผู้ดูแล Hub (เว็บจัดการระบบ → โรงพยาบาล → "ออก API key") — วางตรงนี้แล้วกดทดสอบเชื่อมต่อเพื่อ activate</p>
      <button class='ghost' style='margin-top:12px' onclick="testConn('hub')">📡 ทดสอบเชื่อมต่อ Hub</button>
      <div id='st_hub' class='status'></div>
    </div>

    <div class='card'>
      <h2><span class='stepnum'>2</span> ฐานข้อมูล HOSxP ${badge(step2Done, 'พร้อมแล้ว', 'ยังไม่ครบ')} <span class='note' style='font-weight:400'>(ควรชี้ slave/replica)</span></h2>
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
      <h2><span class='stepnum'>3</span> ทดสอบส่งข้อมูล <span id='step3_badge'>${badge(everSync, 'เคยส่งสำเร็จ', 'ยังไม่เคยส่ง')}</span></h2>
      <p class='note' style='margin:0 0 6px'>ดึงข้อมูล<b>จริง</b>จาก HOSxP ตามงาน (job) ที่ Hub กำหนด มาจำนวนตัวอย่าง เพื่อดูว่า<b>จะส่งอะไร กี่แถว ขนาดเท่าไหร่</b> ก่อนเปิดใช้จริง — <b>ไม่ส่งข้อมูลขึ้น Hub</b> เว้นแต่ติ๊ก "ส่งจริง 1 batch"</p>
      <div class='row' style='align-items:flex-end'>
        <div style='max-width:170px'><label>จำนวนตัวอย่าง (คน)</label><input id='test_sample' type='number' value='20' min='1' max='200'></div>
        <div><label class='chk' style='margin:0 0 10px;font-weight:400;font-size:12.5px'><input type='checkbox' id='test_push'> ส่งจริง 1 batch แรก (ทดสอบครบวงจรถึง Hub)</label></div>
      </div>
      <button style='margin-top:6px' onclick='runTestSync()'>🧪 เริ่มทดสอบ</button>
      <div id='st_test' class='status'></div>
      <div id='test_result'></div>
    </div>

    <div class='card'>
      <h2><span class='stepnum'>4</span> ตารางเวลา &amp; บันทึก ${badge(step4Done, 'เปิดอัตโนมัติแล้ว', 'ยังไม่เปิดอัตโนมัติ')}</h2>
      <div class='chk'><input type='checkbox' id='sched_enabled' ${c.schedule.enabled ? 'checked' : ''}><label style='margin:0'>เปิดรันอัตโนมัติตามเวลา</label></div>
      <label>cron expression</label><input id='sched_cron' value='${esc(c.schedule.cron)}' placeholder='0 3 * * *'>
      <p class='note'>ค่าเริ่มต้น 0 3 * * * = ทุกวัน 03:00 น. (เวลาเครื่อง). ปิดสวิตช์ = รันเองด้วยปุ่ม ▶ ในแท็บสถานะ หรือ <span class='note'>npm run once</span></p>
      <details>
        <summary>ขั้นสูง — ค่าการ sync (ปกติไม่ต้องแก้)</summary>
        <div class='row' style='margin-top:8px'>
          <div><label>โหมด</label><select id='sync_mode'>${opt('incremental', 'incremental (ส่งเฉพาะที่เปลี่ยน)', c.sync.mode)}${opt('full', 'full (ดึงย้อนหลังทุกครั้ง)', c.sync.mode)}</select></div>
          <div><label>ย้อนหลัง (วัน) รอบแรก/full</label><input id='sync_sinceDays' type='number' value='${esc(c.sync.sinceDays)}'></div>
        </div>
        <div class='row'>
          <div><label>overlap (วัน)</label><input id='sync_overlapDays' type='number' value='${esc(c.sync.overlapDays)}'></div>
          <div><label>batch size</label><input id='sync_batchSize' type='number' value='${esc(c.sync.batchSize)}'></div>
          <div><label>concurrency</label><input id='sync_concurrency' type='number' value='${esc(c.sync.concurrency)}'></div>
        </div>
      </details>
    </div>

    <div class='save'><button onclick='saveAll()'>💾 บันทึกการตั้งค่า</button><div id='st_save' class='status'></div></div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
function showTab(t){
  ['status','settings'].forEach(function(k){
    $('tab_'+k).style.display = (k===t)?'':'none';
    $('tabbtn_'+k).className = (k===t)?'on':'';
  });
}
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
function esch(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function fmtBytes(n){ n=Number(n)||0; if(n>=1048576) return (n/1048576).toFixed(1)+' MB'; if(n>=1024) return (n/1024).toFixed(1)+' KB'; return Math.round(n)+' B'; }
function ago(iso){ if(!iso) return 'ยังไม่เคย'; var s=(Date.now()-new Date(iso).getTime())/1000;
  if(s<60) return 'เมื่อครู่'; if(s<3600) return Math.floor(s/60)+' นาทีที่แล้ว'; if(s<86400) return Math.floor(s/3600)+' ชม.ที่แล้ว'; return Math.floor(s/86400)+' วันที่แล้ว'; }

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

// ---------- ทดสอบส่งข้อมูล (dry-run) ----------
function renderTestJob(r){
  var dsRows = Object.keys(r.datasets||{}).map(function(n){
    var cnt = r.datasets[n];
    return '<tr><td>'+esch(n)+'</td><td style="text-align:right">'+cnt.toLocaleString()+'</td>'+
           '<td style="text-align:right">'+(r.built?(cnt/r.built).toFixed(1):'-')+'</td></tr>';
  }).join('') || '<tr><td colspan="3" class="note">— ไม่มีข้อมูลในตัวอย่างนี้ —</td></tr>';
  var pushHtml = '';
  if (r.push) {
    pushHtml = r.push.ok
      ? '<div class="status show ok" style="margin-top:10px">📤 ส่งจริง 1 batch: ส่ง '+r.push.sent+' คน — Hub รับเข้า (ingested) '+r.push.ingested+
        ((r.push.errors&&r.push.errors.length)?(' · Hub แจ้ง error '+r.push.errors.length+' รายการ (ดูรายละเอียดใน log ฝั่ง Hub)'):'')+'</div>'
      : '<div class="status show bad" style="margin-top:10px">📤 ส่งจริงไม่สำเร็จ: '+esch(r.push.message)+'</div>';
  }
  return '<div class="testjob">'+
    '<div style="font-weight:700;margin-bottom:4px">งาน '+esch(r.job)+' v'+(r.version==null?'?':r.version)+
      ' <span class="note" style="font-weight:400">· โหมด '+r.mode+' ตั้งแต่ '+r.since+' · dry-run ใช้เวลา '+(r.elapsedMs/1000).toFixed(1)+' วิ</span></div>'+
    '<div class="kpis">'+
      '<div class="kpi"><b>'+r.driverTotal.toLocaleString()+'</b><span>คนที่จะถูกส่งรอบถัดไป</span></div>'+
      '<div class="kpi"><b>'+fmtBytes(r.estBytes)+'</b><span>ขนาดส่งทั้งรอบ (ประมาณ)</span></div>'+
      '<div class="kpi"><b>'+r.estBatches.toLocaleString()+'</b><span>จำนวน batch</span></div>'+
      '<div class="kpi"><b>'+fmtBytes(r.built?r.sampleBytes/r.built:0)+'</b><span>ขนาดเฉลี่ยต่อคน</span></div>'+
    '</div>'+
    '<div class="note" style="margin:10px 0 2px">จากตัวอย่าง '+r.sampled+' คน: สร้างข้อมูลได้ '+r.built+
      ' · ข้าม '+r.skipped+' (เช่นหา HN ไม่เจอ) · error '+r.buildErrors+' · ขนาดตัวอย่างรวม '+fmtBytes(r.sampleBytes)+'</div>'+
    '<table class="tbl"><thead><tr><th>ข้อมูลที่ส่ง (dataset)</th><th style="text-align:right">แถวรวม (ตัวอย่าง)</th><th style="text-align:right">เฉลี่ยแถว/คน</th></tr></thead><tbody>'+dsRows+'</tbody></table>'+
    pushHtml+'</div>';
}
async function runTestSync(){
  const el = $('st_test'), out = $('test_result'); out.innerHTML = '';
  const d = collect();
  d.sample = Number($('test_sample').value) || 20;
  d.pushOne = $('test_push').checked;
  if (d.pushOne && !confirm('จะส่งข้อมูลจริง 1 batch แรกขึ้น Hub (Hub บันทึกเป็นข้อมูลจริง) — ยืนยัน?')) return;
  show(el, 'run', 'กำลังทดสอบ — ดึงข้อมูลตัวอย่าง ' + d.sample + ' คนจาก HOSxP... (อาจใช้เวลาหลายสิบวินาที)');
  try {
    const r = await fetch('/api/test-sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) });
    const j = await r.json();
    if (!j.ok) { show(el, 'bad', '⚠️ ' + j.message); return; }
    show(el, 'ok', '✅ ทดสอบเสร็จใน ' + (j.totalElapsedMs/1000).toFixed(1) + ' วินาที · นิยามงานจาก: ' + j.source);
    out.innerHTML = j.jobs.map(renderTestJob).join('');
    var pushedOk = j.jobs.some(function(x){ return x.push && x.push.ok; });
    if (pushedOk) $('step3_badge').innerHTML = '<span class="tag ok">✅ เคยส่งสำเร็จ</span>';
  } catch(e){ show(el, 'bad', '⚠️ ' + e.message); }
}

// ---------- แท็บสถานะ ----------
function renderStatus(s){
  const el = $('status_body');
  if (!s.hasConfig) { el.innerHTML = 'ยังไม่ได้ตั้งค่า — ไปที่แท็บ <b>⚙️ ตั้งค่า</b> เพื่อเริ่มติดตั้ง (4 ขั้นตอน)'; return; }
  var run = s.running ? '<span class="tag runy">⏳ กำลัง sync...</span>' : '<span class="tag ok">พร้อม</span>';
  var sched = (s.schedule && s.schedule.enabled)
    ? 'เปิดอัตโนมัติ (cron: ' + esch(s.schedule.cron) + ')'
    : 'ปิดอัตโนมัติ — รันเองด้วยปุ่ม ▶ ด้านล่าง';
  var names = Object.keys(s.jobs || {});
  var jobs = names.length ? '' : '<div class="note" style="margin-top:10px">ยังไม่เคย sync — กด ▶ Sync ตอนนี้ หรือทดสอบส่งข้อมูลในแท็บตั้งค่า (ขั้น ③)</div>';
  names.forEach(function(n){
    var j = s.jobs[n] || {}, lr = j.lastRun;
    jobs += '<div class="jobrow"><b>งาน ' + esch(n) + '</b> ' +
      (lr ? '<span class="tag ' + (lr.ok?'ok':'bad') + '">' + (lr.ok?'รอบล่าสุดสำเร็จ':'รอบล่าสุดมีปัญหา') + '</span>' : '<span class="tag mutedtag">—</span>') +
      '<div class="note" style="margin-top:5px">sync สำเร็จล่าสุด: ' +
      (j.lastSuccessAt ? new Date(j.lastSuccessAt).toLocaleString('th-TH') + ' (' + ago(j.lastSuccessAt) + ')' : 'ยังไม่เคย') + '</div>' +
      (lr ? '<div class="note">รอบล่าสุด: เข้าเกณฑ์ ' + lr.keys + ' คน → ส่ง ' + lr.pushed + ' · Hub รับ ' + lr.ingested +
            ' · ข้าม ' + lr.skipped + ' · error ' + lr.buildErrors + ' · ใช้เวลา ' + Math.round(lr.tookMs/1000) + ' วิ (โหมด ' + lr.mode + ' ตั้งแต่ ' + lr.since + ')</div>' : '') +
      '</div>';
  });
  el.innerHTML = '<div style="font-size:13.5px">รพ. <b>' + esch(s.hospitalName || '') + '</b> (' + esch(s.hospitalCode) + ') · สถานะ ' + run + '</div>' +
    '<div class="note" style="margin-top:5px">' + sched + (s.cronActive ? '' : ' · <b>โปรเซสนี้ไม่ได้รัน cron</b> (เปิดด้วย --setup) — ตารางเวลาทำงานเมื่อรัน npm start') + '</div>' + jobs;
}
async function refreshStatus(){
  try {
    const s = await (await fetch('/api/status')).json();
    renderStatus(s);
    $('btn_sync').disabled = !!s.running;
    const l = await (await fetch('/api/logs')).json();
    const box = $('logbox');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.textContent = (l.lines || []).map(function(x){ return '[' + x.ts.slice(11,19) + '] ' + x.text; }).join('\\n')
      || '— ยังไม่มี log ในโปรเซสนี้ —';
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch(e){}
}
async function syncNow(){
  const el = $('st_sync'); show(el, 'run', 'กำลังสั่งเริ่ม sync...');
  try {
    const r = await fetch('/api/sync-now', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ full: $('sync_full_chk').checked }) });
    const j = await r.json();
    show(el, j.ok ? 'ok' : 'bad', (j.ok ? '✅ ' : '⚠️ ') + j.message);
    refreshStatus();
  } catch(e){ show(el, 'bad', '⚠️ ' + e.message); }
}

showTab('${startTab}');
refreshStatus();
setInterval(refreshStatus, 3000);
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

function startSetup(opts = {}) {
  logbuf.install();   // เก็บ log เข้า buffer ให้แท็บสถานะอ่านได้
  const args = process.argv;
  const host = (args[args.indexOf('--host') + 1] && args.includes('--host')) ? args[args.indexOf('--host') + 1] : (process.env.SETUP_HOST || '127.0.0.1');
  const port = Number((args.includes('--port') && args[args.indexOf('--port') + 1]) || process.env.SETUP_PORT || 7070);
  const cronActive = !!opts.cronActive;   // true = โปรเซสนี้รัน cron อยู่ด้วย (npm start)

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page());
      }
      if (req.method === 'GET' && req.url === '/api/status') {
        const c = readCurrent();
        return json(res, 200, {
          ok: true, running: isRunning(), cronActive,
          hasConfig: !!(fs.existsSync(CONFIG_PATH) && c.hospitalCode),
          hospitalCode: c.hospitalCode, hospitalName: c.hospitalName,
          schedule: c.schedule, jobs: (loadState().jobs || {}),
        });
      }
      if (req.method === 'GET' && req.url === '/api/logs') return json(res, 200, { lines: logbuf.recent(300) });
      if (req.method === 'POST' && req.url === '/api/sync-now') {
        const body = await readBody(req);
        if (isRunning() || testRunning) return json(res, 200, { ok: false, message: 'มีรอบ sync/ทดสอบกำลังทำงานอยู่ — รอให้เสร็จก่อน' });
        const cfg = loadConfig('setup', { optional: true });
        if (!cfg || !cfg.hospitalCode) return json(res, 200, { ok: false, message: 'ยังไม่มี config — บันทึกการตั้งค่า (แท็บ ⚙️) ก่อน' });
        // fire-and-forget: ตามผลจาก /api/status + /api/logs
        runSync(cfg, !!body.full).catch(e => console.error('[agent] sync error:', e.message));
        return json(res, 200, { ok: true, message: 'เริ่ม sync แล้ว — ตามความคืบหน้าได้จาก Log ด้านล่าง' });
      }
      if (req.method === 'POST' && req.url === '/api/test-hosxp') return json(res, 200, await testHosxp(await readBody(req)));
      if (req.method === 'POST' && req.url === '/api/test-hub')   return json(res, 200, await testHub(await readBody(req)));
      if (req.method === 'POST' && req.url === '/api/test-sync')  return json(res, 200, await testSync(await readBody(req)));
      if (req.method === 'POST' && req.url === '/api/save') {
        const body = await readBody(req);
        if (!String(body.hospitalCode || '').trim()) return json(res, 200, { ok: false, message: 'ต้องระบุรหัส รพ.' });
        try { save(body); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 200, { ok: false, message: e.message }); }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { json(res, 500, { ok: false, message: e.message }); }
  });

  // พอร์ตชน (เช่นเปิด setup ค้างไว้อีกจอ) — เตือนแต่ไม่ดับโปรเซส (cron ใน npm start ต้องรันต่อ)
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.warn(`[setup] เปิดหน้าเว็บไม่ได้ — พอร์ต ${port} ถูกใช้อยู่ (อาจมี agent อีกตัวเปิดค้าง) · agent ยังทำงานตามปกติ`);
    else console.error('[setup]', e.message);
  });

  server.listen(port, host, () => {
    console.log(`\n[setup] หน้าสถานะ/ตั้งค่า agent เปิดที่:  http://${host === '0.0.0.0' ? '<ip-เครื่องนี้>' : host}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost')
      console.log('[setup] ⚠️ เปิดให้เครื่องอื่นเข้าถึงได้ — รหัสวิ่งผ่าน HTTP ธรรมดา ใช้ในวงปิด/LAN ที่เชื่อถือได้เท่านั้น');
    if (!cronActive) console.log('[setup] โหมดตั้งค่า (ไม่รัน cron) — กด Ctrl+C เพื่อปิดเมื่อเสร็จ\n');
  });
}

module.exports = { startSetup };
