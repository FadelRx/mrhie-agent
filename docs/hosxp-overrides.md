# คู่มือ Overrides — เมื่อ HOSxP ของ รพ. ชื่อ table/column ไม่ตรงมาตรฐาน

> สำหรับ **IT ของแต่ละ รพ.** ที่ติดตั้ง Sync Agent — ใช้เมื่อ HOSxP เวอร์ชันของ รพ. มีชื่อ
> ตาราง/คอลัมน์ต่างจากค่ามาตรฐาน หรือใช้รหัส lab ต่าง. **รพ. มาตรฐานไม่ต้องตั้งอะไร — เว้นว่างได้**

## หลักการ (อ่านก่อน)

- Agent ไม่ฝัง SQL ไว้ — ดึง "นิยามงาน (pack)" จาก Hub มารัน. SQL อ้างชื่อ table/column ผ่าน **token** `{{...}}`
- ค่า token มาตรฐานอยู่ใน pack ที่ Hub (`hub/packs/<job>.json` ส่วน `idents` / `config`)
- ถ้า รพ. คุณต่าง ให้ใส่ค่าทับเฉพาะตัวที่ต่างลงใน `config.json` ของ รพ. คุณ — **ใส่เฉพาะที่ต่าง ไม่ต้องใส่ครบ**
- ค่าที่ตั้งใน `config.json` มีผล **กับทุกงาน (job)** อัตโนมัติ (medrecon, ANC, ฯลฯ) เพราะเป็นชื่อจริงของเครื่องนั้น

มี 3 ช่องใน `config.json`:

| ช่อง | ใส่อะไร | ตัวอย่าง |
|---|---|---|
| `overrides` | ชื่อ **table / column / ค่า limit** (token `{{...}}`) | `{"ovst":"ovst_old","col_diag":"diagcode"}` |
| `config` | ค่าพารามิเตอร์ของ pack เช่น **รหัส lab** (`$cfg.*`) | `{"labCodes":{"egfr":"700"}}` |
| `labCodes` | ทางลัดเดิมของ `config.labCodes` (ใช้แทนกันได้) | `{"egfr":"700"}` |

> ⚠️ ค่าใน `overrides` ต้องเป็น `A–Z a–z 0–9 _` เท่านั้น (กัน SQL injection) — ใส่ได้แค่ชื่อ identifier/ตัวเลข

---

## รายการ token ทั้งหมด (งาน medrecon)

### 1) ตาราง (table) — ใส่ใน `overrides`

| token | ค่ามาตรฐาน | ตาราง HOSxP / หน้าที่ | คอลัมน์ที่ใช้ |
|---|---|---|---|
| `patient` | `patient` | ทะเบียนผู้ป่วย | hn, cid, pname, fname, lname, sex, birthday |
| `ovst` | `ovst` | visit OPD | vn, hn, vstdate, main_dep |
| `ipt` | `ipt` | การ admit IPD | an, hn, regdate, dchdate |
| `opdscreen` | `opdscreen` | จุดคัดกรอง (vital + FBS/HbA1c) | hn, vn, vstdate, bw, bmi, bps, bpd, fbs, hba1c |
| `opitemrece` | `opitemrece` | รายการสั่ง/จ่ายยา | vn, an, icode, qty, drugusage, sp_use, order_no |
| `drugitems` | `drugitems` | ทะเบียนยา | icode, name, strength |
| `drugusage` | `drugusage` | วิธีใช้ยา (ปกติ) | drugusage, name1, name2, name3 |
| `sp_use` | `sp_use` | วิธีใช้ยา (พิเศษ) | sp_use, name1, name2, name3 |
| `lab_head` | `lab_head` | หัวใบสั่ง lab | vn, lab_order_number |
| `lab_order` | `lab_order` | ผล lab รายตัว | lab_order_number, lab_items_code, lab_order_result |
| `ovstdiag` | `ovstdiag` | การวินิจฉัย (ดูโรคประจำตัว) | hn, icd10 |
| `icd101` | `icd101` | ทะเบียน ICD-10 | code, name |
| `oapp` | `oapp` | นัดครั้งถัดไป | hn, nextdate, nexttime, clinic |
| `clinic` | `clinic` | ทะเบียนคลินิก (ชื่อนัด) | clinic, name |
| `er_regist` | `er_regist` | ทะเบียน ER (ติดป้าย ER) | vn |
| `kskdepartment` | `kskdepartment` | ทะเบียนแผนก (ชื่อคลินิก OPD) | depcode, department |
| `ipt_order_no` | `ipt_order_no` | order ของ IPD (กรองยากลับบ้าน) | order_no, order_type (`HMe` = home med) |

### 2) ชื่อคอลัมน์เฉพาะที่มักต่างกัน — ใส่ใน `overrides`

| token | ค่ามาตรฐาน | คือคอลัมน์ | อยู่ในตาราง |
|---|---|---|---|
| `col_diag` | `icd10` | รหัสวินิจฉัย | `ovstdiag` |
| `col_lab_code` | `lab_items_code` | รหัสรายการ lab | `lab_order` |
| `col_lab_result` | `lab_order_result` | ค่าผล lab | `lab_order` |
| `col_main_dep` | `main_dep` | แผนกหลักของ visit | `ovst` |

