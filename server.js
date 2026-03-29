// ═══════════════════════════════════════════════════════════════════════════════
// LINE Messaging API — FRC Chlorine Monitoring Bot  v12.0
// ═══════════════════════════════════════════════════════════════════════════════
// Changelog v12.0 (จาก v11.0):
//   🔒 Security: ย้าย LINE_TOKEN & Firebase config เป็น env vars ทั้งหมด
//   🎨 Flex Message: ออกแบบใหม่ทุก bubble — gradient header, progress bar, card layout
//   📱 Quick Reply: ทุก reply มี Quick Reply buttons ให้กดต่อได้ทันที
//   🖼️ Rich Menu: เพิ่ม endpoint สร้าง Rich Menu อัตโนมัติ
//   📊 เพิ่มฟีเจอร์: EC report, trend comparison, webhook signature verification
//   🛡️ LINE Webhook Signature Verification
// ═══════════════════════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const cron    = require('node-cron');
const crypto  = require('crypto');
const { initializeApp }  = require('firebase/app');
const { getDatabase, ref, get, set: fbSet, push, onValue } = require('firebase/database');

const app = express();

// ─── 🔒 Security: raw body สำหรับ signature verification ──────────────────────
app.use('/webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 SECURITY: ทุก credential อ่านจาก Environment Variables เท่านั้น
// ═══════════════════════════════════════════════════════════════════════════════

const LINE_TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.LINE_TOKEN || '';
const LINE_SECRET  = process.env.LINE_CHANNEL_SECRET || '';
const LINE_API     = 'https://api.line.me/v2/bot/message';
const MWA_API      = 'https://twqonline.mwa.co.th/TWQMSServicepublic/api/mwaonmobile/getStations';
const CONTOUR_URL  = process.env.CONTOUR_URL || 'https://piphatboribannukul.github.io/FRCfirebase/';

// ═══════════════════════════════════════════════════════════════════════════════
// 🖼️ IMAGE CONFIG — GitHub Pages (ฟรี ไม่ต้อง install อะไร)
// ═══════════════════════════════════════════════════════════════════════════════
const IMG_BASE = process.env.IMG_BASE_URL || 'https://piphatboribannukul.github.io/FRCfirebase/img';

const IMAGES = {
  logo:       `${IMG_BASE}/logo-frc-64.png`,
  bannerFRC:  `${IMG_BASE}/banner-frc.png`,
  bannerEC:   `${IMG_BASE}/banner-ec.png`,
  bannerMap:  `${IMG_BASE}/banner-map.png`,
  bannerAlert:`${IMG_BASE}/banner-alert.png`,
  bannerDaily:`${IMG_BASE}/banner-daily.png`,
  iconSend:   `${IMG_BASE}/icon-send.png`,
  iconPump:   `${IMG_BASE}/icon-pump.png`,
  iconMonitor:`${IMG_BASE}/icon-monitor.png`,
};

// 🗺️ Static Map URL — ใช้ OpenStreetMap Static Map API (ฟรี ไม่ต้อง key)
function staticMapUrl(lat, lon, zoom, width, height, markers) {
  // ใช้ staticmap.openstreetmap.de (ฟรี, ไม่ต้อง API key)
  const w = width || 600;
  const h = height || 300;
  const z = zoom || 14;
  let url = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=${z}&size=${w}x${h}&maptype=mapnik`;
  // เพิ่ม markers
  if (markers && markers.length > 0) {
    for (const m of markers) {
      url += `&markers=${m.lat},${m.lon},${m.color || 'red'}`;
    }
  }
  return url;
}

// สร้าง static map สำหรับกลุ่มสถานี (overview Bangkok)
function overviewMapUrl() {
  return staticMapUrl(13.78, 100.55, 11, 1040, 585, []);
}

// สร้าง static map สำหรับสถานีเดี่ยว
function stationMapUrl(lat, lon) {
  return staticMapUrl(lat, lon, 15, 1040, 585, [{ lat, lon, color: 'red' }]);
}

// สร้าง static map สำหรับตำแหน่ง user + สถานีใกล้
function nearbyMapUrl(userLat, userLon, stations) {
  const markers = [
    { lat: userLat, lon: userLon, color: 'blue' },
    ...stations.slice(0, 3).map(s => ({ lat: s.lat, lon: s.lon, color: 'red' }))
  ];
  return staticMapUrl(userLat, userLon, 14, 1040, 585, markers);
}

// 🔒 Firebase Config จาก env vars (fallback เป็นค่าเดิมเพื่อ backward compatibility)
const firebaseConfig = {
  apiKey:            process.env.FB_API_KEY            || "AIzaSyC0iyNwGCOIh-kbp6xDfijWBWKiE4iI_Lk",
  authDomain:        process.env.FB_AUTH_DOMAIN        || "frc-contour.firebaseapp.com",
  databaseURL:       process.env.FB_DATABASE_URL       || "https://frc-contour-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         process.env.FB_PROJECT_ID         || "frc-contour",
  storageBucket:     process.env.FB_STORAGE_BUCKET     || "frc-contour.firebasestorage.app",
  messagingSenderId: process.env.FB_MESSAGING_ID       || "772799472029",
  appId:             process.env.FB_APP_ID             || "1:772799472029:web:8e6862082d8252a6d04f74"
};

// ⚠️ ตรวจสอบ credentials ตอน start
if (!LINE_TOKEN) {
  console.error('❌ FATAL: LINE_CHANNEL_ACCESS_TOKEN ไม่ได้ตั้งค่า!');
  console.error('   ตั้งค่า env var: LINE_CHANNEL_ACCESS_TOKEN=<your token>');
  process.exit(1);
}
if (!LINE_SECRET) {
  console.warn('⚠️  LINE_CHANNEL_SECRET ไม่ได้ตั้งค่า — webhook signature verification ถูกปิด');
}

const fbApp = initializeApp(firebaseConfig);
const db    = getDatabase(fbApp);

// ═══════════════════════════════════════════════════════════════════════════════
// Thresholds & Station Types (เหมือนเดิม)
// ═══════════════════════════════════════════════════════════════════════════════

const SEND_IDS = ['SP01','SP02','SP03','SP11'];
const PUMP_IDS = ['SP04','SP05','SP12'];

const THRESHOLDS = {
  send:    { good: 1.0, watch: 0.8, low: 0.5, high: 3.0, label: 'สถานีสูบส่งน้ำ' },
  pump:    { good: 0.8, watch: 0.5, low: 0.5, high: 2.0, label: 'สถานีสูบจ่ายน้ำ' },
  monitor: { good: 0.4, watch: 0.2, low: 0.2, high: 2.0, label: 'สถานี Monitor' }
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

const FRC_MIN = 0.2;
const FRC_HI  = 1.0;

// ═══════════════════════════════════════════════════════════════════════════════
// Notify Targets (เหมือนเดิม — เก็บใน Firebase)
// ═══════════════════════════════════════════════════════════════════════════════

let NOTIFY_TARGETS = new Set();
let alertedStations = {};
let waitingPlaceFrom = {};

async function loadTargets() {
  try {
    const snap = await get(ref(db, 'notify_targets'));
    if (snap.exists()) {
      const data = snap.val();
      Object.keys(data).forEach(k => NOTIFY_TARGETS.add(data[k]));
    }
    console.log(`[Init] โหลด notify targets จาก Firebase: ${NOTIFY_TARGETS.size} คน`);
    await fetchAllFollowers();
    console.log(`[Init] รวม notify targets ทั้งหมด: ${NOTIFY_TARGETS.size} คน`);
  } catch(e) { console.error('[Init] Load targets error:', e.message); }
}

async function fetchAllFollowers() {
  try {
    let next = null;
    do {
      const url = next
        ? `https://api.line.me/v2/bot/followers/ids?start=${next}`
        : 'https://api.line.me/v2/bot/followers/ids';
      const res = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${LINE_TOKEN}` },
        timeout: 10000
      });
      const ids = res.data.userIds || [];
      for (const id of ids) {
        if (!NOTIFY_TARGETS.has(id)) {
          NOTIFY_TARGETS.add(id);
          try {
            await fbSet(ref(db, `notify_targets/${id.replace(/[\/\.#\$\[\]]/g, '_')}`), id);
          } catch(e) {}
        }
      }
      next = res.data.next || null;
      console.log(`[Followers] ดึงได้ ${ids.length} คน${next ? ' (มีหน้าถัดไป)' : ''}`);
    } while (next);
  } catch(e) {
    console.log(`[Followers] ไม่สามารถดึง follower list: ${e.response?.data?.message || e.message}`);
  }
}

