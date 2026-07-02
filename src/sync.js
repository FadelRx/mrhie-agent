// ============================================================================
//  แกนกลางของการ sync — แยกออกจาก index.js เพื่อให้เรียกได้จากหลายที่:
//    - index.js       รันตาม cron / --once
//    - setup.js       ปุ่ม "Sync ตอนนี้" + "ทดสอบส่งข้อมูล (dry-run)" บนหน้าเว็บ
//
//  เพิ่มจากเดิม:
//    - lock กันรันซ้อน (cron ยิงมาระหว่างรอบก่อนยังไม่จบ / กดปุ่มซ้ำ)
//    - บันทึกสรุปผลรอบล่าสุดต่อ job ลง .sync-state.json (lastRun) ให้หน้า UI อ่านได้
// ============================================================================
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { runJob } = require('./runner');
const { fetchPacks } = require('./pack');
const { pushItems } = require('./push');

const STATE_PATH = process.env.AGENT_STATE || path.join(__dirname, '..', '.sync-state.json');
const PACK_PATH  = process.env.AGENT_PACK  || path.join(__dirname, '..', '.query-pack.json');

// ---------- state: watermark + ผลรอบล่าสุด แยกราย job ----------
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

// ---------- เชื่อม HOSxP (ใช้ร่วมกัน sync จริง / dry-run) ----------
async function connectHosxp(cfg) {
  const conn = await mysql.createConnection({
    host: cfg.hosxp.host, port: cfg.hosxp.port || 3306,
    user: cfg.hosxp.user, password: cfg.hosxp.password,
    database: cfg.hosxp.database, charset: 'utf8',
    dateStrings: false,
    namedPlaceholders: true,        // ให้ใช้ :hn / :cid / :since ใน SQL ของ pack ได้
  });
  // เกราะกัน HOSxP รพช.เครื่องเล็ก: ตัดคิวรี่ที่หลุดวิ่งนานเกินที่ "ฝั่ง server" (MariaDB max_statement_time = วินาที)
  // *** สำคัญ: timeout ฝั่ง client (mysql2) ไม่หยุดคิวรี่ที่ server — คิวรี่จะวิ่งกิน CPU ต่อแม้ agent ยอมแพ้แล้ว
  //     (พิสูจน์มาแล้ว: คนไข้ที่ opd plan เพี้ยนทำให้ค้าง >12 นาที). อันนี้สั่งให้ DB ฆ่าคิวรี่เองเมื่อเกินเวลา
  const maxQSec = Number(cfg.hosxp.maxQuerySeconds || (cfg.sync && cfg.sync.maxQuerySeconds) || 30);
  try { await conn.query('SET SESSION max_statement_time = ?', [maxQSec]); console.log(`[agent] max_statement_time=${maxQSec}s (กันคิวรี่ค้าง)`); }
  catch (e) { console.warn(`[agent] ตั้ง max_statement_time ไม่ได้ (${e.message}) — เซิร์ฟเวอร์อาจไม่รองรับ, ข้ามไป`); }
  return conn;
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
  const { items, total, errors, skipped } = await runJob(conn, pack, cfg, since, mapLimit, cfg._maxKeys);
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

  // สรุปผลรอบนี้ (ให้หน้าสถานะอ่าน) — เก็บเสมอไม่ว่าสำเร็จหรือล้ม
  const lastRun = {
    at: runStart.toISOString(), mode, since,
    keys: total, built: items.length, buildErrors: errors, skipped,
    pushed, ingested, ok: !pushFailed,
    tookMs: Date.now() - runStart.getTime(),
  };

  // เลื่อน watermark เฉพาะเมื่อ push ไม่ล้ม (ถ้าล้ม sync ซ้ำรอบหน้ากันข้อมูลตกหล่น)
  state.jobs = state.jobs || {};
  if (!pushFailed) {
    state.jobs[job] = { ...jobState, lastSyncStartedAt: runStart.toISOString(), lastSuccessAt: new Date().toISOString(), lastRun };
  } else {
    console.warn(`[agent] job=${job} push มีปัญหา — ไม่เลื่อน watermark`);
    state.jobs[job] = { ...jobState, lastRun };
  }
  return !pushFailed;
}

// ---------- รันทุก job หนึ่งรอบ (มี lock กันรันซ้อน) ----------
let running = false;
const isRunning = () => running;

async function runSync(cfg, forceFull, onlyJob) {
  if (running) { console.warn('[agent] มีรอบ sync กำลังทำงานอยู่ — ข้ามรอบนี้'); return false; }
  running = true;
  const t0 = Date.now();
  try {
    console.log(`[agent] sync start  รพ.=${cfg.hospitalCode}  ${new Date().toISOString()}`);

    // ดึง jobs (packs) ทั้งหมดจาก Hub — Hub ล่มใช้ cache เดิม
    const { packs, source } = await fetchPacks(cfg, PACK_PATH);
    let jobs = packs;
    if (onlyJob) jobs = jobs.filter(p => (p.job || 'default') === onlyJob);
    console.log(`[agent] ${jobs.length} job(s) (${source}): ${jobs.map(p => `${p.job}v${p.version ?? '?'}`).join(', ') || '-'}`);
    if (!jobs.length) { console.warn('[agent] ไม่มี job ให้รัน'); return false; }

    const conn = await connectHosxp(cfg);
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
    return true;
  } finally {
    running = false;
  }
}

module.exports = {
  runSync, isRunning, connectHosxp,
  loadState, saveState, computeCutoff, makeMapLimit,
  STATE_PATH, PACK_PATH,
};
