# mrhie-agent — Sync Agent (ติดตั้งที่ "ทุก" โรงพยาบาล)

ตัว sync ของระบบตามยาเดิมข้ามโรงพยาบาล (Med Reconciliation HIE): ดึงนิยามงาน (query pack) จาก Hub → อ่านข้อมูลจาก HOSxP slave/replica (read-only) → push ขึ้น Hub ผ่าน HTTPS

agent ทำงาน **2 ขา** พร้อมกันเมื่อรัน `npm start`:
1. **Batch (ตาม cron)** — ดึง *ดัชนี* visit + จำนวนยา (med_count) push เก็บที่ Hub (Hub ไม่เก็บตัวยา/lab จริง — federated)
2. **On-demand (WebSocket)** — เปิด WS ค้างออกไปหา Hub (ทะลุ NAT — ไม่ต้องมี public IP/เปิดพอร์ต) รอรับคำสั่ง "ดึงสด" ตอนแพทย์เปิดดูคนไข้ → query HOSxP เฉพาะ visit ที่ขอ → เข้ารหัส E2E ส่งกลับ → **ไม่เก็บที่ Hub** (ใช้ `hub.url`/`hub.apiKey` ตัวเดียวกับ batch — ไม่ต้องตั้งค่าเพิ่ม)