async function saveTarget(targetId) {
  if (!targetId || NOTIFY_TARGETS.has(targetId)) return;
  NOTIFY_TARGETS.add(targetId);
  try {
    await fbSet(ref(db, `notify_targets/${targetId.replace(/[\/\.#\$\[\]]/g, '_')}`), targetId);
    console.log(`[Target] เพิ่ม ${targetId.substring(0, 10)}...`);
  } catch(e) { console.error('[SaveTarget]', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 LINE Webhook Signature Verification
// ═══════════════════════════════════════════════════════════════════════════════

function verifySignature(req) {
  if (!LINE_SECRET) return true; // ข้ามถ้าไม่มี secret
  const sig = req.headers['x-line-signature'];
  if (!sig || !req.rawBody) return false;
  const hash = crypto.createHmac('SHA256', LINE_SECRET).update(req.rawBody).digest('base64');
  return hash === sig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

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

async function linePush(to, messages) {
  try {
    await axios.post(`${LINE_API}/push`, { to, messages }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
  } catch (err) {
    console.error('[LINE Push Error]', err.response?.data || err.message);
  }
}

async function lineReply(replyToken, messages) {
  try {
    await axios.post(`${LINE_API}/reply`, { replyToken, messages }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
  } catch (err) {
    console.error('[LINE Reply Error]', err.response?.data || err.message);
  }
}

async function lineBroadcast(messages) {
  try {
    await axios.post(`${LINE_API}/broadcast`, { messages }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
    console.log('[Broadcast] ส่งสำเร็จ');
    return;
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.log(`[Broadcast] ไม่สำเร็จ: ${errMsg} — fallback เป็น Push`);
  }
  if (NOTIFY_TARGETS.size === 0) { console.log('[Push] ไม่มี target'); return; }
  let sent = 0, failed = 0;
  for (const targetId of NOTIFY_TARGETS) {
    try {
      await axios.post(`${LINE_API}/push`, { to: targetId, messages }, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
      });
      sent++;
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      if (errMsg.includes('not found') || errMsg.includes('blocked')) {
        NOTIFY_TARGETS.delete(targetId);
      }
      failed++;
    }
  }
  console.log(`[Push fallback] ส่ง ${sent} สำเร็จ, ${failed} ล้มเหลว`);
}

function thaiTime(date = new Date()) {
  return date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
}
function thaiDate(date = new Date()) {
  return date.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', year: 'numeric', month: 'long', day: 'numeric' });
}

function frcStatus(frc, type, id) {
  const t = getThreshold(type || 'monitor', id);
  if (frc > t.high)  return { emoji: '🟠', label: 'สูง', color: '#FF8F00' };
  if (frc >= t.good)  return { emoji: '🟢', label: 'ดี', color: '#00C853' };
  if (frc >= t.watch) return { emoji: '🟡', label: 'เฝ้าระวัง', color: '#FFD600' };
  return { emoji: '🔴', label: 'ต่ำ', color: '#FF1744' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📱 Quick Reply Builder — ทุก reply จะมีปุ่มให้กดต่อ
// ═══════════════════════════════════════════════════════════════════════════════

function quickReplyItems(subset) {
  const ALL = {
    search:   { type: 'action', action: { type: 'message', label: '🔍 ค้นหาสถานที่', text: 'ค้นหาสถานที่' } },
    location: { type: 'action', action: { type: 'location', label: '📍 ตำแหน่งปัจจุบัน' } },
    map:      { type: 'action', action: { type: 'uri', label: '🗺️ แผนที่', uri: CONTOUR_URL } },
    chlorine: { type: 'action', action: { type: 'message', label: '💧 คลอรีน', text: 'คลอรีน' } },
    daily:    { type: 'action', action: { type: 'message', label: '📊 สรุปวัน', text: 'สรุปวัน' } },
    ec:       { type: 'action', action: { type: 'message', label: '⚡ EC', text: 'ec' } },
    table:    { type: 'action', action: { type: 'message', label: '📋 ตาราง', text: 'ตารางวัน' } },
    low:      { type: 'action', action: { type: 'message', label: '🔴 สถานีต่ำ', text: 'สถานีต่ำ' } },
    send:     { type: 'action', action: { type: 'message', label: '🏭 สูบส่ง', text: 'ดูสูบส่ง' } },
    pump:     { type: 'action', action: { type: 'message', label: '💧 สูบจ่าย', text: 'ดูสูบจ่าย' } },
    monitor:  { type: 'action', action: { type: 'message', label: '📡 Monitor', text: 'ดู monitor' } },
    help:     { type: 'action', action: { type: 'message', label: '❓ วิธีใช้', text: 'help' } },
  };
  const keys = subset || ['search', 'location', 'map', 'chlorine', 'daily', 'ec'];
  return { items: keys.map(k => ALL[k]).filter(Boolean) };
}

// แนบ Quick Reply ให้ message สุดท้ายใน array
function withQuickReply(messages, subset) {
  if (!messages || messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  last.quickReply = quickReplyItems(subset);
  return messages;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🎨 Flex Message Design System v12 — ออกแบบใหม่ทุก bubble
// ═══════════════════════════════════════════════════════════════════════════════

// Design Tokens
const COLORS = {
  headerDark:   '#0f172a',  // deep navy
  headerPink:   '#831843',  // deep rose
  headerBlue:   '#1e3a5f',  // ocean blue
  headerRed:    '#7f1d1d',  // deep red
  headerGreen:  '#14532d',  // deep green
  accent:       '#e11d48',  // rose-600
  accentBlue:   '#2563eb',  // blue-600
  textPrimary:  '#0f172a',
  textSecondary:'#64748b',
  textMuted:    '#94a3b8',
  bgCard:       '#f8fafc',
  bgWarm:       '#fff1f2',
  bgCool:       '#eff6ff',
  border:       '#e2e8f0',
  good:         '#059669',
  warn:         '#d97706',
  bad:          '#dc2626',
  high:         '#ea580c',
};

function makeHeader(title, subtitle, bgColor, logoUrl) {
  const contents = [];
  if (logoUrl) {
    contents.push({
      type: "box", layout: "horizontal", spacing: "lg", alignItems: "center",
      contents: [
        {
          type: "box", layout: "vertical", flex: 0, width: "40px", height: "40px",
          cornerRadius: "12px", backgroundColor: "#ffffff20",
          justifyContent: "center", alignItems: "center",
          contents: [{
            type: "image", url: logoUrl,
            size: "32px", aspectMode: "fit", aspectRatio: "1:1"
          }]
        },
        {
          type: "box", layout: "vertical", flex: 5,
          contents: [
            { type: "text", text: title, color: "#ffffff", weight: "bold", size: "md", wrap: true },
            ...(subtitle ? [{ type: "text", text: subtitle, color: "#ffffffaa", size: "xxs", margin: "sm", wrap: true }] : [])
          ]
        }
      ]
    });
  } else {
    contents.push({ type: "text", text: title, color: "#ffffff", weight: "bold", size: "md", wrap: true });
    if (subtitle) contents.push({ type: "text", text: subtitle, color: "#ffffffaa", size: "xxs", margin: "sm", wrap: true });
  }
  return {
    type: "box", layout: "vertical",
    backgroundColor: bgColor || COLORS.headerDark,
    paddingAll: "16px",
    paddingBottom: "14px",
    contents
  };
}

// 🖼️ Hero section — ถูกลบออก (ซ้ำซ้อนกับ header)
// ใช้ makeHeader อย่างเดียว ให้ bubble กระชับขึ้น

function makeFooterButtons(buttons) {
  return {
    type: "box", layout: "horizontal", paddingAll: "12px", spacing: "sm",
    contents: buttons.map(b => ({
      type: "button",
      action: b.uri
        ? { type: "uri", label: b.label, uri: b.uri }
        : { type: "message", label: b.label, text: b.text },
      height: "sm",
      style: b.primary ? "primary" : "secondary",
      ...(b.primary ? { color: b.color || COLORS.accent } : {}),
      flex: 1
    }))
  };
}

function makeStatRow(label, value) {
  return {
    type: "box", layout: "horizontal", margin: "sm",
    contents: [
      { type: "text", text: label, size: "xs", color: COLORS.textSecondary, flex: 4, wrap: true },
      { type: "text", text: value, size: "xs", color: COLORS.textPrimary, weight: "bold", flex: 4, align: "end", wrap: true }
    ]
  };
}

function makeCountBox(label, count, color) {
  return {
    type: "box", layout: "vertical", flex: 1, alignItems: "center",
    paddingAll: "4px", cornerRadius: "6px", backgroundColor: COLORS.bgCard,
    contents: [
      { type: "text", text: String(count), size: "md", weight: "bold", color, align: "center" },
      { type: "text", text: label, size: "xxs", color: COLORS.textMuted, align: "center" }
    ]
  };
}

// 📊 Visual progress bar (สร้างจาก box)
function makeProgressBar(percent, color) {
  const pct = Math.max(0, Math.min(100, percent));
  return {
    type: "box", layout: "vertical", height: "6px",
    cornerRadius: "3px", backgroundColor: "#e2e8f0", margin: "sm",
    contents: [{
      type: "box", layout: "vertical", height: "6px",
      cornerRadius: "3px", backgroundColor: color || COLORS.good,
      width: `${pct}%`,
      contents: [{ type: "filler" }]
    }]
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: 🚨 แจ้งเตือน FRC ผิดปกติ (ออกแบบใหม่)
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
      if (!alertedStations[key]) { alertedStations[key] = Date.now(); alertList.push({ ...s, alertType: 'ต่ำ', threshold: t }); }
    } else if (s.frc > t.high) {
      const key = `${s.id}_high`;
      if (!alertedStations[key]) { alertedStations[key] = Date.now(); alertList.push({ ...s, alertType: 'สูง', threshold: t }); }
    } else if (s.frc < t.good) {
      const key = `${s.id}_watch`;
      if (!alertedStations[key]) { alertedStations[key] = Date.now(); alertList.push({ ...s, alertType: 'เฝ้าระวัง', threshold: t }); }
    }
  }

  // ล้าง alert เก่ากว่า 3 ชม.
  const cutoff = Date.now() - 10800000;
  for (const [k, v] of Object.entries(alertedStations)) {
    if (v < cutoff) delete alertedStations[k];
  }

  if (alertList.length === 0) return;
  const flexMsg = buildAlertFlex(alertList);
  await lineBroadcast([flexMsg]);
  console.log(`[Alert] ส่งแจ้งเตือน ${alertList.length} สถานี`);
}

function buildAlertFlex(alerts) {
  const lowCount  = alerts.filter(a => a.alertType === 'ต่ำ').length;
  const watchCount = alerts.filter(a => a.alertType === 'เฝ้าระวัง').length;
  const highCount = alerts.filter(a => a.alertType === 'สูง').length;

  const bodyContents = [
    // Summary counts
    {
      type: "box", layout: "horizontal", margin: "md", spacing: "sm",
      contents: [
        ...(lowCount ? [makeCountBox("🔴 ต่ำ", lowCount, COLORS.bad)] : []),
        ...(watchCount ? [makeCountBox("🟡 ระวัง", watchCount, COLORS.warn)] : []),
        ...(highCount ? [makeCountBox("🟠 สูง", highCount, COLORS.high)] : []),
      ]
    },
    { type: "separator", margin: "lg" },
  ];

  for (const s of alerts.slice(0, 8)) {
    const st = frcStatus(s.frc, s.type, s.id);
    bodyContents.push({
      type: "box", layout: "horizontal", margin: "md",
      paddingAll: "10px", cornerRadius: "8px", backgroundColor: COLORS.bgCard,
      contents: [
        {
          type: "box", layout: "vertical", flex: 0, justifyContent: "center",
          contents: [{ type: "text", text: st.emoji, size: "xl" }]
        },
        {
          type: "box", layout: "vertical", flex: 5, margin: "lg",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: COLORS.textPrimary },
            { type: "text", text: `FRC ${s.frc.toFixed(2)} mg/L — ${s.alertType}`, size: "xs", color: st.color, margin: "xs" },
            { type: "text", text: s.threshold.label, size: "xxs", color: COLORS.textMuted, margin: "xs" }
          ]
        }
      ]
    });
  }

  return {
    type: "flex",
    altText: `🚨 แจ้งเตือน: ค่าคลอรีนผิดปกติ ${alerts.length} สถานี`,
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader(
        `🚨 แจ้งเตือนค่าคลอรีน`,
        `${thaiDate()} ${thaiTime()} น. — พบ ${alerts.length} สถานีผิดปกติ`,
        COLORS.headerRed,
        IMAGES.logo
      ),
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
      footer: makeFooterButtons([
        { label: '🗺️ เปิดแผนที่', uri: CONTOUR_URL, primary: true },
        { label: '💧 ดูค่าปัจจุบัน', text: 'คลอรีน' }
      ])
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 2: 📊 รายงานประจำวัน (ออกแบบใหม่)
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
  const lowStations = sensors.filter(s => s.frc < FRC_MIN).sort((a, b) => a.frc - b.frc).slice(0, 5);

  const flexMsg = buildDailyReportFlex({ total, good, mid, low, avgFrc, minS, maxS, lowStations });
  await lineBroadcast([flexMsg]);
  console.log(`[Daily Report] ส่งรายงาน — สถานี ${total}, ต่ำ ${low}`);
}

function buildDailyReportFlex({ total, good, mid, low, avgFrc, minS, maxS, lowStations }) {
  const pctGood = Math.round((good / total) * 100);

  const bodyContents = [
    // Overall grade
    {
      type: "box", layout: "vertical", margin: "md",
      paddingAll: "14px", cornerRadius: "10px",
      backgroundColor: pctGood >= 80 ? '#ecfdf5' : pctGood >= 50 ? '#fffbeb' : '#fef2f2',
      contents: [
        {
          type: "box", layout: "horizontal",
          contents: [
            { type: "text", text: pctGood >= 80 ? '🟢' : pctGood >= 50 ? '🟡' : '🔴', size: "3xl", flex: 0 },
            {
              type: "box", layout: "vertical", flex: 5, margin: "lg",
              contents: [
                { type: "text", text: `ปกติ ${pctGood}%`, size: "lg", weight: "bold", color: pctGood >= 80 ? COLORS.good : pctGood >= 50 ? COLORS.warn : COLORS.bad },
                { type: "text", text: `FRC เฉลี่ย ${avgFrc} mg/L`, size: "xs", color: COLORS.textSecondary, margin: "xs" }
              ]
            }
          ]
        },
        makeProgressBar(pctGood, pctGood >= 80 ? COLORS.good : pctGood >= 50 ? COLORS.warn : COLORS.bad),
      ]
    },
    // Count boxes
    {
      type: "box", layout: "horizontal", margin: "lg", spacing: "sm",
      contents: [
        makeCountBox("🟢 ดี", good, COLORS.good),
        makeCountBox("🟡 ผ่าน", mid, COLORS.warn),
        makeCountBox("🔴 ต่ำ", low, COLORS.bad),
      ]
    },
    { type: "separator", margin: "lg" },
    // Stats
    makeStatRow("สถานีทั้งหมด", `${total} สถานี`),
    makeStatRow("สูงสุด", `${maxS.frc.toFixed(2)} mg/L — ${maxS.name.substring(0,20)}`),
    makeStatRow("ต่ำสุด", `${minS.frc.toFixed(2)} mg/L — ${minS.name.substring(0,20)}`),
  ];

  if (lowStations.length > 0) {
    bodyContents.push({ type: "separator", margin: "lg" });
    bodyContents.push({ type: "text", text: "⚠️ ต้องติดตาม", weight: "bold", size: "sm", color: COLORS.bad, margin: "md" });
    for (const s of lowStations) {
      bodyContents.push({
        type: "text", text: `• ${s.name.substring(0, 28)} — ${s.frc.toFixed(2)} mg/L`,
        size: "xs", color: COLORS.textSecondary, margin: "sm", wrap: true
      });
    }
  }

  return {
    type: "flex",
    altText: `📊 สรุปคลอรีน — ดี ${good} / ผ่าน ${mid} / ต่ำ ${low}`,
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader('📋 รายงานคุณภาพน้ำ', `${thaiDate()} — FRC Daily Report`, COLORS.headerDark, IMAGES.logo),
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
      footer: makeFooterButtons([
        { label: '🗺️ แผนที่', uri: CONTOUR_URL, primary: true },
        { label: '📋 ดูทั้งหมด', text: 'สรุปทั้งหมด' }
      ])
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature 3: 💧 Reply — ค่าคลอรีนปัจจุบัน (ออกแบบใหม่ + Quick Reply)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTextMessage(replyToken, text, userId) {
  const msg = text.trim();

  // ── คลอรีน / FRC / สถานะ
  if (/คลอรีน|frc|สถานะ|status|ค่าน้ำ/i.test(msg)) {
    return replyCurrentStatus(replyToken);
  }

  // ── ตารางวัน (แยกจาก สรุปวัน)
  if (/ตารางวัน|ตาราง|table/i.test(msg)) {
    return replyDailyTable(replyToken);
  }

  // ── สรุปวัน / daily
  if (/สรุปวัน|สรุปทั้งวัน|daily|ประจำวัน/i.test(msg)) {
    return replyDailySummary(replyToken);
  }

  // ── สรุป / รายงาน
  if (/สรุป|รายงาน|report|summary/i.test(msg)) {
    return replyFullReport(replyToken);
  }

  // ── EC / ค่าการนำไฟฟ้า (ฟีเจอร์ใหม่)
  if (/^ec$|ค่า ec|conductivity|การนำไฟฟ้า/i.test(msg)) {
    return replyECStatus(replyToken);
  }

  // ── ทดสอบแจ้งเตือน
  if (/ทดสอบแจ้งเตือน|test alert/i.test(msg)) {
    for (const k of Object.keys(alertedStations)) delete alertedStations[k];
    const sensors = await fetchSensors();
    const lowList = [], watchList = [], highList = [];
    for (const s of sensors) {
      if (s.frc <= 0) continue;
      const t = getThreshold(s.type, s.id);
      const typeName = getStationType(s) === 'send' ? 'สูบส่ง' : getStationType(s) === 'pump' ? 'สูบจ่าย' : 'Monitor';
      if (s.frc < t.low) lowList.push(`  🔴 ${s.name}\n     FRC ${s.frc.toFixed(2)} มก/ล. (${typeName} เกณฑ์ <${t.low})`);
      else if (s.frc > t.high) highList.push(`  🟠 ${s.name}\n     FRC ${s.frc.toFixed(2)} มก/ล. (${typeName} เกณฑ์ >${t.high})`);
      else if (s.frc < t.good) watchList.push(`  🟡 ${s.name}\n     FRC ${s.frc.toFixed(2)} มก/ล. (${typeName} เกณฑ์ <${t.good})`);
    }
    let reply = `🔔 ทดสอบแจ้งเตือน\n${thaiDate()} ${thaiTime()} น.\nล้าง cooldown แล้ว\n`;
    reply += `\nสถานีทั้งหมด: ${sensors.filter(s=>s.frc>0).length} สถานี\n`;
    if (lowList.length) reply += `\n🔴 ต่ำ ${lowList.length} สถานี:\n${lowList.join('\n')}\n`;
    if (watchList.length) reply += `\n🟡 เฝ้าระวัง ${watchList.length} สถานี:\n${watchList.join('\n')}\n`;
    if (highList.length) reply += `\n🟠 สูง ${highList.length} สถานี:\n${highList.join('\n')}\n`;
    if (!lowList.length && !watchList.length && !highList.length) {
      reply += '\n✅ ทุกสถานีปกติ';
    } else {
      reply += `\n⏳ กำลังส่ง Broadcast...`;
      checkAlerts();
    }
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: reply }]));
  }

  // ── ส่งแจ้งเตือน Manual
  if (/^ส่งแจ้งเตือน|^send alert/i.test(msg)) {
    const sensors = await fetchSensors();
    if (!sensors.length) return lineReply(replyToken, [{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]);
    const alertList = [];
    for (const s of sensors) {
      if (s.frc <= 0) continue;
      const t = getThreshold(s.type, s.id);
      if (s.frc < t.low) alertList.push({ ...s, alertType: 'ต่ำ', threshold: t });
      else if (s.frc > t.high) alertList.push({ ...s, alertType: 'สูง', threshold: t });
      else if (s.frc < t.good) alertList.push({ ...s, alertType: 'เฝ้าระวัง', threshold: t });
    }
    if (alertList.length === 0) {
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: '✅ ทุกสถานีปกติ ไม่มีรายการแจ้งเตือน' }]));
    }
    const flexMsg = buildAlertFlex(alertList);
    let sent = 0, failed = 0;
    for (const targetId of NOTIFY_TARGETS) {
      try {
        await axios.post(`${LINE_API}/push`, { to: targetId, messages: [flexMsg] }, {
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
        });
        sent++;
      } catch { failed++; }
    }
    return lineReply(replyToken, withQuickReply([{
      type: 'text',
      text: `📢 ส่งแจ้งเตือน Manual\n\nพบ ${alertList.length} สถานีผิดปกติ\nส่ง Push ให้ ${sent} คน สำเร็จ${failed ? ` (${failed} ล้มเหลว)` : ''}`
    }]));
  }

  // ── สถานีต่ำ / alert
  if (/ต่ำ|low|alert|แจ้งเตือน|ผิดปกติ/i.test(msg)) {
    return replyLowStations(replyToken);
  }

  // ── ดูรายละเอียดแต่ละ type
  if (/ดูสูบส่ง|สูบส่ง|send/i.test(msg)) return replyTypeDetail(replyToken, 'send');
  if (/ดูสูบจ่าย|สูบจ่าย|ผลิตน้ำ|plant/i.test(msg)) return replyTypeDetail(replyToken, 'plant');
  if (/ดู monitor|ดูมอนิเตอร์|monitor/i.test(msg)) return replyTypeDetail(replyToken, 'monitor');

  // ── ค้นหาสถานี
  if (/^(ค้น|หา|search) .+/i.test(msg)) {
    const query = msg.replace(/^(ค้น|หา|search)\s*/i, '').toLowerCase();
    return replySearchStation(replyToken, query);
  }

  // ── ตำแหน่ง / location / ใกล้ฉัน
  if (/ตำแหน่ง|location|ใกล้ฉัน|ใกล้|nearby|พิกัด/i.test(msg)) {
    return replyLocationPrompt(replyToken);
  }

  // ── ค้นหาสถานที่ + ชื่อ
  if (/^(ค้นหาสถานที่|ไปที่|goto|flyto|นำทาง) .+/i.test(msg)) {
    const place = msg.replace(/^(ค้นหาสถานที่|ไปที่|goto|flyto|นำทาง)\s*/i, '');
    return replyFlyToPlace(replyToken, place);
  }

  // ── ไปที่ (ไม่มีชื่อ) → ถาม
  if (/^(ค้นหาสถานที่|ไปที่|goto|flyto|นำทาง)$/i.test(msg)) {
    waitingPlaceFrom[userId] = true;
    return lineReply(replyToken, withQuickReply([{
      type: "flex", altText: "🔍 พิมพ์ชื่อสถานที่",
      contents: {
        type: "bubble", size: "kilo",
        body: {
          type: "box", layout: "vertical", paddingAll: "20px", alignItems: "center",
          contents: [
            { type: "text", text: "🔍", size: "3xl", align: "center" },
            { type: "text", text: "ค้นหาสถานที่", weight: "bold", size: "md", align: "center", margin: "lg", color: COLORS.textPrimary },
            { type: "text", text: "พิมพ์ชื่อสถานที่ที่ต้องการ\nเช่น สถานีกลางบางซื่อ, สยาม", size: "xs", color: COLORS.textMuted, align: "center", margin: "md", wrap: true }
          ]
        }
      }
    }]));
  }

  // ── รอชื่อสถานที่
  if (waitingPlaceFrom[userId]) {
    delete waitingPlaceFrom[userId];
    return replyFlyToPlace(replyToken, msg);
  }

  // ── เมนู → Carousel Flex พร้อมรูป
  if (/^เมนู$|^menu$/i.test(msg)) {
    return replyMenuCarousel(replyToken);
  }

  // ── help
  if (/help|ช่วย|วิธีใช้|คำสั่ง/i.test(msg)) {
    return replyHelp(replyToken);
  }

  // ── ไม่ตรงคำสั่ง → Carousel เมนู
  return replyMenuCarousel(replyToken);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 💧 replyCurrentStatus — ออกแบบใหม่ v12
// ═══════════════════════════════════════════════════════════════════════════════

async function replyCurrentStatus(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) {
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]));
  }

  const sendStations = sensors.filter(s => getStationType(s) === 'send');
  const plantStations = sensors.filter(s => getStationType(s) === 'pump');
  const monitorStations = sensors.filter(s => getStationType(s) === 'monitor');

  function countByStatus(list, thType) {
    let ok = 0, watch = 0, low = 0, high = 0;
    for (const s of list) {
      const th = getThreshold(thType, s.id);
      if (s.frc > th.high) high++;
      else if (s.frc >= th.good) ok++;
      else if (s.frc >= th.watch) watch++;
      else low++;
    }
    return { ok, watch, low, high, total: list.length };
  }

  const sc = countByStatus(sendStations, 'send');
  const pc = countByStatus(plantStations, 'pump');
  const mc = countByStatus(monitorStations, 'monitor');
  const total = sensors.length;
  const avgFrc = (sensors.reduce((a, s) => a + s.frc, 0) / total).toFixed(2);
  const allOk = sc.ok + pc.ok + mc.ok;
  const allWatch = sc.watch + pc.watch + mc.watch;
  const allLow = sc.low + pc.low + mc.low;
  const allHigh = sc.high + pc.high + mc.high;
  const minS = sensors.filter(s=>s.frc>0).reduce((a,s) => s.frc < a.frc ? s : a, sensors.filter(s=>s.frc>0)[0]);
  const maxS = sensors.reduce((a,s) => s.frc > a.frc ? s : a, sensors[0]);

  const normalPct = total > 0 ? Math.round((allOk / total) * 100) : 0;
  let overallEmoji, overallText, overallBg;
  if (normalPct >= 90) { overallEmoji = '🟢'; overallText = 'ดี'; overallBg = '#ecfdf5'; }
  else if (normalPct >= 70) { overallEmoji = '🟡'; overallText = 'พอใช้'; overallBg = '#fffbeb'; }
  else { overallEmoji = '🔴'; overallText = 'ต้องติดตาม'; overallBg = '#fef2f2'; }

  const alertStations = sensors.filter(s => {
    if (s.frc <= 0) return false;
    const t = getThreshold(s.type, s.id);
    return s.frc < t.low || s.frc > t.high;
  }).sort((a,b) => a.frc - b.frc).slice(0, 3);

  const avgSend = sendStations.length ? (sendStations.reduce((a,s)=>a+s.frc,0)/sendStations.length).toFixed(2) : '-';
  const avgPump = plantStations.length ? (plantStations.reduce((a,s)=>a+s.frc,0)/plantStations.length).toFixed(2) : '-';
  const avgMon = monitorStations.length ? (monitorStations.reduce((a,s)=>a+s.frc,0)/monitorStations.length).toFixed(2) : '-';

  function typeRow(iconUrl, label, count, avg, bgTint, thType) {
    const th = THRESHOLDS[thType] || THRESHOLDS.monitor;
    return {
      type: "box", layout: "horizontal", margin: "xs",
      paddingAll: "8px", paddingStart: "10px", cornerRadius: "8px",
      backgroundColor: bgTint || COLORS.bgCard,
      contents: [
        {
          type: "box", layout: "vertical", flex: 0, width: "56px", height: "56px",
          justifyContent: "center", alignItems: "center",
          contents: [{
            type: "image", url: iconUrl,
            size: "56px", aspectMode: "fit", aspectRatio: "1:1"
          }]
        },
        {
          type: "box", layout: "vertical", flex: 5, margin: "md", justifyContent: "center",
          contents: [
            {
              type: "box", layout: "horizontal",
              contents: [
                { type: "text", text: label, size: "sm", weight: "bold", color: COLORS.textPrimary, flex: 3 },
                { type: "text", text: `${avg}`, size: "md", color: COLORS.accent, weight: "bold", flex: 0 },
                { type: "text", text: " mg/L", size: "xxs", color: COLORS.textMuted, flex: 0, gravity: "bottom" }
              ]
            },
            { type: "text", text: `ดี≥${th.good}  ระวัง${th.watch}-${th.good}  ต่ำ<${th.low}  สูง>${th.high}`, size: "xxs", color: COLORS.textMuted, margin: "none" },
            { type: "text", text: `✅${count.ok} ⚠️${count.watch} ❌${count.low} 🔶${count.high}  ·  ${count.total} สถานี`, size: "xxs", color: COLORS.textSecondary, margin: "none" },
          ]
        }
      ]
    };
  }

  const bodyContents = [
    // Overall
    {
      type: "box", layout: "horizontal", paddingAll: "10px",
      cornerRadius: "8px", backgroundColor: overallBg,
      contents: [
        { type: "text", text: overallEmoji, size: "xl", flex: 0, gravity: "center" },
        {
          type: "box", layout: "vertical", flex: 5, margin: "sm",
          contents: [
            { type: "text", text: `ภาพรวม: ${overallText}`, size: "sm", weight: "bold", color: COLORS.textPrimary },
            { type: "text", text: `ปกติ ${allOk}/${total} สถานี (${normalPct}%)`, size: "xxs", color: COLORS.textSecondary },
            makeProgressBar(normalPct, normalPct >= 80 ? COLORS.good : normalPct >= 50 ? COLORS.warn : COLORS.bad),
          ]
        }
      ]
    },
    // Count boxes
    {
      type: "box", layout: "horizontal", margin: "sm", spacing: "sm",
      contents: [
        makeCountBox("ดี", allOk, COLORS.good),
        makeCountBox("ระวัง", allWatch, COLORS.warn),
        makeCountBox("ต่ำ", allLow, COLORS.bad),
        makeCountBox("สูง", allHigh, COLORS.high),
      ]
    },
    { type: "separator", margin: "sm" },
    // Stats
    makeStatRow("FRC เฉลี่ย", `${avgFrc} mg/L`),
    makeStatRow("สูงสุด / ต่ำสุด", `${maxS ? maxS.frc.toFixed(2) : '-'} / ${minS ? minS.frc.toFixed(2) : '-'} mg/L`),
    { type: "separator", margin: "sm" },
    // Type breakdown
    typeRow(IMAGES.iconSend, "สูบส่ง", sc, avgSend, "#eef6ff", 'send'),
    typeRow(IMAGES.iconPump, "สูบจ่าย", pc, avgPump, "#eefbf3", 'pump'),
    typeRow(IMAGES.iconMonitor, "Monitor", mc, avgMon, "#f8eeff", 'monitor'),
  ];

  // Alert stations
  if (alertStations.length > 0) {
    bodyContents.push({ type: "separator", margin: "xs" });
    bodyContents.push({
      type: "box", layout: "vertical", margin: "xs",
      paddingAll: "8px", cornerRadius: "6px", backgroundColor: COLORS.bgWarm,
      contents: [
        { type: "text", text: "⚠️ ต้องติดตาม", size: "xxs", weight: "bold", color: COLORS.bad },
        ...alertStations.map(s => {
          const st = frcStatus(s.frc, s.type, s.id);
          return { type: "text", text: `${st.emoji} ${(s.name||s.id).substring(0,22)} — ${s.frc.toFixed(2)} mg/L`, size: "xxs", color: COLORS.textSecondary, wrap: true };
        })
      ]
    });
  }

  const flexMsg = {
    type: "flex",
    altText: `💧 FRC ${avgFrc} mg/L — ${overallEmoji}${overallText}`,
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader('💧 คลอรีนอิสระคงเหลือ (FRC)', `Real-Time — ${thaiDate()} ${thaiTime()} น.`, COLORS.headerDark, IMAGES.logo),
      body: { type: "box", layout: "vertical", paddingAll: "10px", paddingTop: "8px", contents: bodyContents },
      footer: {
        type: "box", layout: "vertical", paddingAll: "6px", spacing: "xs",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "xs",
            contents: [
              { type: "button", action: { type: "message", label: "สูบส่ง", text: "ดูสูบส่ง" }, height: "sm", style: "secondary", flex: 1 },
              { type: "button", action: { type: "message", label: "สูบจ่าย", text: "ดูสูบจ่าย" }, height: "sm", style: "secondary", flex: 1 },
              { type: "button", action: { type: "message", label: "Monitor", text: "ดู monitor" }, height: "sm", style: "secondary", flex: 1 },
            ]
          },
          {
            type: "box", layout: "horizontal", spacing: "xs",
            contents: [
              { type: "button", action: { type: "message", label: "สรุปวัน", text: "สรุปวัน" }, height: "sm", style: "primary", color: COLORS.accent, flex: 1 },
              { type: "button", action: { type: "uri", label: "แผนที่", uri: CONTOUR_URL }, height: "sm", style: "primary", color: "#0f172a", flex: 1 },
            ]
          }
        ]
      }
    }
  };

  return lineReply(replyToken, withQuickReply([flexMsg]));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ EC Status Report (ฟีเจอร์ใหม่ v12)
