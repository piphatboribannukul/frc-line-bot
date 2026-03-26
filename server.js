// ═══════════════════════════════════════════════════════════════════════════════
// LINE Messaging API — FRC Chlorine Monitoring Bot
// ═══════════════════════════════════════════════════════════════════════════════
// Features:
//   1. แจ้งเตือนเมื่อค่าคลอรีน (FRC) ต่ำ/สูงผิดปกติ  (Push Message)
//   2. ส่งสรุปรายงานค่าคลอรีนประจำวัน              (Push Message - Cron)
//   3. ให้ user พิมพ์ถามค่าคลอรีนปัจจุบันได้          (Reply Message)
//   4. ส่ง Flex Message พร้อมกราฟ/แผนที่              (Flex Message)
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const cron    = require('node-cron');
const { initializeApp }  = require('firebase/app');
const { getDatabase, ref, get, onValue } = require('firebase/database');

const app = express();
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────────────
const LINE_TOKEN = process.env.LINE_TOKEN || 'YB99Zn6PYMuAMCy44qRzZikQdz4ti4CHPtiFvpdWJgSluDpwB8ji0LzSVLpwlQ6NASdlEOpxFfkgxL/keZiYP5uqVt3hmOiR1QmTKKJjMl7735QA0oYMLB/yF4yygPpXaY3/xITXHHMVm4D9FEx4cwdB04t89/1O/w1cDnyilFU=';
const LINE_API   = 'https://api.line.me/v2/bot/message';
const MWA_API    = 'https://twqonline.mwa.co.th/TWQMSServicepublic/api/mwaonmobile/getStations';

// Thresholds แบ่งตาม type สถานี
// สถานีสูบส่ง = SP01(TR1), SP02(TR2), SP03(TR3), SP11(MTR)
// สถานีสูบจ่าย = SP04(Dis1), SP05(Dis2), SP12(สูบจ่ายมหาสวัสดิ์)
//   + SW ทั้งหมด + SP06-SP10 (โรงงานผลิตน้ำ)
// สถานี monitor = ที่เหลือ (numeric id)
const SEND_IDS = ['SP01','SP02','SP03','SP11'];
const PUMP_IDS = ['SP04','SP05','SP12'];

const THRESHOLDS = {
  send:    { watch: 1.0, low: 0.2, high: 3.0, label: 'สถานีสูบส่งน้ำ' },
  pump:    { watch: 0.8, low: 0.2, high: 2.0, label: 'สถานีสูบจ่ายน้ำ' },
  monitor: { watch: 0.4, low: 0.2, high: 2.0, label: 'สถานี Monitor' }
};
function getThreshold(type, id) {
  const sid = String(id || '').toUpperCase();
  if (SEND_IDS.includes(sid)) return THRESHOLDS.send;
  if (PUMP_IDS.includes(sid) || sid.startsWith('SW') || type === 'plant') return THRESHOLDS.pump;
  if (type === 'pump') return THRESHOLDS.pump;
  return THRESHOLDS.monitor;
}
function getStationType(s) {
  const sid = String(s.id).toUpperCase();
  if (SEND_IDS.includes(sid)) return 'send';
  if (PUMP_IDS.includes(sid) || sid.startsWith('SW') || s.type === 'plant') return 'pump';
  if (s.type === 'pump') return 'pump';
  return 'monitor';
}
// ค่าเดิมสำหรับ backward compatibility
const FRC_MIN = 0.2;
const FRC_HI  = 1.0;

// Group ID / User IDs ที่จะรับแจ้งเตือน (เพิ่มจาก webhook follow event)
let NOTIFY_TARGETS = new Set();
// เก็บ state ว่าแจ้งเตือนไปแล้วหรือยัง (ป้องกันส่งซ้ำ)
let alertedStations = {};
// เก็บ state ว่า user กำลังรอพิมพ์ชื่อสถานที่
let waitingPlaceFrom = {};

// ─── Firebase Config (ตรงกับ HTML ต้นฉบับ) ───────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyC0iyNwGCOIh-kbp6xDfijWBWKiE4iI_Lk",
  authDomain:        "frc-contour.firebaseapp.com",
  databaseURL:       "https://frc-contour-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "frc-contour",
  storageBucket:     "frc-contour.firebasestorage.app",
  messagingSenderId: "772799472029",
  appId:             "1:772799472029:web:8e6862082d8252a6d04f74"
};

const fbApp = initializeApp(firebaseConfig);
const db    = getDatabase(fbApp);

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** ดึงข้อมูล sensor จาก MWA API (ตรง flow เดียวกับ HTML) */
async function fetchSensors() {
  try {
    const res  = await axios.get(MWA_API, { timeout: 15000 });
    const raw  = res.data;
    const arr  = Array.isArray(raw) ? raw : (raw.data || raw.stations || raw.result || []);
    return arr
      .filter(s => s.latitude != null && (s.longtitude != null || s.longitude != null))
      .map(s => {
        const code = (s.stationCode || "").toUpperCase();
        let type = "monitor";
        if (["SP06","SP07","SP08","SP09","SP10"].includes(code)) type = "plant";
        else if (code.startsWith("SP") || code.startsWith("SW")) type = "pump";
        const frcRaw = (s.value && s.value.frc_2 != null) ? s.value.frc_2 : (s.frc || s.chlorine || 0);
        const frc = parseFloat(frcRaw);
        const ecRaw = (s.value && s.value.ecm_5 != null) ? s.value.ecm_5
                    : (s.value && s.value.conductivity != null) ? s.value.conductivity
                    : (s.value && s.value.ec != null) ? s.value.ec
                    : (s.conductivity || s.ec || null);
        const ec = ecRaw != null ? parseFloat(ecRaw) : null;
        return {
          id:     s.stationCode || s.id || 0,
          name:   (s.stationName || "สถานี").trim(),
          area:   s.area   || "",
          branch: s.branch || "",
          lat:    parseFloat(s.latitude),
          lon:    parseFloat(s.longtitude || s.longitude),
          frc:    isNaN(frc) ? 0 : frc,
          ec,
          type,
        };
      })
      .filter(s => s.lat !== 0 && s.lon !== 0);
  } catch (err) {
    console.error('[MWA API Error]', err.message);
    // Fallback: ดึงจาก Firebase /live
    try {
      const snap = await get(ref(db, 'live'));
      if (snap.exists()) {
        const live = snap.val();
        return Object.entries(live).map(([id, v]) => ({
          id, name: `สถานี ${id}`, frc: v.frc || 0, ec: v.ec || null,
          lat: 0, lon: 0, type: 'monitor'
        }));
      }
    } catch (e) { console.error('[Firebase fallback error]', e.message); }
    return [];
  }
}

