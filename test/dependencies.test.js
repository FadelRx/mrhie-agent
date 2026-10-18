const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers/agent');

test('node-cron v4 accepts the agent default schedule and returns a stoppable task', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['node-cron'], /(?:\^|~)?4\./);
  assert.match(pkg.engines.node, />=20/);

  const cron = require('node-cron');
  assert.equal(cron.validate('7 2 * * *'), true);
  const task = cron.schedule('7 2 * * *', () => {});
  assert.equal(typeof task.stop, 'function');
  task.stop();
});