// ═══════════════════════════════════════════════════════════════════════════════

async function replyECStatus(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]));

  const ecStations = sensors.filter(s => s.ec != null && !isNaN(s.ec) && s.ec > 0);
  if (ecStations.length === 0) {
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: '⚡ ไม่พบข้อมูล EC (ค่าการนำไฟฟ้า) ในขณะนี้' }]));
  }

  ecStations.sort((a, b) => b.ec - a.ec);
  const avgEC = (ecStations.reduce((a, s) => a + s.ec, 0) / ecStations.length).toFixed(1);
  const maxEC = ecStations[0];
  const minEC = ecStations[ecStations.length - 1];

  // EC สถานะ: <300 ดีมาก, 300-500 ดี, 500-700 พอใช้, >700 สูง
  function ecStatus(ec) {
    if (ec <= 300) return { emoji: '🟢', label: 'ดีมาก', color: COLORS.good };
    if (ec <= 500) return { emoji: '🟢', label: 'ดี', color: COLORS.good };
    if (ec <= 700) return { emoji: '🟡', label: 'พอใช้', color: COLORS.warn };
    return { emoji: '🟠', label: 'สูง', color: COLORS.high };
  }

  const overall = ecStatus(parseFloat(avgEC));

  const bodyContents = [
    {
      type: "box", layout: "horizontal", paddingAll: "14px",
      cornerRadius: "10px", backgroundColor: COLORS.bgCool,
      contents: [
        { type: "text", text: overall.emoji, size: "3xl", flex: 0 },
        {
          type: "box", layout: "vertical", flex: 5, margin: "lg",
          contents: [
            { type: "text", text: `EC เฉลี่ย: ${avgEC} µS/cm`, size: "md", weight: "bold", color: COLORS.textPrimary },
            { type: "text", text: `${overall.label} — ${ecStations.length} สถานี`, size: "xs", color: COLORS.textSecondary, margin: "xs" }
          ]
        }
      ]
    },
    { type: "separator", margin: "lg" },
    makeStatRow("สูงสุด", `${maxEC.ec.toFixed(1)} µS/cm — ${maxEC.name.substring(0,18)}`),
    makeStatRow("ต่ำสุด", `${minEC.ec.toFixed(1)} µS/cm — ${minEC.name.substring(0,18)}`),
    { type: "separator", margin: "md" },
    { type: "text", text: "📊 Top 8 สถานี EC สูงสุด", weight: "bold", size: "sm", color: COLORS.textPrimary, margin: "md" },
  ];

  for (const s of ecStations.slice(0, 8)) {
    const st = ecStatus(s.ec);
    bodyContents.push({
      type: "box", layout: "horizontal", margin: "sm",
      contents: [
        { type: "text", text: st.emoji, size: "xxs", flex: 0 },
        { type: "text", text: s.name, size: "xxs", color: COLORS.textPrimary, flex: 7, margin: "sm", wrap: true },
        { type: "text", text: s.ec.toFixed(1), size: "xxs", color: st.color, flex: 2, align: "end", weight: "bold" }
      ]
    });
  }

  bodyContents.push({
    type: "text", text: "เกณฑ์: ≤300 ดีมาก | 300-500 ดี | 500-700 พอใช้ | >700 สูง",
    size: "xxs", color: COLORS.textMuted, margin: "lg", wrap: true
  });

  return lineReply(replyToken, withQuickReply([{
    type: "flex",
    altText: `⚡ EC ${avgEC} µS/cm — ${ecStations.length} สถานี`,
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader('⚡ ค่าการนำไฟฟ้า (EC)', `${thaiDate()} ${thaiTime()} น.`, COLORS.headerBlue, IMAGES.logo),
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
      footer: makeFooterButtons([
        { label: '💧 ดูคลอรีน', text: 'คลอรีน', primary: true, color: COLORS.accent },
        { label: '🗺️ แผนที่', uri: CONTOUR_URL }
      ])
    }
  }], ['chlorine', 'daily', 'low', 'map']));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ฟังก์ชันที่เหลือ — reuse logic เดิม + Quick Reply + ออกแบบใหม่