/** ส่ง LINE Push Message */
async function linePush(to, messages) {
  try {
    await axios.post(`${LINE_API}/push`, { to, messages }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
  } catch (err) {
    console.error('[LINE Push Error]', err.response?.data || err.message);
  }
}

/** ส่ง LINE Reply Message */
async function lineReply(replyToken, messages) {
  try {
    await axios.post(`${LINE_API}/reply`, { replyToken, messages }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
  } catch (err) {
    console.error('[LINE Reply Error]', err.response?.data || err.message);
  }
}

/** ส่ง Broadcast ถึงทุกคนที่ follow bot */
async function lineBroadcast(messages) {
  try {
    await axios.post(`${LINE_API}/broadcast`, { messages }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
  } catch (err) {
    console.error('[LINE Broadcast Error]', err.response?.data || err.message);
  }
}

/** จัดรูปแบบเวลาเป็นภาษาไทย */
function thaiTime(date = new Date()) {
  return date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
}
function thaiDate(date = new Date()) {
  return date.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'long', day: 'numeric' });
}

/** สถานะ FRC → emoji + label (รองรับ type สถานี) */
function frcStatus(frc, type, id) {
  const t = getThreshold(type || 'monitor', id);
  if (frc > t.high)  return { emoji: '🟠', label: 'สูง', color: '#FF8F00' };
  if (frc >= t.watch) return { emoji: '🟢', label: 'ดี', color: '#00C853' };
  if (frc >= t.low)   return { emoji: '🟡', label: 'เฝ้าระวัง', color: '#FFD600' };
  return { emoji: '🔴', label: 'ต่ำ', color: '#FF1744' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: แจ้งเตือนเมื่อ FRC ผิดปกติ (Push Message — ตรวจทุก 5 นาที)
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAlerts() {
  const sensors = await fetchSensors();
  if (!sensors.length) return;

  const alertList = [];

  for (const s of sensors) {
    if (s.frc <= 0) continue;
    const t = getThreshold(s.type, s.id);

    if (s.frc < t.low) {
      const key = `${s.id}_low`;
      if (!alertedStations[key]) {
        alertedStations[key] = Date.now();
        alertList.push({ ...s, alertType: 'ต่ำ', threshold: t });
      }
    } else if (s.frc > t.high) {
      const key = `${s.id}_high`;
      if (!alertedStations[key]) {
        alertedStations[key] = Date.now();
        alertList.push({ ...s, alertType: 'สูง', threshold: t });
      }
    } else if (s.frc < t.watch) {
      const key = `${s.id}_watch`;
      if (!alertedStations[key]) {
        alertedStations[key] = Date.now();
        alertList.push({ ...s, alertType: 'เฝ้าระวัง', threshold: t });
      }
    }
  }

  // ล้าง alert ที่เก่ากว่า 3 ชม.
  const cutoff = Date.now() - 10800000;
  for (const [k, v] of Object.entries(alertedStations)) {
    if (v < cutoff) delete alertedStations[k];
  }

  if (alertList.length === 0) return;

  // สร้าง Flex Message แจ้งเตือน
  const flexMsg = buildAlertFlex(alertList);
  await lineBroadcast([flexMsg]);
  console.log(`[Alert] ส่งแจ้งเตือน ${alertList.length} สถานี`);
}

function buildAlertFlex(alerts) {
  const bodyContents = [
    {
      type: "text",
      text: `⚠️ พบค่าคลอรีนผิดปกติ ${alerts.length} สถานี`,
      weight: "bold",
      size: "md",
      color: "#FF1744",
      wrap: true
    },
    {
      type: "text",
      text: `เวลา ${thaiTime()}`,
      size: "xs",
      color: "#999999",
      margin: "sm"
    },
    { type: "separator", margin: "lg" }
  ];

  for (const s of alerts.slice(0, 8)) {
    const st = frcStatus(s.frc, s.type, s.id);
    const tLabel = s.threshold ? s.threshold.label : '';
    bodyContents.push({
      type: "box",
      layout: "horizontal",
      margin: "lg",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 0,
          contents: [{ type: "text", text: st.emoji, size: "lg" }]
        },
        {
          type: "box",
          layout: "vertical",
          flex: 5,
          margin: "md",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: "#1a1a2e" },
            { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L (${s.alertType})`, size: "xs", color: st.color },
            { type: "text", text: tLabel, size: "xxs", color: "#999999" }
          ]
        }
      ]
    });
  }

  return {
    type: "flex",
    altText: `⚠️ แจ้งเตือน: ค่าคลอรีนผิดปกติ ${alerts.length} สถานี`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#FF1744",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "🚨 แจ้งเตือนค่าคลอรีน", color: "#ffffff", weight: "bold", size: "lg" },
          { type: "text", text: "FRC Chlorine Alert", color: "#ffcccc", size: "xs", margin: "sm" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: bodyContents
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "🗺️ เปิดแผนที่ Contour", uri: "https://piphatboribannukul.github.io/FRCfirebase/" },
            style: "primary",
            color: "#cc0055",
            height: "sm"
          }
        ]
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 2: สรุปรายงานประจำวัน (Cron Push — ทุก 8:00 และ 17:00)
// ═══════════════════════════════════════════════════════════════════════════════

async function sendDailyReport() {
  const sensors = await fetchSensors();
  if (!sensors.length) return;

  const total = sensors.length;
  const good  = sensors.filter(s => s.frc >= FRC_HI).length;
  const mid   = sensors.filter(s => s.frc >= FRC_MIN && s.frc < FRC_HI).length;
  const low   = sensors.filter(s => s.frc < FRC_MIN).length;
  const avgFrc = (sensors.reduce((a, s) => a + s.frc, 0) / total).toFixed(2);
  const minS   = sensors.reduce((a, s) => s.frc < a.frc ? s : a, sensors[0]);
  const maxS   = sensors.reduce((a, s) => s.frc > a.frc ? s : a, sensors[0]);

  const lowStations = sensors
    .filter(s => s.frc < FRC_MIN)
    .sort((a, b) => a.frc - b.frc)
    .slice(0, 5);

  const flexMsg = buildDailyReportFlex({
    total, good, mid, low, avgFrc, minS, maxS, lowStations
  });

  await lineBroadcast([flexMsg]);
  console.log(`[Daily Report] ส่งรายงาน — สถานี ${total}, ต่ำ ${low}`);
}

function buildDailyReportFlex({ total, good, mid, low, avgFrc, minS, maxS, lowStations }) {
  const pctGood = ((good / total) * 100).toFixed(0);
  const pctMid  = ((mid / total) * 100).toFixed(0);
  const pctLow  = ((low / total) * 100).toFixed(0);

  const bodyContents = [
    { type: "text", text: "📊 สรุปค่าคลอรีน", weight: "bold", size: "lg", color: "#1a1a2e" },
    { type: "text", text: `${thaiDate()} เวลา ${thaiTime()}`, size: "xs", color: "#999999", margin: "sm" },
    { type: "separator", margin: "lg" },
    {
      type: "box",
      layout: "horizontal",
      margin: "lg",
      contents: [
        { type: "text", text: `🟢 ดี ${good} (${pctGood}%)`, size: "sm", color: "#00C853", flex: 1, align: "center" },
        { type: "text", text: `🟡 ผ่าน ${mid} (${pctMid}%)`, size: "sm", color: "#B8860B", flex: 1, align: "center" },
        { type: "text", text: `🔴 ต่ำ ${low} (${pctLow}%)`, size: "sm", color: "#FF1744", flex: 1, align: "center" }
      ]
    },
    { type: "separator", margin: "lg" },
    makeStatRow("สถานีทั้งหมด", `${total} สถานี`),
    makeStatRow("ค่าเฉลี่ย FRC", `${avgFrc} mg/L`),
    makeStatRow("สูงสุด", `${maxS.frc.toFixed(2)} mg/L`),
    makeStatRow("ต่ำสุด", `${minS.frc.toFixed(2)} mg/L`)
  ];

  // เพิ่มรายชื่อสถานีต่ำ
  if (lowStations.length > 0) {
    bodyContents.push({ type: "separator", margin: "lg" });
    bodyContents.push({
      type: "text", text: "🔴 สถานีที่ต้องติดตาม:",
      weight: "bold", size: "sm", color: "#FF1744", margin: "lg"
    });
    for (const s of lowStations) {
      bodyContents.push({
        type: "text",
        text: `• ${s.name.substring(0, 28)} — ${s.frc.toFixed(2)} mg/L`,
        size: "xs", color: "#666666", margin: "sm", wrap: true
      });
    }
  }

  return {
    type: "flex",
    altText: `📊 สรุปค่าคลอรีนประจำวัน — ดี ${good} / ผ่าน ${mid} / ต่ำ ${low}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#3a0a20",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "📋 รายงานคุณภาพน้ำ", color: "#ffffff", weight: "bold", size: "lg" },
          { type: "text", text: "FRC Daily Report — MWA", color: "#ffccdd", size: "xs", margin: "sm" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: bodyContents
      },
      footer: {
        type: "box",
        layout: "horizontal",
        paddingAll: "12px",
        spacing: "md",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "🗺️ แผนที่", uri: "https://piphatboribannukul.github.io/FRCfirebase/" },
            style: "primary",
            color: "#cc0055",
            height: "sm",
            flex: 1
          },
          {
            type: "button",
            action: { type: "message", label: "📋 ดูทั้งหมด", text: "สรุปทั้งหมด" },
            style: "secondary",
            height: "sm",
            flex: 1
          }
        ]
      }
    }
  };
}

function makeStatRow(label, value) {
  return {
    type: "box",
    layout: "horizontal",
    contents: [
      { type: "text", text: label, size: "xs", color: "#999999", flex: 3 },
      { type: "text", text: value, size: "xs", color: "#1a1a2e", weight: "bold", flex: 5, align: "end", wrap: true }
    ]
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 3: Reply — user พิมพ์ถามค่าคลอรีน
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTextMessage(replyToken, text, userId) {
  const msg = text.trim();

  // ── คำสั่ง: ค่าคลอรีน / frc / สถานะ
  if (/คลอรีน|frc|สถานะ|status|ค่าน้ำ/i.test(msg)) {
    return replyCurrentStatus(replyToken);
  }

  // ── คำสั่ง: ตารางวัน / ตาราง / table
  if (/ตารางวัน|ตาราง|table/i.test(msg)) {
    return replyDailyTable(replyToken);
  }

  // ── คำสั่ง: สรุปวัน / สรุปทั้งวัน / daily
  if (/สรุปวัน|สรุปทั้งวัน|daily|ประจำวัน/i.test(msg)) {
    return replyDailySummary(replyToken);
  }

  // ── คำสั่ง: สรุป / รายงาน
  if (/สรุป|รายงาน|report|summary/i.test(msg)) {
    return replyFullReport(replyToken);
  }

  // ── คำสั่ง: สถานีต่ำ / alert
  if (/ต่ำ|low|alert|แจ้งเตือน|ผิดปกติ/i.test(msg)) {
    return replyLowStations(replyToken);
  }

  // ── คำสั่ง: ดูรายละเอียดแต่ละ type
  if (/ดูสูบส่ง|สูบส่ง|send/i.test(msg)) {
    return replyTypeDetail(replyToken, 'send');
  }
  if (/ดูสูบจ่าย|สูบจ่าย|ผลิตน้ำ|plant/i.test(msg)) {
    return replyTypeDetail(replyToken, 'plant');
  }
  if (/ดู monitor|ดูมอนิเตอร์|monitor/i.test(msg)) {
    return replyTypeDetail(replyToken, 'monitor');
  }

  // ── คำสั่ง: ค้นหาสถานี (พร้อม link flyTo)
  if (/^(ค้น|หา|search) .+/i.test(msg)) {
    const query = msg.replace(/^(ค้น|หา|search)\s*/i, '').toLowerCase();
    return replySearchStation(replyToken, query);
  }

  // ── คำสั่ง: ตำแหน่ง / location / ใกล้ฉัน
  if (/ตำแหน่ง|location|ใกล้ฉัน|ใกล้|nearby|พิกัด/i.test(msg)) {
    return replyLocationPrompt(replyToken);
  }

  // ── คำสั่ง: ค้นหาสถานที่ (flyTo ไปยังพื้นที่ใดก็ได้)
  if (/^(ค้นหาสถานที่|ไปที่|goto|flyto|นำทาง) .+/i.test(msg)) {
    const place = msg.replace(/^(ค้นหาสถานที่|ไปที่|goto|flyto|นำทาง)\s*/i, '');
    return replyFlyToPlace(replyToken, place);
  }

  // ── คำสั่ง: ไปที่ (ไม่มีชื่อสถานที่) → ถามก่อน
  if (/^(ค้นหาสถานที่|ไปที่|goto|flyto|นำทาง)$/i.test(msg)) {
    waitingPlaceFrom[userId] = true;
    return lineReply(replyToken, [{
      type: "flex",
      altText: "🔍 พิมพ์ชื่อสถานที่ที่ต้องการ",
      contents: {
        type: "bubble", size: "kilo",
        body: {
          type: "box", layout: "vertical", paddingAll: "20px", alignItems: "center",
          contents: [
            { type: "text", text: "🔍", size: "3xl", align: "center" },
            { type: "text", text: "ค้นหาสถานที่", weight: "bold", size: "md", align: "center", margin: "lg", color: "#3a0a20" },
            { type: "text", text: "พิมพ์ชื่อสถานที่ที่ต้องการ\nเช่น สถานีกลางบางซื่อ, สยาม\nBot จะพาไปในแผนที่ Contour", size: "xs", color: "#999999", align: "center", margin: "md", wrap: true }
          ]
        }
      }
    }]);
  }

  // ── ถ้ากำลังรอชื่อสถานที่ → flyTo ไปเลย
  if (waitingPlaceFrom[userId]) {
    delete waitingPlaceFrom[userId];
    return replyFlyToPlace(replyToken, msg);
  }

  // ── คำสั่ง: help
  if (/help|ช่วย|วิธีใช้|คำสั่ง|menu|เมนู/i.test(msg)) {
    return replyHelp(replyToken);
  }

  // ── ไม่ตรงคำสั่ง → แนะนำ
  return replyHelp(replyToken);
}

async function replyDailySummary(replyToken) {
  try {
    const snap = await get(ref(db, 'history'));
    if (!snap.exists()) {
      return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่พบข้อมูลประวัติ' }]);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    let allReadings = [];
    let stationCount = 0;

    snap.forEach(codeSnap => {
      const code = codeSnap.key;
      if (code.startsWith('_')) return;
      stationCount++;
      codeSnap.forEach(ptSnap => {
        const p = ptSnap.val();
        if (p && p.ts >= todayMs && p.frc != null) {
          allReadings.push({ code, frc: p.frc, ts: p.ts });
        }
      });
    });

    if (allReadings.length === 0) {
      return lineReply(replyToken, [{ type: 'text', text: '📊 ยังไม่มีข้อมูลสะสมวันนี้\nลองพิมพ์ "คลอรีน" เพื่อดูค่าปัจจุบัน' }]);
    }

    // ดึงชื่อสถานี + ข้อมูล sensor ปัจจุบัน
    let sensors = [];
    let stationNames = {};
    try {
      sensors = await fetchSensors();
      for (const s of sensors) {
        stationNames[String(s.id)] = s.name;
        stationNames[String(s.id).replace(/\/|\./g, '-')] = s.name;
      }
    } catch(e) {}

    const frcValues = allReadings.map(r => r.frc);
    const avgFrc = (frcValues.reduce((a, b) => a + b, 0) / frcValues.length).toFixed(2);
    const minFrc = Math.min(...frcValues).toFixed(2);
    const maxFrc = Math.max(...frcValues).toFixed(2);
    const totalReadings = allReadings.length;
    const lowCount = allReadings.filter(r => r.frc < FRC_MIN).length;
    const lowPct = ((lowCount / totalReadings) * 100).toFixed(0);
    const highCount = allReadings.filter(r => r.frc > 2.0).length;
    const lowStationCodes = new Set(allReadings.filter(r => r.frc < FRC_MIN).map(r => r.code));
    const highStationCodes = new Set(allReadings.filter(r => r.frc > 2.0).map(r => r.code));
    const minReading = allReadings.reduce((a, b) => a.frc < b.frc ? a : b);

    // สรุปปัจจุบันแยก type
    const sendNow = sensors.filter(s => getStationType(s) === 'send');
    const pumpNow = sensors.filter(s => getStationType(s) === 'pump');
    const monNow = sensors.filter(s => getStationType(s) === 'monitor');
    const avgSend = sendNow.length ? (sendNow.reduce((a,s) => a+s.frc, 0) / sendNow.length).toFixed(2) : '-';
    const avgPump = pumpNow.length ? (pumpNow.reduce((a,s) => a+s.frc, 0) / pumpNow.length).toFixed(2) : '-';
    const avgMon = monNow.length ? (monNow.reduce((a,s) => a+s.frc, 0) / monNow.length).toFixed(2) : '-';

    // ประเมินภาพรวม
    const normalPct = 100 - parseInt(lowPct);
    let overallStatus, overallColor, overallEmoji;
    if (normalPct >= 95) { overallStatus = 'ดีมาก'; overallColor = '#00C853'; overallEmoji = '🟢'; }
    else if (normalPct >= 80) { overallStatus = 'ดี'; overallColor = '#00C853'; overallEmoji = '🟢'; }
    else if (normalPct >= 60) { overallStatus = 'พอใช้'; overallColor = '#FFD600'; overallEmoji = '🟡'; }
    else { overallStatus = 'ต้องปรับปรุง'; overallColor = '#FF1744'; overallEmoji = '🔴'; }

    const bodyContents = [
      // ภาพรวมสถานะ
      {
        type: "box", layout: "horizontal", margin: "md", paddingAll: "12px",
        backgroundColor: "#f8f4f6", cornerRadius: "8px",
        contents: [
          { type: "text", text: overallEmoji, size: "3xl", flex: 0 },
          {
            type: "box", layout: "vertical", flex: 5, margin: "lg",
            contents: [
              { type: "text", text: `ภาพรวม: ${overallStatus}`, size: "md", weight: "bold", color: overallColor },
              { type: "text", text: `ค่าปกติ ${normalPct}% ของการตรวจวัดทั้งวัน`, size: "xxs", color: "#999999", margin: "xs", wrap: true }
            ]
          }
        ]
      },
      { type: "separator", margin: "lg" },
      // ตัวเลขสำคัญ
      { type: "text", text: "📊 ตัวเลขสำคัญ", weight: "bold", size: "sm", color: "#3a0a20", margin: "lg" },
      makeStatRow("FRC เฉลี่ยทั้งวัน", `${avgFrc} มก/ล.`),
      makeStatRow("สูงสุด / ต่ำสุด", `${maxFrc} / ${minFrc} มก/ล.`),
      makeStatRow("จำนวนตรวจวัด", `${totalReadings} ครั้ง`),
      { type: "separator", margin: "md" },
      // เฉลี่ยแยก type
      { type: "text", text: "🏭 เฉลี่ยตามประเภท (ปัจจุบัน)", weight: "bold", size: "sm", color: "#3a0a20", margin: "lg" },
      makeStatRow("สูบส่ง", `${avgSend} มก/ล.`),
      makeStatRow("สูบจ่าย", `${avgPump} มก/ล.`),
      makeStatRow("Monitor", `${avgMon} มก/ล.`),
    ];

    // สถานีต่ำ
    if (lowStationCodes.size > 0) {
      bodyContents.push({ type: "separator", margin: "lg" });
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md", paddingAll: "8px",
        backgroundColor: "#fff0f0", cornerRadius: "6px",
        contents: [
          { type: "text", text: "🔴", size: "sm", flex: 0 },
          {
            type: "box", layout: "vertical", flex: 5, margin: "sm",
            contents: [
              { type: "text", text: `ต่ำกว่าเกณฑ์ ${lowStationCodes.size} สถานี (${lowPct}%)`, size: "xs", weight: "bold", color: "#FF1744", wrap: true },
              { type: "text", text: [...lowStationCodes].slice(0, 3).map(c => stationNames[c] || c).join(', '), size: "xxs", color: "#999999", margin: "xs", wrap: true }
            ]
          }
        ]
      });
    }

    // สถานีสูง
    if (highStationCodes.size > 0) {
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "sm", paddingAll: "8px",
        backgroundColor: "#fff8f0", cornerRadius: "6px",
        contents: [
          { type: "text", text: "🟠", size: "sm", flex: 0 },
          {
            type: "box", layout: "vertical", flex: 5, margin: "sm",
            contents: [
              { type: "text", text: `สูงกว่าเกณฑ์ ${highStationCodes.size} สถานี`, size: "xs", weight: "bold", color: "#FF8F00", wrap: true },
              { type: "text", text: [...highStationCodes].slice(0, 3).map(c => stationNames[c] || c).join(', '), size: "xxs", color: "#999999", margin: "xs", wrap: true }
            ]
          }
        ]
      });
    }

    // ปกติทั้งหมด
    if (lowStationCodes.size === 0 && highStationCodes.size === 0) {
      bodyContents.push({ type: "separator", margin: "lg" });
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md", paddingAll: "10px",
        backgroundColor: "#f0fff0", cornerRadius: "6px",
        contents: [
          { type: "text", text: "✅", size: "sm", flex: 0 },
          { type: "text", text: "คลอรีนอยู่ในเกณฑ์ปกติตลอดทั้งวัน", size: "xs", weight: "bold", color: "#00C853", flex: 5, margin: "sm", wrap: true }
        ]
      });
    }

    return lineReply(replyToken, [{
      type: "flex",
      altText: `📊 สรุปผู้บริหาร — ${overallEmoji} ${overallStatus} FRC ${avgFrc} มก/ล.`,
      contents: {
        type: "bubble", size: "mega",
        header: {
          type: "box", layout: "vertical", backgroundColor: "#1a0a40", paddingAll: "16px",
          contents: [
            { type: "text", text: "📊 สรุปประจำวัน", color: "#ffffff", weight: "bold", size: "lg" },
            { type: "text", text: `${thaiDate()} — Executive Summary`, color: "#ccccff", size: "xs", margin: "sm" }
          ]
        },
        body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
        footer: {
          type: "box", layout: "horizontal", paddingAll: "10px", spacing: "sm",
          contents: [
            { type: "button", action: { type: "message", label: "ดูค่าปัจจุบัน", text: "คลอรีน" }, height: "sm", style: "primary", color: "#cc0055", flex: 1 },
            { type: "button", action: { type: "uri", label: "แผนที่", uri: "https://piphatboribannukul.github.io/FRCfirebase/" }, height: "sm", style: "secondary", flex: 1 }
          ]
        }
      }
    }]);
  } catch (err) {
    console.error('[Daily Summary Error]', err.message);
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลประวัติได้: ' + err.message }]);
  }
}

