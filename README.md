# 💧 FRC Chlorine LINE Bot

ระบบ LINE Bot สำหรับติดตามค่าคลอรีน (FRC) แบบ Real-Time
เชื่อมต่อกับ MWA API + Firebase จากระบบ Contour Map เดิม

---

## ✨ ฟีเจอร์ทั้งหมด

| ฟีเจอร์ | รูปแบบ | รายละเอียด |
|---------|--------|-----------|
| 🚨 แจ้งเตือนอัตโนมัติ | Push Message | ตรวจทุก 5 นาที — แจ้งเมื่อ FRC < 0.2 หรือ > 2.0 mg/L |
| 📊 สรุปประจำวัน | Push Broadcast | ส่งรายงานทุก 08:00 และ 17:00 |
| 💬 ถามค่า FRC | Reply Message | พิมพ์ "คลอรีน", "สถานีต่ำ", "หา บางเขน" |
| 🎨 Flex Message | Rich UI | การ์ดสวยพร้อม bar chart, สถานะสี, ปุ่มกด |

---

## 🚀 วิธี Deploy (แนะนำ 3 ทางเลือก)

### ทางเลือก 1: Railway.app (แนะนำ — ง่ายที่สุด)

1. สมัคร https://railway.app (ใช้ GitHub login)
2. กด **New Project** → **Deploy from GitHub Repo**
3. เลือก repo ที่ push โค้ดนี้ไป
4. ตั้ง Environment Variables:
   - `LINE_TOKEN` = Channel Access Token ของคุณ
   - `PORT` = 3000
5. Railway จะให้ URL เช่น `https://frc-bot-xxxx.up.railway.app`
6. ตั้ง Webhook URL ใน LINE Developer Console เป็น:
   ```
   https://frc-bot-xxxx.up.railway.app/webhook
   ```

**ค่าใช้จ่าย:** ฟรี $5/เดือน (เพียงพอสำหรับ Bot นี้)

### ทางเลือก 2: Render.com

1. สมัคร https://render.com
2. New → Web Service → เชื่อม GitHub repo
3. ตั้งค่า:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variables: `LINE_TOKEN`, `PORT=3000`
4. ได้ URL → ตั้งเป็น Webhook ใน LINE

**ค่าใช้จ่าย:** ฟรี (แต่ sleep หลัง 15 นาที — Cron อาจพลาด)

### ทางเลือก 3: VPS / Docker

```bash
git clone <your-repo>
cd line-frc-bot
docker build -t frc-bot .
docker run -d -p 3000:3000 \
  -e LINE_TOKEN="your-token" \
  --name frc-bot \
  frc-bot
```

ใช้ Nginx reverse proxy + Let's Encrypt สำหรับ HTTPS

---

## 🔧 ตั้งค่า LINE Developer Console

### ขั้นตอน:

1. เข้า https://developers.line.biz
2. สร้าง **Provider** (ถ้ายังไม่มี)
3. สร้าง **Messaging API Channel**
4. ในแท็บ **Messaging API**:
   - เปิด **Channel Access Token** → กด Issue
   - ตั้ง **Webhook URL** = `https://your-domain.com/webhook`
   - เปิด **Use webhook** = ✅
   - ปิด **Auto-reply messages** = ❌
   - ปิด **Greeting messages** = ❌

5. Token ที่คุณให้มาคือ:
   ```
   YB99Zn6PYMuAMCy44qR...
   ```
   ใส่ใน Environment Variable `LINE_TOKEN`

---

## 💬 คำสั่งที่ User ใช้ได้

| พิมพ์ | ผลลัพธ์ |
|-------|---------|
| `คลอรีน` หรือ `frc` | แสดงค่า FRC ปัจจุบัน (Flex Message) |
| `สรุป` หรือ `รายงาน` | รายงานสรุปทุกสถานี + bar chart |
| `สถานีต่ำ` หรือ `alert` | รายชื่อสถานีที่ FRC < 0.2 mg/L |
| `หา บางเขน` | ค้นหาสถานีตามชื่อ/รหัส |
| `help` | แสดงเมนูคำสั่งทั้งหมด |

---

## 📁 โครงสร้างไฟล์

```
line-frc-bot/
├── server.js          # โค้ดหลัก (ครบจบไฟล์เดียว)
├── package.json       # Dependencies
├── Dockerfile         # สำหรับ deploy ด้วย Docker
├── .env               # Environment variables
└── README.md          # คู่มือนี้
```

---

## 🔗 แหล่งข้อมูล

- **MWA API:** `https://twqonline.mwa.co.th/TWQMSServicepublic/api/mwaonmobile/getStations`
- **Firebase RTDB:** `https://frc-contour-default-rtdb.asia-southeast1.firebasedatabase.app`
  - `/live` — ค่า FRC ล่าสุด
  - `/history` — ประวัติย้อนหลัง
  - `/forecast` — ค่าพยากรณ์

---

## ⚙️ ปรับแต่งค่า Threshold

แก้ใน `server.js`:

```javascript
const FRC_MIN = 0.2;   // ต่ำกว่านี้ = แจ้งเตือน (mg/L)
const FRC_HI  = 1.0;   // สูงกว่านี้ = สถานะ "ดี"
```

ปรับเวลา Cron:

```javascript
// ตรวจ alert ทุก 5 นาที
cron.schedule('*/5 * * * *', () => checkAlerts());

// รายงานประจำวัน (เปลี่ยนเวลาได้)
cron.schedule('0 8,17 * * *', () => sendDailyReport());
```

---

## 🛡️ หมายเหตุด้านความปลอดภัย

- อย่า commit LINE Token ลง Git (ใช้ Environment Variable)
- Firebase config ตรงนี้เป็น public config (read-only) เหมือนใน HTML ต้นฉบับ
- แนะนำตั้ง Firebase Security Rules จำกัดสิทธิ์

---

## 📱 QR Code

สร้าง QR Code สำหรับ add bot ได้ที่:
LINE Developer Console → Messaging API → QR Code