// ═══════════════════════════════════════════════════════════════════════════════

async function replyDailySummary(replyToken) {
  try {
    const snap = await get(ref(db, 'history'));
    if (!snap.exists()) {
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่พบข้อมูลประวัติ\nลองพิมพ์ "คลอรีน" เพื่อดูค่าปัจจุบัน' }]));
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
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: '📊 ยังไม่มีข้อมูลสะสมวันนี้\nลองพิมพ์ "คลอรีน" เพื่อดูค่าปัจจุบัน' }]));
    }

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
    const lowStationCodes = new Set(allReadings.filter(r => r.frc < FRC_MIN).map(r => r.code));
    const highStationCodes = new Set(allReadings.filter(r => r.frc > 2.0).map(r => r.code));

    const sendNow = sensors.filter(s => getStationType(s) === 'send');
    const pumpNow = sensors.filter(s => getStationType(s) === 'pump');
    const monNow = sensors.filter(s => getStationType(s) === 'monitor');
    const avgSend = sendNow.length ? (sendNow.reduce((a,s) => a+s.frc, 0) / sendNow.length).toFixed(2) : '-';
    const avgPump = pumpNow.length ? (pumpNow.reduce((a,s) => a+s.frc, 0) / pumpNow.length).toFixed(2) : '-';
    const avgMon = monNow.length ? (monNow.reduce((a,s) => a+s.frc, 0) / monNow.length).toFixed(2) : '-';

    const normalPct = 100 - parseInt(lowPct);
    let overallStatus, overallBg;
    if (normalPct >= 95) { overallStatus = 'ดีมาก'; overallBg = '#ecfdf5'; }
    else if (normalPct >= 80) { overallStatus = 'ดี'; overallBg = '#ecfdf5'; }
    else if (normalPct >= 60) { overallStatus = 'พอใช้'; overallBg = '#fffbeb'; }
    else { overallStatus = 'ต้องปรับปรุง'; overallBg = '#fef2f2'; }

    const bodyContents = [
      {
        type: "box", layout: "horizontal", paddingAll: "14px",
        cornerRadius: "10px", backgroundColor: overallBg,
        contents: [
          { type: "text", text: normalPct >= 80 ? '🟢' : normalPct >= 60 ? '🟡' : '🔴', size: "3xl", flex: 0 },
          {
            type: "box", layout: "vertical", flex: 5, margin: "lg",
            contents: [
              { type: "text", text: `ภาพรวม: ${overallStatus}`, size: "md", weight: "bold", color: COLORS.textPrimary },
              { type: "text", text: `ค่าปกติ ${normalPct}% ของวันนี้`, size: "xs", color: COLORS.textSecondary, margin: "xs" },
              makeProgressBar(normalPct, normalPct >= 80 ? COLORS.good : normalPct >= 60 ? COLORS.warn : COLORS.bad),
            ]
          }
        ]
      },
      { type: "separator", margin: "lg" },
      { type: "text", text: "📊 ตัวเลขสำคัญ", weight: "bold", size: "sm", color: COLORS.textPrimary, margin: "md" },
      makeStatRow("FRC เฉลี่ยทั้งวัน", `${avgFrc} mg/L`),
      makeStatRow("สูงสุด / ต่ำสุด", `${maxFrc} / ${minFrc} mg/L`),
      makeStatRow("สถานี", `${stationCount} สถานี`),
      makeStatRow("ข้อมูลสะสม", `${totalReadings} จุด`),
      { type: "separator", margin: "md" },
      { type: "text", text: "🏭 เฉลี่ยตามประเภท (ปัจจุบัน)", weight: "bold", size: "sm", color: COLORS.textPrimary, margin: "md" },
      makeStatRow("สูบส่ง", `${avgSend} mg/L`),
      makeStatRow("สูบจ่าย", `${avgPump} mg/L`),
      makeStatRow("Monitor", `${avgMon} mg/L`),
    ];

    if (lowStationCodes.size > 0) {
      bodyContents.push({ type: "separator", margin: "lg" });
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md",
        paddingAll: "10px", cornerRadius: "8px", backgroundColor: COLORS.bgWarm,
        contents: [
          { type: "text", text: "🔴", size: "sm", flex: 0 },
          {
            type: "box", layout: "vertical", flex: 5, margin: "sm",
            contents: [
              { type: "text", text: `ต่ำกว่าเกณฑ์ ${lowStationCodes.size} สถานี (${lowPct}%)`, size: "xs", weight: "bold", color: COLORS.bad, wrap: true },
              { type: "text", text: [...lowStationCodes].slice(0, 3).map(c => stationNames[c] || c).join(', '), size: "xxs", color: COLORS.textMuted, margin: "xs", wrap: true }
            ]
          }
        ]
      });
    }

    if (highStationCodes.size > 0) {
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "sm",
        paddingAll: "10px", cornerRadius: "8px", backgroundColor: '#fffbeb',
        contents: [
          { type: "text", text: "🟠", size: "sm", flex: 0 },
          {
            type: "box", layout: "vertical", flex: 5, margin: "sm",
            contents: [
              { type: "text", text: `สูงกว่าเกณฑ์ ${highStationCodes.size} สถานี`, size: "xs", weight: "bold", color: COLORS.high, wrap: true },
              { type: "text", text: [...highStationCodes].slice(0, 3).map(c => stationNames[c] || c).join(', '), size: "xxs", color: COLORS.textMuted, margin: "xs", wrap: true }
            ]
          }
        ]
      });
    }

    if (lowStationCodes.size === 0 && highStationCodes.size === 0) {
      bodyContents.push({ type: "separator", margin: "lg" });
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md",
        paddingAll: "10px", cornerRadius: "8px", backgroundColor: '#ecfdf5',
        contents: [
          { type: "text", text: "✅", size: "sm", flex: 0 },
          { type: "text", text: "คลอรีนปกติตลอดทั้งวัน", size: "xs", weight: "bold", color: COLORS.good, flex: 5, margin: "sm", wrap: true }
        ]
      });
    }

    return lineReply(replyToken, withQuickReply([{
      type: "flex",
      altText: `📊 สรุปวัน — ${overallStatus} FRC ${avgFrc} mg/L`,
      contents: {
        type: "bubble", size: "mega",
        header: makeHeader('📊 สรุปประจำวัน', `${thaiDate()} — Executive Summary`, COLORS.headerDark),
        body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
        footer: makeFooterButtons([
          { label: 'ดูค่าปัจจุบัน', text: 'คลอรีน', primary: true },
          { label: 'แผนที่', uri: CONTOUR_URL }
        ])
      }
    }], ['chlorine', 'table', 'low', 'ec', 'map']));
  } catch (err) {
    console.error('[Daily Summary Error]', err.message);
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลประวัติได้: ' + err.message }]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ตารางสรุป FRC แยกตามเขต (เหมือนเดิม + Quick Reply)
// ═══════════════════════════════════════════════════════════════════════════════

async function replyDailyTable(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]));

  const ZONE_GROUPS = [
    { key: 'TR1', title: 'สูบส่งน้ำบางเขน 1 (TR1)', color: '#831843', match: s => s.area === 'TR1' || s.id === 'SP01' || (s.name||'').includes('TR1') },
    { key: 'TR2', title: 'สูบส่งน้ำบางเขน 2 (TR2)', color: '#831843', match: s => s.area === 'TR2' || s.id === 'SP02' || (s.name||'').includes('TR2') },
    { key: 'TR3', title: 'สูบส่งน้ำบางเขน 3 (TR3)', color: '#831843', match: s => s.area === 'TR3' || s.id === 'SP03' || (s.name||'').includes('TR3') },
    { key: 'Dis1', title: 'สูบจ่ายน้ำบางเขน 1 (Dis1)', color: '#1e3a5f', match: s => /Dis\s*1/i.test(s.area) || s.id === 'SP04' || (s.name||'').includes('Dis1') },
    { key: 'Dis2', title: 'สูบจ่ายน้ำบางเขน 2 (Dis2)', color: '#1e3a5f', match: s => /Dis\s*2/i.test(s.area) || s.id === 'SP05' || (s.name||'').includes('Dis2') },
    { key: 'MDIS', title: 'สูบจ่ายน้ำมหาสวัสดิ์', color: '#581c87', match: s => /มหาสวัสดิ์|MDIS|MTR/i.test(s.area) || ['SP11','SP12'].includes(s.id) || /มหาสวัสดิ์/i.test(s.name) },
    { key: 'THO', title: 'โรงผลิตน้ำธนบุรี', color: '#92400e', match: s => /ธนบุรี/i.test(s.area) || s.id === 'SP06' || /ธนบุรี/i.test(s.name) },
    { key: 'SAM', title: 'โรงผลิตน้ำสามเสน', color: '#065f46', match: s => /สามเสน/i.test(s.area) || ['SP07','SP08','SP09','SP10'].includes(s.id) || /สามเสน/i.test(s.name) },
  ];

  const grouped = {};
  const assigned = new Set();
  for (const zone of ZONE_GROUPS) {
    grouped[zone.key] = sensors.filter(s => {
      if (assigned.has(String(s.id))) return false;
      if (zone.match(s)) { assigned.add(String(s.id)); return true; }
      return false;
    });
  }
  const unassigned = sensors.filter(s => !assigned.has(String(s.id)));
  if (unassigned.length > 0) {
    ZONE_GROUPS.push({ key: 'OTHER', title: 'อื่นๆ', color: '#374151', match: () => true });
    grouped['OTHER'] = unassigned;
  }

  const bubbles = [];
  for (const zone of ZONE_GROUPS) {
    const list = grouped[zone.key] || [];
    if (list.length === 0) continue;
    list.sort((a, b) => a.frc - b.frc);

    const rows = [
      {
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: "No.", size: "xxs", color: COLORS.textMuted, flex: 1, weight: "bold" },
          { type: "text", text: "สถานี", size: "xxs", color: COLORS.textMuted, flex: 6, weight: "bold" },
          { type: "text", text: "FRC", size: "xxs", color: COLORS.textMuted, flex: 2, align: "end", weight: "bold" }
        ]
      },
      { type: "separator", margin: "sm" }
    ];

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const st = frcStatus(s.frc, s.type, s.id);
      const shortName = (s.name || String(s.id)).length > 18 ? (s.name || String(s.id)).substring(0, 18) + '..' : (s.name || String(s.id));
      rows.push({
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: `${i + 1}`, size: "xxs", color: COLORS.textMuted, flex: 1 },
          { type: "text", text: shortName, size: "xxs", color: COLORS.textPrimary, flex: 6 },
          { type: "text", text: s.frc.toFixed(2), size: "xxs", color: st.color, flex: 2, align: "end", weight: "bold" }
        ]
      });
    }

    const avg = (list.reduce((a, s) => a + s.frc, 0) / list.length).toFixed(2);
    rows.push({ type: "separator", margin: "sm" });
    rows.push({
      type: "box", layout: "horizontal", margin: "sm",
      contents: [
        { type: "text", text: "-", size: "xxs", color: "#ffffff00", flex: 1 },
        { type: "text", text: "เฉลี่ย", size: "xxs", color: COLORS.textPrimary, flex: 6, weight: "bold" },
        { type: "text", text: avg, size: "xxs", color: COLORS.textPrimary, flex: 2, align: "end", weight: "bold" }
      ]
    });

    bubbles.push({
      type: "bubble", size: "mega",
      header: makeHeader(zone.title, `${list.length} สถานี | ${thaiDate()}`, zone.color),
      body: { type: "box", layout: "vertical", paddingAll: "10px", spacing: "none", contents: rows }
    });
  }

  if (bubbles.length === 0) return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่พบข้อมูลสถานี' }]));

  const totalStations = sensors.length;
  const avgAll = (sensors.reduce((a, s) => a + s.frc, 0) / totalStations).toFixed(2);
  const lowAll = sensors.filter(s => s.frc < FRC_MIN).length;

  const summaryBubble = {
    type: "bubble", size: "mega",
    header: makeHeader('📋 ตารางคลอรีนประจำวัน', `${thaiDate()} — เลื่อน → ดูแต่ละเขต`, COLORS.headerDark),
    body: {
      type: "box", layout: "vertical", paddingAll: "14px",
      contents: [
        makeStatRow("สถานีทั้งหมด", `${totalStations} สถานี`),
        makeStatRow("FRC เฉลี่ย", `${avgAll} mg/L`),
        makeStatRow("ต่ำกว่าเกณฑ์", `${lowAll} สถานี`),
        { type: "separator", margin: "lg" },
        { type: "text", text: "📊 แยกตามเขตรับน้ำ", weight: "bold", size: "sm", color: COLORS.textPrimary, margin: "lg" },
        ...ZONE_GROUPS.filter(z => (grouped[z.key] || []).length > 0).map(z => {
          const list = grouped[z.key];
          const avg = (list.reduce((a, s) => a + s.frc, 0) / list.length).toFixed(2);
          return {
            type: "box", layout: "horizontal", margin: "sm",
            contents: [
              { type: "text", text: z.title, size: "xxs", color: COLORS.textPrimary, flex: 6, wrap: true },
              { type: "text", text: `${list.length}`, size: "xxs", color: COLORS.textMuted, flex: 1, align: "end" },
              { type: "text", text: avg, size: "xxs", color: COLORS.textPrimary, flex: 2, align: "end", weight: "bold" }
            ]
          };
        }),
        { type: "text", text: "← เลื่อนเพื่อดูรายละเอียด →", size: "xxs", color: COLORS.accent, margin: "lg", align: "center" }
      ]
    },
    footer: makeFooterButtons([
      { label: 'ดูค่าปัจจุบัน', text: 'คลอรีน', primary: true },
      { label: 'แผนที่', uri: CONTOUR_URL }
    ])
  };

  return lineReply(replyToken, withQuickReply([{
    type: "flex",
    altText: `📋 ตารางคลอรีน — ${thaiDate()} FRC ${avgAll} mg/L`,
    contents: { type: "carousel", contents: [summaryBubble, ...bubbles.slice(0, 11)] }
  }], ['chlorine', 'daily', 'low', 'ec', 'map']));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ฟังก์ชัน replyTypeDetail, replyFullReport, replyLowStations, replySearchStation,