// ── ตารางสรุปค่า FRC ประจำวัน แยกตามเขต (เหมือนตารางผู้บริหาร) ──
async function replyDailyTable(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) {
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]);
  }

  // จัดกลุ่มสถานีตามเขตรับน้ำ (zone)
  const ZONE_GROUPS = [
    { key: 'TR1', title: 'สูบส่งน้ำบางเขน 1 (TR1)', color: '#cc0055',
      match: s => s.area === 'TR1' || s.id === 'SP01' || (s.name||'').includes('TR1') },
    { key: 'TR2', title: 'สูบส่งน้ำบางเขน 2 (TR2)', color: '#cc0055',
      match: s => s.area === 'TR2' || s.id === 'SP02' || (s.name||'').includes('TR2') },
    { key: 'TR3', title: 'สูบส่งน้ำบางเขน 3 (TR3)', color: '#cc0055',
      match: s => s.area === 'TR3' || s.id === 'SP03' || (s.name||'').includes('TR3') },
    { key: 'Dis1', title: 'สูบจ่ายน้ำบางเขน 1 (Dis1)', color: '#4488ff',
      match: s => /Dis\s*1/i.test(s.area) || s.id === 'SP04' || (s.name||'').includes('Dis1') },
    { key: 'Dis2', title: 'สูบจ่ายน้ำบางเขน 2 (Dis2)', color: '#4488ff',
      match: s => /Dis\s*2/i.test(s.area) || s.id === 'SP05' || (s.name||'').includes('Dis2') },
    { key: 'MDIS', title: 'สูบจ่ายน้ำมหาสวัสดิ์', color: '#9C27B0',
      match: s => /มหาสวัสดิ์|MDIS|MTR/i.test(s.area) || ['SP11','SP12'].includes(s.id) || /มหาสวัสดิ์/i.test(s.name) },
    { key: 'THO', title: 'โรงผลิตน้ำธนบุรี', color: '#FF8F00',
      match: s => /ธนบุรี/i.test(s.area) || s.id === 'SP06' || /ธนบุรี/i.test(s.name) },
    { key: 'SAM', title: 'โรงผลิตน้ำสามเสน', color: '#00897B',
      match: s => /สามเสน/i.test(s.area) || ['SP07','SP08','SP09','SP10'].includes(s.id) || /สามเสน/i.test(s.name) },
  ];

  // จัดกลุ่ม
  const grouped = {};
  const assigned = new Set();
  for (const zone of ZONE_GROUPS) {
    grouped[zone.key] = sensors.filter(s => {
      if (assigned.has(String(s.id))) return false;
      if (zone.match(s)) { assigned.add(String(s.id)); return true; }
      return false;
    });
  }
  // สถานีที่ไม่อยู่ในกลุ่มใด
  const unassigned = sensors.filter(s => !assigned.has(String(s.id)));
  if (unassigned.length > 0) {
    ZONE_GROUPS.push({ key: 'OTHER', title: 'อื่นๆ', color: '#666666', match: () => true });
    grouped['OTHER'] = unassigned;
  }

  // สร้าง carousel
  const bubbles = [];
  for (const zone of ZONE_GROUPS) {
    const list = grouped[zone.key] || [];
    if (list.length === 0) continue;

    // เรียงตาม FRC จากน้อยไปมาก
    list.sort((a, b) => a.frc - b.frc);

    const rows = [];
    // Header row
    rows.push({
      type: "box", layout: "horizontal", margin: "sm",
      contents: [
        { type: "text", text: "No.", size: "xxs", color: "#999999", flex: 1, weight: "bold" },
        { type: "text", text: "สถานี", size: "xxs", color: "#999999", flex: 6, weight: "bold" },
        { type: "text", text: "FRC", size: "xxs", color: "#999999", flex: 2, align: "end", weight: "bold" }
      ]
    });
    rows.push({ type: "separator", margin: "sm" });

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const st = frcStatus(s.frc, s.type, s.id);
      const shortName = s.name.length > 18 ? s.name.substring(0, 18) + '..' : s.name;
      rows.push({
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: `${i + 1}`, size: "xxs", color: "#bbbbbb", flex: 1 },
          { type: "text", text: shortName, size: "xxs", color: "#1a1a2e", flex: 6 },
          { type: "text", text: s.frc.toFixed(2), size: "xxs", color: st.color, flex: 2, align: "end", weight: "bold" }
        ]
      });
    }

    // เฉลี่ย
    const avg = (list.reduce((a, s) => a + s.frc, 0) / list.length).toFixed(2);
    rows.push({ type: "separator", margin: "sm" });
    rows.push({
      type: "box", layout: "horizontal", margin: "sm",
      contents: [
        { type: "text", text: " ", size: "xxs", flex: 1 },
        { type: "text", text: "เฉลี่ย", size: "xxs", color: "#3a0a20", flex: 6, weight: "bold" },
        { type: "text", text: `${avg}`, size: "xxs", color: "#3a0a20", flex: 2, align: "end", weight: "bold" }
      ]
    });

    bubbles.push({
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: zone.color, paddingAll: "12px",
        contents: [
          { type: "text", text: zone.title, color: "#ffffff", weight: "bold", size: "sm", wrap: true },
          { type: "text", text: `${list.length} สถานี | ${thaiDate()}`, color: "#ffffff", size: "xxs", margin: "xs" }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "10px", spacing: "none", contents: rows }
    });
  }

  if (bubbles.length === 0) {
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่พบข้อมูลสถานี' }]);
  }

  // เพิ่ม bubble สรุปหน้าแรก
  const totalStations = sensors.length;
  const avgAll = (sensors.reduce((a, s) => a + s.frc, 0) / totalStations).toFixed(2);
  const lowAll = sensors.filter(s => s.frc < FRC_MIN).length;

  const summaryBubble = {
    type: "bubble", size: "mega",
    header: {
      type: "box", layout: "vertical", backgroundColor: "#1a0a40", paddingAll: "14px",
      contents: [
        { type: "text", text: "📋 ตารางคลอรีนประจำวัน", color: "#ffffff", weight: "bold", size: "md" },
        { type: "text", text: `${thaiDate()} — ${thaiTime()} น. | เลื่อน → ดูแต่ละเขต`, color: "#ccccff", size: "xxs", margin: "sm", wrap: true }
      ]
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "14px",
      contents: [
        makeStatRow("สถานีทั้งหมด", `${totalStations} สถานี`),
        makeStatRow("FRC เฉลี่ย", `${avgAll} มก/ล.`),
        makeStatRow("ต่ำกว่าเกณฑ์", `${lowAll} สถานี`),
        { type: "separator", margin: "lg" },
        { type: "text", text: "📊 แยกตามเขตรับน้ำ", weight: "bold", size: "sm", color: "#3a0a20", margin: "lg" },
        ...ZONE_GROUPS.filter(z => (grouped[z.key] || []).length > 0).map(z => {
          const list = grouped[z.key];
          const avg = (list.reduce((a, s) => a + s.frc, 0) / list.length).toFixed(2);
          return {
            type: "box", layout: "horizontal", margin: "sm",
            contents: [
              { type: "text", text: z.title, size: "xxs", color: "#1a1a2e", flex: 6, wrap: true },
              { type: "text", text: `${list.length}`, size: "xxs", color: "#999999", flex: 1, align: "end" },
              { type: "text", text: `${avg}`, size: "xxs", color: "#3a0a20", flex: 2, align: "end", weight: "bold" }
            ]
          };
        }),
        { type: "text", text: "← เลื่อนซ้ายเพื่อดูรายละเอียดแต่ละเขต →", size: "xxs", color: "#cc0055", margin: "lg", align: "center", wrap: true }
      ]
    },
    footer: {
      type: "box", layout: "horizontal", paddingAll: "10px", spacing: "sm",
      contents: [
        { type: "button", action: { type: "message", label: "ดูค่าปัจจุบัน", text: "คลอรีน" }, height: "sm", style: "primary", color: "#cc0055", flex: 1 },
        { type: "button", action: { type: "uri", label: "แผนที่", uri: "https://piphatboribannukul.github.io/FRCfirebase/" }, height: "sm", style: "secondary", flex: 1 }
      ]
    }
  };

  return lineReply(replyToken, [{
    type: "flex",
    altText: `📋 ตารางคลอรีนประจำวัน — ${thaiDate()} FRC เฉลี่ย ${avgAll} มก/ล.`,
    contents: { type: "carousel", contents: [summaryBubble, ...bubbles.slice(0, 11)] }
  }]);
}

