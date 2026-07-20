// Probe: รัน handleFetch ยิง HOSxP จริง 1 CID — ดูว่าได้ raw datasets กลับมาไหม
// ใช้: node probe-ondemand.js <cid>
const { loadConfig } = require('./src/config');
const { handleFetch } = require('./src/ondemand');

const cid = process.argv[2] || '0094011505897';

(async () => {
  const cfg = loadConfig();
  console.log(`[probe] hub=${cfg.hub.url} hosxp=${cfg.hosxp.user}@${cfg.hosxp.host}:${cfg.hosxp.port}/${cfg.hosxp.database}`);
  console.log(`[probe] fetch cid=${cid} ...`);
  const t0 = Date.now();
  const { datasets } = await handleFetch(cfg, { cid });
  const ms = Date.now() - t0;

  // สรุปแบบไม่โชว์ PII เต็ม
  const ds = datasets || {};
  const summarize = (rows) => Array.isArray(rows) ? rows.length : (rows == null ? 'null' : typeof rows);
  console.log(`[probe] done in ${ms}ms — datasets keys: ${Object.keys(ds).join(', ')}`);
  for (const k of Object.keys(ds)) console.log(`   ${k}: ${summarize(ds[k])} rows`);

  // โชว์ visit_no ที่เจอ (ไว้ seed index) — ไม่ใช่ PII
  const vn = new Set();
  for (const r of (ds.opd || [])) vn.add(`OPD:${r.visit_no}:${(r.visit_date instanceof Date ? r.visit_date.toISOString().slice(0,10) : r.visit_date)}`);
  for (const r of (ds.ipd || [])) vn.add(`IPD:${r.visit_no}:${(r.visit_date instanceof Date ? r.visit_date.toISOString().slice(0,10) : r.visit_date)}`);
  console.log(`[probe] distinct visits (kind:visit_no:date):`);
  for (const v of vn) console.log(`   ${v}`);
  console.log(`[probe] lab types: ${(ds.labs || []).map(l => l.lab_type).join(', ') || '(none)'}`);
  process.exit(0);
})().catch(e => { console.error('[probe] ERROR:', e.message); process.exit(1); });