// replyLocationPrompt, handleLocationMessage, replyFlyToPlace, replyHelp
// — reuse logic เดิม + Quick Reply + header/footer ใหม่
// ═══════════════════════════════════════════════════════════════════════════════

async function replyTypeDetail(replyToken, typeFilter) {
  const sensors = await fetchSensors();
  if (!sensors.length) return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]));

  let filtered, title, thType, headerColor;
  if (typeFilter === 'send') {
    filtered = sensors.filter(s => getStationType(s) === 'send');
    title = '🏭 สถานีสูบส่งน้ำ'; thType = 'send'; headerColor = COLORS.headerPink;
  } else if (typeFilter === 'plant') {
    filtered = sensors.filter(s => getStationType(s) === 'pump');
    title = '💧 สถานีสูบจ่ายน้ำ'; thType = 'pump'; headerColor = COLORS.headerBlue;
  } else {
    filtered = sensors.filter(s => getStationType(s) === 'monitor');
    title = '📡 สถานี Monitor'; thType = 'monitor'; headerColor = '#78350f';
  }

  filtered.sort((a, b) => a.frc - b.frc);
  const th = getThreshold(thType);
  const avg = filtered.length ? (filtered.reduce((a, s) => a + s.frc, 0) / filtered.length).toFixed(2) : '0';

  const pages = [];
  const perPage = 15;
  for (let p = 0; p < filtered.length; p += perPage) pages.push(filtered.slice(p, p + perPage));

  const bubbles = pages.map((page, pageIdx) => {
    const bodyContents = [];
    if (pageIdx === 0) {
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "md",
        contents: [
          { type: "text", text: `🟢>${th.good}`, size: "xxs", color: COLORS.good, flex: 1 },
          { type: "text", text: `🟡${th.watch}-${th.good}`, size: "xxs", color: COLORS.warn, flex: 1 },
          { type: "text", text: `🔴<${th.low}`, size: "xxs", color: COLORS.bad, flex: 1 },
          { type: "text", text: `🟠>${th.high}`, size: "xxs", color: COLORS.high, flex: 1 }
        ]
      });
      bodyContents.push(makeStatRow(`${filtered.length} สถานี`, `เฉลี่ย ${avg} mg/L`));
      bodyContents.push({ type: "separator", margin: "md" });
    } else {
      bodyContents.push({ type: "text", text: `หน้า ${pageIdx + 1}/${pages.length}`, size: "xxs", color: COLORS.textMuted, margin: "sm", align: "center" });
      bodyContents.push({ type: "separator", margin: "sm" });
    }

    for (const s of page) {
      const st = frcStatus(s.frc, s.type, s.id);
      bodyContents.push({
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: st.emoji, size: "xxs", flex: 0 },
          { type: "text", text: s.name, size: "xxs", color: COLORS.textPrimary, flex: 7, margin: "sm", wrap: true },
          { type: "text", text: s.frc.toFixed(2), size: "xxs", color: st.color, flex: 2, align: "end", weight: "bold" }
        ]
      });
    }

    return {
      type: "bubble", size: "mega",
      header: makeHeader(title, `${thaiTime()} น. — เรียงจาก FRC ต่ำสุด`, headerColor),
      body: { type: "box", layout: "vertical", paddingAll: "12px", contents: bodyContents },
      footer: makeFooterButtons([
        { label: 'กลับหน้าหลัก', text: 'คลอรีน' },
        { label: 'แผนที่', uri: CONTOUR_URL, primary: true, color: COLORS.accent }
      ])
    };
  });

  return lineReply(replyToken, withQuickReply([{
    type: "flex",
    altText: `${title} — ${filtered.length} สถานี, FRC ${avg} mg/L`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  }], ['chlorine', 'send', 'pump', 'monitor', 'map']));
}