async function replyCurrentStatus(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) {
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้ กรุณาลองใหม่' }]);
  }

  const sendStations = sensors.filter(s => getStationType(s) === 'send');
  const plantStations = sensors.filter(s => getStationType(s) === 'pump');
  const monitorStations = sensors.filter(s => getStationType(s) === 'monitor');

  function countByStatus(list, thType) {
    let ok = 0, watch = 0, low = 0, high = 0;
    for (const s of list) {
      const th = getThreshold(thType, s.id);
      if (s.frc > th.high) high++;
      else if (s.frc >= th.watch) ok++;
      else if (s.frc >= th.low) watch++;
      else low++;
    }
    return { ok, watch, low, high, total: list.length };
  }

  const sc = countByStatus(sendStations, 'pump');
  const pc = countByStatus(plantStations, 'plant');
  const mc = countByStatus(monitorStations, 'monitor');
  const total = sensors.length;
  const avgFrc = (sensors.reduce((a, s) => a + s.frc, 0) / total).toFixed(2);
  const allOk = sc.ok + pc.ok + mc.ok;
  const allWatch = sc.watch + pc.watch + mc.watch;
  const allLow = sc.low + pc.low + mc.low;
  const allHigh = sc.high + pc.high + mc.high;

  function typeRow(label, c, thType) {
    const th = THRESHOLDS[thType] || THRESHOLDS.monitor;
    return {
      type: "box", layout: "vertical", margin: "lg", paddingAll: "10px",
      backgroundColor: "#f8f4f6", cornerRadius: "8px",
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: label, size: "sm", weight: "bold", color: "#3a0a20", flex: 5 },
            { type: "text", text: `${c.total} สถานี`, size: "xs", color: "#999999", flex: 3, align: "end" }
          ]
        },
        {
          type: "box", layout: "horizontal", margin: "sm", spacing: "xs",
          contents: [
            { type: "text", text: `🟢${c.ok}`, size: "xs", color: "#00C853", flex: 1 },
            { type: "text", text: `🟡${c.watch}`, size: "xs", color: "#B8860B", flex: 1 },
            { type: "text", text: `🔴${c.low}`, size: "xs", color: "#FF1744", flex: 1 },
            { type: "text", text: `🟠${c.high}`, size: "xs", color: "#FF8F00", flex: 1 }
          ]
        },
        { type: "text", text: `ดี >${th.watch} มก/ล. | ระวัง ${th.low}-${th.watch} | ต่ำ <${th.low} | สูง >${th.high} มก/ล.`, size: "xxs", color: "#bbaabb", margin: "sm", wrap: true }
      ]
    };
  }

  const flexMsg = {
    type: "flex",
    altText: `💧 FRC ${avgFrc} mg/L — ดี${allOk} เฝ้าระวัง${allWatch} ต่ำ${allLow} สูง${allHigh}`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "16px",
        contents: [
          { type: "text", text: "💧 คลอรีนอิสระคงเหลือ", color: "#ffffff", weight: "bold", size: "lg" },
          { type: "text", text: `FRC Real-Time — ${thaiTime()} น.`, color: "#ffccdd", size: "xs", margin: "sm" }
        ]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "14px",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              makeCountBox("🟢 ดี", allOk, "#00C853"),
              makeCountBox("🟡 ระวัง", allWatch, "#FFD600"),
              makeCountBox("🔴 ต่ำ", allLow, "#FF1744"),
              makeCountBox("🟠 สูง", allHigh, "#FF8F00"),
            ]
          },
          { type: "separator", margin: "md" },
          {
            type: "box", layout: "horizontal", margin: "md",
            contents: [
              { type: "text", text: `สถานีทั้งหมด ${total}`, size: "xs", color: "#999999", flex: 1 },
              { type: "text", text: `FRC เฉลี่ย ${avgFrc} mg/L`, size: "xs", color: "#3a0a20", flex: 1, align: "end", weight: "bold" }
            ]
          },
          typeRow("🏭 สถานีสูบส่ง", sc, 'send'),
          typeRow("💧 สถานีสูบจ่าย", pc, 'pump'),
          typeRow("📡 Monitor", mc, 'monitor'),
          { type: "separator", margin: "lg" },
          { type: "text", text: "🟢 ดี = เกินเกณฑ์เฝ้าระวัง  🟡 เฝ้าระวัง  🔴 ต่ำกว่าเกณฑ์  🟠 สูงเกิน", size: "xxs", color: "#999999", margin: "sm", wrap: true }
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "10px", spacing: "sm",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "button", action: { type: "message", label: "สูบส่ง", text: "ดูสูบส่ง" }, height: "sm", style: "primary", color: "#cc0055", flex: 1 },
              { type: "button", action: { type: "message", label: "สูบจ่าย", text: "ดูสูบจ่าย" }, height: "sm", style: "primary", color: "#4488ff", flex: 1 },
              { type: "button", action: { type: "message", label: "Monitor", text: "ดู monitor" }, height: "sm", style: "primary", color: "#FF8F00", flex: 1 },
            ]
          },
          { type: "button", action: { type: "uri", label: "🗺️ เปิดแผนที่ Contour", uri: "https://piphatboribannukul.github.io/FRCfirebase/" }, height: "sm", style: "secondary" }
        ]
      }
    }
  };

  return lineReply(replyToken, [flexMsg]);
}

