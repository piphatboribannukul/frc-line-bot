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

// Thresholds (ตรงกับ HTML ต้นฉบับ)
const FRC_MIN = 0.2;   // mg/L — ต่ำกว่านี้ = แจ้งเตือน
const FRC_HI  = 1.0;   // mg/L — สูงกว่านี้ = ดี

// Group ID / User IDs ที่จะรับแจ้งเตือน (เพิ่มจาก webhook follow event)
let NOTIFY_TARGETS = new Set();
// เก็บ state ว่าแจ้งเตือนไปแล้วหรือยัง (ป้องกันส่งซ้ำ)
let alertedStations = {};

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

/** สถานะ FRC → emoji + label */
function frcStatus(frc) {
  if (frc >= FRC_HI)  return { emoji: '🟢', label: 'ดี', color: '#00C853' };
  if (frc >= FRC_MIN) return { emoji: '🟡', label: 'ผ่าน', color: '#FFD600' };
  return { emoji: '🔴', label: 'ต่ำ', color: '#FF1744' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: แจ้งเตือนเมื่อ FRC ผิดปกติ (Push Message — ตรวจทุก 5 นาที)
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAlerts() {
  const sensors = await fetchSensors();
  if (!sensors.length) return;

  const lowStations  = sensors.filter(s => s.frc < FRC_MIN && s.frc > 0);
  const highStations = sensors.filter(s => s.frc > 2.0);

  const alertList = [];

  for (const s of lowStations) {
    const key = `${s.id}_low`;
    if (!alertedStations[key]) {
      alertedStations[key] = Date.now();
      alertList.push({ ...s, alertType: 'ต่ำ' });
    }
  }
  for (const s of highStations) {
    const key = `${s.id}_high`;
    if (!alertedStations[key]) {
      alertedStations[key] = Date.now();
      alertList.push({ ...s, alertType: 'สูง' });
    }
  }

  // ล้าง alert ที่เก่ากว่า 1 ชม.
  const cutoff = Date.now() - 3600000;
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
    const st = frcStatus(s.frc);
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
            { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L (${s.alertType})`, size: "xs", color: st.color }
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

  // สร้าง bar chart ด้วย box
  const barTotal = good + mid + low;
  const barContents = [];
  if (good > 0) barContents.push({ type: "box", layout: "vertical", flex: good, height: "8px", backgroundColor: "#00C853", cornerRadius: "4px" });
  if (mid > 0)  barContents.push({ type: "box", layout: "vertical", flex: mid,  height: "8px", backgroundColor: "#FFD600", cornerRadius: "4px" });
  if (low > 0)  barContents.push({ type: "box", layout: "vertical", flex: low,  height: "8px", backgroundColor: "#FF1744", cornerRadius: "4px" });

  const bodyContents = [
    { type: "text", text: `📊 สรุปค่าคลอรีน`, weight: "bold", size: "lg", color: "#1a1a2e" },
    { type: "text", text: `${thaiDate()} เวลา ${thaiTime()}`, size: "xs", color: "#999999", margin: "sm" },
    { type: "separator", margin: "lg" },
    // Bar chart
    {
      type: "box",
      layout: "horizontal",
      margin: "lg",
      height: "8px",
      cornerRadius: "4px",
      contents: barContents.length ? barContents : [{ type: "filler" }]
    },
    // Legend
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      contents: [
        { type: "text", text: `🟢 ดี ${good} (${pctGood}%)`, size: "xxs", color: "#00C853", flex: 1 },
        { type: "text", text: `🟡 ผ่าน ${mid} (${pctMid}%)`, size: "xxs", color: "#B8860B", flex: 1 },
        { type: "text", text: `🔴 ต่ำ ${low} (${pctLow}%)`, size: "xxs", color: "#FF1744", flex: 1 }
      ]
    },
    { type: "separator", margin: "lg" },
    // Stats
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      spacing: "sm",
      contents: [
        makeStatRow("สถานีทั้งหมด", `${total} สถานี`),
        makeStatRow("ค่าเฉลี่ย FRC", `${avgFrc} mg/L`),
        makeStatRow("สูงสุด", `${maxS.frc.toFixed(2)} mg/L — ${maxS.name.substring(0, 20)}`),
        makeStatRow("ต่ำสุด",  `${minS.frc.toFixed(2)} mg/L — ${minS.name.substring(0, 20)}`),
      ]
    }
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
  const msg = text.trim().toLowerCase();

  // ── คำสั่ง: ค่าคลอรีน / frc / สถานะ
  if (/^(คลอรีน|ค่าคลอรีน|frc|สถานะ|status|ค่า frc|ค่าน้ำ)$/i.test(msg)) {
    return replyCurrentStatus(replyToken);
  }

  // ── คำสั่ง: สรุป / รายงาน
  if (/^(สรุป|รายงาน|report|สรุปทั้งหมด|summary)$/i.test(msg)) {
    return replyFullReport(replyToken);
  }

  // ── คำสั่ง: สถานีต่ำ / alert
  if (/^(ต่ำ|สถานีต่ำ|low|alert|แจ้งเตือน|ผิดปกติ)$/i.test(msg)) {
    return replyLowStations(replyToken);
  }

  // ── คำสั่ง: ค้นหาสถานี
  if (/^(ค้น|หา|search) .+/i.test(msg)) {
    const query = msg.replace(/^(ค้น|หา|search)\s*/i, '');
    return replySearchStation(replyToken, query);
  }

  // ── คำสั่ง: help
  if (/^(help|ช่วย|วิธีใช้|คำสั่ง|menu|เมนู|\?)$/i.test(msg)) {
    return replyHelp(replyToken);
  }

  // ── ไม่ตรงคำสั่ง → แนะนำ
  return replyHelp(replyToken);
}

async function replyCurrentStatus(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) {
    return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้ กรุณาลองใหม่' }]);
  }

  const total = sensors.length;
  const good  = sensors.filter(s => s.frc >= FRC_HI).length;
  const mid   = sensors.filter(s => s.frc >= FRC_MIN && s.frc < FRC_HI).length;
  const low   = sensors.filter(s => s.frc < FRC_MIN).length;
  const avgFrc = (sensors.reduce((a, s) => a + s.frc, 0) / total).toFixed(2);

  const flexMsg = {
    type: "flex",
    altText: `ค่า FRC: เฉลี่ย ${avgFrc} mg/L — ดี ${good} / ผ่าน ${mid} / ต่ำ ${low}`,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "💧 ค่าคลอรีนตอนนี้", weight: "bold", size: "md", color: "#3a0a20" },
          { type: "text", text: `${thaiTime()} น.`, size: "xs", color: "#999999", margin: "sm" },
          { type: "separator", margin: "md" },
          {
            type: "box", layout: "horizontal", margin: "lg", spacing: "md",
            contents: [
              makeCountBox("🟢 ดี", good, "#00C853"),
              makeCountBox("🟡 ผ่าน", mid, "#FFD600"),
              makeCountBox("🔴 ต่ำ", low, "#FF1744"),
            ]
          },
          { type: "separator", margin: "md" },
          makeStatRow("สถานีทั้งหมด", `${total}`),
          makeStatRow("FRC เฉลี่ย", `${avgFrc} mg/L`),
        ]
      },
      footer: {
        type: "box", layout: "horizontal", paddingAll: "10px", spacing: "sm",
        contents: [
          { type: "button", action: { type: "message", label: "📋 สรุปทั้งหมด", text: "สรุปทั้งหมด" }, height: "sm", style: "primary", color: "#cc0055", flex: 1 },
          { type: "button", action: { type: "message", label: "🔴 สถานีต่ำ", text: "สถานีต่ำ" }, height: "sm", style: "secondary", flex: 1 }
        ]
      }
    }
  };

  return lineReply(replyToken, [flexMsg]);
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
          { type: "text", text: `🔴 สถานี FRC ต่ำ (${lowList.length} สถานี)`, color: "#fff", weight: "bold", size: "md" },
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
  const results = sensors.filter(s =>
    s.name.toLowerCase().includes(query) ||
    String(s.id).toLowerCase().includes(query) ||
    (s.area || '').toLowerCase().includes(query) ||
    (s.branch || '').toLowerCase().includes(query)
  ).slice(0, 5);

  if (results.length === 0) {
    return lineReply(replyToken, [{ type: 'text', text: `🔍 ไม่พบสถานี "${query}"\n\nลองพิมพ์ชื่อย่อ เช่น:\n• หา บางเขน\n• หา สมุทรปราการ\n• หา SP01` }]);
  }

  const rows = results.map(s => {
    const st = frcStatus(s.frc);
    return {
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
        }
      ]
    };
  });

  return lineReply(replyToken, [{
    type: "flex",
    altText: `🔍 ผลค้นหา "${query}" — ${results.length} สถานี`,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: "#3a0a20", paddingAll: "14px",
        contents: [
          { type: "text", text: `🔍 ผลค้นหา "${query}"`, color: "#fff", weight: "bold", size: "md", wrap: true },
          { type: "text", text: `พบ ${results.length} สถานี`, color: "#ffccdd", size: "xs", margin: "sm" }
        ]
      },
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows }
    }
  }]);
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
          { type: "text", text: "💧 FRC Chlorine Bot", color: "#fff", weight: "bold", size: "lg" },
          { type: "text", text: "ระบบติดตามค่าคลอรีนอัตโนมัติ", color: "#ffccdd", size: "xs", margin: "sm" }
        ]
      },
      body: {
        type: "box", layout: "vertical", paddingAll: "16px", spacing: "lg",
        contents: [
          { type: "text", text: "📖 คำสั่งที่ใช้ได้:", weight: "bold", size: "md", color: "#3a0a20" },
          makeHelpRow("💧", "คลอรีน", "ดูค่า FRC ปัจจุบัน"),
          makeHelpRow("📋", "สรุป", "รายงานสรุปทุกสถานี"),
          makeHelpRow("🔴", "สถานีต่ำ", "ดูสถานีที่ค่าต่ำ"),
          makeHelpRow("🔍", "หา [ชื่อ]", "ค้นหาสถานี เช่น 'หา บางเขน'"),
          { type: "separator" },
          { type: "text", text: "🔔 Bot จะแจ้งเตือนอัตโนมัติเมื่อค่าคลอรีนต่ำ/สูงผิดปกติ และส่งสรุปรายงานทุกวัน 08:00 / 17:00", size: "xxs", color: "#999999", wrap: true }
        ]
      },
      footer: {
        type: "box", layout: "horizontal", paddingAll: "10px", spacing: "sm",
        contents: [
          { type: "button", action: { type: "message", label: "💧 ค่าตอนนี้", text: "คลอรีน" }, style: "primary", color: "#cc0055", height: "sm", flex: 1 },
          { type: "button", action: { type: "message", label: "📋 สรุป", text: "สรุป" }, style: "secondary", height: "sm", flex: 1 }
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
  console.log(`   Webhook URL: https://your-domain.com/webhook`);
  console.log(`   LINE Token: ${LINE_TOKEN.substring(0, 10)}...`);
});
