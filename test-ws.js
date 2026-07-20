// Phase 1 WS smoke test — ต่อ WS ไปหา hub ตรง ๆ (ไม่แตะ HOSxP/cron)
const { startWsClient } = require('./src/wsclient');

const cfg = {
  hospitalCode: process.env.WS_CODE || 'TEST01',
  hub: {
    url: process.env.WS_HUB || 'http://localhost:8080',
    apiKey: process.env.WS_KEY || 'testkey123',
  },
  hosxp: { hisType: 'hosxp_v4' },
};

console.log(`[test] starting WS client -> ${cfg.hub.url} as ${cfg.hospitalCode}`);
const client = startWsClient(cfg);

// เทส echo round-trip หลังต่อติด ~2s (เข้าถึง ws ผ่าน monkey-patch ไม่ได้ตรง ๆ,
// wsclient ไม่ export ws — แต่ hub echo responder เราจะเทสด้วย client แยกในสเต็ปถัดไป)
// keepalive: จำลอง daemon จริง (index.js มี cron + setup server ค้างไว้)
// ให้ reconnect timer แบบ unref ทำงานได้ ไม่ให้ process จบก่อน
setInterval(() => {}, 1 << 30);
process.on('SIGINT', () => { client.stop(); process.exit(0); });