async function replyTypeDetail(replyToken, typeFilter) {
  const sensors = await fetchSensors();
  if (!sensors.length) {
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]);
  }

  let filtered, title, thType, headerColor;
  if (typeFilter === 'send') {
    filtered = sensors.filter(s => getStationType(s) === 'send');
    title = 'สถานีสูบส่งน้ำ';
    thType = 'send';
    headerColor = '#cc0055';
  } else if (typeFilter === 'plant') {
    filtered = sensors.filter(s => getStationType(s) === 'pump');
    title = 'สถานีสูบจ่ายน้ำ';
    thType = 'pump';
    headerColor = '#4488ff';
  } else {
    filtered = sensors.filter(s => getStationType(s) === 'monitor');
    title = 'สถานี Monitor';
    thType = 'monitor';
    headerColor = '#FF8F00';
  }

  filtered.sort((a, b) => a.frc - b.frc);
  const th = getThreshold(thType);
  const avg = filtered.length ? (filtered.reduce((a, s) => a + s.frc, 0) / filtered.length).toFixed(2) : '0';

  // ใช้ carousel ถ้าสถานีเยอะ — แบ่งหน้าละ 15
  const pages = [];
  const perPage = 15;
  for (let p = 0; p < filtered.length; p += perPage) {
    pages.push(filtered.slice(p, p + perPage));
  }

  const bubbles = pages.map((page, pageIdx) => {
    const bodyContents = [];

    // หน้าแรกแสดงเกณฑ์
    if (pageIdx === 0) {
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md", paddingAll: "8px",
        backgroundColor: "#f8f4f6", cornerRadius: "6px",
        contents: [
          { type: "text", text: `🟢>${th.watch}`, size: "xxs", color: "#00C853", flex: 1 },
          { type: "text", text: `🟡${th.low}-${th.watch}`, size: "xxs", color: "#B8860B", flex: 1 },
          { type: "text", text: `🔴<${th.low}`, size: "xxs", color: "#FF1744", flex: 1 },
          { type: "text", text: `🟠>${th.high}`, size: "xxs", color: "#FF8F00", flex: 1 }
        ]
      });
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md",
        contents: [
          { type: "text", text: `${filtered.length} สถานี`, size: "xs", color: "#999999", flex: 1 },
          { type: "text", text: `เฉลี่ย ${avg} mg/L`, size: "xs", color: "#3a0a20", flex: 1, align: "end", weight: "bold" }
        ]
      });
      bodyContents.push({ type: "separator", margin: "md" });
    } else {
      bodyContents.push({ type: "text", text: `หน้า ${pageIdx + 1}/${pages.length}`, size: "xxs", color: "#999999", margin: "sm", align: "center" });
      bodyContents.push({ type: "separator", margin: "sm" });
    }

    for (const s of page) {
      const st = frcStatus(s.frc, s.type, s.id);
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: st.emoji, size: "xxs", flex: 0 },
          { type: "text", text: s.name, size: "xxs", color: "#1a1a2e", flex: 7, margin: "sm", wrap: true },
          { type: "text", text: s.frc.toFixed(2), size: "xxs", color: st.color, flex: 2, align: "end", weight: "bold" }
        ]
      });
    }

    return {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: headerColor, paddingAll: "14px",
        contents: [
          { type: "text", text: title, color: "#ffffff", weight: "bold", size: "md" },
          { type: "text", text: `${thaiTime()} น. — เรียงจาก FRC ต่ำสุด`, color: "#ffffff", size: "xxs", margin: "sm" }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "12px", contents: bodyContents },
      footer: {
        type: "box", layout: "horizontal", paddingAll: "10px", spacing: "sm",
        contents: [
          { type: "button", action: { type: "message", label: "กลับหน้าหลัก", text: "คลอรีน" }, height: "sm", style: "secondary", flex: 1 },
          { type: "button", action: { type: "uri", label: "แผนที่", uri: "https://piphatboribannukul.github.io/FRCfirebase/" }, height: "sm", style: "primary", color: headerColor, flex: 1 },
        ]
      }
    };
  });

  return lineReply(replyToken, [{
    type: "flex",
    altText: `${title} — ${filtered.length} สถานี, FRC ${avg} mg/L`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  }]);
}