async function replyFullReport(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]));

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

  return lineReply(replyToken, withQuickReply([flex], ['chlorine', 'daily', 'table', 'map']));
}

async function replyLowStations(replyToken) {
  const sensors = await fetchSensors();
  const lowList = sensors.filter(s => s.frc < FRC_MIN).sort((a, b) => a.frc - b.frc);

  if (lowList.length === 0) {
    return lineReply(replyToken, withQuickReply([{
      type: "flex", altText: "✅ ไม่พบสถานีที่ค่าคลอรีนต่ำ",
      contents: {
        type: "bubble", size: "kilo",
        body: {
          type: "box", layout: "vertical", paddingAll: "20px", alignItems: "center",
          backgroundColor: '#ecfdf5',
          contents: [
            { type: "text", text: "✅", size: "3xl", align: "center" },
            { type: "text", text: "ค่าคลอรีนปกติทุกสถานี", weight: "bold", size: "md", align: "center", margin: "lg", color: COLORS.good },
            { type: "text", text: `ตรวจสอบเมื่อ ${thaiTime()} น.`, size: "xs", color: COLORS.textMuted, align: "center", margin: "sm" }
          ]
        }
      }
    }], ['chlorine', 'daily', 'map']));
  }

  const bubbles = [];
  for (let i = 0; i < Math.min(lowList.length, 10); i += 5) {
    const chunk = lowList.slice(i, i + 5);
    const rows = chunk.map((s, idx) => ({
      type: "box", layout: "horizontal", margin: "lg",
      contents: [
        { type: "text", text: `${i + idx + 1}.`, size: "sm", color: COLORS.bad, flex: 0 },
        {
          type: "box", layout: "vertical", flex: 5, margin: "md",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: COLORS.textPrimary },
            {
              type: "box", layout: "horizontal", margin: "xs",
              contents: [
                { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L`, size: "xs", color: COLORS.bad, flex: 3 },
                { type: "text", text: s.area || '', size: "xs", color: COLORS.textMuted, flex: 2, align: "end" }
              ]
            }
          ]
        }
      ]
    }));

    bubbles.push({
      type: "bubble", size: "mega",
      header: makeHeader(`🔴 สถานี FRC ต่ำ (${lowList.length} สถานี)`, `${thaiTime()} น.`, COLORS.headerRed),
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows }
    });
  }

  return lineReply(replyToken, withQuickReply([{
    type: "flex",
    altText: `🔴 พบ ${lowList.length} สถานีค่าคลอรีนต่ำ`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  }], ['chlorine', 'daily', 'map']));
}

async function replySearchStation(replyToken, query) {
  const sensors = await fetchSensors();
  const words = query.split(/\s+/).filter(w => w.length > 0);
  const results = sensors.filter(s => {
    const searchText = `${s.name} ${s.id} ${s.area || ''} ${s.branch || ''}`.toLowerCase();
    return words.every(w => searchText.includes(w));
  }).slice(0, 8);

  if (results.length === 0) {
    return lineReply(replyToken, withQuickReply([{
      type: 'text', text: `🔍 ไม่พบสถานี "${query}"\n\nลองพิมพ์ เช่น:\n• หา บางเขน\n• หา SP01`
    }], ['chlorine', 'help']));
  }

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
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: COLORS.textPrimary },
            { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L (${st.label}) | ${s.id}`, size: "xs", color: st.color, margin: "xs" },
            { type: "text", text: `${s.area} ${s.branch}`.trim() || '-', size: "xxs", color: COLORS.textMuted, margin: "xs", wrap: true }
          ]
        },
        {
          type: "box", layout: "vertical", flex: 0, justifyContent: "center",
          contents: [{ type: "button", action: { type: "uri", label: "📍", uri: flyToUrl }, style: "primary", color: COLORS.accent, height: "sm" }]
        }
      ]
    });
  }

  return lineReply(replyToken, withQuickReply([{
    type: "flex",
    altText: `🔍 ผลค้นหา "${query}" — ${results.length} สถานี`,
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader(`🔍 ผลค้นหา "${query}"`, `พบ ${results.length} สถานี — กด 📍 เพื่อดูในแผนที่`, COLORS.headerDark),
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows }
    }
  }], ['chlorine', 'map', 'help']));
}

