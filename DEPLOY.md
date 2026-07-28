# EC Forecast — Deploy (ฉบับง่าย: อัปโหลด 5 ไฟล์)

## ไฟล์ที่ต้องเอาเข้า repo (โยนหน้าเว็บ GitHub ได้เลย ครั้งเดียวครบ)
1. `models.tar.gz`      — โมเดลทั้ง 122 ตัว มัดเป็นไฟล์เดียว (แตกเองตอนรันครั้งแรก)
2. `predict_ec.py`      — inference รายชั่วโมง
3. `requirements.txt`   — บอก Railway ให้ลง Python libs
4. `station_scores.csv` — คะแนนรายสถานี (เก็บอ้างอิง ไม่ใส่ก็ได้)
5. `DEPLOY.md`          — ไฟล์นี้

## ตั้งค่า (ทำครั้งเดียว)
1. Railway → Variables → เพิ่ม `FIREBASE_URL` = https://<project>.asia-southeast1.firebasedatabase.app
2. เพิ่มใน server.js (ใช้ node-cron ที่มีอยู่):
```js
const { spawn } = require("child_process");
cron.schedule("5 * * * *", () => {
  const p = spawn("python3", ["predict_ec.py"]);
  p.stdout.on("data", d => console.log(`[EC] ${d}`));
  p.stderr.on("data", d => console.error(`[EC] ${d}`));
});
```
3. Push → Railway deploy เอง

## เช็คหลัง deploy ครั้งแรก (ดูใน Railway logs)
- "แตกโมเดลจาก models.tar.gz แล้ว" = โมเดลพร้อม
- "ได้ค่าล่าสุด N สถานี" = ต่อ TWQMS public API ได้
- "ชื่อไม่ตรงโมเดล..." = ต้องจับคู่ชื่อสถานี (เอา log มาให้ Claude แก้ mapping)
- ช่วงสัปดาห์แรก history ยังไม่ครบ 168 ชม. บางสถานีจะยังไม่พยากรณ์ — ปกติ
  (หรือ backfill ให้เต็มเร็วขึ้น — ปรึกษาเซสชันหน้า)

## Firebase ที่ระบบเขียน
- /history/ec/{YYYYMMDDHH}/{station} — buffer ค่าจริง
- /forecast/ec/{station} — {updated, h24, h24_alert, h48, h48_alert}
alert = พยากรณ์เกิน 600 µS/cm