function makeCountBox(label, count, color) {
  return {
    type: "box", layout: "vertical", flex: 1, alignItems: "center",
    contents: [
      { type: "text", text: String(count), size: "xxl", weight: "bold", color, align: "center" },
      { type: "text", text: label, size: "xxs", color: "#999999", align: "center" }
    ]
  };
}

async function replyFullReport(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) {
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]);
  }

  const flex = buildDailyReportFlex({
    total: sensors.length,
    good:  sensors.filter(s => s.frc >= FRC_HI).length,
    mid:   sensors.filter(s => s.frc >= FRC_MIN && s.frc < FRC_HI).length,
    low:   sensors.filter(s => s.frc < FRC_MIN).length,
    avgFrc: (sensors.reduce((a, s) => a + s.frc, 0) / sensors.length).toFixed(2),
    minS: sensors.reduce((a, s) => s.frc < a.frc ? s : a, sensors[0]),
    maxS: sensors.reduce((a, s) => s.frc > a.frc ? s : a, sensors[0]),
    lowStations: sensors.filter(s => s.frc < FRC_MIN).sort((a, b) => a.frc - b.frc).slice(0, 5)
  });

  return lineReply(replyToken, [flex]);
}

async function replyLowStations(replyToken) {
  const sensors = await fetchSensors();
  const lowList = sensors.filter(s => s.frc < FRC_MIN).sort((a, b) => a.frc - b.frc);

  if (lowList.length === 0) {
    return lineReply(replyToken, [{
      type: "flex", altText: "✅ ไม่พบสถานีที่ค่าคลอรีนต่ำ",
      contents: {
        type: "bubble", size: "kilo",
        body: {
          type: "box", layout: "vertical", paddingAll: "20px", alignItems: "center",
          contents: [
            { type: "text", text: "✅", size: "3xl", align: "center" },
            { type: "text", text: "ค่าคลอรีนปกติทุกสถานี", weight: "bold", size: "md", align: "center", margin: "lg", color: "#00C853" },
            { type: "text", text: `ตรวจสอบเมื่อ ${thaiTime()} น.`, size: "xs", color: "#999999", align: "center", margin: "sm" }
          ]
        }
      }
    }]);
  }

  const bubbles = [];
  for (let i = 0; i < Math.min(lowList.length, 10); i += 5) {
    const chunk = lowList.slice(i, i + 5);
    const rows = chunk.map((s, idx) => ({
      type: "box", layout: "horizontal", margin: "lg",
      contents: [
        { type: "text", text: `${i + idx + 1}.`, size: "sm", color: "#FF1744", flex: 0 },
        {
          type: "box", layout: "vertical", flex: 5, margin: "md",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: "#1a1a2e" },
            {
              type: "box", layout: "horizontal", margin: "xs",
              contents: [
                { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L`, size: "xs", color: "#FF1744", flex: 3 },
                { type: "text", text: s.area || '', size: "xs", color: "#999999", flex: 2, align: "end" }
              ]
            }
          ]
        }
      ]
    }));

    bubbles.push({
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#FF1744", paddingAll: "14px",
        contents: [
          { type: "text", text: `🔴 สถานี FRC ต่ำ (${lowList.length} สถานี)`, color: "#ffffff", weight: "bold", size: "md" },
          { type: "text", text: `เวลา ${thaiTime()} น.`, color: "#ffcccc", size: "xs", margin: "sm" }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows }
    });
  }

  return lineReply(replyToken, [{
    type: "flex",
    altText: `🔴 พบ ${lowList.length} สถานีที่ค่าคลอรีนต่ำ`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  }]);
}

async function replySearchStation(replyToken, query) {
  const sensors = await fetchSensors();
  const words = query.split(/\s+/).filter(w => w.length > 0);
  const results = sensors.filter(s => {
    const searchText = `${s.name} ${s.id} ${s.area || ''} ${s.branch || ''}`.toLowerCase();
    return words.every(w => searchText.includes(w));
  }).slice(0, 8);

  if (results.length === 0) {
    return lineReply(replyToken, [{ type: 'text', text: `🔍 ไม่พบสถานี "${query}"\n\nลองพิมพ์ชื่อย่อ เช่น:\n• หา บางเขน\n• หา สมุทรปราการ\n• หา SP01` }]);
  }

  const CONTOUR_URL = 'https://piphatboribannukul.github.io/FRCfirebase/';

  const rows = [];
  for (const s of results) {
    const st = frcStatus(s.frc, s.type, s.id);
    const flyToUrl = `${CONTOUR_URL}?flyto=${s.lat},${s.lon},16&station=${s.id}`;
    rows.push({
      type: "box", layout: "horizontal", margin: "lg",
      contents: [
        { type: "text", text: st.emoji, size: "lg", flex: 0 },
        {
          type: "box", layout: "vertical", flex: 5, margin: "md",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: "#1a1a2e" },
            { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L (${st.label}) | ${s.id}`, size: "xs", color: st.color, margin: "xs" },
            { type: "text", text: `${s.area} ${s.branch}`.trim() || '-', size: "xxs", color: "#999999", margin: "xs", wrap: true }
          ]
        },
        {
          type: "box", layout: "vertical", flex: 0, justifyContent: "center",
          contents: [{
            type: "button",
            action: { type: "uri", label: "📍", uri: flyToUrl },
            style: "primary", color: "#cc0055", height: "sm"
          }]
        }
      ]
    });
  }

  return lineReply(replyToken, [{
    type: "flex",
    altText: `🔍 ผลค้นหา "${query}" — ${results.length} สถานี`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "14px",
        contents: [
          { type: "text", text: `🔍 ผลค้นหา "${query}"`, color: "#ffffff", weight: "bold", size: "md", wrap: true },
          { type: "text", text: `พบ ${results.length} สถานี — กด 📍 เพื่อดูในแผนที่`, color: "#ffccdd", size: "xs", margin: "sm", wrap: true }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows }
    }
  }]);
}