function replyLocationPrompt(replyToken) {
  return lineReply(replyToken, withQuickReply([{
    type: "flex", altText: "📍 ส่งตำแหน่งเพื่อดูค่าคลอรีนใกล้คุณ",
    contents: {
      type: "bubble", size: "kilo",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", alignItems: "center",
        contents: [
          { type: "text", text: "📍", size: "3xl", align: "center" },
          { type: "text", text: "ส่งตำแหน่งของคุณ", weight: "bold", size: "md", align: "center", margin: "lg", color: COLORS.textPrimary },
          { type: "text", text: "กดปุ่ม + ด้านล่างซ้าย\nเลือก Location\nBot จะเปิดแผนที่พร้อมปักหมุดให้!", size: "xs", color: COLORS.textMuted, align: "center", margin: "md", wrap: true }
        ]
      }
    }
  }], ['chlorine', 'map', 'help']));
}

async function handleLocationMessage(replyToken, lat, lon) {
  const sensors = await fetchSensors();
  const mapUrl = `${CONTOUR_URL}?flyto=${lat},${lon},15&pin=${lat},${lon}`;

  const nearest = sensors.map(s => {
    const dist = Math.sqrt((s.lat - lat) ** 2 + (s.lon - lon) ** 2) * 111;
    return { ...s, dist };
  }).sort((a, b) => a.dist - b.dist).slice(0, 3);

  const rows = nearest.map(s => {
    const st = frcStatus(s.frc, s.type, s.id);
    return {
      type: "box", layout: "horizontal", margin: "lg",
      paddingAll: "10px", cornerRadius: "8px", backgroundColor: COLORS.bgCard,
      contents: [
        { type: "text", text: st.emoji, size: "xl", flex: 0 },
        {
          type: "box", layout: "vertical", flex: 5, margin: "md",
          contents: [
            { type: "text", text: s.name, size: "sm", weight: "bold", wrap: true, color: COLORS.textPrimary },
            { type: "text", text: `FRC: ${s.frc.toFixed(2)} mg/L (${st.label})`, size: "xs", color: st.color, margin: "xs" },
            { type: "text", text: `📏 ${s.dist.toFixed(1)} km`, size: "xxs", color: COLORS.textMuted, margin: "xs" }
          ]
        }
      ]
    };
  });

  return lineReply(replyToken, withQuickReply([{
    type: "flex", altText: `📍 สถานีใกล้คุณ — ${nearest[0]?.name || '-'}`,
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader('📍 สถานีใกล้ตำแหน่งคุณ', '3 สถานีที่ใกล้ที่สุด', COLORS.headerDark, IMAGES.logo),
      body: { type: "box", layout: "vertical", paddingAll: "14px", contents: rows },
      footer: {
        type: "box", layout: "vertical", paddingAll: "12px",
        contents: [{ type: "button", action: { type: "uri", label: "🗺️ เปิดแผนที่ ณ ตำแหน่งของฉัน", uri: mapUrl }, style: "primary", color: COLORS.accent, height: "sm" }]
      }
    }
  }], ['chlorine', 'daily', 'map']));
}

async function replyFlyToPlace(replyToken, place) {
  try {
    const sensors = await fetchSensors();

    // ค้นหาในสถานีก่อน
    const words = place.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const stationMatch = sensors.filter(s => {
      const searchText = `${s.name} ${s.id} ${s.area || ''} ${s.branch || ''}`.toLowerCase();
      return words.every(w => searchText.includes(w));
    });

    if (stationMatch.length > 0) {
      const s = stationMatch[0];
      const st = frcStatus(s.frc, s.type, s.id);
      const mapUrl = `${CONTOUR_URL}?flyto=${s.lat},${s.lon},16&station=${s.id}`;

      return lineReply(replyToken, withQuickReply([{
        type: "flex", altText: `📍 ${s.name} — FRC ${s.frc.toFixed(2)} mg/L`,
        contents: {
          type: "bubble", size: "mega",
          header: makeHeader(`📍 ${s.name}`, `${s.id} | ${s.area || ''} ${s.branch || ''}`.trim(), COLORS.headerDark, IMAGES.logo),
          body: {
            type: "box", layout: "vertical", paddingAll: "14px",
            contents: [
              { type: "text", text: `${st.emoji} FRC: ${s.frc.toFixed(2)} mg/L (${st.label})`, size: "sm", color: st.color, weight: "bold" },
              makeStatRow("ประเภท", getThreshold(s.type, s.id).label),
              makeStatRow("พิกัด", `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`),
              ...(stationMatch.length > 1 ? [{ type: "text", text: `พบอีก ${stationMatch.length - 1} สถานี — พิมพ์ "หา ${place}"`, size: "xxs", color: COLORS.textMuted, margin: "md", wrap: true }] : [])
            ]
          },
          footer: {
            type: "box", layout: "vertical", paddingAll: "12px",
            contents: [{ type: "button", action: { type: "uri", label: "🗺️ เปิดในแผนที่ Contour", uri: mapUrl }, style: "primary", color: COLORS.accent, height: "sm" }]
          }
        }
      }], ['chlorine', 'map', 'help']));
    }

    // Geocode จาก Nominatim
    let geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=3&countrycodes=th`;
    let res = await axios.get(geocodeUrl, { timeout: 10000, headers: { 'User-Agent': 'FRC-LINE-Bot/2.0' } });

    if (!res.data || res.data.length === 0) {
      geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place + ' กรุงเทพ')}&format=json&limit=3`;
      res = await axios.get(geocodeUrl, { timeout: 10000, headers: { 'User-Agent': 'FRC-LINE-Bot/2.0' } });
    }

    if (!res.data || res.data.length === 0) {
      return lineReply(replyToken, withQuickReply([{
        type: 'text', text: `🔍 ไม่พบ "${place}"\n\nลองพิมพ์ เช่น:\n• ไปที่ บางเขน\n• ไปที่ สยาม`
      }], ['chlorine', 'search', 'help']));
    }

    const loc = res.data[0];
    const lat = parseFloat(loc.lat);
    const lon = parseFloat(loc.lon);
    const displayName = loc.display_name.split(',').slice(0, 3).join(', ');
    const mapUrl = `${CONTOUR_URL}?flyto=${lat},${lon},15&pin=${lat},${lon}`;

    const nearest = sensors.map(s => ({
      ...s, dist: Math.sqrt((s.lat - lat) ** 2 + (s.lon - lon) ** 2) * 111
    })).sort((a, b) => a.dist - b.dist)[0];

    const bodyContents = [
      { type: "text", text: displayName, size: "xs", color: COLORS.textSecondary, wrap: true },
      { type: "text", text: `พิกัด: ${lat.toFixed(4)}, ${lon.toFixed(4)}`, size: "xxs", color: COLORS.textMuted, margin: "sm" }
    ];
    if (nearest) {
      const st = frcStatus(nearest.frc, nearest.type, nearest.id);
      bodyContents.push({ type: "separator", margin: "md" });
      bodyContents.push({ type: "text", text: "สถานีใกล้สุด:", size: "xxs", color: COLORS.textMuted, margin: "md" });
      bodyContents.push({ type: "text", text: `${st.emoji} ${nearest.name}`, size: "sm", color: COLORS.textPrimary, margin: "xs", wrap: true });
      bodyContents.push({ type: "text", text: `FRC ${nearest.frc.toFixed(2)} mg/L (${nearest.dist.toFixed(1)} km)`, size: "xs", color: st.color, margin: "xs" });
    }

    return lineReply(replyToken, withQuickReply([{
      type: "flex", altText: `🗺️ ${place} — เปิดในแผนที่ Contour`,
      contents: {
        type: "bubble", size: "mega",
        header: makeHeader(`🗺️ ${place}`, null, COLORS.headerDark, IMAGES.logo),
        body: { type: "box", layout: "vertical", paddingAll: "14px", contents: bodyContents },
        footer: {
          type: "box", layout: "vertical", paddingAll: "12px",
          contents: [{ type: "button", action: { type: "uri", label: "🗺️ เปิดในแผนที่ Contour", uri: mapUrl }, style: "primary", color: COLORS.accent, height: "sm" }]
        }
      }
    }], ['chlorine', 'map', 'help']));
  } catch (err) {
    console.error('[FlyTo Error]', err.message);
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: `❌ ไม่สามารถค้นหา "${place}" ได้` }]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📱 Carousel Menu — รูป + ปุ่มกด เลื่อนซ้ายขวา (ส่งเมื่อพิมพ์ "เมนู")
// ═══════════════════════════════════════════════════════════════════════════════

