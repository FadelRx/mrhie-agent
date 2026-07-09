# mrhie-agent — Sync Agent (ติดตั้งที่ "ทุก" โรงพยาบาล)

ตัว sync ของระบบตามยาเดิมข้ามโรงพยาบาล (Med Reconciliation HIE): ดึงนิยามงาน (query pack) จาก Hub → อ่านข้อมูลจาก HOSxP slave/replica (read-only) → push ขึ้น Hub ผ่าน HTTPS

> ระบบนี้แยกเป็น 3 repo:
> - [`mrhie-hub`](https://github.com/FadelRx/mrhie-hub) — เซิร์ฟเวอร์กลาง (API + ฐานข้อมูล) ติดตั้งที่ สสจ./รพ.แม่ข่าย ที่เดียว
> - **`mrhie-agent`** (repo นี้) — ตัว sync ติดตั้งที่ทุก รพ.
> - [`mrhie-web`](https://github.com/FadelRx/mrhie-web) — เว็บแอปสำหรับเจ้าหน้าที่/ผู้ดูแล

## ติดตั้ง

ต้องมี Node.js 18+ และเข้าถึง HOSxP **slave/replica** ของ รพ. ได้ (read-only)

```bash
npm install

npm run setup    # ★ เปิดหน้าตั้งค่าผ่านเว็บ http://127.0.0.1:7070 — wizard 4 ขั้น + ทดสอบเชื่อมต่อ/ทดสอบส่งข้อมูล
npm run once     # ทดสอบ sync รอบเดียว
npm start        # รันค้างไว้ตาม cron + เปิดหน้าสถานะที่ http://127.0.0.1:7070 (ดูผล sync/กดสั่งรัน/แก้ค่า)
```

**`npm run setup`** เปิดหน้าเว็บ (local) 2 แท็บ: **⚙️ ตั้งค่า** เป็น wizard 4 ขั้น — ① โรงพยาบาล & Hub (ลงทะเบียนด้วยโค้ด/วาง API key + ทดสอบเชื่อมต่อ) → ② HOSxP (ทดสอบ connect จริง) → ③ **ทดสอบส่งข้อมูล (dry-run)** ดึงข้อมูลจริงจำนวนตัวอย่างมาโชว์ว่า *จะส่ง dataset อะไร กี่แถว ขนาดรวมประมาณเท่าไหร่ กี่ batch* โดยไม่ส่งขึ้น Hub (ติ๊ก "ส่งจริง 1 batch" เพื่อพิสูจน์ครบวงจรได้) → ④ ตารางเวลา + 💾 บันทึก (เขียน `config.json` + `.env` ให้เอง) และ **📊 สถานะ** — ผล sync ล่าสุดราย job, ปุ่ม **▶ Sync ตอนนี้**, log ล่าสุด. หน้าเดียวกันนี้เปิดค้างอยู่ตลอดเมื่อรัน `npm start`. ค่าเริ่มต้นผูกกับ `127.0.0.1`; ถ้าต้องเข้าจากเครื่องอื่นใน LAN ใช้ `npm run setup -- --host 0.0.0.0 --port 8090` (เฉพาะวงปิดที่เชื่อถือได้)

**ลงทะเบียนด้วยโค้ด (ไม่ต้องรอ key จาก Hub):** ในหน้า setup ช่อง "🎫 ลงทะเบียนครั้งแรก" — ผู้ดูแล Hub ออก **โค้ดลงทะเบียน** (เว็บจัดการระบบ → โรงพยาบาล → "ออกโค้ดลงทะเบียน", อายุสั้น ใช้ครั้งเดียว) ส่งให้ รพ. ล่วงหน้าทีเดียว. รพ. กรอกรหัส รพ. + โค้ด แล้วกด "ลงทะเบียน" → agent แลกโค้ดกับ Hub ได้ API key มาเขียน `.env` ให้อัตโนมัติ. Hub ยังเป็น root of trust (คุมสิทธิ์ + revoke ได้ + บันทึก access_log)

<details><summary>หรือแก้ไฟล์เอง (ไม่ใช้ UI)</summary>

```bash
cp config.example.json config.json
cp .env.example .env
#   แก้ config.json (ค่าที่ไม่ลับ): hospitalCode, hub.url, hosxp.host/port/user/database
#   แก้ .env (รหัสลับ — gitignore): HUB_API_KEY, HOSXP_PASSWORD
```
</details>

> **รหัสลับเก็บใน `.env` ไม่ใช่ `config.json`**: ค่าใน `.env` (`HUB_API_KEY`, `HOSXP_PASSWORD`, และจะใส่ `HOSXP_HOST/PORT/USER/DB` ด้วยก็ได้) จะทับค่าใน `config.json` ตอนรัน — ไม่มีรหัส plaintext ติดไปกับไฟล์ config ตอน backup/แชร์

การเพิ่ม รพ. ใหม่ = ติดตั้ง agent ที่ รพ. นั้น + ออกโค้ดลงทะเบียน/API key ที่ Hub — **ไม่ต้องแก้โค้ด**

## โหมด sync (incremental vs full)

ค่าเริ่มต้น `sync.mode = "incremental"` — **รอบแรก** ดึงย้อนหลัง `sinceDays` วัน (full) จากนั้น agent จำ watermark ไว้ใน `.sync-state.json` แล้ว**รอบถัดไปดึงเฉพาะคนที่มี visit ใหม่**ตั้งแต่รอบก่อน (เผื่อย้อน `overlapDays` กันข้อมูลแก้/จำหน่ายล่าช้า)

```bash
node src/index.js --once          # sync ตามโหมด (incremental ถ้ามี watermark)
node src/index.js --full          # บังคับ sync เต็มย้อนหลัง sinceDays (เช่นหลังเพิ่งติดตั้ง/กู้ข้อมูล)
node src/index.js --job medrecon  # รันเฉพาะบางงาน (job)
```

## หมายเหตุทางเทคนิค

- **Agent เป็น generic runner (รองรับหลายงาน)**: agent **ไม่รู้จักโดเมนใด ๆ** — มันดึง "งาน (job)" ทั้งหมดที่ active จาก Hub (`GET /api/agent/pack`) มารัน driver → datasets แล้วส่ง raw rows กลับ. **เพิ่มงานใหม่ = เพิ่มที่ฝั่ง Hub เท่านั้น** — ไม่ต้องแก้/อัปเดต agent ที่ รพ.
- **Query pack**: pack หนึ่ง = หนึ่งงาน บอก `driver` (ดึงรายการคีย์ เช่น CID) + `datasets` (ชุด SQL + การ bind พารามิเตอร์). agent cache ไว้ (`.query-pack.json`) เผื่อ Hub ล่ม
- **HOSxP ต่างเวอร์ชัน**: ถ้า รพ. ใดชื่อ table/column ต่าง ตั้ง `overrides` (idents) และ/หรือ `config` ใน `config.json` ของ รพ. นั้นเอง — ดู [`docs/hosxp-overrides.md`](docs/hosxp-overrides.md)
- **รุ่นนี้** อ่านข้อมูลอย่างเดียว ไม่เขียนกลับ HOSxP

## License
ใช้ภายในเครือข่ายโรงพยาบาล เพื่อการรักษาพยาบาลเท่านั้น
