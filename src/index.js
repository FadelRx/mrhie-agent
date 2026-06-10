// ============================================================================
//  Med Reconciliation HIE — Sync Agent (generic runner)
//  ติดตั้งที่แต่ละ รพ. : อ่าน HOSxP slave -> รัน "jobs" จาก Hub -> push raw rows ขึ้น Hub
//
//  *** agent ไม่รู้จักโดเมน ***  งานทั้งหมด (med recon, ANC, ฯลฯ) นิยามด้วย pack ที่ Hub
//  เพิ่มงานใหม่ = เพิ่ม pack + job module ที่ Hub เท่านั้น — ไฟล์ฝั่ง agent ไม่ต้องแก้
//
//  รัน:  node src/index.js          (ตั้ง cron ตาม config)
//        node src/index.js --once   (รันรอบเดียวแล้วจบ — ไว้ทดสอบ)
//        node src/index.js --full   (sync เต็ม เพิกเฉย watermark)
//        node src/index.js --job medrecon   (รันเฉพาะบาง job)
// ============================================================================
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const { runJob } = require('./runner');
const { fetchPacks } = require('./pack');
const { pushItems } = require('./push');

const CONFIG_PATH = process.env.AGENT_CONFIG || path.join(__dirname, '..', 'config.json');
const STATE_PATH  = process.env.AGENT_STATE  || path.join(__dirname, '..', '.sync-state.json');
const PACK_PATH   = process.env.AGENT_PACK   || path.join(__dirname, '..', '.query-pack.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[agent] config not found: ${CONFIG_PATH}  (คัดลอกจาก config.example.json)`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------- state: watermark แยกราย job ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('[agent] save state failed:', e.message); }
}

// คำนวณ cutoff ต่อ job (sync hint จาก pack ทับค่า default ใน config.json ได้)
//   incremental + มี watermark -> cutoff = watermark - overlapDays
//   อื่น ๆ (full / รอบแรก / --full) -> cutoff = วันนี้ - sinceDays
function computeCutoff(cfg, pack, jobState, forceFull) {
  const sync = { ...(cfg.sync || {}), ...(pack.sync || {}) };
  const mode = forceFull ? 'full' : (sync.mode || 'incremental');
  if (mode === 'incremental' && jobState.lastSyncStartedAt) {
    const overlap = (sync.overlapDays != null) ? sync.overlapDays : 2;
    const d = new Date(jobState.lastSyncStartedAt);
    d.setDate(d.getDate() - overlap);
    return { mode: 'incremental', cutoff: d };
  }
  const days = sync.sinceDays || 180;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return { mode: 'full', cutoff: d };
}

// รัน task แบบจำกัด concurrency (คืน {__error} แทนการ throw เพื่อไม่ให้ล้มทั้งรอบ)
function makeMapLimit(limit) {
  return async function mapLimit(items, worker) {
    const out = []; let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx]); }
        catch (e) { out[idx] = { __error: e.message, key: items[idx] }; }
      }
    });
    await Promise.all(runners);
    return out;
  };
}

// ---------- รัน job เดียวจนจบ (driver -> per key -> push) ----------
async function runOneJob(conn, cfg, pack, state, forceFull) {
  const job = pack.job || 'default';
  const runStart = new Date();
  const jobState = (state.jobs && state.jobs[job]) || {};
  const { mode, cutoff } = computeCutoff(cfg, pack, jobState, forceFull);
  const since = cutoff.toISOString().slice(0, 10);
  console.log(`[agent] job=${job} v${pack.version ?? '?'}  mode=${mode}  ตั้งแต่=${since}`);

  const mapLimit = makeMapLimit(cfg.sync && cfg.sync.concurrency || 4);
  const { items, total, errors, skipped } = await runJob(conn, pack, cfg, since, mapLimit);
  console.log(`[agent] job=${job} keys=${total} build_errors=${errors} skipped=${skipped} -> push ${items.length}`);

  // push เป็น batch
  const size = (cfg.sync && cfg.sync.batchSize) || 50;
  let pushed = 0, ingested = 0, pushFailed = false;
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    try {
      const r = await pushItems(cfg.hub, cfg.hospitalCode, job, batch);
      pushed += batch.length; ingested += (r.ingested || 0);
      if (r.errors && r.errors.length) console.warn(`[agent] job=${job} hub errors:`, r.errors.slice(0, 3));
    } catch (e) {
      pushFailed = true;
      console.error(`[agent] job=${job} push batch ${Math.floor(i / size)} failed: ${e.message}`);
    }
  }
  console.log(`[agent] job=${job} done  push=${pushed} ingested=${ingested}`);

  // เลื่อน watermark เฉพาะเมื่อ push ไม่ล้ม (ถ้าล้ม sync ซ้ำรอบหน้ากันข้อมูลตกหล่น)
  state.jobs = state.jobs || {};
  if (!pushFailed) {
    state.jobs[job] = { ...jobState, lastSyncStartedAt: runStart.toISOString(), lastSuccessAt: new Date().toISOString() };
  } else {
    console.warn(`[agent] job=${job} push มีปัญหา — ไม่เลื่อน watermark`);
  }
  return !pushFailed;
}

async function runSync(cfg, forceFull, onlyJob) {
  const t0 = Date.now();
  console.log(`[agent] sync start  รพ.=${cfg.hospitalCode}  ${new Date().toISOString()}`);

  // ดึง jobs (packs) ทั้งหมดจาก Hub — Hub ล่มใช้ cache เดิม
  const { packs, source } = await fetchPacks(cfg, PACK_PATH);
  let jobs = packs;
  if (onlyJob) jobs = jobs.filter(p => (p.job || 'default') === onlyJob);
  console.log(`[agent] ${jobs.length} job(s) (${source}): ${jobs.map(p => `${p.job}v${p.version ?? '?'}`).join(', ') || '-'}`);
  if (!jobs.length) { console.warn('[agent] ไม่มี job ให้รัน'); return; }

  const conn = await mysql.createConnection({
    host: cfg.hosxp.host, port: cfg.hosxp.port || 3306,
    user: cfg.hosxp.user, password: cfg.hosxp.password,
    database: cfg.hosxp.database, charset: 'utf8',
    dateStrings: false,
    namedPlaceholders: true,        // ให้ใช้ :hn / :cid / :since ใน SQL ของ pack ได้
  });

  const state = loadState();
  try {
    for (const pack of jobs) {
      try { await runOneJob(conn, cfg, pack, state, forceFull); }
      catch (e) { console.error(`[agent] job=${pack.job} fatal: ${e.message}`); }
      saveState(state);             // บันทึกหลังจบแต่ละ job (กันสูญหายถ้า job ถัดไปล้ม)
    }
  } finally {
    await conn.end();
  }
  console.log(`[agent] sync end  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

(async () => {
  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  const forceFull = process.argv.includes('--full');
  const ji = process.argv.indexOf('--job');
  const onlyJob = ji >= 0 ? process.argv[ji + 1] : null;

  if (once || !(cfg.schedule && cfg.schedule.enabled)) {
    await runSync(cfg, forceFull, onlyJob).catch(e => { console.error('[agent] fatal:', e.message); process.exit(1); });
    process.exit(0);
  }

  const expr = (cfg.schedule && cfg.schedule.cron) || '0 3 * * *';
  console.log(`[agent] scheduled: ${expr}  (--once = รันทันที, --full = sync เต็ม, --job <name> = เฉพาะงาน)`);
  cron.schedule(expr, () => runSync(cfg, false, onlyJob).catch(e => console.error('[agent] sync error:', e.message)));
})();