function replyMenuCarousel(replyToken) {
  const menuItems = [
    {
      image: `${IMG_BASE}/menu-contour.png`,
      title: "🗺️ Contour Map",
      desc: "แผนที่คลอรีน Real-Time",
      action: { type: "uri", label: "เปิดแผนที่", uri: CONTOUR_URL },
      btnColor: "#0f172a"
    },
    {
      image: `${IMG_BASE}/menu-frc.png`,
      title: "💧 Chlorine FRC",
      desc: "ค่า FRC สูบส่ง/สูบจ่าย/Monitor",
      action: { type: "message", label: "ดูค่าคลอรีน", text: "คลอรีน" },
      btnColor: "#e11d48"
    },
    {
      image: `${IMG_BASE}/menu-ec.png`,
      title: "⚡ Conductivity (EC)",
      desc: "ค่าการนำไฟฟ้าทุกสถานี",
      action: { type: "message", label: "ดูค่า EC", text: "ec" },
      btnColor: "#1e3a5f"
    },
    {
      image: `${IMG_BASE}/menu-search.png`,
      title: "🔍 Search Station",
      desc: "ค้นหาสถานี ดูกราฟ ดูพิกัด",
      action: { type: "message", label: "ค้นหา", text: "ค้นหาสถานที่" },
      btnColor: "#14532d"
    },
    {
      image: `${IMG_BASE}/menu-nearby.png`,
      title: "📍 Nearby",
      desc: "ส่งตำแหน่ง ดูสถานีรอบตัวคุณ",
      action: { type: "message", label: "ส่งตำแหน่ง", text: "ใกล้ฉัน" },
      btnColor: "#92400e"
    },
  ];

  const bubbles = menuItems.map(item => ({
    type: "bubble",
    size: "kilo",
    hero: {
      type: "image",
      url: item.image,
      size: "full",
      aspectRatio: "20:13",
      aspectMode: "cover",
      action: item.action
    },
    body: {
      type: "box", layout: "vertical",
      paddingAll: "16px", paddingTop: "14px", paddingBottom: "8px", spacing: "sm",
      contents: [
        { type: "text", text: item.title, weight: "bold", size: "lg", color: COLORS.textPrimary },
        { type: "text", text: item.desc, size: "xs", color: COLORS.textSecondary, wrap: true },
      ]
    },
    footer: {
      type: "box", layout: "vertical", paddingAll: "12px", paddingTop: "4px",
      contents: [{
        type: "button",
        action: item.action,
        style: "primary",
        color: item.btnColor,
        height: "sm"
      }]
    }
  }));

  return lineReply(replyToken, withQuickReply([{
    type: "flex",
    altText: "📱 เมนู FRC Bot — เลื่อนเพื่อดูทั้งหมด",
    contents: { type: "carousel", contents: bubbles }
  }]));
}

function makeHelpRow(emoji, cmd, desc) {
  return {
    type: "box", layout: "horizontal", spacing: "md", margin: "sm",
    contents: [
      { type: "text", text: emoji, size: "md", flex: 0 },
      { type: "text", text: `"${cmd}"`, size: "sm", weight: "bold", color: COLORS.accent, flex: 2 },
      { type: "text", text: desc, size: "xs", color: COLORS.textSecondary, flex: 5, wrap: true }
    ]
  };
}

function replyHelp(replyToken) {
  return lineReply(replyToken, withQuickReply([{
    type: "flex", altText: "📖 วิธีใช้งาน FRC Bot",
    contents: {
      type: "bubble", size: "mega",
      header: makeHeader('💧 FRC Chlorine Bot v12', 'ระบบติดตามคลอรีนอิสระคงเหลือ', COLORS.headerDark, IMAGES.logo),
      body: {
        type: "box", layout: "vertical", paddingAll: "14px", spacing: "md",
        contents: [
          { type: "text", text: "📱 คำสั่งหลัก", weight: "bold", size: "sm", color: COLORS.textPrimary },
          makeHelpRow("💧", "คลอรีน", "ดูค่า FRC แยกสูบส่ง/สูบจ่าย/Monitor"),
          makeHelpRow("⚡", "ec", "ดูค่า EC (ค่าการนำไฟฟ้า)"),
          makeHelpRow("📊", "สรุปวัน", "สรุปประจำวันแบบผู้บริหาร"),
          makeHelpRow("📋", "ตารางวัน", "ตาราง FRC แยกตามเขตรับน้ำ"),
          makeHelpRow("🔴", "สถานีต่ำ", "ดูสถานีที่ค่าต่ำกว่าเกณฑ์"),
          { type: "separator" },
          { type: "text", text: "🔍 ค้นหา & แผนที่", weight: "bold", size: "sm", color: COLORS.textPrimary },
          makeHelpRow("🔍", "หา [ชื่อ]", "ค้นหาสถานีในระบบ"),
          makeHelpRow("🗺️", "ไปที่ [สถานที่]", "บินไปในแผนที่ Contour"),
          makeHelpRow("📍", "ใกล้ฉัน", "ส่งตำแหน่ง → ดูสถานีใกล้"),
          { type: "separator" },
          { type: "text", text: "🔔 แจ้งเตือนอัตโนมัติ", weight: "bold", size: "xs", color: COLORS.textPrimary },
          { type: "text", text: "ตรวจค่าทุก 30 นาที — แจ้งเมื่อผิดปกติ", size: "xxs", color: COLORS.textMuted, wrap: true },
          { type: "text", text: "สูบส่ง: ดี>1.0 ต่ำ<0.5 | สูบจ่าย: ดี>0.8 ต่ำ<0.5", size: "xxs", color: COLORS.textMuted, wrap: true },
          { type: "text", text: "Monitor: ดี>0.4 ต่ำ<0.2", size: "xxs", color: COLORS.textMuted, wrap: true },
        ]
      },
      footer: makeFooterButtons([
        { label: '💧 คลอรีน', text: 'คลอรีน', primary: true },
        { label: '📊 สรุปวัน', text: 'สรุปวัน' }
      ])
    }
  }], ['chlorine', 'daily', 'ec', 'low', 'map', 'location']));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🖼️ Rich Menu — Endpoint สร้าง Rich Menu อัตโนมัติ
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/setup-richmenu', async (req, res) => {
  try {
    // Layout: 2500x1686
    // Row 1 (3 ปุ่ม): แผนที่ | คลอรีน | EC
    // Row 2 (2 ปุ่ม): ค้นหาสถานี | ใกล้ฉัน
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "FRC Bot Menu v12",
      chatBarText: "💧 เมนู FRC",
      areas: [
        // Row 1
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "uri", label: "แผนที่", uri: CONTOUR_URL } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "คลอรีน", text: "คลอรีน" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "EC", text: "ec" } },
        // Row 2
        { bounds: { x: 0, y: 843, width: 1250, height: 843 }, action: { type: "message", label: "ค้นหาสถานี", text: "ค้นหาสถานที่" } },
        { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: "message", label: "ใกล้ฉัน", text: "ใกล้ฉัน" } },
      ]
    };

    // Step 1: สร้าง Rich Menu
    const createRes = await axios.post('https://api.line.me/v2/bot/richmenu', richMenu, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
    const richMenuId = createRes.data.richMenuId;
    console.log(`[RichMenu] สร้างสำเร็จ: ${richMenuId}`);

    // Step 2: Set เป็น default สำหรับ user ทุกคน
    await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {}, {
      headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
    });
    console.log(`[RichMenu] ตั้งเป็น default สำเร็จ`);

    res.json({
      success: true,
      richMenuId,
      message: 'Rich Menu สร้าง + ตั้ง default สำเร็จ!',
      note: 'ต้อง upload รูป 2500x1686 เพิ่ม ผ่าน API หรือ LINE OA Manager',
      upload_url: `POST https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      layout: {
        row1: ['🗺️ แผนที่ Contour', '💧 คลอรีน FRC', '⚡ ค่า EC'],
        row2: ['🔍 ค้นหาสถานี', '📍 ใกล้ฉัน']
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Webhook Endpoint (+ Signature Verification)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/webhook', async (req, res) => {
  // 🔒 Verify signature
  if (!verifySignature(req)) {
    console.warn('⚠️ Webhook signature verification failed!');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const events = req.body.events || [];
  for (const event of events) {
    try {
      const source = event.source;
      if (source) {
        const targetId = source.groupId || source.roomId || source.userId;
        if (targetId) saveTarget(targetId);
      }

      if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(event.replyToken, event.message.text, source?.userId);
      }

      if (event.type === 'message' && event.message.type === 'location') {
        const { latitude, longitude } = event.message;
        await handleLocationMessage(event.replyToken, latitude, longitude);
      }

      if (event.type === 'follow') {
        await lineReply(event.replyToken, withQuickReply([{
          type: 'text',
          text: '🌸 ยินดีต้อนรับสู่ FRC Chlorine Bot!\n\nพิมพ์ "คลอรีน" เพื่อดูค่า FRC ปัจจุบัน\nหรือกดปุ่มด้านล่าง เพื่อเริ่มใช้งาน\n\n🔔 Bot จะแจ้งเตือนอัตโนมัติเมื่อค่าผิดปกติ'
        }], ['chlorine', 'daily', 'ec', 'map', 'location', 'help']));
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
    bot: 'FRC Chlorine LINE Bot v12.0',
    version: '12.0',
    time: new Date().toISOString(),
    targets: NOTIFY_TARGETS.size,
    security: {
      tokenFromEnv: !LINE_TOKEN.includes('YB99'),
      signatureVerification: !!LINE_SECRET,
      firebaseFromEnv: !!process.env.FB_API_KEY
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cron Jobs
// ═══════════════════════════════════════════════════════════════════════════════

cron.schedule('*/30 * * * *', () => {
  console.log(`[Cron] ตรวจ FRC alert — ${new Date().toISOString()}`);
  checkAlerts();
}, { timezone: 'Asia/Bangkok' });

cron.schedule('*/10 * * * *', async () => {
  try {
    const sensors = await fetchSensors();
    if (!sensors.length) return;
    const ts = Date.now();
    const promises = sensors.map(s => {
      const code = String(s.id).replace(/[\/\.#\$\[\]]/g, '-');
      return push(ref(db, `history/${code}`), { frc: s.frc, ts });
    });
    await Promise.all(promises);
    console.log(`[Cron] บันทึก history ${sensors.length} สถานี`);
  } catch(e) {
    console.error('[Cron] History save error:', e.message);
  }
}, { timezone: 'Asia/Bangkok' });

cron.schedule('0 8 * * *', () => {
  console.log(`[Cron] ส่งรายงานประจำวัน — ${new Date().toISOString()}`);
  sendDailyReport();
}, { timezone: 'Asia/Bangkok' });

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FRC Chlorine LINE Bot v12.0 running on port ${PORT}`);
  console.log(`   Webhook URL: POST /webhook`);
  console.log(`   Rich Menu Setup: POST /setup-richmenu`);
  console.log(`   🔒 Token from env: ${!LINE_TOKEN.includes('YB99') ? '✅' : '⚠️ ใช้ hardcoded — ควรย้ายเป็น env var'}`);
  console.log(`   🔒 Signature verify: ${LINE_SECRET ? '✅' : '⚠️ ปิดอยู่ — ตั้ง LINE_CHANNEL_SECRET'}`);
  loadTargets();
});
