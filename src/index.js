// ============================================================================
//  Med Reconciliation HIE — Sync Agent
//  ติดตั้งที่แต่ละ รพ. : อ่าน HOSxP slave -> แปลงเป็นรูปแบบกลาง -> push ขึ้น Hub
//  รัน:  node src/index.js          (ตั้ง cron ตาม config)
//        node src/index.js --once   (รันรอบเดียวแล้วจบ — ไว้ทดสอบ)
// ============================================================================
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const { listCandidateCids, buildPatientPayload } = require('./hosxp');
const { pushBatch } = require('./push');

const CONFIG_PATH = process.env.AGENT_CONFIG || path.join(__dirname, '..', 'config.json');
const STATE_PATH  = process.env.AGENT_STATE  || path.join(__dirname, '..', '.sync-state.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[agent] config not found: ${CONFIG_PATH}  (คัดลอกจาก config.example.json)`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------- state (watermark สำหรับ incremental sync) ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('[agent] save state failed:', e.message); }
}

// คำนวณวันที่ cutoff + โหมด
//   mode=incremental และมี watermark -> cutoff = watermark - overlapDays
//   อื่น ๆ (full / รอบแรก / --full) -> cutoff = วันนี้ - sinceDays
function computeCutoff(cfg, state, forceFull) {
  const sync = cfg.sync || {};
  const mode = forceFull ? 'full' : (sync.mode || 'incremental');
  if (mode === 'incremental' && state.lastSyncStartedAt) {
    const overlap = (sync.overlapDays != null) ? sync.overlapDays : 2;
    const d = new Date(state.lastSyncStartedAt);
    d.setDate(d.getDate() - overlap);
    return { mode: 'incremental', cutoff: d };
  }
  const days = sync.sinceDays || 180;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return { mode: 'full', cutoff: d };
}

// รัน task แบบจำกัด concurrency
async function mapLimit(items, limit, worker) {
  const out = []; let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx]); }
      catch (e) { out[idx] = { __error: e.message, cid: items[idx] }; }
    }
  });
  await Promise.all(runners);
  return out;
}

async function runSync(cfg, forceFull) {
  const t0 = Date.now();
  const runStart = new Date();                 // จับเวลาก่อน query — ใช้เป็น watermark รอบถัดไป
  const state = loadState();
  const { mode, cutoff } = computeCutoff(cfg, state, forceFull);
  console.log(`[agent] sync start  รพ.=${cfg.hospitalCode}  mode=${mode}  ตั้งแต่=${cutoff.toISOString().slice(0, 10)}  ${runStart.toISOString()}`);

  const conn = await mysql.createConnection({
    host: cfg.hosxp.host, port: cfg.hosxp.port || 3306,
    user: cfg.hosxp.user, password: cfg.hosxp.password,
    database: cfg.hosxp.database, charset: 'utf8',
    dateStrings: false,
  });

  let pushFailed = false;
  try {
    const cids = await listCandidateCids(conn, cutoff);
    console.log(`[agent] candidates: ${cids.length} คน`);

    // สร้าง payload (จำกัด concurrency กันโหลด DB)
    const built = await mapLimit(cids, cfg.sync.concurrency || 4,
      (cid) => buildPatientPayload(conn, cid, cfg.sync));
    const buildErrors = built.filter(p => p && p.__error).length;
    const payloads = built.filter(p => p && !p.__error && p.patient);
    if (buildErrors) console.warn(`[agent] build errors: ${buildErrors} คน (ข้ามไป)`);

    // push เป็น batch
    const size = cfg.sync.batchSize || 50;
    let pushed = 0, ingested = 0;
    for (let i = 0; i < payloads.length; i += size) {
      const batch = payloads.slice(i, i + size);
      try {
        const r = await pushBatch(cfg.hub, cfg.hospitalCode, batch);
        pushed += batch.length; ingested += (r.ingested || 0);
        if (r.errors && r.errors.length) console.warn(`[agent] hub errors:`, r.errors.slice(0, 3));
      } catch (e) {
        pushFailed = true;
        console.error(`[agent] push batch ${Math.floor(i / size)} failed: ${e.message}`);
      }
    }
    console.log(`[agent] done  mode=${mode} push=${pushed} ingested=${ingested}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } finally {
    await conn.end();
  }

  // เลื่อน watermark เฉพาะเมื่อ push ไม่ล้ม (ถ้าล้มจะ sync ซ้ำรอบหน้าเพื่อไม่ให้ข้อมูลตกหล่น)
  if (!pushFailed) {
    saveState({ ...state, lastSyncStartedAt: runStart.toISOString(), lastSuccessAt: new Date().toISOString() });
  } else {
    console.warn('[agent] push มีปัญหา — ไม่เลื่อน watermark จะ sync ซ้ำรอบถัดไป');
  }
}

(async () => {
  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  const forceFull = process.argv.includes('--full');   // บังคับ sync เต็ม (เพิกเฉย watermark)

  if (once || !(cfg.schedule && cfg.schedule.enabled)) {
    await runSync(cfg, forceFull).catch(e => { console.error('[agent] fatal:', e.message); process.exit(1); });
    process.exit(0);
  }

  const expr = (cfg.schedule && cfg.schedule.cron) || '0 3 * * *';
  console.log(`[agent] scheduled: ${expr}  (--once = รันทันที, --full = sync เต็มครั้งเดียว)`);
  cron.schedule(expr, () => runSync(cfg, false).catch(e => console.error('[agent] sync error:', e.message)));
})();
