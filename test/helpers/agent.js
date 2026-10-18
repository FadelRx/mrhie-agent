// ============================================================================
//  ตัวช่วยสำหรับเทสต์: spawn `node src/index.js --setup` ใน temp dir แล้วยิง HTTP เข้าไป
//    - ไม่ต้องมี HOSxP / Hub จริง (หน้า setup อ่าน/เขียนไฟล์อย่างเดียว จนกว่าจะกดทดสอบ/sync)
//    - ทุกไฟล์ของ agent (config/.env/state/pack/keypin/lock) ชี้ไป temp dir — ไม่แตะไฟล์จริงใน repo
//    - ตัด env SETUP_* / AGENT_* / HUB_* / HOSXP_* ของเครื่องนักพัฒนาออกก่อน กันผลเทสต์เพี้ยน
// ============================================================================
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'src', 'index.js');

// loopback alias ที่ "ไม่ใช่" 127.0.0.1 — หน้า setup ถือว่าไม่ใช่ loopback (ต้องใช้รหัส)
// แต่ยังไม่เปิดพอร์ตออก LAN จริง (ใช้แทน 0.0.0.0 ในเทสต์)
const ALT_HOST = '127.0.0.2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mrhie-agent-test-'));
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// bind loopback alias ได้ไหม (Linux/Windows ได้, macOS ปกติไม่ได้) — ไม่ได้ให้ skip เทสต์นั้น
async function canBind(host) {
  try { await freePort(host); return true; } catch { return false; }
}

function agentEnv(dir, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SETUP_|AGENT_|HUB_|HOSXP_)/i.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    AGENT_CONFIG: path.join(dir, 'config.json'),
    AGENT_ENV: path.join(dir, '.env'),
    AGENT_PACK: path.join(dir, '.query-pack.json'),
    AGENT_STATE: path.join(dir, '.sync-state.json'),
    AGENT_KEYPIN: path.join(dir, '.hub-key.json'),
    AGENT_LOCK: path.join(dir, '.agent.lock'),
    ...extra,
  };
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

// เริ่ม agent แล้วรอจนพอร์ตเปิด / โปรเซสออก / หมดเวลา
//   คืน { ready, child, output(), exited, stop() } — ready=false = ไม่เปิดพอร์ตตามที่คาด
async function startAgent({ env, host = '127.0.0.1', port, args = ['--setup'], timeoutMs = 6000, cwd }) {
  const child = spawn(process.execPath, [INDEX, ...args], {
    env, cwd: cwd || os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([exited, sleep(3000)]);
    }
  };

  let ready = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (await canConnect(host, port)) { ready = true; break; }
    await sleep(50);
  }
  return { ready, child, output: () => out, exited, stop };
}

// HTTP request แบบคุม header ได้ครบ (Host/Origin/Sec-Fetch-*) — fetch ของ Node ตั้ง Host เองไม่ได้
function request(host, port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: p, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { ROOT, INDEX, ALT_HOST, sleep, tmpDir, rmDir, freePort, canBind, agentEnv, startAgent, request };