// ── Location: ขอตำแหน่งจาก user ──
function replyLocationPrompt(replyToken) {
  return lineReply(replyToken, [{
    type: "flex",
    altText: "📍 ส่งตำแหน่งเพื่อดูค่าคลอรีนใกล้คุณ",
    contents: {
      type: "bubble", size: "kilo",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", alignItems: "center",
        contents: [
          { type: "text", text: "📍", size: "3xl", align: "center" },
          { type: "text", text: "ส่งตำแหน่งของคุณ", weight: "bold", size: "md", align: "center", margin: "lg", color: "#3a0a20" },
          { type: "text", text: "กดปุ่ม + ด้านล่างซ้าย\nเลือก Location\nBot จะเปิดแผนที่พร้อมปักหมุดให้!", size: "xs", color: "#999999", align: "center", margin: "md", wrap: true }
        ]
      }
    }
  }]);
}

// ── รับ Location → เปิด Contour Map พร้อมปักหมุด ──
async function handleLocationMessage(replyToken, lat, lon) {
  const sensors = await fetchSensors();
  const CONTOUR_URL = 'https://piphatboribannukul.github.io/FRCfirebase/';
  const mapUrl = `${CONTOUR_URL}?flyto=${lat},${lon},15&pin=${lat},${lon}`;

  const nearest = sensors.map(s => {
    const dist = Math.sqrt((s.lat - lat) ** 2 + (s.lon - lon) ** 2) * 111;
    return { ...s, dist };
  }).sort((a, b) => a.dist - b.dist).slice(0, 3);

  const rows = nearest.map(s => {
    const st = frcStatus(s.frc, s.type, s.id);
    return {
      type: "box", layout: "horizontal", margin: "lg",
      contents: [
        { type: "text", text: st.emoji, size: "lg", flex: 0 },
        {
          type: "box", layout: "vertical", flex: 5, margin: "md",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: "#1a1a2e" },
            { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L (${st.label})`, size: "xs", color: st.color, margin: "xs" },
            { type: "text", text: `📏 ${s.dist.toFixed(1)} km`, size: "xxs", color: "#999999", margin: "xs" }
          ]
        }
      ]
    };
  });

  return lineReply(replyToken, [{
    type: "flex",
    altText: `📍 สถานีใกล้คุณ — ${nearest[0]?.name || '-'}`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "14px",
        contents: [
          { type: "text", text: "📍 สถานีใกล้ตำแหน่งคุณ", color: "#ffffff", weight: "bold", size: "md" },
          { type: "text", text: "3 สถานีที่ใกล้ที่สุด", color: "#ffccdd", size: "xs", margin: "sm" }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows },
      footer: {
        type: "box", layout: "vertical", paddingAll: "12px",
        contents: [{
          type: "button",
          action: { type: "uri", label: "🗺️ เปิดแผนที่ ณ ตำแหน่งของฉัน", uri: mapUrl },
          style: "primary", color: "#cc0055", height: "sm"
        }]
      }
    }
  }]);
}

// ── ค้นหาสถานที่ → flyTo (ไม่จำกัดแค่สถานี ใช้ geocoding) ──
async function replyFlyToPlace(replyToken, place) {
  try {
    const CONTOUR_URL = 'https://piphatboribannukul.github.io/FRCfirebase/';
    const sensors = await fetchSensors();

    // ขั้น 1: ค้นหาในสถานีก่อน
    const words = place.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const stationMatch = sensors.filter(s => {
      const searchText = `${s.name} ${s.id} ${s.area || ''} ${s.branch || ''}`.toLowerCase();
      return words.every(w => searchText.includes(w));
    });

    if (stationMatch.length > 0) {
      // เจอสถานีในระบบ → flyTo ไปสถานีแรก
      const s = stationMatch[0];
      const st = frcStatus(s.frc, s.type, s.id);
      const mapUrl = `${CONTOUR_URL}?flyto=${s.lat},${s.lon},16&station=${s.id}`;

      return lineReply(replyToken, [{
        type: "flex",
        altText: `📍 ${s.name} — FRC ${s.frc.toFixed(2)} mg/L`,
        contents: {
          type: "bubble", size: "mega",
          header: {
            type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "14px",
            contents: [
              { type: "text", text: `📍 ${s.name}`, color: "#ffffff", weight: "bold", size: "md", wrap: true },
              { type: "text", text: `${s.id} | ${s.area || ''} ${s.branch || ''}`.trim(), color: "#ffccdd", size: "xxs", margin: "sm", wrap: true }
            ]
          },
          body: {
            type: "box", layout: "vertical", paddingAll: "14px",
            contents: [
              { type: "text", text: `${st.emoji} FRC: ${s.frc.toFixed(2)} mg/L (${st.label})`, size: "sm", color: st.color, weight: "bold" },
              makeStatRow("ประเภท", getThreshold(s.type, s.id).label),
              makeStatRow("พิกัด", `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`),
              stationMatch.length > 1 ? { type: "text", text: `พบอีก ${stationMatch.length - 1} สถานีที่ตรง — พิมพ์ "หา ${place}" เพื่อดูทั้งหมด`, size: "xxs", color: "#999999", margin: "md", wrap: true } : { type: "filler" }
            ].filter(c => c.type !== 'filler')
          },
          footer: {
            type: "box", layout: "vertical", paddingAll: "12px",
            contents: [{
              type: "button",
              action: { type: "uri", label: "🗺️ เปิดในแผนที่ Contour", uri: mapUrl },
              style: "primary", color: "#cc0055", height: "sm"
            }]
          }
        }
      }]);
    }

    // ขั้น 2: ไม่เจอในสถานี → geocode จาก Nominatim
    // ลองค้นหาแบบ 1: ชื่อตรงๆ + Thailand
    let geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=3&countrycodes=th`;
    let res = await axios.get(geocodeUrl, { timeout: 10000, headers: { 'User-Agent': 'FRC-LINE-Bot/1.0' } });

    // ถ้าไม่เจอ ลองเพิ่ม กรุงเทพ
    if (!res.data || res.data.length === 0) {
      geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place + ' กรุงเทพ')}&format=json&limit=3`;
      res = await axios.get(geocodeUrl, { timeout: 10000, headers: { 'User-Agent': 'FRC-LINE-Bot/1.0' } });
    }

    if (!res.data || res.data.length === 0) {
      return lineReply(replyToken, [{ type: 'text', text: `🔍 ไม่พบ "${place}"\n\nลองพิมพ์ เช่น:\n• ไปที่ บางเขน\n• ไปที่ สยาม\n• ไปที่ สุวรรณภูมิ\n• ไปที่ สถานีสูบส่ง (ค้นหาสถานีในระบบ)` }]);
    }

    const loc = res.data[0];
    const lat = parseFloat(loc.lat);
    const lon = parseFloat(loc.lon);
    const displayName = loc.display_name.split(',').slice(0, 3).join(', ');
    const mapUrl = `${CONTOUR_URL}?flyto=${lat},${lon},15&pin=${lat},${lon}`;

    const nearest = sensors.map(s => {
      const dist = Math.sqrt((s.lat - lat) ** 2 + (s.lon - lon) ** 2) * 111;
      return { ...s, dist };
    }).sort((a, b) => a.dist - b.dist)[0];

    const bodyContents = [
      { type: "text", text: displayName, size: "xs", color: "#666666", wrap: true },
      { type: "text", text: `พิกัด: ${lat.toFixed(4)}, ${lon.toFixed(4)}`, size: "xxs", color: "#999999", margin: "sm" }
    ];
    if (nearest) {
      const st = frcStatus(nearest.frc, nearest.type, nearest.id);
      bodyContents.push({ type: "separator", margin: "md" });
      bodyContents.push({ type: "text", text: "สถานีใกล้สุด:", size: "xxs", color: "#999999", margin: "md" });
      bodyContents.push({ type: "text", text: `${st.emoji} ${nearest.name}`, size: "sm", color: "#1a1a2e", margin: "xs", wrap: true });
      bodyContents.push({ type: "text", text: `FRC ${nearest.frc.toFixed(2)} mg/L (${nearest.dist.toFixed(1)} km)`, size: "xs", color: st.color, margin: "xs" });
    }

    return lineReply(replyToken, [{
      type: "flex",
      altText: `🗺️ ${place} — เปิดในแผนที่ Contour`,
      contents: {
        type: "bubble", size: "mega",
        header: {
          type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "14px",
          contents: [
            { type: "text", text: `🗺️ ${place}`, color: "#ffffff", weight: "bold", size: "md", wrap: true }
          ]
        },
        body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
        footer: {
          type: "box", layout: "vertical", paddingAll: "12px",
          contents: [{
            type: "button",
            action: { type: "uri", label: "🗺️ เปิดในแผนที่ Contour", uri: mapUrl },
            style: "primary", color: "#cc0055", height: "sm"
          }]
        }
      }
    }]);
  } catch (err) {
    console.error('[FlyTo Error]', err.message);
    return lineReply(replyToken, [{ type: 'text', text: `❌ ไม่สามารถค้นหา "${place}" ได้` }]);
  }
}

function replyHelp(replyToken) {
  return lineReply(replyToken, [{
    type: "flex",
    altText: "📖 วิธีใช้งาน FRC Bot",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "16px",
        contents: [
          { type: "text", text: "💧 FRC Chlorine Bot", color: "#ffffff", weight: "bold", size: "lg" },
          { type: "text", text: "ระบบติดตามคลอรีนอิสระคงเหลือ", color: "#ffccdd", size: "xs", margin: "sm" }
        ]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "14px", spacing: "md",
        contents: [
          { type: "text", text: "📱 เมนูหลัก (Rich Menu)", weight: "bold", size: "sm", color: "#3a0a20" },
          makeHelpRow("💧", "คลอรีน", "ดูค่า FRC แยกสูบส่ง/สูบจ่าย/Monitor"),
          makeHelpRow("🔍", "ค้นหาสถานที่", "พิมพ์ชื่อ → บินไปในแผนที่"),
          makeHelpRow("📍", "ใกล้ฉัน", "ส่งตำแหน่ง → เปิดแผนที่ปักหมุด"),
          makeHelpRow("🗺️", "แผนที่", "เปิด Contour Map เต็มจอ"),
          makeHelpRow("📊", "สรุปวัน", "สรุปประจำวันแบบผู้บริหาร"),
          makeHelpRow("📋", "ตาราง", "ตาราง FRC แยกตามเขตรับน้ำ"),
          { type: "separator" },
          { type: "text", text: "⌨️ คำสั่งเพิ่มเติม", weight: "bold", size: "sm", color: "#3a0a20" },
          makeHelpRow("📋", "สรุป", "รายงานสรุปทุกสถานี"),
          makeHelpRow("🔴", "สถานีต่ำ", "ดูสถานีที่ค่าต่ำกว่าเกณฑ์"),
          makeHelpRow("🔍", "หา [ชื่อ]", "ค้นหาสถานีในระบบ"),
          makeHelpRow("🏭", "ดูสูบส่ง", "รายละเอียดสถานีสูบส่ง"),
          makeHelpRow("💧", "ดูสูบจ่าย", "รายละเอียดสถานีสูบจ่าย"),
          makeHelpRow("📡", "ดู monitor", "รายละเอียดสถานี Monitor"),
          { type: "separator" },
          { type: "text", text: "🔔 แจ้งเตือนอัตโนมัติ", weight: "bold", size: "xs", color: "#3a0a20" },
          { type: "text", text: "ตรวจค่าทุก 10 นาที · แจ้งเมื่อผิดปกติ", size: "xxs", color: "#999999", wrap: true },
          { type: "text", text: "สูบส่ง: ต่ำ<0.2 ระวัง<1.0 สูง>3.0 มก/ล.", size: "xxs", color: "#999999", wrap: true },
          { type: "text", text: "สูบจ่าย: ต่ำ<0.2 ระวัง<0.8 สูง>2.0 มก/ล.", size: "xxs", color: "#999999", wrap: true },
          { type: "text", text: "Monitor: ต่ำ<0.2 ระวัง<0.4 สูง>2.0 มก/ล.", size: "xxs", color: "#999999", wrap: true }
        ]
      },
      footer: {
        type: "box", layout: "horizontal", paddingAll: "10px", spacing: "sm",
        contents: [
          { type: "button", action: { type: "message", label: "คลอรีน", text: "คลอรีน" }, style: "primary", color: "#cc0055", height: "sm", flex: 1 },
          { type: "button", action: { type: "message", label: "สรุปวัน", text: "สรุปวัน" }, style: "secondary", height: "sm", flex: 1 }
        ]
      }
    }
  }]);
}

function makeHelpRow(emoji, cmd, desc) {
  return {
    type: "box", layout: "horizontal", spacing: "md",
    contents: [
      { type: "text", text: emoji, size: "md", flex: 0 },
      { type: "text", text: `"${cmd}"`, size: "sm", weight: "bold", color: "#cc0055", flex: 2 },
      { type: "text", text: desc, size: "xs", color: "#666666", flex: 5, wrap: true }
    ]
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Webhook Endpoint
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ตอบ LINE ทันที

  const events = req.body.events || [];
  for (const event of events) {
    try {
      // เก็บ userId / groupId สำหรับ Push Message
      const source = event.source;
      if (source) {
        const targetId = source.groupId || source.roomId || source.userId;
        if (targetId) NOTIFY_TARGETS.add(targetId);
      }

      if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(event.replyToken, event.message.text, source?.userId);
      }

      if (event.type === 'message' && event.message.type === 'location') {
        const { latitude, longitude } = event.message;
        await handleLocationMessage(event.replyToken, latitude, longitude);
      }

      if (event.type === 'follow') {
        await lineReply(event.replyToken, [{
          type: 'text',
          text: '🌸 ยินดีต้อนรับสู่ FRC Chlorine Bot!\n\nพิมพ์ "คลอรีน" เพื่อดูค่า FRC ปัจจุบัน\nหรือพิมพ์ "help" เพื่อดูคำสั่งทั้งหมด\n\n🔔 Bot จะแจ้งเตือนอัตโนมัติเมื่อค่าผิดปกติ'
        }]);
      }
    } catch (err) {
      console.error('[Webhook Error]', err.message);
    }
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    bot: 'FRC Chlorine LINE Bot',
    time: new Date().toISOString(),
    targets: NOTIFY_TARGETS.size
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cron Jobs
// ═══════════════════════════════════════════════════════════════════════════════

// ตรวจค่าผิดปกติทุก 5 นาที
cron.schedule('*/5 * * * *', () => {
  console.log(`[Cron] ตรวจ FRC alert — ${new Date().toISOString()}`);
  checkAlerts();
}, { timezone: 'Asia/Bangkok' });

// สรุปรายงานประจำวัน 08:00 และ 17:00
cron.schedule('0 8,17 * * *', () => {
  console.log(`[Cron] ส่งรายงานประจำวัน — ${new Date().toISOString()}`);
  sendDailyReport();
}, { timezone: 'Asia/Bangkok' });

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FRC Chlorine LINE Bot running on port ${PORT}`);
  console.log(`   Webhook URL: https://frc-line-bot-production.up.railway.app/webhook`);
  console.log(`   LINE Token: ${LINE_TOKEN.substring(0, 10)}...`);
});
