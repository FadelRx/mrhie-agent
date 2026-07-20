// debug: รัน medrecon pack ราย cid แล้วดูว่าได้ opd/ipd (ยา) กี่แถว + med_count ต่อ visit
const { loadConfig } = require('./src/config');
const { connectHosxp, PACK_PATH } = require('./src/sync');
const { fetchPacks } = require('./src/pack');
const { buildContext, runPerKey } = require('./src/runner');

const cid = process.argv[2] || '0094991133084';
(async () => {
  const cfg = loadConfig();
  const { packs } = await fetchPacks(cfg, PACK_PATH);
  const pack = packs.find(p => p.job === 'medrecon');
  console.log('medrecon pack found:', !!pack, 'datasets:', pack && pack.datasets.map(d => d.name).join(','));
  const ctx = buildContext(pack, cfg);
  const perKey = ctx.pack.datasets.filter(d => (d.scope || 'perKey') === 'perKey');
  const c = await connectHosxp(cfg);
  const ds = await runPerKey(c, ctx, perKey, cid, '1970-01-01');
  console.log('datasets keys:', Object.keys(ds || {}).join(','));
  for (const k of Object.keys(ds || {})) console.log('  ', k, Array.isArray(ds[k]) ? ds[k].length + ' rows' : ds[k]);
  // med_count per visit (เลียนแบบ groupMeds)
  const byVisit = {};
  for (const r of (ds.opd || [])) byVisit['OPD:' + r.visit_no] = (byVisit['OPD:' + r.visit_no] || 0) + 1;
  for (const r of (ds.ipd || [])) byVisit['IPD:' + r.visit_no] = (byVisit['IPD:' + r.visit_no] || 0) + 1;
  console.log('med_count per visit (raw):', JSON.stringify(byVisit));
  // เทส toPayload ฝั่ง hub ด้วย datasets จริง
  const { toPayload } = require('C:/Users/ASUS01/Desktop/medReconcile/mrhie-hub/src/jobs/medrecon');
  const payload = toPayload({ key: cid, datasets: ds });
  console.log('toPayload visits:', (payload.visits || []).length);
  for (const v of (payload.visits || [])) console.log(`   ${v.visit_type}:${v.visit_no} meds=${(v.meds||[]).length} date=${v.visit_date}`);
  await c.end(); process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