> ระบบนี้แยกเป็น 3 repo:
> - [`mrhie-hub`](https://github.com/FadelRx/mrhie-hub) — เซิร์ฟเวอร์กลาง (API + ฐานข้อมูล) ติดตั้งที่ สสจ./รพ.แม่ข่าย ที่เดียว
> - **`mrhie-agent`** (repo นี้) — ตัว sync ติดตั้งที่ทุก รพ.
> - [`mrhie-web`](https://github.com/FadelRx/mrhie-web) — เว็บแอปสำหรับเจ้าหน้าที่/ผู้ดูแล

## ติดตั้ง

ต้องมี Node.js 20+ และเข้าถึง HOSxP **slave/replica** ของ รพ. ได้ (read-only)

```bash
npm install

npm run setup    # ★ เปิดหน้าตั้งค่าผ่านเว็บ http://127.0.0.1:7070 — wizard 4 ขั้น + ทดสอบเชื่อมต่อ/ทดสอบส่งข้อมูล
npm run once     # ทดสอบ sync รอบเดียว (batch อย่างเดียว ไม่เปิด WS)
npm start        # ★ รันจริง: cron + WS on-demand + หน้าสถานะ/ตั้งค่าที่ :7070 — ผ่าน supervisor (run.js) ที่ respawn ให้อัตโนมัติ
```

ตรวจสอบแบบไม่เชื่อมต่อ HOSxP หรือ Hub จริง:

```bash
npm test
npm run check    # tests + ตรวจ syntax ของไฟล์ runtime
npm audit --audit-level=moderate
docker compose config --quiet
```

> **`npm start` รันผ่าน `run.js` (supervisor)** — ถ้า agent ปิด/crash หรือกด **🔄 รีสตาร์ท** ในหน้า UI มันจะเปิดใหม่ให้เอง (โหลด `config.json`/`.env` ใหม่ทุกครั้ง — ไม่มีปัญหาค่าเก่าค้าง). ถ้าอยากรันตรงไม่ผ่าน supervisor ใช้ `npm run start:direct` (ปุ่มรีสตาร์ทจะแค่ปิด ไม่เปิดเอง)

**`npm run setup`** เปิดหน้าเว็บ (local) 2 แท็บ: **⚙️ ตั้งค่า** เป็น wizard 4 ขั้น — ① โรงพยาบาล & Hub (วาง API key ที่ได้จากผู้ดูแล Hub + ทดสอบเชื่อมต่อ = activate) → ② HOSxP (ทดสอบ connect จริง) → ③ **ทดสอบส่งข้อมูล (dry-run)** ดึงข้อมูลจริงจำนวนตัวอย่างมาโชว์ว่า *จะส่ง dataset อะไร กี่แถว ขนาดรวมประมาณเท่าไหร่ กี่ batch* โดยไม่ส่งขึ้น Hub (ติ๊ก "ส่งจริง 1 batch" เพื่อพิสูจน์ครบวงจรได้) → ④ ตารางเวลา + 💾 บันทึก (เขียน `config.json` + `.env` ให้เอง) และ **📊 สถานะ** — ผล sync ล่าสุดราย job, ปุ่ม **▶ Sync ตอนนี้**, ปุ่ม **🔄 รีสตาร์ท agent** (โหลด config ใหม่ทันทีเมื่อรันผ่าน `npm start` — ไม่ต้องแตะ terminal), log ล่าสุด. หน้าเดียวกันนี้เปิดค้างอยู่ตลอดเมื่อรัน `npm start`. ค่าเริ่มต้นผูกกับ `127.0.0.1`; ถ้าต้องเข้าจากเครื่องอื่นใน LAN ใช้ `npm run setup -- --host 0.0.0.0 --port 8090` (เฉพาะวงปิดที่เชื่อถือได้)

เมื่อ bind นอก loopback ต้องมี `SETUP_TOKEN` หรือ `SETUP_TOKEN_FILE` มิฉะนั้นหน้า setup จะไม่เปิด. Docker Compose ใช้ `/data/.setup-token`: ครั้งแรก agent สุ่ม token 256 บิต เก็บใน named volume และแสดง URL ที่มี token ใน log เพียงครั้งเดียว; ดู token ภายหลังด้วย `docker compose exec agent cat /data/.setup-token`. หน้าแรกจะแลก token เป็น cookie `HttpOnly; SameSite=Strict`. API ที่เปลี่ยนสถานะรับเฉพาะ `application/json` และปฏิเสธ browser request ข้าม origin. Compose publish พอร์ตเฉพาะ `127.0.0.1:7070` โดยค่าเริ่มต้น; หากจำเป็นต้องวางหลัง HTTPS reverse proxy ให้ตั้ง `SETUP_PUBLIC_ORIGIN=https://<โดเมน>` อย่างชัดเจน (ระบบไม่เชื่อ `X-Forwarded-*` จากผู้เรียกโดยอัตโนมัติ).

**การขอ API key มีทางเดียว:** ผู้ดูแล Hub ออก key (เว็บจัดการระบบ → โรงพยาบาล → "ออก API key", แสดงครั้งเดียว) ส่งให้ รพ. → รพ. วาง key ในหน้า setup ขั้น ① แล้วกด "📡 ทดสอบเชื่อมต่อ Hub" เพื่อ activate → บันทึก (key ถูกเขียนลง `.env` ให้เอง). Hub เป็น root of trust: หมุน key/ปิด รพ. ได้ทุกเมื่อ + บันทึก access_log

<details><summary>หรือแก้ไฟล์เอง (ไม่ใช้ UI)</summary>

```bash
cp config.example.json config.json
cp .env.example .env
#   แก้ config.json (ค่าที่ไม่ลับ): hospitalCode, hub.url, hosxp.host/port/user/database
#   แก้ .env (รหัสลับ — gitignore): HUB_API_KEY, HOSXP_PASSWORD
```
</details>

> **รหัสลับเก็บใน `.env` ไม่ใช่ `config.json`**: ค่าใน `.env` (`HUB_API_KEY`, `HOSXP_PASSWORD`, และจะใส่ `HOSXP_HOST/PORT/USER/DB` ด้วยก็ได้) จะทับค่าใน `config.json` ตอนรัน — ไม่มีรหัส plaintext ติดไปกับไฟล์ config ตอน backup/แชร์

การเพิ่ม รพ. ใหม่ = ติดตั้ง agent ที่ รพ. นั้น + ออก API key ที่ Hub — **ไม่ต้องแก้โค้ด**

## โหมด sync (incremental vs full)

ค่าเริ่มต้น `sync.mode = "incremental"` — **รอบแรก** ดึงย้อนหลัง `sinceDays` วัน (full) จากนั้น agent จำ watermark ไว้ใน `.sync-state.json` แล้ว**รอบถัดไปดึงเฉพาะคนที่มี visit ใหม่**ตั้งแต่รอบก่อน (เผื่อย้อน `overlapDays` กันข้อมูลแก้/จำหน่ายล่าช้า)

```bash
node src/index.js --once          # sync ตามโหมด (incremental ถ้ามี watermark)
node src/index.js --full          # บังคับ sync เต็มย้อนหลัง sinceDays (เช่นหลังเพิ่งติดตั้ง/กู้ข้อมูล)
node src/index.js --job medrecon  # รันเฉพาะบางงาน (job)
```

## รันจริงที่ รพ. (auto-start / auto-restart)

agent ต้องรันค้าง 24/7 และเปิดเองหลังเครื่องรีบูต — เอา `run.js` (supervisor) ไปทำเป็น service:

```powershell
# Windows — ด้วย nssm (https://nssm.cc): ชี้ไปที่ node run.js
nssm install mrhie-agent "C:\Program Files\nodejs\node.exe" "C:\path\to\mrhie-agent\run.js"
nssm set mrhie-agent AppDirectory "C:\path\to\mrhie-agent"
nssm start mrhie-agent
```
```bash
# หรือ pm2 (ข้ามแพลตฟอร์ม)
pm2 start run.js --name mrhie-agent && pm2 save && pm2 startup
```

เมื่อรันแบบนี้ ปุ่ม **🔄 รีสตาร์ท** ในหน้า UI (:7070) จะสั่งให้โปรเซสออกแล้ว supervisor/pm2 เปิดใหม่ให้เอง (อ่าน config/.env ใหม่หมด) — เจ้าหน้าที่แก้ค่าแล้วใช้ได้เลยโดยไม่ต้องเข้า terminal

## หมายเหตุทางเทคนิค

- **Agent เป็น generic runner (รองรับหลายงาน)**: agent **ไม่รู้จักโดเมนใด ๆ** — มันดึง "งาน (job)" ทั้งหมดที่ active จาก Hub (`GET /api/agent/pack`) มารัน driver → datasets แล้วส่ง raw rows กลับ. **เพิ่มงานใหม่ = เพิ่มที่ฝั่ง Hub เท่านั้น** — ไม่ต้องแก้/อัปเดต agent ที่ รพ.
- **Query pack**: pack หนึ่ง = หนึ่งงาน บอก `driver` (ดึงรายการคีย์ เช่น CID) + `datasets` (ชุด SQL + การ bind พารามิเตอร์). agent cache ไว้ (`.query-pack.json`) เผื่อ Hub ล่ม
- **HOSxP ต่างเวอร์ชัน**: ถ้า รพ. ใดชื่อ table/column ต่าง ตั้ง `overrides` (idents) และ/หรือ `config` ใน `config.json` ของ รพ. นั้นเอง — ดู [`docs/hosxp-overrides.md`](docs/hosxp-overrides.md)
- **ยืนยัน login ด้วยรหัส HOSxP**: ท่อ WS เดียวกันยังรับคำสั่ง `auth` จาก hub — เจ้าหน้าที่ รพ. login เว็บด้วย**รหัส HOSxP เดิม**ได้ agent ตรวจกับตาราง `opduser` (เทียบ MD5 ที่ hub ส่งมากับคอลัมน์ `passweb` + เช็ค `account_disable`) แล้วตอบแค่ ok/ชื่อ — **ไม่รับ/ไม่เก็บรหัส plaintext** และอ่าน HOSxP อย่างเดียว
- **รุ่นนี้** อ่านข้อมูลอย่างเดียว ไม่เขียนกลับ HOSxP

## License
ใช้ภายในเครือข่ายโรงพยาบาล เพื่อการรักษาพยาบาลเท่านั้น
