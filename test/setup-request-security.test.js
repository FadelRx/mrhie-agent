const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, rmDir, freePort, agentEnv, startAgent, request } = require('./helpers/agent');

function saveBody() {
  return JSON.stringify({
    hospitalCode: 'TEST', hospitalName: 'Test Hospital',
    hub: { url: 'https://hub.invalid', apiKey: '' },
    hosxp: { host: '127.0.0.1', port: 3306, user: 'readonly', password: '', database: 'hos' },
    sync: { mode: 'incremental', sinceDays: 1, overlapDays: 1, batchSize: 10, concurrency: 1 },
    schedule: { enabled: false, cron: '0 * * * *' },
  });
}

async function fixture(t, extraEnv = {}) {
  const dir = tmpDir();
  t.after(() => rmDir(dir));
  const port = await freePort();
  const agent = await startAgent({
    env: agentEnv(dir, { SETUP_HOST: '127.0.0.1', SETUP_PORT: String(port), ...extraEnv }),
    host: '127.0.0.1', port,
  });
  t.after(() => agent.stop());
  assert.ok(agent.ready, agent.output());
  return { dir, port };
}

test('state-changing setup APIs reject a cross-origin browser request', async (t) => {
  const { dir, port } = await fixture(t);
  const result = await request('127.0.0.1', port, {
    method: 'POST', path: '/api/save',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: saveBody(),
  });
  assert.equal(result.status, 403);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'rejected request must not mutate config');
});

test('state-changing setup APIs reject cross-site Fetch Metadata even without Origin', async (t) => {
  const { port } = await fixture(t);
  const result = await request('127.0.0.1', port, {
    method: 'POST', path: '/api/save',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: saveBody(),
  });
  assert.equal(result.status, 403);
});

test('state-changing setup APIs require an application/json content type', async (t) => {
  const { port } = await fixture(t);
  const origin = `http://127.0.0.1:${port}`;
  for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded']) {
    const headers = { origin };
    if (contentType) headers['content-type'] = contentType;
    const result = await request('127.0.0.1', port, {
      method: 'POST', path: '/api/save', headers, body: saveBody(),
    });
    assert.equal(result.status, 415, contentType || 'missing Content-Type');
  }
});

test('same-origin JSON request is accepted, including a charset parameter', async (t) => {
  const { dir, port } = await fixture(t);
  const result = await request('127.0.0.1', port, {
    method: 'POST', path: '/api/save',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json; charset=utf-8' },
    body: saveBody(),
  });
  assert.equal(result.status, 200);
  assert.equal(result.json && result.json.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).hospitalCode, 'TEST');
});

test('explicit HTTPS public origin is accepted behind a reverse proxy', async (t) => {
  const publicOrigin = 'https://agent.example.org';
  const { dir, port } = await fixture(t, { SETUP_PUBLIC_ORIGIN: publicOrigin });
  const result = await request('127.0.0.1', port, {
    method: 'POST', path: '/api/save',
    headers: { origin: publicOrigin, host: '127.0.0.1:' + port, 'content-type': 'application/json' },
    body: saveBody(),
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).hospitalCode, 'TEST');
});
