// ============================================================================
//  โหลด config + secret จาก env — ใช้ร่วมกันทั้ง index.js / explain.js / probe-perf.js
//
//  แนะนำ: เก็บ "รหัส" (HOSxP password, hub apiKey) ไว้ใน .env หรือ env var
//          ไม่ใช่ใน config.json (กัน plaintext หลุดตอน backup/แชร์ไฟล์)
//  ค่าใน env จะทับค่าใน config.json เสมอ
// ============================================================================
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.AGENT_CONFIG || path.join(__dirname, '..', 'config.json');
const ENV_PATH    = process.env.AGENT_ENV    || path.join(__dirname, '..', '.env');

// โหลด .env แบบเบา ๆ (ไม่พึ่ง dependency) — KEY=VALUE บรรทัดละตัว, ไม่ทับ env ที่ตั้งไว้แล้ว
function loadDotEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

function loadConfig(tag = 'agent') {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[${tag}] config not found: ${CONFIG_PATH}  (คัดลอกจาก config.example.json)`);
    process.exit(1);
  }
  loadDotEnv();
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // --- secret จาก env var (ทับค่าใน config.json) ---
  cfg.hub = cfg.hub || {}; cfg.hosxp = cfg.hosxp || {};
  if (process.env.HUB_API_KEY)    cfg.hub.apiKey     = process.env.HUB_API_KEY;
  if (process.env.HOSXP_PASSWORD) cfg.hosxp.password = process.env.HOSXP_PASSWORD;
  if (process.env.HOSXP_USER)     cfg.hosxp.user     = process.env.HOSXP_USER;
  if (process.env.HOSXP_HOST)     cfg.hosxp.host     = process.env.HOSXP_HOST;
  if (process.env.HOSXP_PORT)     cfg.hosxp.port     = Number(process.env.HOSXP_PORT);
  if (process.env.HOSXP_DB)       cfg.hosxp.database = process.env.HOSXP_DB;

  // เตือนถ้ารหัสยังเป็นค่า placeholder/ว่าง (กันลืมตั้ง)
  if (!cfg.hosxp.password || cfg.hosxp.password === 'CHANGE_ME')
    console.warn(`[${tag}] ⚠️ ยังไม่ได้ตั้งรหัส HOSxP — ตั้งใน .env (HOSXP_PASSWORD=...) หรือ config.json`);
  if (!cfg.hub.apiKey || cfg.hub.apiKey === 'PASTE_API_KEY_FROM_HUB')
    console.warn(`[${tag}] ⚠️ ยังไม่ได้ตั้ง hub.apiKey — ตั้งใน .env (HUB_API_KEY=...) หรือ config.json`);

  return cfg;
}

module.exports = { loadConfig, loadDotEnv, CONFIG_PATH };