### 3) ค่า limit (ปรับปริมาณข้อมูล/โหลด) — ใส่ใน `overrides` (เป็นตัวเลขในเครื่องหมายคำพูด)

| token | ค่ามาตรฐาน | ความหมาย |
|---|---|---|
| `opdVisits` | `"5"` | ดึงยา OPD ย้อนหลังกี่ visit ล่าสุด |
| `ipdAdmits` | `"3"` | ดึงยากลับบ้าน IPD ย้อนหลังกี่ admit ล่าสุด |
| `labScanVisits` | `"25"` | สแกนย้อนหลังกี่ visit เพื่อหา eGFR / ไขมัน |

### 4) รหัส lab (`lab_items_code`) — ใส่ใน `config.labCodes` (หรือ `labCodes`)

| token | ค่ามาตรฐาน | คือผล lab |
|---|---|---|
| `egfr` | `622` | eGFR |
| `chol` | `102` | Cholesterol |
| `tg` | `103` | Triglyceride |
| `hdl` | `91` | HDL |
| `ldl` | `535` | LDL |

> FBS / HbA1c อ่านตรงจากคอลัมน์ `opdscreen.fbs` / `opdscreen.hba1c` ไม่ได้ใช้รหัส lab

---

## Template พร้อมใช้

### แบบ A — รพ. มาตรฐาน (ปกติใช้แบบนี้)
ไม่ต้องตั้งอะไร เว้นว่างทั้ง 3 ช่อง:
```json
  "overrides": {},
  "config": {},
  "labCodes": {}
```

### แบบ B — ใส่เฉพาะตัวที่ต่าง (แนะนำ)
ตัวอย่าง รพ. ที่คอลัมน์วินิจฉัยชื่อ `diagcode`, ตาราง ovst ชื่อ `ovst1`, อยากดึง OPD 7 visit และใช้รหัส eGFR = 700:
```json
  "overrides": {
    "col_diag": "diagcode",
    "ovst": "ovst1",
    "opdVisits": "7"
  },
  "config": {
    "labCodes": { "egfr": "700" }
  },
  "labCodes": {}
```

### แบบ C — รายการเต็ม (คัดลอกแล้วลบตัวที่ไม่ต้องแก้ออก)
> อย่าใส่ครบทุกบรรทัดโดยไม่จำเป็น — ใส่ค่าผิดจะทำให้ query พัง ให้คงไว้เฉพาะตัวที่ต่างจริง
```json
  "overrides": {
    "patient": "patient",
    "ovst": "ovst",
    "ipt": "ipt",
    "opdscreen": "opdscreen",
    "opitemrece": "opitemrece",
    "drugitems": "drugitems",
    "drugusage": "drugusage",
    "sp_use": "sp_use",
    "lab_head": "lab_head",
    "lab_order": "lab_order",
    "ovstdiag": "ovstdiag",
    "icd101": "icd101",
    "oapp": "oapp",
    "clinic": "clinic",
    "er_regist": "er_regist",
    "kskdepartment": "kskdepartment",
    "ipt_order_no": "ipt_order_no",
    "col_diag": "icd10",
    "col_lab_code": "lab_items_code",
    "col_lab_result": "lab_order_result",
    "col_main_dep": "main_dep",
    "opdVisits": "5",
    "ipdAdmits": "3",
    "labScanVisits": "25"
  },
  "config": {
    "labCodes": { "egfr": "622", "chol": "102", "tg": "103", "hdl": "91", "ldl": "535" }
  }
```

---

## วิธีตรวจว่าค่าจริงของ รพ. คืออะไร

รันบน HOSxP slave (read-only) เพื่อยืนยันก่อนตั้ง override:

```sql
-- ตารางนี้มีอยู่ไหม / ชื่ออะไร
SHOW TABLES LIKE 'ovst%';

-- ตารางนี้มีคอลัมน์อะไรบ้าง (ดูว่าชื่อ col_diag/main_dep ตรงไหม)
SHOW COLUMNS FROM ovstdiag;
SHOW COLUMNS FROM ovst LIKE '%dep%';

-- หารหัส lab ของ รพ. (ดูชื่อแล้วจดรหัส lab_items_code)
SELECT lab_items_code, lab_items_name
  FROM lab_items
 WHERE lab_items_name LIKE '%GFR%'
    OR lab_items_name LIKE '%Cholest%'
    OR lab_items_name LIKE '%Triglyc%'
    OR lab_items_name LIKE '%HDL%'
    OR lab_items_name LIKE '%LDL%';
```

> ทดสอบหลังตั้งค่า: `node src/index.js --once` แล้วดู log — ถ้า query ตัวไหนพัง agent จะแจ้งชื่อ token/ตารางที่ผิด

---

## เมื่อไหร่ควรแก้ที่ Hub แทน (ไม่ใช่ที่ รพ.)

ถ้าพบว่า **หลาย รพ. ต่างเหมือน ๆ กัน** (เช่นใช้รหัส lab ชุดเดียวกันทั้งโซน) อย่าไปตั้งซ้ำทุกเครื่อง —
แจ้ง Hub admin ให้แก้ค่ามาตรฐานใน pack แล้ว `npm run set-pack` ครั้งเดียว มีผลทุกแห่ง
(ยังคง override รายเครื่องทับได้ถ้าบางแห่งยังต่างอีก)
