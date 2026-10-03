// LINE Messaging API — FRC Chlorine Monitoring Bot  v12.3
// ═══════════════════════════════════════════════════════════════════════════════
// Changelog v12.3 (จาก v12.2):
//   ⏱️ Alert cron: เปลี่ยนจากตรวจ "ทุก 1 ชม." → ตรวจ "วันละครั้ง 08:00 น."
//   📋 Alert Flex: ยกเลิกการตัดที่ 8 สถานี — ลิสต์ทุกสถานีที่ผิดปกติรวมในข้อความเดียว (ประหยัด broadcast quota)
//
// Changelog v12.2 (จาก v12.1):
//   🔒 Firebase: เปลี่ยนจาก Client SDK → Admin SDK (bypass App Check)
//   📉 ปิด broadcast สรุปวัน อัตโนมัติ (ยังเรียก manual ได้)
//   ⏱️ Alert cooldown: 8 ชม. → 24 ชม. (สถานีเดิมแจ้งวันละ 1 ครั้ง)
//
// Changelog v12.1 (จาก v12.0):
//   🌸 Welcome Flex: เปลี่ยน follow event จาก text ธรรมดา → Flex Message สวยงาม
//      - gradient header + LIVE badge + feature cards + action buttons
//      - รองรับ "สวัสดี", "hello", "hi" แสดง welcome flex เหมือนกัน
//
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
const admin   = require('firebase-admin');
const { spawn } = require('child_process');
const { checkEquipmentDue } = require('./linebot_equipment_alert');
const { makeRepairApi } = require('./repair_module');

const app = express();

// ─── 🔒 Security: raw body สำหรับ signature verification ──────────────────────
app.use('/webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.json());

// ── ระบบแจ้งซ่อม: endpoint รับจากหน้าเว็บ repair.html (GitHub Pages) ──
let repairApi = null;   // สร้างหลัง Firebase init (ดูด้านล่างประกาศ db แล้วค่อย attach)
app.use('/repair', (req, res, next) => {          // CORS สำหรับ GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.post('/repair/close', async (req, res) => {
  try {
    if (!repairApi) return res.status(503).json({ error: 'ระบบยังไม่พร้อม' });
    const { key, by } = req.body || {};
    if (!key || !by) return res.status(400).json({ error: 'ข้อมูลไม่ครบ (key, by)' });
    res.json(await repairApi.closeTicket({ key, by }));
  } catch (e) {
    console.error('[Repair] close error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/repair', async (req, res) => {
  try {
    if (!repairApi) return res.status(503).json({ error: 'ระบบยังไม่พร้อม' });
    const { station, items, foundDate, foundTime, reporter } = req.body || {};
    if (!station || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ (station, items)' });
    const r = await repairApi.createTicket({ station, items, foundDate, foundTime, reporter, via: 'web' });
    res.json(r);
  } catch (e) {
    console.error('[Repair] endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

const IMG_CACHE_BUSTER = 'v2';

const IMAGES = {
  logo:       `${IMG_BASE}/logo-frc-64.png?${IMG_CACHE_BUSTER}`,
  bannerFRC:  `${IMG_BASE}/banner-frc.png?${IMG_CACHE_BUSTER}`,
  bannerEC:   `${IMG_BASE}/banner-ec.png?${IMG_CACHE_BUSTER}`,
  bannerMap:  `${IMG_BASE}/banner-map.png?${IMG_CACHE_BUSTER}`,
  bannerAlert:`${IMG_BASE}/banner-alert.png?${IMG_CACHE_BUSTER}`,
  bannerDaily:`${IMG_BASE}/banner-daily.png?${IMG_CACHE_BUSTER}`,
  iconSend:   `${IMG_BASE}/icon-send.png?${IMG_CACHE_BUSTER}`,
  iconPump:   `${IMG_BASE}/icon-pump.png?${IMG_CACHE_BUSTER}`,
  iconMonitor:`${IMG_BASE}/icon-monitor.png?${IMG_CACHE_BUSTER}`,
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

// 🔒 Firebase Admin SDK — bypass App Check, ใช้ service account หรือ default credentials
// ตั้ง env var FIREBASE_SERVICE_ACCOUNT = JSON string ของ service account key
// หรือถ้ารันบน GCP จะใช้ default credentials อัตโนมัติ
const FB_DB_URL = process.env.FB_DATABASE_URL || "https://frc-contour-default-rtdb.asia-southeast1.firebasedatabase.app";

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FB_DB_URL
  });
  console.log('🔒 Firebase Admin: initialized with service account');
} else {
  // fallback: ใช้ databaseURL อย่างเดียว (จำกัดสิทธิ์ตาม RTDB rules)
  admin.initializeApp({
    databaseURL: FB_DB_URL
  });
  console.log('⚠️  Firebase Admin: initialized WITHOUT service account — RTDB rules ต้องเปิด public read/write');
}

const db = admin.database();
repairApi = makeRepairApi(db);

// ⚠️ ตรวจสอบ LINE credentials ตอน start
if (!LINE_TOKEN) {
  console.error('❌ FATAL: LINE_CHANNEL_ACCESS_TOKEN ไม่ได้ตั้งค่า!');
  console.error('   ตั้งค่า env var: LINE_CHANNEL_ACCESS_TOKEN=<your token>');
  process.exit(1);
}
if (!LINE_SECRET) {
  console.warn('⚠️  LINE_CHANNEL_SECRET ไม่ได้ตั้งค่า — webhook signature verification ถูกปิด');
}

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
  if (SEND_IDS.includes(sid) || type === 'send') return THRESHOLDS.send;
  if (PUMP_IDS.includes(sid) || sid.startsWith('SW') || type === 'plant' || type === 'pump') return THRESHOLDS.pump;
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
    const snap = await db.ref('notify_targets').once('value');
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
            await db.ref(`notify_targets/${id.replace(/[\/\.#\$\[\]]/g, '_')}`).set(id);
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
    await db.ref(`notify_targets/${targetId.replace(/[\/\.#\$\[\]]/g, '_')}`).set(targetId);
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
      const snap = await db.ref('live').once('value');
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

async function getLineProfile(userId) {
  const r = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
    headers: { Authorization: `Bearer ${LINE_TOKEN}` } });
  return r.data;
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
    turb:     { type: 'action', action: { type: 'message', label: "💧 ความขุ่น", text: 'สรุปความขุ่น' } },
    table:    { type: 'action', action: { type: 'message', label: '📋 ตาราง', text: 'ตารางวัน' } },
    low:      { type: 'action', action: { type: 'message', label: '🔴 สถานีต่ำ', text: 'สถานีต่ำ' } },
    send:     { type: 'action', action: { type: 'message', label: '🏭 สูบส่ง', text: 'ดูสูบส่ง' } },
    pump:     { type: 'action', action: { type: 'message', label: '💧 สูบจ่าย', text: 'ดูสูบจ่าย' } },
    monitor:  { type: 'action', action: { type: 'message', label: '📡 Monitor', text: 'ดู monitor' } },
    help:     { type: 'action', action: { type: 'message', label: '❓ วิธีใช้', text: 'help' } },
  };
  const keys = subset || ['search', 'location', 'map', 'chlorine', 'daily', 'turb', 'ec'];
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
    if (s.frc < 0) continue; // ข้าม FRC ติดลบเท่านั้น (0.00 ถือว่าผิดปกติ)
    const t = getThreshold(s.type, s.id);
    // แจ้งเตือนเฉพาะค่าต่ำเท่านั้น
    if (s.frc < t.low) {
      const key = `${s.id}_low`;
      if (!alertedStations[key]) { alertedStations[key] = Date.now(); alertList.push({ ...s, alertType: 'ต่ำ', threshold: t }); }
    }
  }

  // [v12.3] ล้าง alert เก่ากว่า 24 ชม. — กันไม่ให้ซ้ำถ้ามีการเรียก checkAlerts() เพิ่มเติมในวันเดียวกัน
  // (การแจ้งเตือนอัตโนมัติหลักตอนนี้รันวันละครั้งเดียวตาม cron ด้านล่าง)
  const cutoff = Date.now() - 86400000;
  for (const [k, v] of Object.entries(alertedStations)) {
    if (v < cutoff) delete alertedStations[k];
  }

  if (alertList.length === 0) return;
  const flexMsg = buildAlertFlex(alertList);
  await lineBroadcast([flexMsg]);
  console.log(`[Alert] ส่งแจ้งเตือนประจำวัน ${alertList.length} สถานี (เฉพาะค่าต่ำ) — รวมเป็น broadcast เดียว`);
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

  // [v12.3] แจ้งวันละครั้ง → ลิสต์ทุกสถานีที่ผิดปกติในข้อความเดียว ไม่ตัดที่ 8 สถานีแล้ว
  for (const s of alerts) {
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

// คำสั่งที่บอทจะตอบเมื่ออยู่ใน "กลุ่ม/ห้อง" — ข้อความอื่นของคนในกลุ่มปล่อยผ่านเงียบ ๆ
// (แชท 1:1 ตอบทุกอย่างเหมือนเดิม รวม fallback เมนู)
const GROUP_COMMANDS = /^(แจ้งซ่อม|เซ็นเซอร์|วาระเปลี่ยน|เปลี่ยนเซ็นเซอร์|เมนู|help|สถานะ|คลอรีน|frc)/i;   // ห้ามใช้ \b กับภาษาไทย

async function handleTextMessage(replyToken, text, userId, sourceType = 'user') {
  const msg = text.trim();
  if (sourceType !== 'user' && !GROUP_COMMANDS.test(msg)) return;   // ในกลุ่ม: ไม่ใช่คำสั่ง = เงียบ

  // ── แจ้งซ่อม: "แจ้งซ่อม" เปล่า = สรุปวันนี้ | "แจ้งซ่อม <รายการ>" = ออกใบอัตโนมัติ
  // ── แจ้งซ่อม: "แจ้งซ่อม" เปล่า = สรุปวันนี้ | "แจ้งซ่อม <รายการ>" = ออกใบ (รอเมลเสร็จแล้วค่อยตอบ)
  if (/^แจ้งซ่อม/.test(msg) && repairApi) {
    const body = msg.replace(/^แจ้งซ่อม/, '').trim();
    if (!body) {
      const t = await repairApi.todaySummaryText();
      return lineReply(replyToken, [{ type: 'text', text: t }]);
    }
    const entries = repairApi.parseRepairText(body);
    let prof = '-';
    try { const p = await getLineProfile(userId); prof = p?.displayName || '-'; } catch (_) {}
    const okLines = [], issues = [];
    let mailedAll = true, anyMail = false, anyInHouse = false;
    for (const e of entries) {
      if (!e.hits.length) { issues.push(`❓ ไม่พบสถานี: "${e.raw.slice(0, 40)}"`); continue; }
      if (e.hits.length > 1) { issues.push(`❓ "${e.raw.slice(0, 30)}" กำกวม: ${e.hits.slice(0, 3).map(h => h.name).join(' / ')}`); continue; }
      // ยืดหยุ่นตามภาษาหน้างาน: มีสถานี + อย่างน้อยอาการหรือพารามิเตอร์ = ออกใบได้ ส่วนที่ขาดลง "ไม่ระบุ" + แนบข้อความต้นฉบับ
      if (!e.param && !e.problem) { issues.push(`❓ ${e.hits[0].name}: ระบุอาการด้วย เช่น "คลอรีนต่ำ" "คลอรีนแกว่งสูง" "ขุ่นสูง" "จอ error"`); continue; }
      // ไม่ระบุพารามิเตอร์ + อาการเป็น ERROR/ดับ/ค่าหาย = ทั้งสถานีหลุด (ระบบสื่อสาร)
      // → ลงหมวด "หน้าจอ TWQ" ตามธรรมเนียมที่ทีมบันทึกในชีตมาตลอด
      const wholeStation = !e.param && e.problem && /ERROR|ดับ|ค่าหาย/.test(e.problem);
      const param = e.param || (wholeStation ? 'หน้าจอ TWQ' : 'ไม่ระบุพารามิเตอร์');
      const problem = e.problem || 'ไม่ระบุอาการ';
      const item = { param, problem };
      if (wholeStation) item.note = 'ทั้งสถานี (ระบบสื่อสาร) — ข้อความแจ้ง: ' + e.raw.slice(0, 60);
      else if (!e.param || !e.problem) item.note = 'ข้อความแจ้ง: ' + e.raw.slice(0, 80);
      const r = await repairApi.createTicket({ station: e.hits[0].name,
        items: [item], reporter: prof, via: 'line' });
      if (r.created) {
        okLines.push(`${e.hits[0].name} ${param} ${problem} (${r.no})`);
        if (r.skipped && r.skipped.length) issues.push(`ℹ️ ${e.hits[0].name}: ${r.skipped.join(', ')} มีในใบวันนี้แล้ว — ไม่ส่งซ้ำ`);
        if (r.emailSent === true) anyMail = true;
        else if (r.ticket && r.ticket.company && r.ticket.company.includes('กองบูรณาการ')) anyInHouse = true;
        else { mailedAll = false; issues.push(`⚠️ ${r.no} เมลไม่ออก (${r.emailErr || ''})`); }
      } else issues.push(`ℹ️ ${r.msg}`);
    }
    const L = [];
    if (okLines.length) {
      L.push(repairApi.thDateFull(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })));
      okLines.forEach((t, i) => L.push(`${i + 1}. ${t}`));
      if (anyMail && mailedAll) L.push('', 'ส่งการแจ้งซ่อมสำเร็จ ✅ ตรวจเช็คอีเมล');
      else if (anyMail) L.push('', 'บันทึกแล้ว — บางใบเมลไม่ออก (ดูด้านล่าง)');
      if (anyInHouse) L.push('(งานสถานีสูบจ่ายน้ำ — กบน. ดำเนินการเอง ไม่ส่งเมลผู้รับจ้าง)');
    }
    L.push(...issues);
    return lineReply(replyToken, [{ type: 'text', text: L.join('\n') || 'ไม่มีรายการ' }]);
  }

  // ── วาระเปลี่ยนเซ็นเซอร์/อุปกรณ์ (ถามสถานะได้ทุกเมื่อ ไม่ต้องรอ cron วันที่ 1)
  if (/^เซ็นเซอร์$|วาระเปลี่ยน|เปลี่ยนเซ็นเซอร์/i.test(msg)) {
    const replyClient = { pushMessage: async ({ messages }) => lineReply(replyToken, messages) };
    return checkEquipmentDue(replyClient, userId, { always: true });
  }

  // ── คลอรีน / FRC / สถานะ
  if (/คลอรีน|frc|สถานะ|status|ค่าน้ำ/i.test(msg)) {
    return replyCurrentStatus(replyToken);
  }

  // ── ตารางสรุปวัน (ค่าเฉลี่ยทั้งวัน แยกตามเขต)
  if (/ตารางสรุปวัน/i.test(msg)) {
    return replyDailyTableSummary(replyToken);
  }

  // ── ตารางวัน (ค่า real-time แยกตามเขต)
  if (/ตารางวัน|ตาราง|table/i.test(msg)) {
    return replyDailyTable(replyToken);
  }

  // ── ส่งสรุปวัน Broadcast (ต้องเช็คก่อน "สรุปวัน")
  if (/^ส่งสรุปวัน|^broadcast daily/i.test(msg)) {
    // delegate to handler below
    return handleBroadcastDaily(replyToken);
  }

  // ── ส่งแจ้งเตือน Manual (ต้องเช็คก่อน "แจ้งเตือน")
  if (/^ส่งแจ้งเตือน|^send alert/i.test(msg)) {
    return handleSendAlert(replyToken);
  }

  // ── สรุปความขุ่น (ต้องเช็คก่อน "สรุป" ทั่วไป)
  { const m = msg.match(/ขุ่น\s*บริการ\s*([1-5])/); if (m) return replyTurbidityRegion(replyToken, Number(m[1]) - 1, /เมื่อวาน/.test(msg) ? -1 : 0); }
  if (/ขุ่น.*เมื่อวาน|เมื่อวาน.*ขุ่น/.test(msg)) return replyTurbiditySummary(replyToken, -1);
  if (/^(สรุป)?\s*(ความ)?ขุ่น(วันนี้)?$|^turbidity$/i.test(msg.trim())) return replyTurbiditySummary(replyToken, 0);

  // ── สรุปวัน / สรุป / daily / รายงาน → ทั้งหมดไปสรุปวัน
  if (/สรุปวัน|สรุป|daily|ประจำวัน|รายงาน|report|summary/i.test(msg)) {
    return replyDailySummary(replyToken);
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
      if (s.frc < 0) continue;
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

  // (ส่งแจ้งเตือน/ส่งสรุปวัน ถูกจัดการด้านบนแล้ว)

  // (ส่งสรุปวัน ถูกจัดการด้านบนแล้ว)

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

  // ── สวัสดี / ทักทาย → Welcome text + Carousel
  if (/^สวัสดี|^hello|^hi$|^หวัดดี|^ดี$/i.test(msg)) {
    const welcomeText = {
      type: 'text',
      text: '💧 ยินดีต้อนรับสู่ Real-Time Contour Bot!\n\nสามารถกดเมนูด้านล่าง เพื่อเริ่มใช้งาน\nหรือพิมพ์ help เพื่อดูคำสั่ง\n\n🔔 Bot จะแจ้งเตือนอัตโนมัติเมื่อค่าผิดปกติ'
    };
    return lineReply(replyToken, withQuickReply([welcomeText, buildMenuCarousel()], ['chlorine', 'daily', 'ec', 'map', 'location', 'help']));
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
    if (s.frc < 0) return false;
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
    typeRow(IMAGES.iconSend, "สูบส่ง", sc, avgSend, "#dbeafe", 'send'),
    typeRow(IMAGES.iconPump, "สูบจ่าย", pc, avgPump, "#d1fae5", 'pump'),
    typeRow(IMAGES.iconMonitor, "Monitor", mc, avgMon, "#ede9fe", 'monitor'),
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
              { type: "button", action: { type: "message", label: "สูบส่ง", text: "ดูสูบส่ง" }, height: "sm", style: "primary", color: "#3b82f6", flex: 1 },
              { type: "button", action: { type: "message", label: "สูบจ่าย", text: "ดูสูบจ่าย" }, height: "sm", style: "primary", color: "#10b981", flex: 1 },
              { type: "button", action: { type: "message", label: "Monitor", text: "ดู monitor" }, height: "sm", style: "primary", color: "#8b5cf6", flex: 1 },
            ]
          },
          {
            type: "box", layout: "horizontal", spacing: "xs",
            contents: [
              { type: "button", action: { type: "message", label: "📋 ตาราง", text: "ตารางวัน" }, height: "sm", style: "primary", color: COLORS.accent, flex: 1 },
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

// ═══════════════════════════════════════════════════════════════════════════════
// 📢 ส่งแจ้งเตือน Manual + ส่งสรุปวัน Broadcast
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSendAlert(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) return lineReply(replyToken, [{type:'text',text:'❌ ไม่สามารถดึงข้อมูลได้'}]);
  const alertList = [];
  for (const s of sensors) {
    if (s.frc < 0) continue;
    const t = getThreshold(s.type, s.id);
    if (s.frc < t.low) alertList.push({...s, alertType:'ต่ำ', threshold:t});
    else if (s.frc > t.high) alertList.push({...s, alertType:'สูง', threshold:t});
    else if (s.frc < t.good) alertList.push({...s, alertType:'เฝ้าระวัง', threshold:t});
  }
  if (alertList.length === 0) return lineReply(replyToken, withQuickReply([{type:'text',text:'✅ ทุกสถานีปกติ ไม่มีรายการแจ้งเตือน'}]));
  const flexMsg = buildAlertFlex(alertList);
  await lineBroadcast([flexMsg]);
  return lineReply(replyToken, withQuickReply([{type:'text',text:`📢 ส่งแจ้งเตือน Broadcast สำเร็จ\nพบ ${alertList.length} สถานีผิดปกติ`}]));
}

// ═══ [ประหยัดดาวน์โหลด] โหลด history เฉพาะ "วันนี้" รายสถานี แทนการโหลดทั้ง node 7 วัน ═══
// ใช้กับ สรุปวัน / ตารางสรุปวัน / broadcast สรุปวัน ซึ่งกรอง p.ts >= เที่ยงคืนวันนี้อยู่แล้ว
// - รายชื่อสถานีเอาจาก /live (poll.yml เขียน key รูปแบบเดียวกับ history) ~3 KB
// - key ของ history = timestamp ms (13 หลัก ยาวเท่ากัน) → orderByKey().startAt() กรองที่ server ได้ ไม่ต้องตั้ง index
// - คืนค่าหน้าตาเหมือน DataSnapshot (exists / forEach) ฟังก์ชันเดิมจึงทำงานเหมือนเดิมทุกบรรทัด
async function loadTodayHistorySnap() {
  // [แก้ ต.ค.69] เที่ยงคืน 'เวลาไทย' — server Railway เป็น UTC, setHours(0) เดิมได้ 07:00 น. ไทย
  const startKey = String(bkkMidnight() - 60 * 60 * 1000);  // เผื่อ 1 ชม. (ฟังก์ชันเดิมกรอง ts อีกชั้น)
  const liveSnap = await db.ref('live').once('value');
  const codes = Object.keys(liveSnap.val() || {});
  const results = await Promise.all(codes.map(code =>
    db.ref(`history/${code}`).orderByKey().startAt(startKey).once('value')
      .then(s => [code, s]).catch(() => [code, null])));
  const hits = results.filter(([, s]) => s && s.exists());
  return {
    exists: () => hits.length > 0,
    forEach: (fn) => { for (const [code, s] of hits) {
      if (fn({ key: code, val: () => s.val(), forEach: (g) => s.forEach(g) }) === true) return true;
    } return false; }
  };
}

async function handleBroadcastDaily(replyToken) {
  try {
    const snap = await loadTodayHistorySnap();   // [ประหยัดดาวน์โหลด] เดิมโหลด history ทั้งก้อน 7 วัน
    if (!snap.exists()) { if (replyToken) await lineReply(replyToken, withQuickReply([{type:'text',text:'❌ ไม่พบข้อมูลประวัติ'}])); return; }
    const todayMs = bkkMidnight();   // [แก้ ต.ค.69] เที่ยงคืนเวลาไทย (เดิม setHours(0) บน UTC = 07:00 น. ไทย)
    const stationReadings = {};
    snap.forEach(cs => {
      const code = cs.key; if (code.startsWith('_')) return;
      cs.forEach(ps => { const p = ps.val(); if (p && p.ts >= todayMs && p.frc != null && p.frc > 0) { if (!stationReadings[code]) stationReadings[code] = []; stationReadings[code].push(p.frc); } });
    });
    if (Object.keys(stationReadings).length === 0) { if (replyToken) await lineReply(replyToken, withQuickReply([{type:'text',text:'📊 ยังไม่มีข้อมูลสะสมวันนี้'}])); return; }
    const sensors = await fetchSensors();
    const sMap = {}; for (const s of sensors) { sMap[String(s.id)] = s; sMap[String(s.id).replace(/\/|\./g,'-')] = s; }
    const daily = Object.entries(stationReadings).map(([code, r]) => { const avg = r.reduce((a,b)=>a+b,0)/r.length; const s = sMap[code]||{}; return {id:code,name:s.name||code,frc:parseFloat(avg.toFixed(3)),type:s.type||'monitor'}; });
    const sendS=daily.filter(s=>getStationType(s)==='send'), pumpS=daily.filter(s=>getStationType(s)==='pump'), monS=daily.filter(s=>getStationType(s)==='monitor');
    function cnt(list,thType){let ok=0,watch=0,low=0,high=0;for(const s of list){const th=getThreshold(thType,s.id);if(s.frc>th.high)high++;else if(s.frc>=th.good)ok++;else if(s.frc>=th.watch)watch++;else low++;}return{ok,watch,low,high,total:list.length};}
    const sc=cnt(sendS,'send'),pc=cnt(pumpS,'pump'),mc=cnt(monS,'monitor');
    const total=daily.length, avgFrc=(daily.reduce((a,s)=>a+s.frc,0)/total).toFixed(2);
    const allOk=sc.ok+pc.ok+mc.ok, normalPct=total>0?Math.round((allOk/total)*100):0;
    let oe,ot,ob; if(normalPct>=90){oe='🟢';ot='ดี';ob='#ecfdf5';}else if(normalPct>=70){oe='🟡';ot='พอใช้';ob='#fffbeb';}else{oe='🔴';ot='ต้องติดตาม';ob='#fef2f2';}
    const avgSend=sendS.length?(sendS.reduce((a,s)=>a+s.frc,0)/sendS.length).toFixed(2):'-';
    const avgPump=pumpS.length?(pumpS.reduce((a,s)=>a+s.frc,0)/pumpS.length).toFixed(2):'-';
    const avgMon=monS.length?(monS.reduce((a,s)=>a+s.frc,0)/monS.length).toFixed(2):'-';
    function typeRow(iconUrl,label,count,avg,bgTint,thType){const th=THRESHOLDS[thType]||THRESHOLDS.monitor;return{type:"box",layout:"horizontal",margin:"xs",paddingAll:"8px",paddingStart:"10px",cornerRadius:"8px",backgroundColor:bgTint||COLORS.bgCard,contents:[{type:"box",layout:"vertical",flex:0,width:"56px",height:"56px",justifyContent:"center",alignItems:"center",contents:[{type:"image",url:iconUrl,size:"56px",aspectMode:"fit",aspectRatio:"1:1"}]},{type:"box",layout:"vertical",flex:5,margin:"md",justifyContent:"center",contents:[{type:"box",layout:"horizontal",contents:[{type:"text",text:label,size:"sm",weight:"bold",color:COLORS.textPrimary,flex:3},{type:"text",text:`${avg}`,size:"md",color:COLORS.accent,weight:"bold",flex:0},{type:"text",text:" mg/L",size:"xxs",color:COLORS.textMuted,flex:0,gravity:"bottom"}]},{type:"text",text:`✅${count.ok} ⚠️${count.watch} ❌${count.low} 🔶${count.high}  ·  ${count.total} สถานี`,size:"xxs",color:COLORS.textSecondary,margin:"none"}]}]};}
    const flexMsg={type:"flex",altText:`📊 สรุปวัน — ${oe}${ot} FRC ${avgFrc} mg/L`,contents:{type:"bubble",size:"mega",header:{type:"box",layout:"vertical",backgroundColor:COLORS.headerDark,paddingAll:"16px",paddingBottom:"14px",contents:[{type:"box",layout:"horizontal",spacing:"lg",alignItems:"center",contents:[{type:"box",layout:"vertical",flex:0,width:"40px",height:"40px",cornerRadius:"12px",backgroundColor:"#ffffff20",justifyContent:"center",alignItems:"center",contents:[{type:"image",url:IMAGES.logo,size:"32px",aspectMode:"fit",aspectRatio:"1:1"}]},{type:"box",layout:"vertical",flex:5,contents:[{type:"text",text:"📊 สรุปประจำวัน",color:"#ffffff",weight:"bold",size:"lg",wrap:true},{type:"text",text:`(เวลา 0.00 น. – ปัจจุบัน)`,color:"#ffffffe0",size:"sm",weight:"bold",margin:"xs",wrap:true},{type:"text",text:`${thaiDate()} ${thaiTime()} น.`,color:"#ffffffaa",size:"xs",margin:"xs",wrap:true}]}]}]},body:{type:"box",layout:"vertical",paddingAll:"10px",paddingTop:"8px",contents:[{type:"box",layout:"horizontal",paddingAll:"10px",cornerRadius:"8px",backgroundColor:ob,contents:[{type:"text",text:oe,size:"xl",flex:0,gravity:"center"},{type:"box",layout:"vertical",flex:5,margin:"sm",contents:[{type:"text",text:`ภาพรวม: ${ot}`,size:"sm",weight:"bold",color:COLORS.textPrimary},{type:"text",text:`ปกติ ${allOk}/${total} สถานี (${normalPct}%)`,size:"xxs",color:COLORS.textSecondary},makeProgressBar(normalPct,normalPct>=80?COLORS.good:normalPct>=50?COLORS.warn:COLORS.bad)]}]},{type:"separator",margin:"sm"},makeStatRow("FRC เฉลี่ยทั้งวัน",`${avgFrc} mg/L`),{type:"separator",margin:"sm"},typeRow(IMAGES.iconSend,"สูบส่ง",sc,avgSend,"#dbeafe",'send'),typeRow(IMAGES.iconPump,"สูบจ่าย",pc,avgPump,"#d1fae5",'pump'),typeRow(IMAGES.iconMonitor,"Monitor",mc,avgMon,"#ede9fe",'monitor')]},footer:{type:"box",layout:"horizontal",paddingAll:"6px",spacing:"xs",contents:[{type:"button",action:{type:"uri",label:"🗺️ แผนที่",uri:CONTOUR_URL},height:"sm",style:"primary",color:"#0f172a",flex:1}]}}};
    await lineBroadcast([flexMsg]);
    console.log(`[Broadcast] ส่งสรุปวัน broadcast สำเร็จ`);
    if (replyToken) await lineReply(replyToken, withQuickReply([{type:'text',text:`📢 ส่งสรุปวัน Broadcast สำเร็จ\n\n${oe} ภาพรวม: ${ot}\nFRC เฉลี่ย: ${avgFrc} mg/L\nปกติ ${allOk}/${total} สถานี (${normalPct}%)`}]));
  } catch(err) {
    console.error('[Broadcast Daily Error]', err.message);
    if (replyToken) await lineReply(replyToken, withQuickReply([{type:'text',text:'❌ ส่งสรุปวัน error: '+err.message}]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🌫️ สรุปความขุ่น (TWQMS tub_1 จาก history_wq ที่ collector บันทึกทุก 15 นาที)
// คำสั่ง: "สรุปความขุ่น" / "สรุปขุ่น" / "ความขุ่น" = วันนี้ 0.00 น.–ปัจจุบัน
//         "ขุ่นเมื่อวาน" / "สรุปความขุ่นเมื่อวาน" = เมื่อวานทั้งวัน
// จัดกลุ่มเหมือน report_turbidity.html: น้ำออก 4 โรงงาน + 5 ภาค (บริการ 1–5)
// เกณฑ์: เขียว ≤ 4.00 · เหลือง > 4.00–5.00 · แดง > 5.00 NTU
// ═══════════════════════════════════════════════════════════════════════════════
const TUR_STATIONS = {"SP01":["สถานีสูบส่งน้ำบางเขน 1 (TR1)","ประชาชื่น",13.87858,100.55298],"SW01":["สถานีสูบจ่ายน้ำลุมพินี","แม้นศรี",13.734649,100.53785],"SM02":["สำนักงานประปาสาขาทุ่งมหาเมฆ","ทุ่งมหาเมฆ",13.71571,100.539415],"SW11":["สถานีสูบจ่ายน้ำพหลโยธิน","พญาไท",13.787854,100.55427],"SP02":["สถานีสูบส่งน้ำบางเขน 2 (TR2)","ประชาชื่น",13.878268,100.5544],"SW02":["สถานีสูบจ่ายน้ำลาดพร้าว","ลาดพร้าว",13.766959,100.59763],"S008":["บริษัท โอสถสภา จำกัด (มหาชน)","สุขุมวิท",13.760925,100.631088],"S009":["สถานคุ้มครองและพัฒนาอาชีพบ้านเกร็ดตระการ","ลาดพร้าว",13.80942,100.615716],"SW03":["สถานีสูบจ่ายน้ำคลองเตย","สุขุมวิท",13.715186,100.58102],"S010":["ศูนย์วิทยาศาสตร์เพื่อการศึกษาแห่งชาติ","สุขุมวิท",13.720083,100.582425],"SM03":["สำนักงานประปาสาขาสุขุมวิท-พระโขนง","พระโขนง",13.708,100.59941],"SW04":["สถานีสูบจ่ายน้ำสำโรง","พระโขนง",13.662468,100.59082],"S011":["บริษัท ศิครินทร์ จำกัด (มหาชน) (โรงพยาบาลศิครินทร์)","พระโขนง",13.655181,100.645761],"S012":["โรงเรียนหาดอมราอักษรลักษณ์วิทยา","สมุทรปราการ",13.560314,100.590053],"S013":["บริษัท เอจีซี แฟลทกลาส (ประเทศไทย) จำกัด (มหาชน)","สุขสวัสดิ์",13.604611,100.555855],"SM04":["สำนักงานประปาสาขาสมุทรปราการ","สมุทรปราการ",13.604564,100.598424],"S014":["โรงไฟฟ้าพระนครใต้","สมุทรปราการ",13.620921,100.561644],"SP03":["สถานีสูบส่งน้ำบางเขน 3 (TR3)","ประชาชื่น",13.877851,100.55593],"SW05":["สถานีสูบจ่ายน้ำมีนบุรี","มีนบุรี",13.826229,100.74055],"S015":["บริษัท มหาจักรออโตพาร์ท จำกัด","มีนบุรี",13.83018,100.849967],"SM05":["สำนักงานประปาสาขามีนบุรี","มีนบุรี",13.814991,100.74118],"S016":["นิคมอุตสาหกรรมบางชัน","มีนบุรี",13.801554,100.705106],"S017":["ศูนย์ไตเทียมเทียนฟ้าประชาการุณย์","มีนบุรี",13.828346,100.720017],"SW06":["สถานีสูบจ่ายน้ำลาดกระบัง","สุวรรณภูมิ",13.724753,100.741005],"S019":["บริษัท ท่าอากาศยานไทย มหาชน จำกัด (สุวรรณภูมิ)","สุวรรณภูมิ",13.713374,100.76257],"S018":["นิคมอุตสาหกรรมลาดกระบัง","สุวรรณภูมิ",13.758024,100.79126],"S020":["มหาวิทยาลัยหัวเฉียวเฉลิมพระเกียรติ (วิทยาเขตบางพลี)","สุวรรณภูมิ",13.612905,100.756515],"SW07":["สถานีสูบจ่ายน้ำบางพลี","สมุทรปราการ",13.598997,100.713974],"S021":["นิคมอุตสาหกรรมบางพลี","สมุทรปราการ",13.565099,100.791495],"S022":["สถานีตำรวจภูธรคลองด่าน","สมุทรปราการ",13.502919,100.836085],"S023":["นิคมอุตสาหกรรมบางปู","สมุทรปราการ",13.541545,100.66235],"SP04":["สถานีสูบจ่ายน้ำบางเขน 1 (Dis1)","ประชาชื่น",13.877877,100.55349],"SM01":["สำนักงานประปาสาขานนทบุรี","นนทบุรี",13.87789,100.514037],"S003":["กองพันทหารสื่อสาร กองบัญชาการกองทัพไทย","ประชาชื่น",13.93261,100.58014],"S002":["โรงเรียนทหารขนส่ง กรมการขนส่งทหารบก","นนทบุรี",13.931563,100.532203],"SP05":["สถานีสูบจ่ายน้ำบางเขน 2 (Dis2)","ประชาชื่น",13.877606,100.554955],"S005":["โรงพยาบาลซีจีเอช สายไหม","บางเขน",13.924336,100.684037],"S004":["โรงพยาบาลภูมิพลอดุลยเดช","บางเขน",13.909108,100.616983],"SP11":["สถานีสูบส่งน้ำมหาสวัสดิ์","ประชาชื่น",13.87858,100.55298],"SW08":["สถานีสูบจ่ายน้ำราษฎร์บูรณะ","ตากสิน",13.675917,100.467606],"S026":["ม.เทคโนโลยีพระจอมเกล้าธนบุรี (วิทยาเขตบางขุนเทียน)","ตากสิน",13.574889,100.438535],"S025":["ศูนย์กีฬาเฉลิมพระเกียรติ","สุขสวัสดิ์",13.648373,100.49335],"SW09":["สถานีสูบจ่ายน้ำเพชรเกษม","ภาษีเจริญ",13.72472,100.40649],"S027":["มหาวิทยาลัยเอเชียอาคเนย์","ภาษีเจริญ",13.706699,100.355239],"S028":["เรือนจำพิเศษธนบุรี","ภาษีเจริญ",13.645822,100.385196],"SW10":["สถานีสูบจ่ายน้ำท่าพระ","บางกอกน้อย",13.731417,100.47622],"S033":["โรงพยาบาลสมเด็จพระปิ่นเกล้า กรมแพทย์ทหารเรือ","ตากสิน",13.710108,100.486837],"S024":["ศูนย์พัฒนาการจัดสวัสดิการสังคมผู้สูงอายุบ้านบางแค (บ้านพักคนชราบางแค)","ภาษีเจริญ",13.711507,100.426571],"SP12":["สถานีสูบจ่ายน้ำมหาสวัสดิ์","มหาสวัสดิ์",13.807434,100.409775],"S029":["โรงเรียนบดินทรเดชา (สิงห์ สิงหเสนี) นนทบุรี","มหาสวัสดิ์",13.806157,100.478711],"S032":["โรงเรียนตั้งพิรุฬห์ธรรม","บางกอกน้อย",13.780158,100.344283],"SM06":["สำนักงานประปาสาขาบางบัวทอง","บางบัวทอง",13.911923,100.424523],"S030":["โรงเรียนราชวินิต นนทบุรี","มหาสวัสดิ์",13.839914,100.348271],"S001":["โรงเรียนเตรียมอุดมศึกษาน้อมเกล้า นนทบุรี","บางบัวทอง",13.926307,100.480931],"S031":["สถานีตำรวจภูธรไทรน้อย","บางบัวทอง",13.98311,100.323411],"SP06":["โรงงานผลิตน้ำธนบุรี","บางกอกน้อย",13.759008,100.47099],"S007":["โรงพยาบาลศิริราช","บางกอกน้อย",13.759399,100.484423],"SP07":["โรงงานผลิตน้ำสามเสน 1","พญาไท",13.773751,100.5303],"SP08":["โรงงานผลิตน้ำสามเสน 2","พญาไท",13.774175,100.53128],"SP09":["โรงงานผลิตน้ำสามเสน 3","พญาไท",13.775821,100.52958],"S006":["พระราชวังดุสิต สวนจิตรลดา","แม้นศรี",13.772542,100.520972],"SP10":["โรงงานผลิตน้ำสามเสน 4","พญาไท",13.77449,100.52874]};   // id → [ชื่อ, สาขา, lat, lon] (สาขาจากขอบเขต MWADistrict ของ TWQMS)
const TUR_PLANTS = [
  { name: 'รง.บางเขน',     ids: ['SP01','SP02','SP03','SP04','SP05'] },
  { name: 'รง.มหาสวัสดิ์', ids: ['SP11','SP12'] },
  { name: 'รง.สามเสน',     ids: ['SP07','SP08','SP09','SP10'] },
  { name: 'รง.ธนบุรี',      ids: ['SP06'] },
];
const TUR_REGIONS = [
  { name: 'บริการ 1', col: '#d9692b', bg: '#fdf0e8', br: ['สุขุมวิท','พระโขนง','สมุทรปราการ','ทุ่งมหาเมฆ'] },
  { name: 'บริการ 2', col: '#8e5fc2', bg: '#f3edfa', br: ['แม้นศรี','พญาไท','ลาดพร้าว'] },
  { name: 'บริการ 3', col: '#2f8fd8', bg: '#e8f2fb', br: ['ประชาชื่น','บางเขน','มีนบุรี','สุวรรณภูมิ'] },
  { name: 'บริการ 4', col: '#b8901a', bg: '#fbf5e3', br: ['ตากสิน','สุขสวัสดิ์','บางกอกน้อย','ภาษีเจริญ'] },
  { name: 'บริการ 5', col: '#2fa88a', bg: '#e5f5f0', br: ['นนทบุรี','บางบัวทอง','มหาสวัสดิ์'] },
];
const TUR_PLANT_IDS = TUR_PLANTS.flatMap(p => p.ids);
const TUR_HEADER_COL = '#0284c7';   // หัวการ์ดความขุ่น: ฟ้าน้ำทะเล (เด่นกว่า navy)
const TUR_REPORT_URL = 'https://piphatboribannukul.github.io/FRCfirebase/report_turbidity.html';
const turColor = v => v == null ? '#94a3b8' : v <= 4 ? COLORS.good : v <= 5 ? COLORS.warn : COLORS.bad;
const turDot   = v => v == null ? '⚪' : v <= 4 ? '🟢' : v <= 5 ? '🟡' : '🔴';

// เที่ยงคืนเวลาไทย (server Railway เป็น UTC — ห้ามใช้ setHours(0) ตรงๆ)
function bkkMidnight(dayOffset = 0) {
  const b = new Date(Date.now() + 7 * 3600e3);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 7 * 3600e3 + dayOffset * 86400e3;
}

// อ่าน history_wq ช่วงเวลา → สถิติรายสถานี {avg,max,maxTs,min,n}
const _turCache = {};   // กันโหลดซ้ำ: การ์ด + รูปแผนที่เรียกช่วงเดียวกันภายใน 2 นาที
async function loadTurbidityStats(startTs, endTs) {
  const ck = `${startTs}-${endTs || ''}`, hit = _turCache[ck];
  if (hit && Date.now() - hit.t < 120000) return hit.v;
  const v = await _loadTurbidityStats(startTs, endTs); _turCache[ck] = { t: Date.now(), v }; return v;
}
async function _loadTurbidityStats(startTs, endTs) {
  const ids = Object.keys(TUR_STATIONS);
  const out = {};
  await Promise.all(ids.map(async id => {
    try {
      let q = db.ref(`history_wq/${id}`).orderByKey().startAt(String(startTs));
      if (endTs) q = q.endAt(String(endTs - 1));
      const snap = await q.once('value');
      const v = snap.val() || {};
      let sum = 0, n = 0, max = null, maxTs = 0, min = null;
      for (const p of Object.values(v)) {
        const t = Number(p && p.tub);
        if (!isFinite(t) || t < 0 || t > 1000) continue;            // ตัดค่าเสีย (-9999 ฯลฯ)
        sum += t; n++;
        if (max == null || t > max) { max = t; maxTs = p.ts; }
        if (min == null || t < min) min = t;
      }
      if (n) out[id] = { avg: sum / n, max, maxTs, min, n };
    } catch (e) { console.error('[Turbidity] load', id, e.message); }
  }));
  return out;
}

function turGroupStats(ids, S) {
  const d = ids.filter(id => S[id]);
  if (!d.length) return { avg: null, max: null, n: 0, tot: ids.length };
  const top = d.reduce((a, b) => (S[b].max > S[a].max ? b : a));
  return { avg: d.reduce((a, id) => a + S[id].avg, 0) / d.length, max: S[top].max, maxId: top, n: d.length, tot: ids.length };
}
const turType = id => SEND_IDS.includes(id) ? 'send' : (PUMP_IDS.includes(id) || id.startsWith('SW') || id.startsWith('SP')) ? 'pump' : 'monitor';
const turRegionIds = r => Object.keys(TUR_STATIONS).filter(id => r.br.includes(TUR_STATIONS[id][1]) && !TUR_PLANT_IDS.includes(id));

// ═══════════════════════════════════════════════════════════════════════════════
// 🗺️ แผนที่ความขุ่น (PNG) สำหรับ hero ของการ์ด LINE — ลงสีพื้นที่ตามภาค (บริการ 1–5), จุดสถานีตามเกณฑ์
// ต้องมี dependency "@napi-rs/canvas" — ถ้าติดตั้งไม่ได้ การ์ดจะส่งแบบไม่มีแผนที่ (ไม่กระทบส่วนอื่น)
// ฟอนต์ไทย Sarabun ดาวน์โหลดจาก GitHub ครั้งแรกแล้วเก็บไว้ใน /tmp
// ═══════════════════════════════════════════════════════════════════════════════
let TUR_CANVAS = null;
try { TUR_CANVAS = require('@napi-rs/canvas'); } catch (e) { console.warn('[TurMap] @napi-rs/canvas ไม่พร้อม — การ์ดความขุ่นจะไม่มีแผนที่:', e.message); }
const TUR_BRANCH_POLY = [{"n":"ภาษีเจริญ","c":[[13.723,100.4705],[13.7244,100.4681],[13.7253,100.4671],[13.7281,100.4652],[13.7325,100.4627],[13.735,100.4622],[13.7364,100.462],[13.7389,100.4616],[13.7417,100.4616],[13.7444,100.462],[13.7441,100.4606],[13.7436,100.4596],[13.7436,100.4588],[13.7439,100.4579],[13.7439,100.4572],[13.7436,100.4568],[13.7432,100.457],[13.7429,100.4569],[13.7421,100.4564],[13.7419,100.4553],[13.7424,100.455],[13.7425,100.4544],[13.742,100.454],[13.7418,100.4534],[13.7411,100.4523],[13.7411,100.4507],[13.7404,100.4498],[13.7409,100.4491],[13.7403,100.4479],[13.7403,100.4473],[13.7407,100.4462],[13.7406,100.4444],[13.7401,100.4432],[13.7405,100.4406],[13.7402,100.44],[13.74,100.4391],[13.74,100.4351],[13.7403,100.4337],[13.7403,100.4324],[13.7408,100.4319],[13.7421,100.4312],[13.7423,100.4309],[13.7424,100.4303],[13.7422,100.4297],[13.7424,100.4272],[13.7428,100.4257],[13.7435,100.4249],[13.7436,100.424],[13.7442,100.4215],[13.7446,100.4209],[13.7456,100.4197],[13.7472,100.4168],[13.7491,100.4082],[13.7498,100.404],[13.7502,100.4024],[13.751,100.3971],[13.753,100.3806],[13.7536,100.3732],[13.7538,100.3658],[13.7538,100.3631],[13.7536,100.3611],[13.7521,100.3522],[13.7512,100.3481],[13.7492,100.3444],[13.7491,100.3414],[13.7478,100.3347],[13.7476,100.3314],[13.7463,100.3318],[13.7441,100.3318],[13.741,100.3326],[13.7397,100.3332],[13.7392,100.3332],[13.7368,100.3328],[13.7352,100.3335],[13.7326,100.3351],[13.7323,100.3351],[13.7318,100.335],[13.7294,100.3365],[13.7293,100.3365],[13.7291,100.3361],[13.728,100.3365],[13.7277,100.3363],[13.7261,100.337],[13.726,100.3364],[13.7242,100.3363],[13.723,100.3364],[13.7221,100.3362],[13.7218,100.3362],[13.7211,100.3363],[13.7182,100.338],[13.7182,100.3379],[13.7176,100.3381],[13.7177,100.3383],[13.7159,100.3387],[13.715,100.3377],[13.714,100.3379],[13.7132,100.3382],[13.7126,100.3386],[13.7118,100.3372],[13.7116,100.3352],[13.7132,100.3348],[13.713,100.3342],[13.7123,100.3325],[13.7103,100.3335],[13.71,100.3336],[13.71,100.3333],[13.7088,100.3334],[13.7078,100.3333],[13.7065,100.3328],[13.7036,100.3312],[13.702,100.3313],[13.7019,100.3312],[13.7019,100.3303],[13.6999,100.3303],[13.6974,100.3314],[13.6926,100.332],[13.6923,100.3321],[13.6917,100.332],[13.6909,100.332],[13.6877,100.3326],[13.6834,100.3339],[13.6816,100.3334],[13.677,100.3361],[13.6772,100.3375],[13.6762,100.338],[13.6742,100.3385],[13.6727,100.3385],[13.6718,100.3387],[13.6692,100.3389],[13.6684,100.3393],[13.6677,100.3394],[13.6664,100.3403],[13.6658,100.3401],[13.6655,100.3401],[13.6636,100.3406],[13.6625,100.3407],[13.6617,100.3412],[13.6613,100.3413],[13.6606,100.3413],[13.6597,100.3409],[13.6589,100.3409],[13.6574,100.3397],[13.6567,100.3394],[13.6554,100.3394],[13.6543,100.3396],[13.653,100.3389],[13.6518,100.3386],[13.6515,100.3386],[13.6511,100.3388],[13.6503,100.3386],[13.6431,100.3382],[13.6424,100.3383],[13.639,100.3407],[13.6388,100.341],[13.6389,100.3417],[13.6392,100.3423],[13.6393,100.3437],[13.6393,100.3453],[13.6402,100.3478],[13.6404,100.3486],[13.6403,100.3503],[13.6401,100.3503],[13.6402,100.3519],[13.6403,100.3521],[13.6409,100.352],[13.6408,100.3538],[13.6409,100.3544],[13.6412,100.3544],[13.6419,100.3541],[13.6421,100.3542],[13.6422,100.3546],[13.6418,100.3548],[13.6418,100.3549],[13.6422,100.3558],[13.6423,100.3561],[13.6411,100.3569],[13.6369,100.3583],[13.6367,100.3585],[13.6348,100.3585],[13.6342,100.3586],[13.6344,100.36],[13.6333,100.3601],[13.6334,100.3611],[13.6333,100.3612],[13.6329,100.3612],[13.6329,100.3616],[13.6315,100.3617],[13.6314,100.3619],[13.6315,100.3624],[13.6313,100.3627],[13.6312,100.363],[13.6308,100.3627],[13.6299,100.3632],[13.6296,100.363],[13.6294,100.363],[13.6289,100.3638],[13.6282,100.3645],[13.628,100.3649],[13.6274,100.365],[13.6274,100.3651],[13.6277,100.3656],[13.6274,100.366],[13.6272,100.3672],[13.627,100.3673],[13.6263,100.3671],[13.6261,100.3674],[13.6258,100.3689],[13.6256,100.3691],[13.6256,100.3697],[13.6253,100.3702],[13.6256,100.3709],[13.6255,100.3711],[13.6249,100.3714],[13.6244,100.3712],[13.6231,100.3716],[13.6208,100.3719],[13.6207,100.372],[13.6208,100.373],[13.6201,100.3729],[13.6191,100.3745],[13.6185,100.3751],[13.6675,100.43],[13.6732,100.4296],[13.6785,100.429],[13.6803,100.4286],[13.6888,100.4276],[13.6917,100.427],[13.6945,100.4267],[13.6981,100.4265],[13.6996,100.4267],[13.7073,100.4262],[13.7225,100.4693],[13.723,100.4705]],"cen":[13.6862,100.3805]},{"n":"บางเขน","c":[[13.9314,100.6418],[13.9318,100.6405],[13.9322,100.64],[13.9328,100.6398],[13.9344,100.6398],[13.935,100.6259],[13.9487,100.6252],[13.9505,100.6223],[13.9271,100.6265],[13.9261,100.6264],[13.8998,100.611],[13.8977,100.6077],[13.8971,100.607],[13.8955,100.6057],[13.8911,100.5988],[13.8885,100.5955],[13.8816,100.5893],[13.8797,100.5881],[13.8786,100.5879],[13.8589,100.5864],[13.8566,100.5874],[13.8521,100.5876],[13.85,100.5882],[13.8463,100.5888],[13.8438,100.5897],[13.8441,100.5909],[13.8453,100.594],[13.8457,100.5957],[13.8458,100.5969],[13.8461,100.5976],[13.8463,100.5987],[13.8468,100.6023],[13.8481,100.6043],[13.8489,100.6058],[13.8492,100.6069],[13.8491,100.6086],[13.8491,100.614],[13.8484,100.6196],[13.8481,100.6208],[13.8472,100.6217],[13.8466,100.6227],[13.8458,100.6235],[13.8435,100.6278],[13.8431,100.6284],[13.8426,100.6287],[13.8427,100.6311],[13.8425,100.633],[13.8439,100.636],[13.8436,100.6367],[13.8448,100.6373],[13.8457,100.6386],[13.8462,100.6394],[13.8466,100.6409],[13.8474,100.6462],[13.8462,100.6485],[13.8464,100.65],[13.8469,100.6521],[13.8468,100.6531],[13.8474,100.6555],[13.8478,100.6565],[13.8477,100.6587],[13.8486,100.6589],[13.8486,100.6592],[13.8488,100.6592],[13.8491,100.6612],[13.8498,100.6615],[13.8505,100.6632],[13.8506,100.6651],[13.8505,100.6657],[13.851,100.6676],[13.8524,100.6698],[13.8527,100.6708],[13.8535,100.6707],[13.8554,100.6742],[13.8573,100.6762],[13.858,100.6771],[13.8584,100.6788],[13.8584,100.6793],[13.8587,100.6803],[13.8598,100.681],[13.8607,100.6821],[13.8621,100.6831],[13.8628,100.6834],[13.8659,100.6839],[13.8666,100.6842],[13.8693,100.6857],[13.87,100.6855],[13.8728,100.6845],[13.8742,100.6844],[13.8746,100.6845],[13.8753,100.685],[13.8765,100.6864],[13.8779,100.6873],[13.8787,100.688],[13.8791,100.6887],[13.8797,100.6898],[13.8799,100.6899],[13.8803,100.6899],[13.8816,100.6893],[13.8836,100.6897],[13.8852,100.6903],[13.8857,100.6907],[13.8867,100.692],[13.8872,100.6914],[13.8885,100.6913],[13.8918,100.6915],[13.8969,100.6923],[13.898,100.6922],[13.8985,100.692],[13.8992,100.6916],[13.9003,100.6906],[13.9006,100.6904],[13.9013,100.6903],[13.9032,100.6895],[13.9049,100.6882],[13.9058,100.6877],[13.9077,100.687],[13.909,100.687],[13.9093,100.6869],[13.9102,100.6858],[13.9115,100.6835],[13.9137,100.6837],[13.9142,100.6842],[13.9145,100.685],[13.9152,100.6859],[13.9171,100.6875],[13.9175,100.6875],[13.9185,100.6873],[13.9207,100.6872],[13.923,100.688],[13.9238,100.6886],[13.9249,100.6887],[13.9259,100.6894],[13.9264,100.6894],[13.9292,100.6898],[13.931,100.6899],[13.9308,100.6892],[13.931,100.6863],[13.9309,100.686],[13.9308,100.6818],[13.9309,100.6782],[13.9305,100.6683],[13.9305,100.6636],[13.9308,100.6615],[13.9306,100.659],[13.931,100.6515],[13.9312,100.6502],[13.9312,100.6479],[13.9313,100.6471],[13.9314,100.6418]],"cen":[13.8966,100.6494]},{"n":"มีนบุรี","c":[[13.7378,100.8789],[13.7542,100.8894],[13.7665,100.8965],[13.79,100.9096],[13.7909,100.9104],[13.7948,100.9175],[13.8014,100.9288],[13.8029,100.9297],[13.8133,100.9376],[13.8144,100.9386],[13.8381,100.9078],[13.8415,100.9091],[13.8437,100.9107],[13.8446,100.9116],[13.8468,100.9128],[13.8474,100.909],[13.8477,100.9081],[13.8489,100.9022],[13.8541,100.9034],[13.859,100.9047],[13.8591,100.9055],[13.8598,100.9056],[13.8605,100.9063],[13.8658,100.9064],[13.8702,100.9062],[13.8805,100.9064],[13.8958,100.9079],[13.9062,100.909],[13.9447,100.9141],[13.9486,100.914],[13.9436,100.8648],[13.941,100.8433],[13.9401,100.837],[13.9396,100.8337],[13.9366,100.8208],[13.9369,100.8208],[13.9327,100.7995],[13.931,100.7918],[13.9277,100.7596],[13.9258,100.7471],[13.924,100.7327],[13.924,100.7277],[13.9224,100.7181],[13.9201,100.7078],[13.9195,100.7028],[13.9189,100.6924],[13.9191,100.6873],[13.9183,100.6873],[13.9175,100.6875],[13.9171,100.6875],[13.9152,100.6859],[13.9145,100.685],[13.9142,100.6842],[13.9137,100.6837],[13.9115,100.6835],[13.9102,100.6858],[13.9093,100.6869],[13.909,100.687],[13.9077,100.687],[13.9058,100.6877],[13.9049,100.6882],[13.9032,100.6895],[13.9013,100.6903],[13.9006,100.6904],[13.9003,100.6906],[13.8992,100.6916],[13.8985,100.692],[13.898,100.6922],[13.8969,100.6923],[13.8918,100.6915],[13.8885,100.6913],[13.8872,100.6914],[13.8867,100.692],[13.8857,100.6907],[13.8852,100.6903],[13.8836,100.6897],[13.8816,100.6893],[13.8803,100.6899],[13.8799,100.6899],[13.8797,100.6898],[13.8791,100.6887],[13.8787,100.688],[13.8779,100.6873],[13.8765,100.6864],[13.8753,100.685],[13.8746,100.6845],[13.8742,100.6844],[13.8728,100.6845],[13.87,100.6855],[13.8693,100.6857],[13.8666,100.6842],[13.8659,100.6839],[13.8628,100.6834],[13.8618,100.6829],[13.8607,100.6821],[13.8598,100.681],[13.8587,100.6803],[13.8584,100.6793],[13.8584,100.6788],[13.8581,100.6774],[13.8577,100.6767],[13.8554,100.6742],[13.8535,100.6707],[13.8527,100.6708],[13.8525,100.6709],[13.8523,100.6716],[13.8522,100.6738],[13.8515,100.677],[13.8504,100.6787],[13.8503,100.6797],[13.85,100.6804],[13.8491,100.6823],[13.848,100.6838],[13.8468,100.6843],[13.8451,100.6855],[13.8437,100.686],[13.8417,100.6864],[13.8402,100.6868],[13.8386,100.6877],[13.8382,100.6878],[13.836,100.6883],[13.835,100.6878],[13.8347,100.6878],[13.8329,100.6901],[13.8324,100.6905],[13.8309,100.6909],[13.8301,100.6919],[13.8248,100.6948],[13.8242,100.6952],[13.8232,100.6954],[13.8222,100.6954],[13.8216,100.6956],[13.8208,100.6961],[13.8203,100.6969],[13.8173,100.6965],[13.8165,100.6966],[13.8147,100.6968],[13.8126,100.6975],[13.8122,100.6978],[13.8112,100.6987],[13.8095,100.7014],[13.8089,100.7018],[13.8079,100.7021],[13.807,100.702],[13.8054,100.7011],[13.8047,100.7005],[13.8044,100.7005],[13.7976,100.7049],[13.7982,100.7061],[13.7851,100.7136],[13.7827,100.7149],[13.7815,100.7153],[13.7799,100.7155],[13.778,100.7163],[13.7779,100.7173],[13.7777,100.7173],[13.7777,100.7169],[13.7769,100.717],[13.7769,100.7177],[13.7762,100.7178],[13.7762,100.7175],[13.7759,100.7175],[13.7759,100.7178],[13.7756,100.7178],[13.7756,100.7173],[13.7754,100.7173],[13.7754,100.717],[13.7751,100.717],[13.7751,100.7168],[13.775,100.7168],[13.775,100.7174],[13.7746,100.7177],[13.7746,100.718],[13.7743,100.718],[13.7743,100.7178],[13.7732,100.7189],[13.7729,100.7196],[13.7716,100.7209],[13.7731,100.7215],[13.7729,100.7221],[13.7767,100.7237],[13.7762,100.7248],[13.776,100.7256],[13.7746,100.7337],[13.7762,100.7368],[13.7762,100.7375],[13.7758,100.7376],[13.7758,100.7382],[13.776,100.7384],[13.776,100.7388],[13.7738,100.7389],[13.7741,100.7463],[13.7767,100.7464],[13.7768,100.7538],[13.7777,100.7539],[13.7766,100.7557],[13.7757,100.7584],[13.7757,100.7594],[13.7758,100.7599],[13.7776,100.7614],[13.7783,100.7618],[13.7799,100.7637],[13.7817,100.7663],[13.7816,100.7675],[13.7819,100.7676],[13.782,100.7685],[13.7823,100.7686],[13.7825,100.7696],[13.7826,100.7712],[13.7825,100.773],[13.7831,100.7763],[13.7829,100.7769],[13.7825,100.7777],[13.7821,100.781],[13.7817,100.7824],[13.7819,100.7828],[13.7819,100.7837],[13.7818,100.7848],[13.7815,100.7865],[13.7813,100.789],[13.7815,100.7911],[13.782,100.7925],[13.7827,100.7934],[13.7834,100.7947],[13.7828,100.7959],[13.7816,100.8009],[13.7817,100.8037],[13.7816,100.8086],[13.782,100.8109],[13.7823,100.8122],[13.7828,100.8133],[13.7841,100.8143],[13.7842,100.8146],[13.7838,100.8149],[13.783,100.816],[13.7823,100.819],[13.7797,100.8228],[13.7777,100.8226],[13.777,100.8239],[13.7749,100.8264],[13.7724,100.8288],[13.7713,100.8295],[13.7698,100.83],[13.7674,100.8323],[13.7679,100.8345],[13.7675,100.8375],[13.7701,100.8401],[13.7706,100.8411],[13.7709,100.8425],[13.771,100.8439],[13.7707,100.8461],[13.7709,100.8491],[13.771,100.8559],[13.7704,100.858],[13.7703,100.8607],[13.7696,100.8617],[13.7678,100.8633],[13.767,100.8639],[13.7647,100.8648],[13.7635,100.8649],[13.7619,100.8655],[13.7603,100.8657],[13.7584,100.8665],[13.7546,100.8663],[13.7528,100.8666],[13.7497,100.8681],[13.7469,100.8702],[13.745,100.8719],[13.744,100.8722],[13.7417,100.8734],[13.7401,100.8741],[13.7388,100.8752],[13.7383,100.876],[13.7381,100.8769],[13.7378,100.8789]],"cen":[13.8431,100.7982]},{"n":"ทุ่งมหาเมฆ","c":[[13.7229,100.5526],[13.7327,100.5292],[13.738,100.5157],[13.7353,100.5159],[13.7325,100.5155],[13.7313,100.5149],[13.7305,100.5143],[13.73,100.5136],[13.7293,100.5123],[13.7272,100.5126],[13.7231,100.5127],[13.7211,100.5124],[13.7193,100.512],[13.7175,100.5115],[13.716,100.5107],[13.7146,100.5099],[13.7128,100.5085],[13.7117,100.5075],[13.7083,100.5039],[13.7068,100.5018],[13.7058,100.5],[13.7029,100.4945],[13.7019,100.493],[13.7007,100.4918],[13.7001,100.4913],[13.6988,100.4907],[13.696,100.49],[13.6948,100.4899],[13.6933,100.49],[13.6921,100.4905],[13.6912,100.4913],[13.6903,100.4925],[13.6888,100.4946],[13.6877,100.4969],[13.687,100.4985],[13.6866,100.5],[13.6854,100.5064],[13.6844,100.5134],[13.6832,100.5171],[13.6716,100.5309],[13.6698,100.5349],[13.6695,100.536],[13.6691,100.5382],[13.6692,100.5406],[13.6694,100.5418],[13.6709,100.5451],[13.6718,100.5468],[13.6738,100.5485],[13.6749,100.5491],[13.6772,100.551],[13.678,100.5514],[13.6823,100.5525],[13.6859,100.5527],[13.6906,100.5526],[13.6929,100.5521],[13.6971,100.5515],[13.6987,100.5514],[13.7002,100.5493],[13.7012,100.5483],[13.7019,100.5478],[13.7026,100.5476],[13.7034,100.5478],[13.7039,100.5481],[13.7092,100.5535],[13.7095,100.5538],[13.7102,100.5541],[13.7186,100.5532],[13.7196,100.5529],[13.7229,100.5526]],"cen":[13.7037,100.5219]},{"n":"บางกอกน้อย","c":[[13.7853,100.5048],[13.7924,100.5114],[13.7945,100.5131],[13.7973,100.5151],[13.7993,100.5161],[13.8016,100.517],[13.805,100.5176],[13.8102,100.5171],[13.8113,100.5166],[13.8132,100.5152],[13.8017,100.5025],[13.8007,100.501],[13.8001,100.4996],[13.7907,100.4733],[13.7899,100.4707],[13.7889,100.4663],[13.7899,100.4667],[13.7921,100.4679],[13.7949,100.4698],[13.7957,100.4675],[13.7967,100.4653],[13.7972,100.464],[13.7982,100.459],[13.7995,100.4423],[13.7995,100.4401],[13.8007,100.4228],[13.8014,100.4107],[13.8024,100.3827],[13.8025,100.3741],[13.8032,100.357],[13.8033,100.3482],[13.8038,100.3335],[13.8041,100.3284],[13.8024,100.3291],[13.8021,100.3291],[13.802,100.3288],[13.8014,100.3288],[13.7992,100.3293],[13.7962,100.3295],[13.7923,100.33],[13.7876,100.3304],[13.7763,100.3299],[13.7711,100.3294],[13.7685,100.3291],[13.766,100.3292],[13.7651,100.3293],[13.7627,100.33],[13.7614,100.3305],[13.7588,100.3308],[13.7571,100.3313],[13.7547,100.3314],[13.7536,100.3318],[13.7483,100.3313],[13.7476,100.3314],[13.7477,100.3342],[13.7485,100.3388],[13.7491,100.3414],[13.7492,100.3444],[13.7512,100.3481],[13.7521,100.3522],[13.7536,100.3611],[13.7538,100.3631],[13.7538,100.3658],[13.7536,100.3732],[13.753,100.3806],[13.751,100.3971],[13.7502,100.4024],[13.7498,100.404],[13.7491,100.4082],[13.7472,100.4168],[13.7456,100.4197],[13.7446,100.4209],[13.7442,100.4215],[13.7436,100.424],[13.7435,100.4249],[13.7428,100.4257],[13.7424,100.4272],[13.7422,100.4297],[13.7424,100.4303],[13.7423,100.4309],[13.7421,100.4312],[13.7408,100.4319],[13.7403,100.4324],[13.7403,100.4337],[13.74,100.4351],[13.74,100.4391],[13.7402,100.44],[13.7405,100.4406],[13.7401,100.4432],[13.7406,100.4444],[13.7407,100.4462],[13.7403,100.4473],[13.7403,100.4479],[13.7409,100.4491],[13.7404,100.4498],[13.7411,100.4507],[13.7411,100.4523],[13.7418,100.4534],[13.742,100.454],[13.7425,100.4544],[13.7424,100.455],[13.7419,100.4553],[13.7421,100.4564],[13.7429,100.4569],[13.7432,100.457],[13.7436,100.4568],[13.7439,100.4572],[13.7439,100.4579],[13.7436,100.4588],[13.7436,100.4596],[13.7441,100.4606],[13.7444,100.462],[13.7417,100.4616],[13.7389,100.4616],[13.7364,100.462],[13.735,100.4622],[13.7327,100.4627],[13.7281,100.4652],[13.7253,100.4671],[13.7244,100.4681],[13.7226,100.4713],[13.7226,100.4724],[13.7224,100.4761],[13.7232,100.4803],[13.7244,100.4836],[13.7249,100.4844],[13.7284,100.4857],[13.7323,100.4863],[13.7351,100.4872],[13.7367,100.488],[13.7388,100.4888],[13.7403,100.4899],[13.7425,100.4919],[13.7442,100.4905],[13.7464,100.4889],[13.7476,100.4883],[13.7497,100.4878],[13.7523,100.4876],[13.7546,100.4876],[13.7571,100.488],[13.7599,100.4891],[13.7617,100.4905],[13.7656,100.4948],[13.7675,100.4963],[13.7701,100.4979],[13.7791,100.5015],[13.7836,100.5036],[13.7853,100.5048]],"cen":[13.7677,100.4128]},{"n":"สุวรรณภูมิ","c":[[13.6033,100.7203],[13.6024,100.728],[13.6022,100.7291],[13.6021,100.7326],[13.6018,100.7349],[13.6015,100.736],[13.6012,100.7385],[13.6012,100.7403],[13.6017,100.7432],[13.6017,100.7446],[13.601,100.7461],[13.5994,100.7481],[13.5991,100.7501],[13.5987,100.7517],[13.5986,100.7531],[13.5986,100.7535],[13.599,100.7545],[13.5996,100.7553],[13.5998,100.7558],[13.5997,100.7572],[13.5994,100.7588],[13.5994,100.7595],[13.5992,100.7601],[13.5984,100.7611],[13.598,100.7615],[13.5966,100.7667],[13.597,100.7711],[13.5967,100.7723],[13.5965,100.7745],[13.5961,100.777],[13.5957,100.7782],[13.5946,100.7805],[13.5938,100.7829],[13.5937,100.7845],[13.593,100.7881],[13.593,100.7902],[13.592,100.7943],[13.5913,100.7965],[13.5908,100.7986],[13.5906,100.7991],[13.5902,100.7992],[13.5887,100.8039],[13.5879,100.8043],[13.5873,100.8042],[13.5866,100.8036],[13.5858,100.8023],[13.5854,100.8021],[13.5847,100.8024],[13.5839,100.8032],[13.5815,100.8084],[13.5812,100.8106],[13.5808,100.8116],[13.5802,100.8124],[13.5793,100.8133],[13.5792,100.8143],[13.5783,100.817],[13.5779,100.8176],[13.5769,100.8184],[13.5767,100.8191],[13.5768,100.8199],[13.5771,100.8203],[13.578,100.8213],[13.5781,100.8222],[13.578,100.8228],[13.5774,100.8237],[13.576,100.8251],[13.5753,100.8256],[13.5752,100.8261],[13.5763,100.8283],[13.577,100.8293],[13.5779,100.8299],[13.5784,100.8305],[13.5785,100.8313],[13.5786,100.8325],[13.578,100.8335],[13.5776,100.8339],[13.5767,100.8342],[13.5752,100.8342],[13.5746,100.8344],[13.574,100.8347],[13.5733,100.8354],[13.5744,100.8376],[13.5744,100.8397],[13.5751,100.8414],[13.5757,100.8423],[13.5761,100.8443],[13.5761,100.8454],[13.5764,100.8463],[13.5772,100.8476],[13.5773,100.8509],[13.5776,100.8525],[13.5763,100.8531],[13.5759,100.8536],[13.5759,100.8553],[13.5764,100.8574],[13.5749,100.8626],[13.5729,100.8691],[13.5723,100.8724],[13.5718,100.874],[13.5722,100.876],[13.5714,100.8787],[13.5714,100.8803],[13.5716,100.8823],[13.5645,100.8902],[13.5641,100.8909],[13.5615,100.8938],[13.5541,100.9041],[13.5566,100.9052],[13.5577,100.9059],[13.5589,100.9066],[13.5604,100.9077],[13.5617,100.9081],[13.5631,100.9091],[13.5652,100.9111],[13.5673,100.9118],[13.5677,100.9121],[13.5687,100.9136],[13.5692,100.9139],[13.5713,100.9152],[13.5732,100.9151],[13.5744,100.9146],[13.5767,100.9139],[13.5776,100.9133],[13.5784,100.9123],[13.5789,100.9111],[13.5799,100.9095],[13.5806,100.9077],[13.5807,100.907],[13.5833,100.9071],[13.5856,100.9067],[13.5872,100.9068],[13.592,100.9073],[13.5926,100.9085],[13.5928,100.9097],[13.5926,100.9114],[13.5922,100.913],[13.5923,100.9137],[13.5927,100.9147],[13.5946,100.9184],[13.5948,100.9194],[13.5946,100.9207],[13.5933,100.9238],[13.5931,100.9245],[13.5932,100.9246],[13.5975,100.9281],[13.5986,100.9294],[13.5993,100.9305],[13.6104,100.939],[13.6165,100.9443],[13.6182,100.9458],[13.629,100.9575],[13.632,100.9606],[13.6325,100.9609],[13.6359,100.9622],[13.6441,100.9651],[13.6442,100.9642],[13.6448,100.9623],[13.6455,100.9586],[13.647,100.954],[13.6483,100.9536],[13.6529,100.9527],[13.654,100.9526],[13.6553,100.9526],[13.6561,100.9547],[13.657,100.9549],[13.6581,100.9548],[13.6589,100.9561],[13.66,100.9568],[13.6619,100.9576],[13.6626,100.9557],[13.6635,100.9526],[13.6656,100.9469],[13.6754,100.9186],[13.6842,100.8946],[13.689,100.8801],[13.6899,100.8775],[13.697,100.8607],[13.6985,100.8576],[13.6994,100.8552],[13.7022,100.8568],[13.7378,100.8789],[13.7381,100.8769],[13.7383,100.876],[13.7388,100.8752],[13.7401,100.8741],[13.7417,100.8734],[13.744,100.8722],[13.745,100.8719],[13.7469,100.8702],[13.7497,100.8681],[13.7528,100.8666],[13.7546,100.8663],[13.7584,100.8665],[13.7603,100.8657],[13.7619,100.8655],[13.7635,100.8649],[13.7647,100.8648],[13.767,100.8639],[13.7678,100.8633],[13.7696,100.8617],[13.7703,100.8607],[13.7704,100.858],[13.771,100.8559],[13.7709,100.8491],[13.7707,100.8461],[13.771,100.8439],[13.7709,100.8425],[13.7706,100.8411],[13.7701,100.8401],[13.7675,100.8375],[13.7679,100.8345],[13.7674,100.8323],[13.7698,100.83],[13.7713,100.8295],[13.7724,100.8288],[13.7749,100.8264],[13.777,100.8239],[13.7777,100.8226],[13.7797,100.8228],[13.7823,100.819],[13.783,100.816],[13.7838,100.8149],[13.7842,100.8146],[13.7841,100.8143],[13.7828,100.8133],[13.7823,100.8122],[13.782,100.8109],[13.7816,100.8086],[13.7817,100.8037],[13.7816,100.8009],[13.7828,100.7959],[13.7834,100.7947],[13.7827,100.7934],[13.782,100.7925],[13.7815,100.7911],[13.7813,100.789],[13.7815,100.7865],[13.7818,100.7848],[13.7819,100.7837],[13.7819,100.7828],[13.7817,100.7824],[13.7821,100.781],[13.7825,100.7777],[13.7829,100.7769],[13.7831,100.7763],[13.7825,100.773],[13.7826,100.7712],[13.7825,100.7696],[13.7823,100.7686],[13.782,100.7685],[13.7819,100.7676],[13.7816,100.7675],[13.7817,100.7663],[13.7799,100.7637],[13.7783,100.7618],[13.7776,100.7614],[13.7758,100.7599],[13.7757,100.7594],[13.7757,100.7584],[13.7766,100.7557],[13.7777,100.7539],[13.7768,100.7538],[13.7767,100.7464],[13.7741,100.7463],[13.7738,100.7389],[13.776,100.7388],[13.776,100.7384],[13.7758,100.7382],[13.7758,100.7376],[13.7762,100.7375],[13.7762,100.7368],[13.7746,100.7337],[13.776,100.7256],[13.7762,100.7248],[13.7767,100.7237],[13.7729,100.7221],[13.7731,100.7215],[13.7716,100.7209],[13.7729,100.7196],[13.7732,100.7189],[13.7743,100.7178],[13.7743,100.718],[13.7746,100.718],[13.7746,100.7177],[13.775,100.7174],[13.775,100.7168],[13.7751,100.7168],[13.7751,100.717],[13.7754,100.717],[13.7754,100.7173],[13.7756,100.7173],[13.7756,100.7178],[13.7759,100.7178],[13.7759,100.7175],[13.7762,100.7175],[13.7762,100.7178],[13.7769,100.7177],[13.7769,100.717],[13.7771,100.7169],[13.7777,100.7169],[13.7777,100.7173],[13.7779,100.7173],[13.778,100.7163],[13.777,100.7166],[13.7726,100.7162],[13.7715,100.7159],[13.7668,100.7131],[13.7653,100.7125],[13.7639,100.7112],[13.7624,100.7103],[13.7615,100.7094],[13.761,100.709],[13.7577,100.7069],[13.7567,100.7065],[13.7565,100.7071],[13.7564,100.7082],[13.7564,100.7097],[13.7479,100.7092],[13.7447,100.7091],[13.7393,100.7087],[13.7387,100.7088],[13.7379,100.7086],[13.7372,100.7087],[13.7317,100.7083],[13.7307,100.7083],[13.7241,100.7089],[13.7075,100.7114],[13.7061,100.7115],[13.7013,100.7124],[13.7012,100.711],[13.6952,100.7099],[13.6951,100.7102],[13.6913,100.7098],[13.6902,100.7096],[13.6883,100.709],[13.6877,100.7086],[13.6847,100.7073],[13.6809,100.7066],[13.6786,100.7064],[13.6789,100.7055],[13.6746,100.7046],[13.6744,100.7052],[13.6725,100.7045],[13.6641,100.6998],[13.6627,100.6993],[13.6586,100.6985],[13.6535,100.698],[13.6546,100.6932],[13.6519,100.6928],[13.6514,100.6929],[13.6514,100.6924],[13.6506,100.6924],[13.6513,100.6892],[13.6502,100.6883],[13.6483,100.688],[13.6478,100.687],[13.6467,100.6866],[13.6464,100.686],[13.644,100.6834],[13.6433,100.6828],[13.6422,100.6823],[13.639,100.6815],[13.6374,100.6809],[13.6365,100.6806],[13.6341,100.6791],[13.631,100.6786],[13.6273,100.6784],[13.6268,100.6781],[13.626,100.6754],[13.6235,100.6758],[13.6229,100.6756],[13.6223,100.6752],[13.6218,100.6753],[13.6205,100.6747],[13.6188,100.6724],[13.6172,100.6721],[13.6158,100.6716],[13.6149,100.6715],[13.614,100.671],[13.6141,100.6722],[13.6134,100.6758],[13.6128,100.6771],[13.6115,100.6819],[13.6111,100.685],[13.61,100.6885],[13.6096,100.6893],[13.6094,100.6905],[13.6088,100.6926],[13.6082,100.6939],[13.6076,100.6965],[13.607,100.6983],[13.6064,100.7025],[13.6057,100.7049],[13.6057,100.7078],[13.6055,100.7083],[13.6047,100.7095],[13.6041,100.7097],[13.6035,100.7104],[13.6034,100.7119],[13.6035,100.7132],[13.6031,100.7173],[13.6033,100.7203]],"cen":[13.669,100.8197]},{"n":"บางบัวทอง","c":[[13.9142,100.4662],[13.9158,100.4669],[13.917,100.4678],[13.9184,100.47],[13.9187,100.4722],[13.9183,100.4748],[13.9177,100.4771],[13.9156,100.4818],[13.9149,100.4847],[13.9146,100.4877],[13.9146,100.4914],[13.9156,100.4938],[13.9171,100.4958],[13.9191,100.4973],[13.9209,100.4983],[13.9236,100.4991],[13.9257,100.4993],[13.9319,100.5004],[13.9343,100.501],[13.9374,100.5022],[13.9378,100.4995],[13.9384,100.4981],[13.939,100.4978],[13.9391,100.497],[13.9396,100.4963],[13.9396,100.4957],[13.9398,100.4953],[13.9402,100.4953],[13.9408,100.4939],[13.9405,100.4935],[13.9406,100.493],[13.941,100.4924],[13.941,100.4918],[13.9411,100.4913],[13.9421,100.4905],[13.9425,100.4894],[13.944,100.488],[13.9449,100.4875],[13.946,100.4886],[13.9465,100.4885],[13.9475,100.4873],[13.9494,100.4867],[13.9501,100.4863],[13.9505,100.486],[13.9512,100.4846],[13.9542,100.4818],[13.9557,100.4808],[13.9571,100.4792],[13.958,100.4787],[13.9587,100.478],[13.9608,100.4759],[13.961,100.4751],[13.9637,100.4724],[13.9607,100.4706],[13.9601,100.47],[13.9599,100.4693],[13.9602,100.4687],[13.9602,100.468],[13.9601,100.4673],[13.9598,100.467],[13.9592,100.4668],[13.9587,100.4665],[13.9582,100.4665],[13.9582,100.4657],[13.9591,100.4649],[13.9597,100.4645],[13.9602,100.4638],[13.9606,100.4618],[13.9612,100.4605],[13.9615,100.4596],[13.9621,100.4588],[13.966,100.4551],[13.9663,100.4545],[13.9661,100.4542],[13.9664,100.4533],[13.9669,100.4526],[13.9673,100.4522],[13.9681,100.4526],[13.9742,100.4442],[13.9788,100.4383],[13.9799,100.437],[13.9808,100.4356],[13.9814,100.4341],[13.9835,100.4254],[13.9948,100.3811],[13.9889,100.3806],[13.9909,100.3716],[13.9921,100.365],[13.9924,100.3642],[13.9943,100.3611],[13.9953,100.3605],[14.0008,100.3556],[14.0083,100.3511],[14.0178,100.3457],[14.0225,100.3435],[14.0249,100.3428],[14.0384,100.3365],[14.0434,100.3346],[14.0478,100.3334],[14.0531,100.3323],[14.0608,100.3316],[14.0648,100.332],[14.0672,100.3324],[14.0693,100.3333],[14.077,100.3347],[14.0922,100.3401],[14.0971,100.3415],[14.1053,100.3421],[14.1151,100.3444],[14.1279,100.3333],[14.1293,100.3222],[14.1332,100.3132],[14.1361,100.3081],[14.1389,100.3008],[14.1398,100.2989],[14.1402,100.2971],[14.1394,100.2955],[14.1384,100.2944],[14.1361,100.2931],[14.1336,100.2903],[14.1256,100.2797],[14.1206,100.2794],[14.1086,100.278],[14.0988,100.2771],[14.0887,100.277],[14.0817,100.2766],[14.0756,100.2748],[14.0739,100.2745],[14.0727,100.2736],[14.0709,100.2736],[14.0693,100.2739],[14.0668,100.2735],[14.0646,100.2719],[14.0605,100.2668],[14.0562,100.263],[14.0514,100.26],[14.0469,100.258],[14.0386,100.2558],[14.0328,100.2555],[14.0265,100.2561],[14.0217,100.2574],[14.0167,100.2595],[14.0118,100.2624],[14.0066,100.2667],[14.0015,100.2749],[13.9932,100.2678],[13.9894,100.2691],[13.9849,100.272],[13.9761,100.2807],[13.9634,100.2981],[13.9442,100.2844],[13.9349,100.2743],[13.9206,100.2651],[13.915,100.2744],[13.9111,100.2772],[13.8959,100.2845],[13.8988,100.2906],[13.899,100.2905],[13.9003,100.2935],[13.9019,100.2977],[13.9024,100.2982],[13.9033,100.2995],[13.9037,100.3004],[13.9049,100.3058],[13.9062,100.3075],[13.9061,100.3106],[13.9067,100.3144],[13.9085,100.3236],[13.9091,100.3235],[13.9095,100.3247],[13.91,100.3355],[13.9101,100.3406],[13.9096,100.3468],[13.9092,100.3482],[13.9089,100.3503],[13.9094,100.3562],[13.9097,100.3571],[13.9098,100.3582],[13.9097,100.3624],[13.91,100.3637],[13.9105,100.3695],[13.9105,100.3723],[13.9102,100.3737],[13.9087,100.3757],[13.9083,100.3762],[13.9083,100.3771],[13.9085,100.3783],[13.9093,100.3809],[13.9095,100.3821],[13.909,100.3859],[13.9096,100.3873],[13.9098,100.3889],[13.9079,100.3963],[13.9077,100.3974],[13.908,100.3998],[13.9071,100.4024],[13.9063,100.4075],[13.9051,100.4071],[13.8994,100.4075],[13.874,100.4099],[13.8769,100.448],[13.8763,100.4526],[13.8742,100.4577],[13.8726,100.4609],[13.8711,100.4645],[13.8704,100.4671],[13.8699,100.471],[13.8701,100.4718],[13.8701,100.4736],[13.8704,100.4764],[13.8727,100.4762],[13.8756,100.4766],[13.8779,100.4776],[13.8857,100.4849],[13.8909,100.4891],[13.895,100.4906],[13.8967,100.4904],[13.8995,100.489],[13.9002,100.4863],[13.9013,100.4768],[13.9024,100.4735],[13.9056,100.4699],[13.9097,100.4671],[13.912,100.4665],[13.9142,100.4662]],"cen":[14.004,100.3122]},{"n":"มหาสวัสดิ์","c":[[13.9102,100.3737],[13.9105,100.3723],[13.9105,100.3695],[13.91,100.3637],[13.9097,100.3624],[13.9098,100.3582],[13.9097,100.3571],[13.9094,100.3562],[13.9089,100.3503],[13.9092,100.3482],[13.9096,100.3468],[13.9101,100.3406],[13.91,100.3355],[13.9095,100.3247],[13.9091,100.3235],[13.9085,100.3236],[13.9067,100.3144],[13.9061,100.3106],[13.9062,100.3075],[13.9049,100.3058],[13.9037,100.3004],[13.9033,100.2995],[13.9024,100.2982],[13.9019,100.2977],[13.9003,100.2935],[13.899,100.2905],[13.8988,100.2906],[13.8959,100.2845],[13.8797,100.2923],[13.8105,100.325],[13.8042,100.3279],[13.8038,100.3335],[13.8033,100.3482],[13.8032,100.357],[13.8025,100.3741],[13.8024,100.3827],[13.8014,100.4107],[13.8007,100.4228],[13.7995,100.4401],[13.7995,100.4423],[13.7982,100.459],[13.7972,100.464],[13.7967,100.4653],[13.7957,100.4675],[13.7949,100.4698],[13.7921,100.4679],[13.7899,100.4667],[13.7889,100.4663],[13.7899,100.4707],[13.7907,100.4733],[13.8001,100.4996],[13.8007,100.501],[13.8017,100.5025],[13.8132,100.5152],[13.8141,100.5142],[13.8163,100.5069],[13.8179,100.5037],[13.8198,100.5022],[13.8209,100.5015],[13.8259,100.4996],[13.8286,100.498],[13.8331,100.4947],[13.8355,100.4928],[13.8391,100.4911],[13.8421,100.4903],[13.8447,100.4899],[13.8469,100.4892],[13.8484,100.488],[13.8499,100.4863],[13.8508,100.4843],[13.8521,100.4817],[13.8532,100.4807],[13.8561,100.4788],[13.8619,100.4775],[13.8704,100.4764],[13.8701,100.4736],[13.8701,100.4718],[13.8699,100.471],[13.8704,100.4671],[13.8711,100.4645],[13.8726,100.4609],[13.8742,100.4577],[13.8763,100.4526],[13.8769,100.448],[13.874,100.4099],[13.8994,100.4075],[13.9051,100.4071],[13.9063,100.4075],[13.9071,100.4024],[13.908,100.3998],[13.9077,100.3974],[13.9079,100.3963],[13.9098,100.3889],[13.9096,100.3873],[13.909,100.3859],[13.9095,100.3821],[13.9093,100.3809],[13.9085,100.3783],[13.9083,100.3771],[13.9083,100.3762],[13.9087,100.3757],[13.9102,100.3737]],"cen":[13.8498,100.3965]},{"n":"พระโขนง","c":[[13.614,100.671],[13.6149,100.6715],[13.6158,100.6716],[13.6172,100.6721],[13.6188,100.6724],[13.6205,100.6747],[13.6218,100.6753],[13.6223,100.6752],[13.6229,100.6756],[13.6235,100.6758],[13.626,100.6754],[13.6268,100.6781],[13.6273,100.6784],[13.631,100.6786],[13.6341,100.6791],[13.6365,100.6806],[13.6374,100.6809],[13.639,100.6815],[13.6422,100.6823],[13.643,100.6826],[13.644,100.6834],[13.6464,100.686],[13.6467,100.6866],[13.6478,100.687],[13.6483,100.688],[13.6502,100.6883],[13.6512,100.6891],[13.6513,100.6892],[13.6506,100.6924],[13.6514,100.6924],[13.6514,100.6929],[13.6519,100.6928],[13.6546,100.6932],[13.6535,100.698],[13.6586,100.6985],[13.6627,100.6993],[13.6641,100.6998],[13.6717,100.7041],[13.6744,100.7052],[13.6746,100.7046],[13.6789,100.7055],[13.6786,100.7064],[13.6809,100.7066],[13.6847,100.7073],[13.6877,100.7086],[13.6883,100.709],[13.6913,100.7098],[13.6951,100.7102],[13.6952,100.7099],[13.7012,100.711],[13.7013,100.7124],[13.7061,100.7115],[13.7075,100.7114],[13.7241,100.7089],[13.7239,100.7089],[13.7241,100.6822],[13.7239,100.6733],[13.7149,100.6392],[13.7147,100.6376],[13.7147,100.6366],[13.7146,100.6357],[13.7146,100.635],[13.7149,100.6344],[13.7149,100.6335],[13.7146,100.6326],[13.7149,100.6321],[13.7155,100.6295],[13.7152,100.6289],[13.7151,100.6282],[13.7144,100.628],[13.7134,100.6269],[13.7129,100.6262],[13.7123,100.6258],[13.7128,100.6253],[13.7129,100.6248],[13.7147,100.6242],[13.7147,100.6238],[13.7145,100.6232],[13.7145,100.6225],[13.7142,100.6223],[13.7131,100.6221],[13.7123,100.6214],[13.7104,100.6213],[13.7104,100.6208],[13.7113,100.6201],[13.7115,100.6192],[13.7113,100.6188],[13.7106,100.6183],[13.7098,100.6164],[13.71,100.616],[13.7104,100.6158],[13.7107,100.6158],[13.7114,100.6164],[13.713,100.6157],[13.7132,100.6153],[13.7133,100.6148],[13.7132,100.6144],[13.7127,100.6139],[13.7126,100.6134],[13.7128,100.6126],[13.7131,100.6124],[13.7153,100.6122],[13.7155,100.6121],[13.7156,100.6117],[13.7155,100.6106],[13.7159,100.6088],[13.7159,100.6074],[13.7154,100.6065],[13.7142,100.6055],[13.7138,100.6032],[13.7135,100.6023],[13.7131,100.6019],[13.7116,100.6017],[13.7111,100.6014],[13.7111,100.601],[13.712,100.5994],[13.7122,100.5983],[13.7119,100.5978],[13.7107,100.5971],[13.7102,100.5966],[13.7088,100.5923],[13.7076,100.5911],[13.7061,100.5903],[13.7055,100.5896],[13.7049,100.5875],[13.7034,100.5808],[13.7029,100.5807],[13.6986,100.581],[13.6966,100.5835],[13.6911,100.5888],[13.6885,100.5893],[13.6849,100.5897],[13.684,100.5895],[13.6822,100.589],[13.681,100.5884],[13.6746,100.5836],[13.6674,100.5776],[13.6642,100.5748],[13.6614,100.5718],[13.6569,100.5716],[13.6568,100.5718],[13.6575,100.5726],[13.6577,100.5733],[13.6584,100.5738],[13.6585,100.574],[13.6584,100.5742],[13.6562,100.5763],[13.6559,100.5762],[13.6558,100.5752],[13.6554,100.5747],[13.655,100.5748],[13.6538,100.5758],[13.6528,100.5761],[13.6527,100.5763],[13.6534,100.577],[13.6532,100.5774],[13.6529,100.5777],[13.6527,100.5779],[13.6531,100.5786],[13.653,100.5794],[13.6528,100.5798],[13.6525,100.5801],[13.6524,100.5806],[13.6524,100.5815],[13.6522,100.5818],[13.6518,100.5837],[13.652,100.5846],[13.6513,100.585],[13.6511,100.5856],[13.6506,100.5861],[13.6507,100.5869],[13.6505,100.588],[13.6505,100.5887],[13.6498,100.5895],[13.6495,100.5905],[13.6495,100.5911],[13.649,100.5916],[13.6492,100.5918],[13.6498,100.5917],[13.65,100.5918],[13.6502,100.5922],[13.65,100.5932],[13.6495,100.5931],[13.6491,100.5926],[13.6489,100.5925],[13.6486,100.5927],[13.6485,100.5931],[13.6485,100.5955],[13.6463,100.5985],[13.6454,100.6004],[13.6445,100.6011],[13.6442,100.6016],[13.6439,100.6026],[13.6427,100.604],[13.6414,100.6069],[13.6408,100.6077],[13.6399,100.6085],[13.6377,100.6128],[13.6362,100.6148],[13.6354,100.6166],[13.634,100.6185],[13.6337,100.6198],[13.632,100.6219],[13.6318,100.6227],[13.6313,100.6239],[13.6297,100.6268],[13.6296,100.628],[13.6283,100.6297],[13.628,100.6309],[13.6272,100.6321],[13.6264,100.6342],[13.6257,100.6353],[13.6253,100.6367],[13.6249,100.6373],[13.6241,100.6383],[13.6235,100.6401],[13.6229,100.6409],[13.6222,100.6425],[13.6215,100.6447],[13.6201,100.6476],[13.6198,100.6494],[13.6192,100.6512],[13.6192,100.6523],[13.6184,100.6542],[13.6181,100.6553],[13.6178,100.6578],[13.617,100.6598],[13.6168,100.6615],[13.6164,100.6621],[13.6148,100.663],[13.6143,100.6636],[13.6145,100.6652],[13.614,100.671]],"cen":[13.669,100.6407]},{"n":"สุขสวัสดิ์","c":[[13.6986,100.581],[13.7007,100.5767],[13.7022,100.573],[13.705,100.5657],[13.7057,100.5635],[13.7063,100.5611],[13.7064,100.5597],[13.7063,100.5569],[13.7057,100.5553],[13.7046,100.5538],[13.7029,100.5523],[13.7012,100.5517],[13.6991,100.5513],[13.6971,100.5515],[13.6929,100.5521],[13.6906,100.5526],[13.6859,100.5527],[13.6823,100.5525],[13.678,100.5514],[13.6772,100.551],[13.6749,100.5491],[13.6738,100.5485],[13.6718,100.5468],[13.6702,100.5437],[13.6694,100.5418],[13.6692,100.5406],[13.6691,100.5382],[13.6695,100.536],[13.6698,100.5349],[13.6716,100.5309],[13.6832,100.5171],[13.6844,100.5134],[13.6851,100.5083],[13.6859,100.5033],[13.6866,100.5],[13.687,100.4985],[13.6877,100.4969],[13.6888,100.4946],[13.6903,100.4925],[13.6917,100.4909],[13.6921,100.4905],[13.6933,100.49],[13.6948,100.4899],[13.6948,100.4874],[13.695,100.4866],[13.6947,100.4853],[13.6948,100.4841],[13.6947,100.4827],[13.6945,100.4825],[13.6934,100.4821],[13.6929,100.4803],[13.6926,100.4798],[13.6903,100.4764],[13.689,100.4749],[13.6882,100.4737],[13.6884,100.4731],[13.6895,100.4723],[13.6905,100.4718],[13.6905,100.4716],[13.6899,100.4701],[13.6895,100.4686],[13.6878,100.4693],[13.6868,100.4691],[13.6864,100.4696],[13.6841,100.4701],[13.683,100.4706],[13.6824,100.4701],[13.6805,100.4703],[13.6791,100.4708],[13.6787,100.4702],[13.6784,100.469],[13.675,100.4703],[13.6741,100.4681],[13.6737,100.4666],[13.669,100.4679],[13.664,100.469],[13.6574,100.4707],[13.6548,100.4711],[13.6489,100.4724],[13.6396,100.4735],[13.6354,100.4747],[13.6343,100.475],[13.6321,100.4751],[13.6312,100.4755],[13.6306,100.4756],[13.6299,100.4755],[13.6296,100.4753],[13.629,100.4741],[13.6286,100.474],[13.6278,100.4744],[13.6273,100.4744],[13.6268,100.4735],[13.626,100.4729],[13.6255,100.4724],[13.6263,100.449],[13.6219,100.4502],[13.6218,100.4504],[13.6215,100.4504],[13.6206,100.4497],[13.6204,100.4497],[13.6201,100.45],[13.6188,100.4502],[13.6181,100.4501],[13.6171,100.4503],[13.6167,100.4502],[13.6159,100.4506],[13.6156,100.451],[13.6157,100.4512],[13.6152,100.4514],[13.615,100.4514],[13.6146,100.4512],[13.6122,100.4512],[13.6114,100.4515],[13.6109,100.4513],[13.6105,100.4517],[13.6098,100.4517],[13.6094,100.4519],[13.6078,100.4524],[13.6069,100.453],[13.606,100.4532],[13.606,100.4538],[13.6059,100.4538],[13.6054,100.4536],[13.6044,100.4538],[13.603,100.4533],[13.6024,100.4527],[13.6016,100.4524],[13.6008,100.4523],[13.6004,100.4521],[13.5984,100.4522],[13.5976,100.4515],[13.5967,100.4509],[13.5959,100.451],[13.5953,100.4509],[13.5946,100.4509],[13.5935,100.4501],[13.5928,100.4493],[13.5924,100.4493],[13.5918,100.4491],[13.5912,100.4493],[13.5907,100.4491],[13.5903,100.4488],[13.59,100.4485],[13.5895,100.4483],[13.5893,100.4478],[13.589,100.4475],[13.588,100.4476],[13.5876,100.4473],[13.5873,100.4467],[13.5869,100.4465],[13.5863,100.4467],[13.5852,100.4463],[13.5848,100.4463],[13.5833,100.4466],[13.5824,100.4466],[13.5626,100.4448],[13.5541,100.4443],[13.5491,100.445],[13.546,100.4456],[13.5409,100.4464],[13.5408,100.4466],[13.5403,100.4466],[13.5376,100.447],[13.5297,100.4485],[13.509,100.452],[13.4997,100.4538],[13.4995,100.4543],[13.5002,100.4557],[13.5002,100.4573],[13.5,100.459],[13.4995,100.4591],[13.4993,100.4603],[13.4949,100.4626],[13.4948,100.4638],[13.4951,100.4648],[13.4956,100.4657],[13.4962,100.4661],[13.4968,100.4673],[13.4975,100.4683],[13.4979,100.4684],[13.4978,100.4691],[13.4969,100.4691],[13.497,100.4704],[13.4979,100.4703],[13.4986,100.4709],[13.4985,100.4721],[13.4971,100.4719],[13.4972,100.4723],[13.4977,100.473],[13.498,100.4731],[13.4977,100.475],[13.497,100.475],[13.4969,100.4775],[13.4973,100.4777],[13.4969,100.4782],[13.4968,100.4791],[13.4966,100.4796],[13.4968,100.4806],[13.4957,100.4809],[13.496,100.4831],[13.4971,100.483],[13.4973,100.4832],[13.4975,100.4863],[13.497,100.4865],[13.497,100.4872],[13.4979,100.4891],[13.4985,100.4892],[13.4984,100.4895],[13.4965,100.4899],[13.4966,100.4901],[13.4963,100.4904],[13.4965,100.4909],[13.4967,100.4915],[13.4979,100.4917],[13.4982,100.4925],[13.4995,100.4924],[13.4994,100.4931],[13.5,100.4931],[13.4999,100.4935],[13.4997,100.494],[13.4991,100.4943],[13.4988,100.4957],[13.4988,100.4977],[13.4999,100.4978],[13.5,100.5006],[13.4997,100.5009],[13.4999,100.5021],[13.5002,100.5029],[13.5005,100.5044],[13.5006,100.5067],[13.5011,100.5078],[13.5013,100.5107],[13.5015,100.511],[13.501,100.5119],[13.5006,100.5123],[13.5006,100.5132],[13.5001,100.5138],[13.5003,100.5141],[13.5013,100.5143],[13.5013,100.5146],[13.5007,100.5146],[13.5008,100.5148],[13.5011,100.5149],[13.5001,100.5162],[13.5009,100.5168],[13.5013,100.5167],[13.5017,100.5169],[13.5016,100.52],[13.5021,100.52],[13.5024,100.5215],[13.5029,100.5219],[13.5026,100.5229],[13.5029,100.5229],[13.5031,100.5241],[13.5023,100.5243],[13.5022,100.5271],[13.5025,100.5272],[13.5026,100.5276],[13.503,100.5279],[13.5031,100.5285],[13.5036,100.5291],[13.5035,100.5305],[13.5031,100.5306],[13.5031,100.5321],[13.5024,100.533],[13.5017,100.533],[13.5017,100.5341],[13.503,100.534],[13.5032,100.5344],[13.503,100.5348],[13.5033,100.5354],[13.5036,100.5355],[13.5037,100.5368],[13.5041,100.5369],[13.5042,100.5396],[13.505,100.5406],[13.5057,100.5433],[13.5061,100.5433],[13.506,100.5469],[13.5057,100.547],[13.5056,100.5475],[13.5059,100.5476],[13.5059,100.5479],[13.5062,100.5485],[13.5056,100.5486],[13.5056,100.549],[13.5059,100.5491],[13.5057,100.5525],[13.5062,100.5537],[13.5069,100.5541],[13.5069,100.5545],[13.5072,100.5545],[13.5077,100.5552],[13.5075,100.5618],[13.5082,100.5619],[13.5088,100.563],[13.5092,100.563],[13.5096,100.5638],[13.5088,100.5642],[13.5091,100.5652],[13.509,100.5658],[13.5087,100.5662],[13.5093,100.5666],[13.509,100.567],[13.5097,100.5677],[13.5096,100.5684],[13.5099,100.5683],[13.5103,100.5685],[13.5103,100.5689],[13.5096,100.5694],[13.5093,100.5691],[13.5091,100.5693],[13.5095,100.57],[13.5103,100.5701],[13.5106,100.5709],[13.5106,100.5717],[13.5104,100.5719],[13.5096,100.572],[13.5098,100.5724],[13.5101,100.5722],[13.5101,100.5726],[13.5104,100.5725],[13.5108,100.573],[13.5101,100.5736],[13.5095,100.5728],[13.5092,100.573],[13.5092,100.5732],[13.5098,100.5738],[13.5091,100.5741],[13.5092,100.5747],[13.512,100.5771],[13.513,100.5788],[13.5137,100.5791],[13.5137,100.579],[13.5176,100.5832],[13.5177,100.584],[13.5204,100.5862],[13.5241,100.5886],[13.5255,100.589],[13.5333,100.5882],[13.5341,100.5884],[13.5348,100.5887],[13.5354,100.5892],[13.5366,100.5907],[13.5373,100.593],[13.5571,100.5776],[13.5594,100.5769],[13.5623,100.5764],[13.5696,100.5766],[13.573,100.5779],[13.5768,100.5805],[13.5842,100.5862],[13.5923,100.5909],[13.5951,100.5922],[13.5978,100.5926],[13.6023,100.592],[13.6051,100.5915],[13.6074,100.5906],[13.6091,100.5887],[13.61,100.5868],[13.6107,100.5848],[13.6112,100.5795],[13.6111,100.5758],[13.6113,100.5665],[13.6118,100.5639],[13.6126,100.5613],[13.614,100.5577],[13.6166,100.5534],[13.619,100.5499],[13.6208,100.5481],[13.627,100.5427],[13.6358,100.5373],[13.6388,100.5361],[13.6422,100.5351],[13.6461,100.5343],[13.6485,100.534],[13.653,100.5341],[13.654,100.5344],[13.6569,100.5356],[13.6586,100.5366],[13.6596,100.5377],[13.6604,100.5388],[13.6609,100.5407],[13.6609,100.5415],[13.6608,100.5427],[13.6603,100.545],[13.6595,100.548],[13.6588,100.5502],[13.658,100.5518],[13.6561,100.5567],[13.6558,100.5581],[13.6558,100.5599],[13.6561,100.5619],[13.6567,100.5641],[13.6582,100.5676],[13.6613,100.5718],[13.6642,100.5748],[13.6674,100.5776],[13.6746,100.5836],[13.681,100.5884],[13.6822,100.589],[13.684,100.5895],[13.6849,100.5897],[13.6885,100.5893],[13.6911,100.5888],[13.6966,100.5835],[13.6986,100.581]],"cen":[13.6006,100.5222]},{"n":"นนทบุรี","c":[[13.9556,100.5418],[13.9557,100.5407],[13.9558,100.539],[13.9539,100.5389],[13.9526,100.5386],[13.9507,100.5376],[13.949,100.5364],[13.9475,100.5348],[13.9456,100.5322],[13.9451,100.5313],[13.9445,100.5298],[13.9441,100.5282],[13.9435,100.5233],[13.9436,100.5203],[13.9439,100.515],[13.9438,100.5105],[13.9434,100.5088],[13.9425,100.5069],[13.9415,100.5054],[13.9393,100.5035],[13.9374,100.5022],[13.9343,100.501],[13.9319,100.5004],[13.9257,100.4993],[13.9236,100.4991],[13.9209,100.4983],[13.9191,100.4973],[13.9171,100.4958],[13.9156,100.4938],[13.9146,100.4914],[13.9146,100.4877],[13.9149,100.4847],[13.9156,100.4818],[13.9177,100.4771],[13.9183,100.4748],[13.9187,100.4722],[13.9184,100.47],[13.917,100.4678],[13.9158,100.4669],[13.9142,100.4662],[13.912,100.4665],[13.9097,100.4671],[13.9056,100.4699],[13.9024,100.4735],[13.9013,100.4768],[13.9002,100.4863],[13.8995,100.489],[13.8967,100.4904],[13.895,100.4906],[13.8909,100.4891],[13.8857,100.4849],[13.8779,100.4776],[13.8756,100.4766],[13.8727,100.4762],[13.8619,100.4775],[13.8599,100.4779],[13.8561,100.4788],[13.8532,100.4807],[13.8521,100.4817],[13.8508,100.4843],[13.8499,100.4863],[13.8484,100.488],[13.8469,100.4892],[13.8447,100.4899],[13.8421,100.4903],[13.8391,100.4911],[13.8355,100.4928],[13.8331,100.4947],[13.8286,100.498],[13.8259,100.4996],[13.8209,100.5015],[13.8198,100.5022],[13.8179,100.5037],[13.8163,100.5069],[13.8161,100.5075],[13.819,100.5063],[13.8194,100.5064],[13.8212,100.5072],[13.8215,100.5076],[13.8224,100.5076],[13.8228,100.5077],[13.8234,100.5087],[13.8236,100.5096],[13.8242,100.5101],[13.8245,100.5101],[13.8246,100.5096],[13.8248,100.5093],[13.8252,100.5092],[13.8255,100.5093],[13.8252,100.5107],[13.8253,100.5108],[13.8262,100.511],[13.8261,100.5118],[13.8259,100.5121],[13.8249,100.5126],[13.8247,100.5128],[13.8247,100.5131],[13.8262,100.5132],[13.8269,100.5147],[13.8271,100.5154],[13.8276,100.5158],[13.8286,100.5159],[13.8307,100.5188],[13.8329,100.5212],[13.8339,100.5223],[13.8344,100.5228],[13.8398,100.5291],[13.8417,100.531],[13.8424,100.532],[13.8442,100.5339],[13.8451,100.535],[13.8462,100.5362],[13.8467,100.5374],[13.8475,100.5386],[13.8495,100.5434],[13.8499,100.5435],[13.8498,100.5438],[13.9515,100.5678],[13.951,100.5667],[13.9503,100.5667],[13.9504,100.5663],[13.9506,100.5658],[13.9505,100.5647],[13.9504,100.5645],[13.9497,100.564],[13.9498,100.5634],[13.9496,100.5628],[13.9499,100.5621],[13.9498,100.5619],[13.9494,100.5617],[13.9494,100.5615],[13.95,100.561],[13.95,100.5605],[13.9504,100.5605],[13.9507,100.5603],[13.9507,100.5596],[13.9505,100.5584],[13.9498,100.5572],[13.9501,100.5568],[13.9502,100.5562],[13.9515,100.555],[13.9515,100.5547],[13.9514,100.5545],[13.9504,100.5543],[13.9504,100.5541],[13.9514,100.5534],[13.9511,100.5526],[13.9517,100.5512],[13.9518,100.5505],[13.952,100.5498],[13.9521,100.5491],[13.9527,100.5484],[13.9526,100.5476],[13.9527,100.5471],[13.9525,100.5458],[13.9526,100.5456],[13.9533,100.5456],[13.9534,100.5454],[13.9533,100.5451],[13.953,100.5448],[13.953,100.5444],[13.9535,100.5439],[13.9538,100.5439],[13.9543,100.5442],[13.9544,100.5441],[13.9545,100.5438],[13.954,100.5428],[13.9535,100.5421],[13.9547,100.5413],[13.9553,100.5422],[13.9556,100.5418]],"cen":[13.8864,100.519]},{"n":"แม้นศรี","c":[[13.8,100.52],[13.8002,100.5194],[13.8002,100.5164],[13.7973,100.5151],[13.7945,100.5131],[13.7924,100.5114],[13.7845,100.5042],[13.7836,100.5036],[13.7791,100.5015],[13.7701,100.4979],[13.7675,100.4963],[13.7656,100.4948],[13.7617,100.4905],[13.7599,100.4891],[13.7571,100.488],[13.7546,100.4876],[13.7523,100.4876],[13.7497,100.4878],[13.7476,100.4883],[13.746,100.4892],[13.7442,100.4905],[13.7417,100.4926],[13.7406,100.4939],[13.7398,100.4954],[13.739,100.4979],[13.737,100.5063],[13.7362,100.508],[13.7357,100.5088],[13.735,100.5096],[13.7338,100.5106],[13.731,100.5118],[13.7293,100.5123],[13.73,100.5136],[13.7305,100.5143],[13.7313,100.5149],[13.7325,100.5155],[13.7353,100.5159],[13.738,100.5157],[13.7327,100.5292],[13.7229,100.5526],[13.7264,100.5523],[13.7484,100.5498],[13.7482,100.5539],[13.7481,100.554],[13.7482,100.5543],[13.7484,100.5587],[13.7482,100.561],[13.7478,100.5631],[13.7551,100.5648],[13.7553,100.5638],[13.7558,100.559],[13.7558,100.5568],[13.756,100.5559],[13.756,100.5551],[13.7561,100.5544],[13.7561,100.554],[13.7559,100.5539],[13.756,100.5531],[13.7559,100.5526],[13.7556,100.5524],[13.756,100.5524],[13.7566,100.5521],[13.7586,100.5505],[13.7597,100.548],[13.7598,100.5475],[13.7605,100.5471],[13.7605,100.546],[13.7614,100.5454],[13.7617,100.5446],[13.7624,100.5438],[13.7628,100.5431],[13.7637,100.5423],[13.764,100.5415],[13.7646,100.5409],[13.7648,100.5403],[13.7651,100.5402],[13.7654,100.54],[13.7656,100.5395],[13.7666,100.5381],[13.7668,100.5375],[13.7675,100.5371],[13.7677,100.5365],[13.7682,100.5362],[13.7686,100.5354],[13.7699,100.534],[13.7743,100.5278],[13.7976,100.5373],[13.7996,100.5331],[13.7982,100.5323],[13.7984,100.5308],[13.7988,100.5289],[13.7988,100.5281],[13.7986,100.527],[13.7993,100.5256],[13.7992,100.5249],[13.7996,100.5239],[13.7997,100.5229],[13.8,100.5223],[13.8,100.52]],"cen":[13.7615,100.5177]},{"n":"สมุทรปราการ","c":[[13.614,100.671],[13.6145,100.6652],[13.6143,100.6636],[13.6148,100.663],[13.6164,100.6621],[13.6168,100.6615],[13.617,100.6598],[13.6178,100.6578],[13.6181,100.6553],[13.6184,100.6542],[13.6192,100.6523],[13.6192,100.6512],[13.6198,100.6494],[13.6201,100.6476],[13.6215,100.6447],[13.6229,100.6409],[13.6235,100.6401],[13.6241,100.6383],[13.6249,100.6373],[13.6253,100.6367],[13.6257,100.6353],[13.6264,100.6342],[13.6272,100.6321],[13.628,100.6309],[13.6283,100.6297],[13.6296,100.628],[13.6297,100.6268],[13.6313,100.6239],[13.6318,100.6227],[13.632,100.6219],[13.6337,100.6198],[13.634,100.6185],[13.6354,100.6166],[13.6362,100.6148],[13.6377,100.6128],[13.6399,100.6085],[13.6408,100.6077],[13.6414,100.6069],[13.6427,100.604],[13.6439,100.6026],[13.6442,100.6016],[13.6445,100.6011],[13.6454,100.6004],[13.6463,100.5985],[13.6485,100.5955],[13.6485,100.5931],[13.6486,100.5927],[13.6489,100.5925],[13.6491,100.5926],[13.6495,100.5931],[13.65,100.5932],[13.6502,100.5922],[13.65,100.5918],[13.6498,100.5917],[13.6492,100.5918],[13.649,100.5916],[13.6495,100.5911],[13.6495,100.5905],[13.6498,100.5895],[13.6505,100.5887],[13.6505,100.588],[13.6507,100.5869],[13.6506,100.5861],[13.6511,100.5856],[13.6513,100.585],[13.652,100.5846],[13.6518,100.5837],[13.6522,100.5818],[13.6524,100.5815],[13.6524,100.5806],[13.6525,100.5801],[13.6528,100.5798],[13.653,100.5794],[13.6531,100.5786],[13.6527,100.5779],[13.6529,100.5777],[13.6532,100.5774],[13.6534,100.577],[13.6527,100.5763],[13.6528,100.5761],[13.6538,100.5758],[13.655,100.5748],[13.6554,100.5747],[13.6558,100.5752],[13.6559,100.5762],[13.6562,100.5763],[13.6576,100.575],[13.6585,100.574],[13.6577,100.5733],[13.6575,100.5726],[13.6568,100.5718],[13.6569,100.5716],[13.6613,100.5718],[13.6582,100.5676],[13.6567,100.5641],[13.6561,100.5619],[13.6557,100.5589],[13.6558,100.5576],[13.6561,100.5567],[13.658,100.5518],[13.6588,100.5502],[13.66,100.5464],[13.6608,100.5427],[13.6609,100.5407],[13.6604,100.5388],[13.6596,100.5377],[13.6586,100.5366],[13.6569,100.5356],[13.6534,100.5341],[13.6518,100.534],[13.6485,100.534],[13.6461,100.5343],[13.6422,100.5351],[13.6388,100.5361],[13.6358,100.5373],[13.627,100.5427],[13.6208,100.5481],[13.619,100.5499],[13.6166,100.5534],[13.614,100.5577],[13.6126,100.5613],[13.6118,100.5639],[13.6113,100.5665],[13.6111,100.5758],[13.6112,100.5795],[13.6107,100.5848],[13.61,100.5868],[13.6091,100.5887],[13.6074,100.5906],[13.6051,100.5915],[13.6023,100.592],[13.5978,100.5926],[13.5951,100.5922],[13.5923,100.5909],[13.5842,100.5862],[13.5768,100.5805],[13.573,100.5779],[13.5696,100.5766],[13.5623,100.5764],[13.5594,100.5769],[13.5571,100.5776],[13.5373,100.593],[13.5376,100.5958],[13.5376,100.5982],[13.5376,100.6041],[13.5374,100.6117],[13.5359,100.6152],[13.5355,100.6158],[13.5334,100.6181],[13.5323,100.6202],[13.5303,100.6221],[13.5271,100.6226],[13.5246,100.6216],[13.5241,100.6221],[13.5221,100.6234],[13.5212,100.6242],[13.5195,100.6264],[13.5175,100.6312],[13.5155,100.6349],[13.5136,100.6381],[13.5131,100.6398],[13.5116,100.6468],[13.5099,100.658],[13.5093,100.6597],[13.5058,100.6654],[13.5027,100.678],[13.5002,100.6929],[13.4965,100.7177],[13.4961,100.7294],[13.491,100.7675],[13.4845,100.8037],[13.4825,100.8175],[13.475,100.8396],[13.4735,100.8497],[13.4811,100.8506],[13.4867,100.8511],[13.4957,100.8521],[13.4876,100.8716],[13.4896,100.8717],[13.4904,100.8715],[13.4942,100.8725],[13.498,100.8722],[13.5002,100.8726],[13.502,100.8727],[13.5077,100.8726],[13.5087,100.8722],[13.5125,100.8716],[13.513,100.8716],[13.5163,100.8724],[13.5183,100.8735],[13.5199,100.874],[13.5206,100.8741],[13.5231,100.8722],[13.5237,100.8721],[13.5245,100.8723],[13.5255,100.8727],[13.527,100.8738],[13.5287,100.8745],[13.5344,100.8755],[13.5357,100.8761],[13.5385,100.877],[13.5423,100.8784],[13.547,100.8794],[13.548,100.8795],[13.5485,100.8799],[13.551,100.8835],[13.5517,100.8841],[13.5538,100.8849],[13.5571,100.8864],[13.5575,100.887],[13.5576,100.8891],[13.5578,100.8895],[13.5586,100.8898],[13.5595,100.8899],[13.562,100.8894],[13.5632,100.8893],[13.5644,100.8899],[13.5645,100.8902],[13.5716,100.8823],[13.5714,100.8803],[13.5714,100.8787],[13.5722,100.876],[13.5718,100.874],[13.5723,100.8724],[13.5729,100.8691],[13.5749,100.8626],[13.5764,100.8574],[13.5759,100.8553],[13.5759,100.8536],[13.5763,100.8531],[13.5776,100.8525],[13.5773,100.8509],[13.5772,100.8476],[13.5764,100.8463],[13.5761,100.8454],[13.5761,100.8443],[13.5757,100.8423],[13.5751,100.8414],[13.5744,100.8397],[13.5744,100.8376],[13.5733,100.8354],[13.574,100.8347],[13.5746,100.8344],[13.5752,100.8342],[13.5767,100.8342],[13.5776,100.8339],[13.578,100.8335],[13.5787,100.8323],[13.5784,100.8305],[13.5779,100.8299],[13.577,100.8293],[13.5763,100.8283],[13.5752,100.8261],[13.5753,100.8256],[13.576,100.8251],[13.5774,100.8237],[13.578,100.8228],[13.5781,100.8222],[13.578,100.8213],[13.5771,100.8203],[13.5768,100.8199],[13.5767,100.8191],[13.5769,100.8184],[13.5779,100.8176],[13.5783,100.817],[13.5792,100.8143],[13.5793,100.8133],[13.5802,100.8124],[13.5808,100.8116],[13.5812,100.8106],[13.5815,100.8084],[13.5839,100.8032],[13.5847,100.8024],[13.5854,100.8021],[13.5858,100.8023],[13.5866,100.8036],[13.5873,100.8042],[13.5879,100.8043],[13.5887,100.8039],[13.5902,100.7992],[13.5906,100.7991],[13.5908,100.7986],[13.5913,100.7965],[13.5924,100.7929],[13.593,100.7902],[13.593,100.7881],[13.5937,100.7845],[13.5938,100.7829],[13.5946,100.7805],[13.5957,100.7782],[13.5961,100.777],[13.5965,100.7745],[13.5967,100.7723],[13.597,100.7711],[13.5966,100.7667],[13.598,100.7615],[13.5984,100.7611],[13.5992,100.7601],[13.5994,100.7595],[13.5994,100.7588],[13.5997,100.7572],[13.5998,100.7558],[13.5996,100.7553],[13.599,100.7545],[13.5986,100.7535],[13.5986,100.7531],[13.5987,100.7517],[13.5991,100.7501],[13.5994,100.7481],[13.601,100.7461],[13.6017,100.7446],[13.6017,100.7432],[13.6012,100.7403],[13.6012,100.7385],[13.6015,100.736],[13.6018,100.7349],[13.6021,100.7326],[13.6022,100.7291],[13.6024,100.728],[13.6033,100.7203],[13.6031,100.7173],[13.6035,100.7132],[13.6034,100.7119],[13.6035,100.7105],[13.6041,100.7097],[13.6047,100.7095],[13.6055,100.7083],[13.6057,100.7078],[13.6057,100.7049],[13.6064,100.7025],[13.607,100.6983],[13.6076,100.6965],[13.6082,100.6939],[13.6088,100.6926],[13.6094,100.6905],[13.6096,100.6893],[13.61,100.6885],[13.6111,100.685],[13.6115,100.6819],[13.6128,100.6771],[13.6134,100.6758],[13.6141,100.6722],[13.614,100.671]],"cen":[13.5679,100.7315]},{"n":"ตากสิน","c":[[13.7293,100.5123],[13.731,100.5118],[13.7338,100.5106],[13.735,100.5096],[13.7357,100.5088],[13.7362,100.508],[13.737,100.5063],[13.7374,100.5049],[13.7387,100.4991],[13.7398,100.4954],[13.7406,100.4939],[13.7417,100.4926],[13.7425,100.4919],[13.7403,100.4899],[13.7383,100.4886],[13.7367,100.488],[13.7351,100.4872],[13.7332,100.4865],[13.7323,100.4863],[13.7284,100.4857],[13.7276,100.4855],[13.7249,100.4844],[13.7244,100.4836],[13.7232,100.4803],[13.7224,100.4761],[13.7226,100.4724],[13.7226,100.4713],[13.723,100.4705],[13.7225,100.4693],[13.7073,100.4262],[13.6996,100.4267],[13.6981,100.4265],[13.6945,100.4267],[13.6917,100.427],[13.6888,100.4276],[13.6803,100.4286],[13.6785,100.429],[13.6732,100.4296],[13.6675,100.43],[13.6186,100.3752],[13.6159,100.3753],[13.6136,100.3757],[13.6137,100.376],[13.6094,100.3763],[13.6098,100.3767],[13.6094,100.3771],[13.6067,100.3772],[13.6066,100.3771],[13.6026,100.3783],[13.5985,100.3805],[13.5938,100.3833],[13.5928,100.3815],[13.5919,100.381],[13.5912,100.3809],[13.591,100.3815],[13.5906,100.3818],[13.5903,100.3827],[13.5894,100.3835],[13.5892,100.3842],[13.5884,100.3845],[13.5877,100.3842],[13.5876,100.3844],[13.5876,100.3851],[13.5874,100.3853],[13.5869,100.3848],[13.5867,100.3849],[13.5864,100.3853],[13.5863,100.3853],[13.5861,100.3847],[13.5859,100.385],[13.5859,100.3857],[13.5856,100.3857],[13.5855,100.3853],[13.5852,100.3853],[13.5851,100.3861],[13.5848,100.3863],[13.5837,100.3863],[13.582,100.387],[13.5777,100.3877],[13.5757,100.3883],[13.5751,100.3886],[13.575,100.3889],[13.5742,100.3894],[13.5725,100.3898],[13.5717,100.3899],[13.5704,100.3906],[13.5689,100.3905],[13.5672,100.3909],[13.5654,100.3907],[13.5645,100.3911],[13.563,100.391],[13.5628,100.3913],[13.563,100.392],[13.5629,100.3922],[13.5625,100.3923],[13.5623,100.3927],[13.5617,100.3927],[13.5612,100.3932],[13.561,100.3931],[13.5607,100.3926],[13.5605,100.3925],[13.5603,100.3932],[13.5599,100.3928],[13.5596,100.3931],[13.5594,100.393],[13.5584,100.3933],[13.558,100.3943],[13.5578,100.394],[13.5575,100.3939],[13.5559,100.3942],[13.5557,100.3946],[13.5554,100.3948],[13.5549,100.3946],[13.5546,100.3946],[13.5545,100.3951],[13.5537,100.3952],[13.5535,100.3954],[13.5532,100.3958],[13.5532,100.3964],[13.5527,100.397],[13.5526,100.3981],[13.5529,100.3989],[13.5527,100.3991],[13.5524,100.3991],[13.5523,100.3995],[13.5526,100.4003],[13.5525,100.4012],[13.553,100.4017],[13.5529,100.4021],[13.5529,100.4026],[13.5532,100.4029],[13.5534,100.4034],[13.5551,100.4045],[13.5551,100.4048],[13.5546,100.4054],[13.5545,100.406],[13.5542,100.4064],[13.5543,100.4067],[13.5549,100.4072],[13.5547,100.4074],[13.5542,100.4084],[13.5547,100.4089],[13.5547,100.4097],[13.5549,100.4107],[13.5556,100.4122],[13.556,100.4122],[13.5563,100.412],[13.5566,100.412],[13.5569,100.4123],[13.5568,100.413],[13.5574,100.4134],[13.5573,100.4136],[13.5567,100.414],[13.5567,100.4143],[13.5571,100.415],[13.5561,100.4152],[13.5545,100.4147],[13.5539,100.4149],[13.5533,100.4149],[13.5524,100.4147],[13.5514,100.4144],[13.551,100.4148],[13.55,100.4167],[13.5488,100.4175],[13.5467,100.4194],[13.546,100.4198],[13.5443,100.42],[13.5435,100.4194],[13.5431,100.4193],[13.5426,100.4194],[13.5414,100.4187],[13.5409,100.4186],[13.5402,100.4178],[13.5392,100.4152],[13.5384,100.4146],[13.538,100.4149],[13.5367,100.4145],[13.5364,100.4139],[13.5358,100.4136],[13.5353,100.4126],[13.5314,100.4129],[13.529,100.4122],[13.5281,100.4118],[13.5275,100.4113],[13.5262,100.4111],[13.5258,100.4105],[13.5252,100.4105],[13.5247,100.4104],[13.5235,100.4087],[13.5216,100.408],[13.5212,100.4078],[13.5208,100.4072],[13.5204,100.4069],[13.5199,100.4067],[13.5189,100.4065],[13.5183,100.4066],[13.5078,100.4061],[13.5076,100.4063],[13.493,100.4097],[13.4929,100.4099],[13.4927,100.4106],[13.4935,100.4187],[13.4938,100.4239],[13.4943,100.4261],[13.4947,100.4274],[13.4951,100.4312],[13.4951,100.433],[13.4961,100.4393],[13.4961,100.4405],[13.4967,100.4421],[13.4976,100.4486],[13.4986,100.4513],[13.4986,100.4519],[13.4991,100.452],[13.4991,100.4523],[13.4993,100.4524],[13.4998,100.4536],[13.4997,100.4538],[13.509,100.452],[13.5297,100.4485],[13.5376,100.447],[13.5403,100.4466],[13.5408,100.4466],[13.5409,100.4464],[13.546,100.4456],[13.5491,100.445],[13.5541,100.4443],[13.5626,100.4448],[13.5824,100.4466],[13.5833,100.4466],[13.5848,100.4463],[13.5852,100.4463],[13.5863,100.4467],[13.5869,100.4465],[13.5873,100.4467],[13.5876,100.4473],[13.588,100.4476],[13.589,100.4475],[13.5893,100.4478],[13.5895,100.4483],[13.59,100.4485],[13.5903,100.4488],[13.5907,100.4491],[13.5912,100.4493],[13.5918,100.4491],[13.5924,100.4493],[13.5928,100.4493],[13.5935,100.4501],[13.5946,100.4509],[13.5953,100.4509],[13.5959,100.451],[13.5967,100.4509],[13.5976,100.4515],[13.5984,100.4522],[13.6004,100.4521],[13.6008,100.4523],[13.6016,100.4524],[13.6024,100.4527],[13.603,100.4533],[13.6044,100.4538],[13.6054,100.4536],[13.6059,100.4538],[13.606,100.4538],[13.606,100.4532],[13.6069,100.453],[13.6078,100.4524],[13.6094,100.4519],[13.6098,100.4517],[13.6105,100.4517],[13.6109,100.4513],[13.6114,100.4515],[13.6122,100.4512],[13.6146,100.4512],[13.615,100.4514],[13.6152,100.4514],[13.6157,100.4512],[13.6156,100.451],[13.6159,100.4506],[13.6167,100.4502],[13.6171,100.4503],[13.6181,100.4501],[13.6188,100.4502],[13.6201,100.45],[13.6204,100.4497],[13.6206,100.4497],[13.6215,100.4504],[13.6218,100.4504],[13.6219,100.4502],[13.6263,100.449],[13.6255,100.4724],[13.626,100.4729],[13.6268,100.4735],[13.6273,100.4744],[13.6278,100.4744],[13.6285,100.474],[13.6289,100.4741],[13.6292,100.4743],[13.6297,100.4754],[13.6302,100.4756],[13.6308,100.4756],[13.6321,100.4751],[13.6343,100.475],[13.6354,100.4747],[13.6396,100.4735],[13.6489,100.4724],[13.6548,100.4711],[13.6574,100.4707],[13.664,100.469],[13.669,100.4679],[13.6737,100.4666],[13.6741,100.4681],[13.675,100.4703],[13.6784,100.469],[13.6787,100.4702],[13.6791,100.4708],[13.6805,100.4703],[13.6824,100.4701],[13.683,100.4706],[13.6841,100.4701],[13.6864,100.4696],[13.6868,100.4691],[13.6878,100.4693],[13.6895,100.4686],[13.6899,100.4701],[13.6905,100.4716],[13.6905,100.4718],[13.6895,100.4723],[13.6884,100.4731],[13.6882,100.4737],[13.689,100.4749],[13.6903,100.4764],[13.6926,100.4798],[13.6929,100.4803],[13.6934,100.4821],[13.6945,100.4825],[13.6947,100.4827],[13.6948,100.4841],[13.6947,100.4853],[13.695,100.4866],[13.6948,100.4874],[13.6948,100.4899],[13.6967,100.4901],[13.6988,100.4907],[13.7001,100.4913],[13.7014,100.4925],[13.7029,100.4945],[13.7058,100.5],[13.7068,100.5018],[13.7083,100.5039],[13.7117,100.5075],[13.7146,100.5099],[13.716,100.5107],[13.7175,100.5115],[13.7211,100.5124],[13.7231,100.5127],[13.7253,100.5127],[13.7272,100.5126],[13.7293,100.5123]],"cen":[13.6176,100.4128]},{"n":"สุขุมวิท","c":[[13.7476,100.5652],[13.7482,100.561],[13.7484,100.5587],[13.7482,100.5543],[13.7481,100.554],[13.7482,100.5539],[13.7484,100.5498],[13.7264,100.5523],[13.7196,100.5529],[13.7187,100.5532],[13.7104,100.5541],[13.7099,100.554],[13.7092,100.5535],[13.7039,100.5481],[13.703,100.5477],[13.7022,100.5477],[13.7016,100.5479],[13.7002,100.5493],[13.6987,100.5514],[13.6991,100.5513],[13.7012,100.5517],[13.7029,100.5523],[13.7046,100.5538],[13.7057,100.5553],[13.7063,100.5569],[13.7064,100.5597],[13.7063,100.5611],[13.7057,100.5635],[13.705,100.5657],[13.7007,100.5767],[13.6986,100.581],[13.7029,100.5807],[13.7034,100.5808],[13.7049,100.5875],[13.7055,100.5896],[13.7061,100.5903],[13.7076,100.5911],[13.7088,100.5923],[13.7102,100.5966],[13.7107,100.5971],[13.7119,100.5978],[13.7122,100.5983],[13.712,100.5994],[13.7111,100.601],[13.7111,100.6014],[13.7116,100.6017],[13.7131,100.6019],[13.7135,100.6023],[13.7138,100.6032],[13.7142,100.6055],[13.7154,100.6065],[13.7159,100.6072],[13.7159,100.6088],[13.7155,100.6106],[13.7156,100.6117],[13.7155,100.6121],[13.7153,100.6122],[13.7131,100.6124],[13.7128,100.6126],[13.7126,100.6134],[13.7127,100.6139],[13.7132,100.6144],[13.7133,100.6148],[13.7132,100.6153],[13.713,100.6157],[13.7114,100.6164],[13.7107,100.6158],[13.7104,100.6158],[13.71,100.616],[13.7098,100.6164],[13.7106,100.6183],[13.7113,100.6188],[13.7115,100.6192],[13.7113,100.6201],[13.7104,100.6208],[13.7104,100.6213],[13.7123,100.6214],[13.7131,100.6221],[13.7142,100.6223],[13.7145,100.6225],[13.7145,100.6232],[13.7147,100.6238],[13.7147,100.6242],[13.7129,100.6248],[13.7128,100.6253],[13.7123,100.6258],[13.7129,100.6262],[13.7134,100.6269],[13.7144,100.628],[13.7151,100.6282],[13.7152,100.6289],[13.7155,100.6295],[13.7149,100.6321],[13.7146,100.6326],[13.7149,100.6335],[13.7149,100.6344],[13.7146,100.635],[13.7146,100.6357],[13.7147,100.6366],[13.7147,100.6376],[13.7149,100.6392],[13.7239,100.6733],[13.7241,100.6822],[13.7239,100.7089],[13.7317,100.7083],[13.7372,100.7087],[13.7379,100.7086],[13.7387,100.7088],[13.7393,100.7087],[13.7447,100.7091],[13.7479,100.7092],[13.7564,100.7097],[13.7564,100.7082],[13.7565,100.7071],[13.7567,100.7065],[13.7577,100.7069],[13.761,100.709],[13.7615,100.7094],[13.7624,100.7103],[13.7639,100.7112],[13.7653,100.7125],[13.7668,100.7131],[13.7715,100.7159],[13.7726,100.7162],[13.7772,100.7165],[13.7799,100.7155],[13.7815,100.7153],[13.7829,100.7147],[13.7982,100.7061],[13.7957,100.7015],[13.7877,100.6873],[13.7791,100.6714],[13.7737,100.6619],[13.7699,100.6548],[13.7659,100.6498],[13.7652,100.6483],[13.765,100.6474],[13.7635,100.6342],[13.7621,100.6208],[13.7617,100.6192],[13.7614,100.6163],[13.7607,100.6145],[13.7504,100.6034],[13.7474,100.6003],[13.743,100.5987],[13.7417,100.5986],[13.7407,100.5988],[13.741,100.5979],[13.7411,100.5971],[13.7433,100.5852],[13.7448,100.5792],[13.7454,100.576],[13.7457,100.5739],[13.7462,100.5722],[13.747,100.5676],[13.7476,100.5652]],"cen":[13.7484,100.6553]},{"n":"พญาไท","c":[[13.8566,100.5874],[13.8589,100.5864],[13.8584,100.5857],[13.8582,100.584],[13.8579,100.5835],[13.858,100.5815],[13.8574,100.5778],[13.8574,100.5762],[13.857,100.5749],[13.857,100.5736],[13.8566,100.5726],[13.8564,100.571],[13.8563,100.5689],[13.8558,100.5665],[13.8556,100.5662],[13.8557,100.5656],[13.8554,100.5653],[13.8554,100.5652],[13.8233,100.5479],[13.8166,100.5446],[13.815,100.544],[13.8126,100.5434],[13.8072,100.5412],[13.803,100.5398],[13.797,100.537],[13.7743,100.5278],[13.7699,100.534],[13.7686,100.5354],[13.7682,100.5362],[13.7677,100.5365],[13.7675,100.5371],[13.7668,100.5375],[13.7666,100.5381],[13.7656,100.5395],[13.7654,100.54],[13.7651,100.5402],[13.7648,100.5403],[13.7646,100.5409],[13.764,100.5415],[13.7637,100.5423],[13.7628,100.5431],[13.7624,100.5438],[13.7617,100.5446],[13.7614,100.5454],[13.7605,100.546],[13.7605,100.5471],[13.7598,100.5475],[13.7597,100.548],[13.7586,100.5505],[13.7566,100.5521],[13.756,100.5524],[13.7556,100.5524],[13.7559,100.5526],[13.756,100.5531],[13.7559,100.5539],[13.7561,100.554],[13.7561,100.5544],[13.756,100.5551],[13.756,100.5559],[13.7558,100.5568],[13.7558,100.559],[13.7553,100.5638],[13.7551,100.5648],[13.7478,100.5631],[13.7476,100.5652],[13.747,100.5676],[13.7462,100.5722],[13.7457,100.5739],[13.7454,100.576],[13.7448,100.5792],[13.7433,100.5852],[13.7411,100.5971],[13.741,100.5979],[13.7407,100.5988],[13.7417,100.5986],[13.743,100.5987],[13.7474,100.6003],[13.751,100.6041],[13.7522,100.6031],[13.7572,100.5978],[13.7604,100.596],[13.7624,100.5948],[13.7636,100.5946],[13.765,100.5948],[13.766,100.5947],[13.7686,100.5938],[13.7727,100.5931],[13.7743,100.5931],[13.7769,100.5935],[13.7793,100.5935],[13.7797,100.5933],[13.7816,100.592],[13.7836,100.5914],[13.7864,100.5901],[13.7872,100.59],[13.7894,100.59],[13.7917,100.5894],[13.7962,100.5893],[13.7982,100.5891],[13.8004,100.589],[13.8016,100.5888],[13.803,100.5883],[13.8043,100.5887],[13.8085,100.5887],[13.8105,100.589],[13.8121,100.5884],[13.8127,100.5885],[13.8137,100.5889],[13.8149,100.5889],[13.8162,100.5893],[13.8178,100.5895],[13.8195,100.5892],[13.8225,100.5893],[13.8241,100.589],[13.8259,100.5895],[13.829,100.5899],[13.8318,100.5898],[13.8334,100.59],[13.8359,100.5907],[13.8376,100.591],[13.839,100.5908],[13.8407,100.5903],[13.844,100.5897],[13.8463,100.5888],[13.85,100.5882],[13.8521,100.5876],[13.8566,100.5874]],"cen":[13.7997,100.5636]},{"n":"ลาดพร้าว","c":[[13.8505,100.6785],[13.8515,100.677],[13.8522,100.6738],[13.8523,100.6716],[13.8525,100.6709],[13.8527,100.6708],[13.8524,100.6698],[13.8516,100.6684],[13.8512,100.668],[13.8509,100.6674],[13.8505,100.6657],[13.8506,100.6651],[13.8505,100.6634],[13.85,100.6619],[13.8498,100.6615],[13.8491,100.6612],[13.8488,100.6593],[13.8486,100.6592],[13.8486,100.6589],[13.8477,100.6587],[13.8478,100.6565],[13.8474,100.6555],[13.8468,100.6531],[13.8469,100.6521],[13.8464,100.65],[13.8462,100.6485],[13.8474,100.6462],[13.8466,100.6409],[13.8462,100.6394],[13.8457,100.6386],[13.8448,100.6373],[13.8436,100.6367],[13.8439,100.636],[13.8425,100.633],[13.8427,100.6311],[13.8426,100.6287],[13.8431,100.6284],[13.8435,100.6278],[13.8458,100.6235],[13.8466,100.6227],[13.8472,100.6217],[13.8481,100.6208],[13.8484,100.6196],[13.8491,100.614],[13.8491,100.6086],[13.8492,100.6069],[13.8489,100.6058],[13.8481,100.6043],[13.8468,100.6023],[13.8463,100.5987],[13.8461,100.5976],[13.8458,100.5969],[13.8457,100.5957],[13.8453,100.594],[13.8441,100.5909],[13.8438,100.5897],[13.8407,100.5903],[13.839,100.5908],[13.8373,100.591],[13.8323,100.5898],[13.829,100.5899],[13.8259,100.5895],[13.8241,100.589],[13.8225,100.5893],[13.8195,100.5892],[13.8178,100.5895],[13.8162,100.5893],[13.8149,100.5889],[13.8137,100.5889],[13.8125,100.5885],[13.8118,100.5885],[13.8105,100.589],[13.81,100.589],[13.8085,100.5887],[13.8043,100.5887],[13.803,100.5883],[13.8016,100.5888],[13.8004,100.589],[13.7982,100.5891],[13.7962,100.5893],[13.7917,100.5894],[13.7894,100.59],[13.7872,100.59],[13.7864,100.5901],[13.7836,100.5914],[13.7816,100.592],[13.7797,100.5933],[13.7793,100.5935],[13.7769,100.5935],[13.7743,100.5931],[13.7727,100.5931],[13.7686,100.5938],[13.766,100.5947],[13.765,100.5948],[13.7636,100.5946],[13.7624,100.5948],[13.7604,100.596],[13.7572,100.5978],[13.7522,100.6031],[13.751,100.6041],[13.7587,100.6125],[13.7605,100.6142],[13.7612,100.6156],[13.7615,100.6167],[13.7617,100.6192],[13.7621,100.6211],[13.7623,100.6242],[13.765,100.6474],[13.7656,100.6493],[13.7699,100.6548],[13.7737,100.6619],[13.7976,100.7049],[13.8046,100.7005],[13.806,100.7015],[13.807,100.702],[13.8079,100.7021],[13.8091,100.7018],[13.8095,100.7014],[13.8105,100.6997],[13.8119,100.698],[13.8126,100.6975],[13.8136,100.6971],[13.8151,100.6967],[13.817,100.6965],[13.8202,100.6969],[13.8208,100.6961],[13.8216,100.6956],[13.8222,100.6954],[13.8232,100.6954],[13.8242,100.6952],[13.8248,100.6948],[13.8301,100.6919],[13.8309,100.6909],[13.8324,100.6905],[13.8329,100.6901],[13.8347,100.6878],[13.835,100.6878],[13.836,100.6883],[13.8382,100.6878],[13.8386,100.6877],[13.8402,100.6868],[13.8417,100.6864],[13.8437,100.686],[13.8451,100.6855],[13.8468,100.6843],[13.848,100.6838],[13.8483,100.6835],[13.8491,100.6823],[13.8502,100.6801],[13.8505,100.6785]],"cen":[13.8019,100.6454]},{"n":"ประชาชื่น","c":[[13.9271,100.6265],[13.9505,100.6223],[13.9516,100.6193],[13.9535,100.616],[13.9543,100.614],[13.9537,100.6045],[13.9515,100.6048],[13.9505,100.6048],[13.9484,100.6052],[13.9441,100.6058],[13.9457,100.6019],[13.9483,100.5965],[13.9495,100.5932],[13.9503,100.5915],[13.951,100.5893],[13.9546,100.5739],[13.9544,100.5732],[13.9518,100.5687],[13.9515,100.5678],[13.8498,100.5438],[13.8499,100.5435],[13.8495,100.5434],[13.8475,100.5386],[13.8467,100.5374],[13.8462,100.5362],[13.8451,100.535],[13.8442,100.5339],[13.8424,100.532],[13.8417,100.531],[13.8398,100.5291],[13.8344,100.5228],[13.8339,100.5223],[13.8329,100.5212],[13.8307,100.5188],[13.8286,100.5159],[13.8276,100.5158],[13.8271,100.5154],[13.8269,100.5147],[13.8262,100.5132],[13.8247,100.5131],[13.8247,100.5128],[13.8249,100.5126],[13.8259,100.5121],[13.8261,100.5118],[13.8262,100.511],[13.8253,100.5108],[13.8252,100.5107],[13.8255,100.5093],[13.8252,100.5092],[13.8248,100.5093],[13.8246,100.5096],[13.8245,100.5101],[13.8242,100.5101],[13.8236,100.5096],[13.8234,100.5087],[13.8228,100.5077],[13.8224,100.5076],[13.8215,100.5076],[13.8212,100.5072],[13.8194,100.5064],[13.819,100.5063],[13.8161,100.5075],[13.8141,100.5142],[13.8132,100.5152],[13.8113,100.5166],[13.8102,100.5171],[13.805,100.5176],[13.8016,100.517],[13.8002,100.5164],[13.8002,100.5194],[13.7999,100.5208],[13.8,100.5223],[13.7997,100.5229],[13.7996,100.5239],[13.7992,100.5249],[13.7993,100.5256],[13.7987,100.5268],[13.7988,100.5289],[13.7984,100.5308],[13.7982,100.5323],[13.7996,100.5331],[13.7976,100.5373],[13.7975,100.5373],[13.803,100.5398],[13.8072,100.5412],[13.8126,100.5434],[13.815,100.544],[13.8171,100.5448],[13.8233,100.5479],[13.8554,100.5652],[13.8554,100.5653],[13.8557,100.5656],[13.8556,100.5662],[13.8558,100.5665],[13.8563,100.5689],[13.8564,100.571],[13.8566,100.5726],[13.857,100.5736],[13.857,100.5749],[13.8574,100.5762],[13.8574,100.5778],[13.858,100.5815],[13.8579,100.5835],[13.8582,100.584],[13.8584,100.5857],[13.8589,100.5864],[13.8786,100.5879],[13.8797,100.5881],[13.8804,100.5884],[13.8816,100.5893],[13.8885,100.5955],[13.8911,100.5988],[13.8955,100.6057],[13.8971,100.607],[13.8977,100.6077],[13.8998,100.611],[13.9261,100.6264],[13.9271,100.6265]],"cen":[13.8765,100.5689]}];
const TUR_REGION_OUTLINE = [[[[13.6933,100.49],[13.6953,100.4899],[13.6976,100.4903],[13.6994,100.4909],[13.7007,100.4918],[13.7019,100.493],[13.7029,100.4945],[13.7058,100.5],[13.7083,100.5039],[13.7128,100.5085],[13.716,100.5107],[13.7175,100.5115],[13.7193,100.512],[13.7231,100.5127],[13.7272,100.5127],[13.7293,100.5123],[13.73,100.5136],[13.7305,100.5143],[13.7313,100.5149],[13.7325,100.5155],[13.7353,100.5159],[13.7381,100.5157],[13.7327,100.5292],[13.7229,100.5526],[13.7264,100.5523],[13.7484,100.5498],[13.7482,100.5539],[13.7481,100.554],[13.7482,100.5543],[13.7484,100.5587],[13.7482,100.561],[13.7462,100.5722],[13.7457,100.5739],[13.7448,100.5792],[13.7433,100.5852],[13.7411,100.5971],[13.7411,100.5979],[13.7407,100.5987],[13.743,100.5987],[13.7474,100.6003],[13.7607,100.6145],[13.7614,100.6163],[13.7617,100.6192],[13.7621,100.6208],[13.7635,100.6342],[13.765,100.6474],[13.7652,100.6483],[13.7659,100.6498],[13.7699,100.6549],[13.7982,100.7061],[13.7829,100.7147],[13.7815,100.7153],[13.7799,100.7155],[13.777,100.7166],[13.7726,100.7162],[13.7715,100.7159],[13.7668,100.7131],[13.7653,100.7125],[13.7639,100.7112],[13.7624,100.7103],[13.7615,100.7094],[13.7577,100.7069],[13.7568,100.7065],[13.7565,100.7071],[13.7564,100.7082],[13.7564,100.7097],[13.7307,100.7083],[13.7241,100.7089],[13.7061,100.7115],[13.7013,100.7123],[13.7012,100.711],[13.6952,100.7099],[13.6951,100.7102],[13.6913,100.7098],[13.6883,100.709],[13.6877,100.7086],[13.6847,100.7073],[13.6786,100.7064],[13.6788,100.7055],[13.6746,100.7046],[13.6744,100.7052],[13.6717,100.7041],[13.6641,100.6998],[13.6627,100.6993],[13.6586,100.6985],[13.6536,100.698],[13.6546,100.6932],[13.6519,100.6928],[13.6514,100.6929],[13.6513,100.6924],[13.6506,100.6924],[13.6513,100.6892],[13.6501,100.6884],[13.6482,100.688],[13.6478,100.687],[13.6467,100.6866],[13.6464,100.686],[13.6433,100.6828],[13.6422,100.6823],[13.639,100.6815],[13.6365,100.6806],[13.6341,100.679],[13.631,100.6786],[13.6273,100.6784],[13.6268,100.6781],[13.626,100.6754],[13.6235,100.6758],[13.6229,100.6756],[13.6223,100.6752],[13.6218,100.6753],[13.6205,100.6747],[13.6188,100.6724],[13.6158,100.6716],[13.6149,100.6715],[13.614,100.6711],[13.614,100.6722],[13.6134,100.6758],[13.6128,100.6771],[13.6115,100.6819],[13.6111,100.685],[13.6101,100.6885],[13.6096,100.6893],[13.6094,100.6905],[13.6088,100.6926],[13.6082,100.6939],[13.6077,100.6965],[13.607,100.6983],[13.6064,100.7025],[13.6057,100.7049],[13.6057,100.7078],[13.6047,100.7095],[13.6041,100.7097],[13.6034,100.7105],[13.6034,100.7119],[13.6035,100.7132],[13.6031,100.7173],[13.6033,100.7203],[13.6024,100.728],[13.6022,100.7291],[13.6021,100.7326],[13.6018,100.7349],[13.6015,100.736],[13.6012,100.7385],[13.6012,100.7403],[13.6017,100.7432],[13.6017,100.7446],[13.601,100.7461],[13.5994,100.7481],[13.5991,100.7501],[13.5987,100.7517],[13.5986,100.7535],[13.599,100.7545],[13.5998,100.7558],[13.5994,100.7595],[13.5992,100.7601],[13.598,100.7615],[13.5966,100.7667],[13.597,100.7711],[13.5967,100.7723],[13.5961,100.777],[13.5946,100.7804],[13.5938,100.7829],[13.5937,100.7846],[13.593,100.7881],[13.593,100.7902],[13.5924,100.7929],[13.5913,100.7965],[13.5908,100.7986],[13.5907,100.799],[13.5902,100.7992],[13.5887,100.8039],[13.5879,100.8043],[13.5873,100.8042],[13.5866,100.8036],[13.5857,100.8023],[13.5854,100.8021],[13.5847,100.8024],[13.5839,100.8032],[13.5815,100.8084],[13.5812,100.8105],[13.5808,100.8116],[13.5802,100.8124],[13.5793,100.8133],[13.5792,100.8142],[13.5783,100.817],[13.5779,100.8176],[13.5769,100.8184],[13.5767,100.819],[13.5768,100.8198],[13.5771,100.8203],[13.578,100.8213],[13.5781,100.8222],[13.578,100.8228],[13.5774,100.8237],[13.576,100.8251],[13.5753,100.8256],[13.5752,100.8261],[13.5763,100.8283],[13.577,100.8293],[13.5779,100.8299],[13.5783,100.8305],[13.5787,100.8323],[13.578,100.8335],[13.5776,100.8339],[13.5767,100.8342],[13.5746,100.8344],[13.574,100.8347],[13.5733,100.8355],[13.5744,100.8376],[13.5743,100.8398],[13.5751,100.8414],[13.5757,100.8423],[13.5761,100.8443],[13.5761,100.8454],[13.5764,100.8463],[13.5772,100.8476],[13.5773,100.8509],[13.5776,100.8525],[13.5763,100.8531],[13.5759,100.8536],[13.5759,100.8553],[13.5764,100.8574],[13.5749,100.8626],[13.5729,100.8691],[13.5723,100.8724],[13.5718,100.874],[13.5722,100.876],[13.5714,100.8787],[13.5716,100.8823],[13.5645,100.8902],[13.5644,100.8899],[13.5632,100.8893],[13.562,100.8894],[13.5595,100.8899],[13.5586,100.8898],[13.5578,100.8895],[13.5576,100.8891],[13.5575,100.887],[13.5571,100.8864],[13.5517,100.8841],[13.551,100.8835],[13.5485,100.8799],[13.548,100.8795],[13.5423,100.8784],[13.5385,100.877],[13.5357,100.8761],[13.5344,100.8755],[13.5286,100.8745],[13.527,100.8738],[13.5255,100.8727],[13.5245,100.8723],[13.5237,100.8721],[13.5231,100.8722],[13.5206,100.8741],[13.5199,100.874],[13.5183,100.8735],[13.5163,100.8724],[13.513,100.8716],[13.5087,100.8722],[13.5077,100.8726],[13.502,100.8727],[13.5002,100.8726],[13.498,100.8722],[13.4942,100.8725],[13.4904,100.8715],[13.4896,100.8717],[13.4876,100.8716],[13.4956,100.8521],[13.4735,100.8497],[13.475,100.8396],[13.4825,100.8175],[13.4845,100.8037],[13.491,100.7675],[13.4961,100.7294],[13.4965,100.7177],[13.5002,100.6929],[13.5027,100.678],[13.5058,100.6654],[13.5093,100.6597],[13.5099,100.658],[13.5116,100.6468],[13.5131,100.6397],[13.5136,100.6381],[13.5155,100.6349],[13.5175,100.6312],[13.5195,100.6264],[13.5212,100.6242],[13.5221,100.6234],[13.5246,100.6216],[13.5271,100.6226],[13.5303,100.6221],[13.5323,100.6202],[13.5334,100.6181],[13.5359,100.6152],[13.5374,100.6117],[13.5377,100.6041],[13.5376,100.5982],[13.5376,100.5958],[13.5373,100.593],[13.5571,100.5776],[13.5594,100.5769],[13.5623,100.5764],[13.5696,100.5766],[13.573,100.5779],[13.5768,100.5805],[13.5842,100.5862],[13.5923,100.5909],[13.5951,100.5922],[13.5978,100.5926],[13.6051,100.5915],[13.6073,100.5906],[13.6091,100.5887],[13.61,100.5868],[13.6107,100.5848],[13.6112,100.5795],[13.611,100.5758],[13.6113,100.5665],[13.6118,100.5639],[13.6126,100.5613],[13.614,100.5577],[13.6166,100.5534],[13.619,100.5499],[13.6208,100.5481],[13.627,100.5427],[13.6358,100.5373],[13.6388,100.5361],[13.6422,100.5351],[13.6461,100.5343],[13.6485,100.534],[13.653,100.5341],[13.654,100.5344],[13.6569,100.5356],[13.6586,100.5366],[13.6597,100.5377],[13.6604,100.5388],[13.6609,100.5407],[13.6609,100.5415],[13.6604,100.545],[13.6596,100.548],[13.6588,100.5502],[13.6561,100.5567],[13.6558,100.5589],[13.6561,100.5619],[13.6567,100.5641],[13.6582,100.5676],[13.6613,100.5718],[13.6642,100.5748],[13.6674,100.5776],[13.6746,100.5836],[13.681,100.5884],[13.6822,100.589],[13.6849,100.5897],[13.6885,100.5893],[13.6911,100.5888],[13.6965,100.5835],[13.6986,100.581],[13.7007,100.5767],[13.7022,100.573],[13.7057,100.5635],[13.7063,100.5611],[13.7064,100.5597],[13.7063,100.5569],[13.7057,100.5553],[13.7046,100.5538],[13.7029,100.5523],[13.7012,100.5517],[13.6991,100.5513],[13.6971,100.5515],[13.6906,100.5526],[13.6859,100.5527],[13.6823,100.5525],[13.678,100.5514],[13.6772,100.551],[13.6749,100.5492],[13.6738,100.5485],[13.6718,100.5468],[13.6709,100.5451],[13.6694,100.5418],[13.6692,100.5406],[13.6691,100.5382],[13.6698,100.5349],[13.6716,100.5309],[13.6832,100.5171],[13.6844,100.5134],[13.6854,100.5064],[13.687,100.4985],[13.6888,100.4946],[13.6903,100.4924],[13.6917,100.4909],[13.6933,100.49]]],[[[13.7599,100.4891],[13.7617,100.4905],[13.7656,100.4948],[13.7675,100.4963],[13.7701,100.4979],[13.7791,100.5015],[13.7845,100.5042],[13.7924,100.5114],[13.7945,100.5131],[13.7973,100.5151],[13.8002,100.5164],[13.8,100.5223],[13.7992,100.5249],[13.7993,100.5256],[13.7987,100.5268],[13.7988,100.5288],[13.7982,100.5323],[13.7996,100.5331],[13.7976,100.5373],[13.803,100.5398],[13.8071,100.5412],[13.8126,100.5433],[13.815,100.544],[13.8166,100.5446],[13.8233,100.5479],[13.8381,100.5558],[13.8554,100.5652],[13.8557,100.5656],[13.8556,100.5662],[13.8563,100.5689],[13.8564,100.571],[13.8566,100.5725],[13.857,100.5736],[13.857,100.5749],[13.8574,100.5762],[13.8574,100.5778],[13.8579,100.5815],[13.8579,100.5835],[13.8582,100.584],[13.8584,100.5857],[13.8589,100.5864],[13.8566,100.5874],[13.8521,100.5876],[13.85,100.5882],[13.8463,100.5888],[13.8438,100.5898],[13.8441,100.5909],[13.8453,100.594],[13.8458,100.5969],[13.8461,100.5976],[13.8463,100.5986],[13.8468,100.6023],[13.8481,100.6043],[13.8492,100.6069],[13.8491,100.6086],[13.8491,100.614],[13.8484,100.6196],[13.8481,100.6208],[13.8472,100.6217],[13.8466,100.6227],[13.8458,100.6235],[13.8435,100.6278],[13.8426,100.6287],[13.8427,100.6311],[13.8425,100.633],[13.8439,100.636],[13.8436,100.6367],[13.8448,100.6373],[13.8457,100.6386],[13.8462,100.6394],[13.8466,100.6409],[13.8474,100.6462],[13.8462,100.6485],[13.8464,100.65],[13.8469,100.6521],[13.8468,100.6531],[13.8478,100.6565],[13.8478,100.6586],[13.8486,100.6589],[13.8486,100.6592],[13.8488,100.6593],[13.8491,100.6612],[13.8498,100.6615],[13.85,100.6619],[13.8505,100.6634],[13.8505,100.6657],[13.8509,100.6674],[13.8511,100.668],[13.8516,100.6684],[13.8524,100.6698],[13.8527,100.6708],[13.8525,100.6709],[13.8523,100.6716],[13.8522,100.6738],[13.8515,100.6769],[13.8504,100.6787],[13.8502,100.6801],[13.8491,100.6823],[13.848,100.6838],[13.8468,100.6843],[13.8451,100.6855],[13.8437,100.686],[13.8417,100.6864],[13.8402,100.6868],[13.8382,100.6878],[13.836,100.6883],[13.835,100.6878],[13.8347,100.6878],[13.8324,100.6905],[13.8309,100.6909],[13.8301,100.6919],[13.8242,100.6952],[13.8232,100.6954],[13.8222,100.6954],[13.8216,100.6956],[13.8208,100.6961],[13.8202,100.6969],[13.817,100.6965],[13.8151,100.6968],[13.8136,100.6971],[13.8126,100.6975],[13.8119,100.6981],[13.8106,100.6997],[13.8095,100.7014],[13.8091,100.7018],[13.8079,100.7021],[13.807,100.702],[13.806,100.7015],[13.8046,100.7005],[13.7976,100.7049],[13.7699,100.6549],[13.7659,100.6498],[13.7652,100.6483],[13.765,100.6474],[13.7635,100.6342],[13.7621,100.6208],[13.7617,100.6192],[13.7614,100.6163],[13.7607,100.6145],[13.7474,100.6003],[13.743,100.5987],[13.7407,100.5988],[13.7411,100.5979],[13.7411,100.5971],[13.7433,100.5852],[13.7448,100.5792],[13.7457,100.5739],[13.7462,100.5722],[13.7482,100.561],[13.7484,100.5587],[13.7482,100.5543],[13.7481,100.554],[13.7482,100.5539],[13.7484,100.5499],[13.7229,100.5526],[13.7327,100.5292],[13.738,100.5157],[13.7353,100.5159],[13.7325,100.5155],[13.7313,100.5149],[13.7305,100.5143],[13.73,100.5136],[13.7293,100.5123],[13.7311,100.5118],[13.7338,100.5106],[13.7357,100.5088],[13.737,100.5063],[13.7387,100.4991],[13.7401,100.4949],[13.7406,100.4939],[13.7417,100.4926],[13.7442,100.4905],[13.746,100.4892],[13.7476,100.4883],[13.7497,100.4878],[13.7523,100.4876],[13.7546,100.4876],[13.7571,100.488],[13.7599,100.4891]]],[[[13.819,100.5063],[13.8194,100.5064],[13.8211,100.5071],[13.8215,100.5076],[13.8228,100.5077],[13.8234,100.5087],[13.8236,100.5096],[13.8242,100.5101],[13.8245,100.5101],[13.8246,100.5096],[13.8248,100.5093],[13.8255,100.5093],[13.8252,100.5107],[13.8262,100.511],[13.8261,100.5118],[13.8259,100.5121],[13.8249,100.5126],[13.8247,100.5131],[13.8262,100.5132],[13.8271,100.5154],[13.8276,100.5158],[13.8286,100.5159],[13.8307,100.5188],[13.8339,100.5223],[13.8344,100.5228],[13.8398,100.5291],[13.8417,100.531],[13.8424,100.532],[13.8442,100.5338],[13.8451,100.535],[13.8462,100.5362],[13.8466,100.5374],[13.8475,100.5386],[13.8495,100.5433],[13.8499,100.5435],[13.8499,100.5438],[13.9515,100.5677],[13.9518,100.5687],[13.9544,100.5732],[13.9546,100.5739],[13.951,100.5893],[13.9503,100.5915],[13.9483,100.5965],[13.9457,100.6019],[13.9441,100.6057],[13.9537,100.6045],[13.9543,100.614],[13.9534,100.616],[13.9516,100.6194],[13.9505,100.6224],[13.9487,100.6252],[13.935,100.626],[13.9344,100.6399],[13.9322,100.64],[13.9318,100.6405],[13.9314,100.6418],[13.9313,100.6471],[13.9312,100.6479],[13.9312,100.6502],[13.9306,100.659],[13.9308,100.6615],[13.9305,100.6636],[13.9305,100.6683],[13.9309,100.6782],[13.9308,100.6818],[13.931,100.6863],[13.9308,100.6892],[13.931,100.6899],[13.9259,100.6894],[13.9249,100.6887],[13.9238,100.6886],[13.923,100.688],[13.9214,100.6873],[13.9205,100.6872],[13.9191,100.6873],[13.9189,100.6924],[13.9195,100.7028],[13.9201,100.7078],[13.9224,100.7181],[13.924,100.7277],[13.924,100.7327],[13.9258,100.7471],[13.9278,100.7596],[13.931,100.7918],[13.9327,100.7995],[13.9369,100.8208],[13.9366,100.8208],[13.9396,100.8337],[13.941,100.8433],[13.9436,100.8648],[13.9486,100.914],[13.9447,100.9141],[13.9062,100.9091],[13.8958,100.9079],[13.8806,100.9064],[13.8702,100.9062],[13.8658,100.9064],[13.8605,100.9063],[13.8598,100.9057],[13.8591,100.9055],[13.8589,100.9047],[13.8541,100.9034],[13.8489,100.9022],[13.8477,100.9081],[13.8474,100.909],[13.8468,100.9128],[13.8446,100.9115],[13.8437,100.9107],[13.8415,100.9091],[13.8381,100.9078],[13.8144,100.9386],[13.8029,100.9297],[13.8014,100.9289],[13.7948,100.9175],[13.7909,100.9104],[13.79,100.9096],[13.7665,100.8965],[13.7542,100.8894],[13.7294,100.8736],[13.7022,100.8567],[13.6994,100.8552],[13.6904,100.8763],[13.689,100.8801],[13.6842,100.8946],[13.6754,100.9186],[13.6635,100.9526],[13.6619,100.9576],[13.6599,100.9568],[13.6589,100.9561],[13.6581,100.9548],[13.657,100.9549],[13.6561,100.9547],[13.6553,100.9526],[13.6529,100.9527],[13.6483,100.9536],[13.647,100.954],[13.6455,100.9586],[13.6448,100.9623],[13.6441,100.9651],[13.6376,100.9628],[13.633,100.9611],[13.6315,100.9601],[13.6236,100.9516],[13.6165,100.9443],[13.6104,100.939],[13.5993,100.9305],[13.5975,100.9281],[13.5931,100.9245],[13.5946,100.9207],[13.5948,100.9194],[13.5946,100.9184],[13.5927,100.9147],[13.5923,100.9137],[13.5922,100.913],[13.5928,100.9097],[13.5926,100.9085],[13.592,100.9073],[13.5872,100.9067],[13.5856,100.9067],[13.5833,100.9071],[13.5807,100.907],[13.5803,100.9086],[13.5799,100.9095],[13.5784,100.9123],[13.5776,100.9134],[13.5767,100.914],[13.5732,100.9151],[13.5713,100.9152],[13.5692,100.9139],[13.5673,100.9118],[13.5652,100.9111],[13.5631,100.9091],[13.5617,100.9081],[13.5604,100.9077],[13.5589,100.9066],[13.5566,100.9052],[13.5541,100.9041],[13.5615,100.8938],[13.5641,100.8909],[13.5645,100.8902],[13.5716,100.8823],[13.5714,100.8787],[13.5722,100.876],[13.5718,100.874],[13.5723,100.8724],[13.5729,100.8691],[13.5749,100.8626],[13.5764,100.8574],[13.5759,100.8553],[13.5759,100.8536],[13.5763,100.8531],[13.5776,100.8524],[13.5773,100.8509],[13.5772,100.8476],[13.5764,100.8463],[13.5761,100.8454],[13.5761,100.8443],[13.5757,100.8423],[13.5751,100.8414],[13.5743,100.8398],[13.5744,100.8376],[13.5733,100.8354],[13.574,100.8347],[13.5746,100.8344],[13.5767,100.8342],[13.5776,100.8339],[13.578,100.8335],[13.5787,100.8323],[13.5783,100.8305],[13.5779,100.8299],[13.577,100.8293],[13.5763,100.8283],[13.5752,100.8261],[13.5753,100.8256],[13.576,100.8251],[13.5774,100.8237],[13.578,100.8228],[13.5781,100.8222],[13.578,100.8213],[13.5771,100.8203],[13.5768,100.8198],[13.5767,100.8191],[13.5769,100.8184],[13.5779,100.8176],[13.5783,100.817],[13.5792,100.8142],[13.5793,100.8133],[13.5802,100.8124],[13.5808,100.8116],[13.5812,100.8105],[13.5815,100.8084],[13.5839,100.8032],[13.5847,100.8024],[13.5854,100.8021],[13.5857,100.8023],[13.5866,100.8036],[13.5873,100.8042],[13.5879,100.8043],[13.5887,100.8039],[13.5902,100.7992],[13.5906,100.7991],[13.5908,100.7986],[13.5913,100.7965],[13.5924,100.7929],[13.593,100.7902],[13.593,100.7881],[13.5937,100.7846],[13.5938,100.7829],[13.5946,100.7804],[13.5961,100.777],[13.5967,100.7723],[13.597,100.7711],[13.5966,100.7667],[13.598,100.7615],[13.5992,100.7601],[13.5994,100.7595],[13.5998,100.7558],[13.599,100.7545],[13.5986,100.7535],[13.5987,100.7517],[13.5991,100.7501],[13.5994,100.7481],[13.601,100.7461],[13.6017,100.7446],[13.6017,100.7432],[13.6012,100.7403],[13.6012,100.7385],[13.6015,100.736],[13.6018,100.7349],[13.6021,100.7326],[13.6022,100.7291],[13.6024,100.728],[13.6033,100.7203],[13.6031,100.7173],[13.6035,100.7132],[13.6034,100.7119],[13.6034,100.7105],[13.6041,100.7097],[13.6047,100.7095],[13.6057,100.7078],[13.6057,100.7049],[13.6064,100.7025],[13.607,100.6983],[13.6077,100.6965],[13.6082,100.6939],[13.6088,100.6926],[13.6094,100.6905],[13.6096,100.6893],[13.6101,100.6885],[13.6111,100.685],[13.6115,100.6819],[13.6128,100.6771],[13.6134,100.6758],[13.614,100.6722],[13.614,100.671],[13.6149,100.6715],[13.6158,100.6716],[13.6188,100.6724],[13.6205,100.6747],[13.6218,100.6753],[13.6223,100.6752],[13.6229,100.6756],[13.6235,100.6758],[13.626,100.6754],[13.6268,100.6781],[13.6273,100.6784],[13.631,100.6786],[13.6341,100.679],[13.6365,100.6806],[13.639,100.6815],[13.6422,100.6823],[13.6433,100.6828],[13.6464,100.686],[13.6467,100.6866],[13.6478,100.687],[13.6483,100.688],[13.6501,100.6884],[13.6513,100.6892],[13.6507,100.6924],[13.6513,100.6924],[13.6514,100.6928],[13.6519,100.6928],[13.6546,100.6932],[13.6536,100.698],[13.6586,100.6985],[13.6627,100.6993],[13.6641,100.6998],[13.6725,100.7045],[13.6744,100.7052],[13.6746,100.7046],[13.6788,100.7055],[13.6787,100.7064],[13.6847,100.7073],[13.6878,100.7086],[13.6883,100.709],[13.6913,100.7098],[13.6951,100.7102],[13.6952,100.7099],[13.7012,100.711],[13.7013,100.7123],[13.7061,100.7115],[13.724,100.7089],[13.7307,100.7083],[13.7564,100.7097],[13.7564,100.7082],[13.7567,100.7065],[13.7577,100.7069],[13.761,100.709],[13.7624,100.7103],[13.7639,100.7112],[13.7653,100.7125],[13.7668,100.7131],[13.7715,100.7159],[13.7726,100.7162],[13.777,100.7166],[13.7799,100.7155],[13.7815,100.7153],[13.7829,100.7147],[13.7982,100.7061],[13.7976,100.7049],[13.8044,100.7005],[13.8047,100.7004],[13.8054,100.7011],[13.807,100.702],[13.8079,100.7021],[13.8089,100.7018],[13.8095,100.7014],[13.8112,100.6987],[13.8126,100.6975],[13.8147,100.6968],[13.8165,100.6966],[13.8173,100.6965],[13.8203,100.6969],[13.8208,100.6961],[13.8216,100.6956],[13.8222,100.6954],[13.8232,100.6954],[13.8242,100.6952],[13.8301,100.6919],[13.8309,100.6909],[13.8324,100.6905],[13.8347,100.6878],[13.835,100.6878],[13.836,100.6883],[13.8386,100.6877],[13.8402,100.6868],[13.8417,100.6864],[13.8437,100.686],[13.8451,100.6855],[13.8468,100.6843],[13.848,100.6838],[13.8491,100.6823],[13.85,100.6804],[13.8504,100.6787],[13.8515,100.677],[13.8522,100.6738],[13.8523,100.6716],[13.8527,100.6708],[13.8524,100.6698],[13.8516,100.6684],[13.8511,100.668],[13.8509,100.6674],[13.8505,100.6657],[13.8505,100.6634],[13.85,100.6619],[13.8498,100.6615],[13.8491,100.6612],[13.8488,100.6593],[13.8486,100.6592],[13.8486,100.6589],[13.8477,100.6587],[13.8478,100.6565],[13.8468,100.6531],[13.8469,100.6521],[13.8464,100.65],[13.8462,100.6485],[13.8474,100.6462],[13.8466,100.6409],[13.8462,100.6394],[13.8457,100.6386],[13.8448,100.6373],[13.8436,100.6366],[13.8439,100.636],[13.8425,100.633],[13.8427,100.6311],[13.8426,100.6287],[13.8435,100.6278],[13.8458,100.6235],[13.8466,100.6227],[13.8472,100.6217],[13.8481,100.6208],[13.8484,100.6196],[13.8491,100.614],[13.8491,100.6086],[13.8492,100.6069],[13.8481,100.6043],[13.8468,100.6023],[13.8463,100.5986],[13.8461,100.5976],[13.8458,100.5969],[13.8453,100.594],[13.8441,100.5909],[13.8438,100.5897],[13.8463,100.5888],[13.85,100.5882],[13.8521,100.5876],[13.8566,100.5874],[13.8588,100.5864],[13.8584,100.5857],[13.8582,100.584],[13.8579,100.5835],[13.8579,100.5815],[13.8574,100.5778],[13.8574,100.5762],[13.857,100.5749],[13.857,100.5736],[13.8566,100.5725],[13.8564,100.571],[13.8563,100.5689],[13.8556,100.5662],[13.8557,100.5656],[13.8554,100.5652],[13.8381,100.5558],[13.8233,100.5479],[13.8166,100.5446],[13.815,100.544],[13.8126,100.5433],[13.8071,100.5412],[13.803,100.5398],[13.7975,100.5373],[13.7996,100.5331],[13.7982,100.5323],[13.7988,100.5288],[13.7987,100.5268],[13.7992,100.5256],[13.7992,100.5249],[13.8,100.5223],[13.8002,100.5164],[13.8016,100.517],[13.805,100.5176],[13.8102,100.5171],[13.8113,100.5166],[13.8132,100.5152],[13.8141,100.5142],[13.8161,100.5075],[13.819,100.5063]]],[[[13.8041,100.3284],[13.8038,100.3335],[13.8025,100.3741],[13.8024,100.3827],[13.8014,100.4107],[13.8007,100.4228],[13.7995,100.4401],[13.7995,100.4423],[13.7982,100.459],[13.7972,100.464],[13.7949,100.4697],[13.7921,100.4679],[13.7899,100.4666],[13.789,100.4664],[13.7907,100.4733],[13.8007,100.501],[13.8017,100.5025],[13.8132,100.5152],[13.8113,100.5166],[13.8102,100.5171],[13.805,100.5176],[13.8016,100.517],[13.7993,100.5161],[13.7973,100.5151],[13.7945,100.5131],[13.7924,100.5114],[13.7845,100.5042],[13.7791,100.5015],[13.7701,100.4979],[13.7675,100.4963],[13.7656,100.4948],[13.7617,100.4905],[13.7599,100.4891],[13.7571,100.488],[13.7546,100.4876],[13.7523,100.4876],[13.7497,100.4878],[13.7476,100.4883],[13.746,100.4892],[13.7442,100.4905],[13.7412,100.4931],[13.7404,100.4943],[13.7396,100.4961],[13.7387,100.4991],[13.7374,100.5049],[13.7366,100.5071],[13.7357,100.5088],[13.7343,100.5102],[13.7322,100.5113],[13.7293,100.5123],[13.7272,100.5127],[13.7253,100.5127],[13.7231,100.5127],[13.7211,100.5124],[13.7175,100.5115],[13.716,100.5107],[13.7146,100.5099],[13.7117,100.5075],[13.7084,100.5039],[13.7076,100.5028],[13.7058,100.5],[13.7029,100.4945],[13.7019,100.493],[13.7001,100.4913],[13.6988,100.4907],[13.696,100.49],[13.6933,100.49],[13.6921,100.4905],[13.6903,100.4924],[13.6888,100.4946],[13.687,100.4985],[13.6854,100.5064],[13.6844,100.5134],[13.6832,100.5171],[13.6716,100.5309],[13.6698,100.5349],[13.6691,100.5382],[13.6692,100.5406],[13.6694,100.5418],[13.6709,100.5451],[13.6718,100.5468],[13.6738,100.5485],[13.6749,100.5492],[13.6772,100.551],[13.678,100.5514],[13.6823,100.5525],[13.6859,100.5527],[13.6906,100.5526],[13.6971,100.5515],[13.6991,100.5513],[13.7012,100.5517],[13.7029,100.5523],[13.7046,100.5538],[13.7057,100.5553],[13.7063,100.5569],[13.7064,100.5597],[13.7063,100.5611],[13.7057,100.5635],[13.7022,100.573],[13.7007,100.5767],[13.6986,100.581],[13.6965,100.5835],[13.6911,100.5888],[13.6885,100.5893],[13.6849,100.5897],[13.6822,100.589],[13.681,100.5884],[13.6746,100.5836],[13.6674,100.5776],[13.6642,100.5748],[13.6613,100.5718],[13.6582,100.5676],[13.6567,100.5641],[13.6561,100.5619],[13.6558,100.5599],[13.6558,100.5576],[13.6561,100.5566],[13.6588,100.5502],[13.6596,100.548],[13.6606,100.5435],[13.6609,100.5407],[13.6604,100.5388],[13.6597,100.5377],[13.6586,100.5366],[13.6569,100.5356],[13.653,100.5341],[13.6485,100.534],[13.6461,100.5343],[13.6422,100.5351],[13.6388,100.5361],[13.6358,100.5373],[13.627,100.5427],[13.6208,100.5481],[13.619,100.5499],[13.6166,100.5534],[13.614,100.5577],[13.6126,100.5613],[13.6118,100.5639],[13.6113,100.5665],[13.611,100.5758],[13.6112,100.5795],[13.6107,100.5848],[13.61,100.5868],[13.6091,100.5887],[13.6074,100.5906],[13.6051,100.5915],[13.5978,100.5926],[13.5951,100.5922],[13.5923,100.5909],[13.5842,100.5862],[13.5768,100.5805],[13.573,100.5779],[13.5696,100.5766],[13.5623,100.5764],[13.5594,100.5769],[13.5571,100.5776],[13.5373,100.593],[13.5366,100.5907],[13.5354,100.5892],[13.5348,100.5887],[13.5333,100.5882],[13.5255,100.589],[13.5241,100.5886],[13.5204,100.5862],[13.5177,100.584],[13.5176,100.5832],[13.5138,100.579],[13.5137,100.5791],[13.513,100.5788],[13.512,100.5771],[13.5092,100.5747],[13.5091,100.5741],[13.5097,100.5738],[13.5092,100.5732],[13.5092,100.573],[13.5095,100.5728],[13.5101,100.5736],[13.5108,100.573],[13.5104,100.5725],[13.5101,100.5726],[13.5101,100.5723],[13.5098,100.5724],[13.5096,100.572],[13.5104,100.5719],[13.5106,100.5717],[13.5106,100.5709],[13.5103,100.5701],[13.5095,100.57],[13.5091,100.5693],[13.5093,100.5691],[13.5096,100.5693],[13.5103,100.5688],[13.5103,100.5685],[13.5099,100.5683],[13.5096,100.5684],[13.5097,100.5677],[13.509,100.567],[13.5092,100.5666],[13.5088,100.5662],[13.509,100.5658],[13.5091,100.5652],[13.5088,100.5642],[13.5095,100.5637],[13.5092,100.5631],[13.5088,100.563],[13.5082,100.5619],[13.5075,100.5617],[13.5077,100.5552],[13.5072,100.5545],[13.5069,100.5545],[13.5068,100.5541],[13.5062,100.5537],[13.5057,100.5525],[13.5059,100.5491],[13.5056,100.549],[13.5056,100.5486],[13.5062,100.5485],[13.5059,100.5476],[13.5057,100.5475],[13.5057,100.547],[13.506,100.5469],[13.5061,100.5434],[13.5057,100.5433],[13.505,100.5406],[13.5042,100.5396],[13.5041,100.5369],[13.5037,100.5368],[13.5036,100.5355],[13.5033,100.5354],[13.503,100.5348],[13.5032,100.5344],[13.503,100.534],[13.5017,100.5341],[13.5017,100.533],[13.5024,100.533],[13.5031,100.5321],[13.5031,100.5306],[13.5035,100.5305],[13.5036,100.5291],[13.5031,100.5285],[13.503,100.5279],[13.5026,100.5276],[13.5025,100.5272],[13.5022,100.5271],[13.5023,100.5243],[13.5031,100.524],[13.5029,100.5229],[13.5026,100.5229],[13.5029,100.5219],[13.5024,100.5215],[13.5021,100.52],[13.5016,100.52],[13.5017,100.5169],[13.5013,100.5167],[13.5009,100.5168],[13.5001,100.5162],[13.5011,100.515],[13.5007,100.5146],[13.5013,100.5146],[13.5013,100.5143],[13.5003,100.5141],[13.5001,100.5138],[13.5006,100.5132],[13.5006,100.5124],[13.5011,100.5119],[13.5015,100.511],[13.5011,100.5078],[13.5006,100.5067],[13.5005,100.5044],[13.5003,100.5029],[13.4999,100.5021],[13.4997,100.5009],[13.5,100.5006],[13.4999,100.4978],[13.4988,100.4977],[13.4988,100.4957],[13.4991,100.4943],[13.4997,100.494],[13.5,100.4932],[13.4995,100.4931],[13.4994,100.4924],[13.4982,100.4925],[13.4979,100.4917],[13.4967,100.4915],[13.4963,100.4904],[13.4966,100.4902],[13.4966,100.4899],[13.4984,100.4895],[13.4985,100.4893],[13.4979,100.4891],[13.497,100.4872],[13.497,100.4865],[13.4975,100.4863],[13.4973,100.4832],[13.4971,100.483],[13.496,100.4831],[13.4958,100.4809],[13.4968,100.4805],[13.4966,100.4796],[13.4969,100.4782],[13.4972,100.4777],[13.4969,100.4775],[13.497,100.475],[13.4977,100.4749],[13.498,100.4731],[13.4977,100.473],[13.4972,100.4723],[13.4971,100.4719],[13.4985,100.4721],[13.4986,100.4709],[13.4979,100.4703],[13.497,100.4704],[13.4969,100.4691],[13.4978,100.4691],[13.4979,100.4684],[13.4975,100.4683],[13.4968,100.4673],[13.4962,100.4661],[13.4956,100.4657],[13.4951,100.4648],[13.4948,100.4638],[13.4949,100.4626],[13.4993,100.4603],[13.4996,100.4591],[13.5,100.4589],[13.5002,100.4573],[13.5002,100.4557],[13.4995,100.4543],[13.4998,100.4535],[13.4993,100.4524],[13.499,100.4523],[13.4991,100.452],[13.4986,100.4519],[13.4986,100.4513],[13.4976,100.4486],[13.4967,100.4421],[13.4961,100.4405],[13.4961,100.4393],[13.4951,100.433],[13.4947,100.4274],[13.4938,100.4239],[13.4935,100.4187],[13.4927,100.4106],[13.493,100.4097],[13.5076,100.4063],[13.5078,100.4061],[13.5199,100.4067],[13.5204,100.4069],[13.5216,100.408],[13.5235,100.4087],[13.5247,100.4104],[13.5258,100.4105],[13.5262,100.4111],[13.5275,100.4113],[13.5281,100.4118],[13.529,100.4122],[13.5314,100.4129],[13.5353,100.4126],[13.5358,100.4135],[13.5364,100.4139],[13.5368,100.4145],[13.538,100.4149],[13.5384,100.4146],[13.5392,100.4152],[13.5402,100.4178],[13.5409,100.4186],[13.5414,100.4187],[13.5426,100.4194],[13.5431,100.4193],[13.5435,100.4194],[13.5445,100.42],[13.546,100.4198],[13.5468,100.4194],[13.5488,100.4175],[13.55,100.4167],[13.551,100.4148],[13.5514,100.4144],[13.5524,100.4147],[13.5533,100.4149],[13.5545,100.4147],[13.5561,100.4152],[13.557,100.4151],[13.5567,100.414],[13.5573,100.4137],[13.5574,100.4135],[13.5568,100.413],[13.5569,100.4123],[13.5566,100.412],[13.5557,100.4122],[13.5549,100.4107],[13.5547,100.4097],[13.5547,100.4089],[13.5542,100.4084],[13.5549,100.4072],[13.5543,100.4067],[13.5542,100.4064],[13.5545,100.406],[13.5546,100.4054],[13.5551,100.4048],[13.5551,100.4045],[13.5534,100.4034],[13.5529,100.4026],[13.553,100.4017],[13.5525,100.4011],[13.5526,100.4003],[13.5523,100.3993],[13.5524,100.3991],[13.5527,100.3991],[13.5529,100.3989],[13.5526,100.3981],[13.5526,100.3972],[13.5532,100.3964],[13.5532,100.3958],[13.5536,100.3953],[13.5545,100.3951],[13.5546,100.3946],[13.5553,100.3948],[13.5556,100.3947],[13.556,100.3942],[13.5576,100.3939],[13.558,100.3943],[13.5584,100.3933],[13.5594,100.393],[13.5596,100.3931],[13.5599,100.3928],[13.5603,100.3932],[13.5605,100.3925],[13.5612,100.3932],[13.5617,100.3927],[13.5623,100.3926],[13.5625,100.3923],[13.5629,100.3922],[13.563,100.392],[13.5628,100.3913],[13.563,100.391],[13.5645,100.3911],[13.5654,100.3907],[13.5672,100.3909],[13.5689,100.3905],[13.5704,100.3906],[13.5717,100.3899],[13.5742,100.3894],[13.5757,100.3883],[13.5777,100.3877],[13.582,100.387],[13.5837,100.3863],[13.5848,100.3863],[13.5851,100.3861],[13.5852,100.3853],[13.5855,100.3853],[13.5856,100.3857],[13.5859,100.3857],[13.5859,100.385],[13.5861,100.3847],[13.5863,100.3853],[13.5869,100.3848],[13.5874,100.3853],[13.5876,100.3851],[13.5877,100.3842],[13.5884,100.3845],[13.5891,100.3842],[13.5898,100.3831],[13.5903,100.3827],[13.5906,100.3818],[13.591,100.3815],[13.5912,100.3809],[13.5919,100.381],[13.5928,100.3815],[13.5938,100.3833],[13.6021,100.3784],[13.6066,100.3771],[13.6067,100.3772],[13.6094,100.3771],[13.6097,100.3767],[13.6094,100.3763],[13.6136,100.376],[13.6136,100.3757],[13.6159,100.3753],[13.6185,100.3752],[13.6185,100.3751],[13.6191,100.3745],[13.6201,100.3729],[13.6208,100.373],[13.6207,100.372],[13.6244,100.3712],[13.6249,100.3714],[13.6253,100.3713],[13.6256,100.371],[13.6253,100.3703],[13.6256,100.3697],[13.6256,100.3691],[13.6258,100.3689],[13.6262,100.3672],[13.6264,100.3671],[13.6271,100.3673],[13.6273,100.3671],[13.6274,100.366],[13.6277,100.3656],[13.6274,100.365],[13.628,100.3649],[13.6282,100.3644],[13.6294,100.363],[13.6297,100.363],[13.6299,100.3632],[13.6308,100.3627],[13.6312,100.363],[13.6315,100.3624],[13.6315,100.3617],[13.6329,100.3616],[13.6329,100.3612],[13.6334,100.3611],[13.6333,100.3601],[13.6344,100.36],[13.6342,100.3587],[13.6348,100.3585],[13.6367,100.3585],[13.6411,100.3569],[13.6423,100.3561],[13.6422,100.3558],[13.6418,100.3549],[13.6422,100.3546],[13.6421,100.3542],[13.6409,100.3544],[13.6408,100.3538],[13.6409,100.352],[13.6403,100.3521],[13.6402,100.3519],[13.6401,100.3503],[13.6404,100.3503],[13.6404,100.3486],[13.6402,100.3478],[13.6393,100.3453],[13.6393,100.3438],[13.6388,100.341],[13.639,100.3407],[13.6428,100.3382],[13.6503,100.3386],[13.6508,100.3388],[13.6518,100.3386],[13.653,100.3389],[13.6543,100.3396],[13.6563,100.3393],[13.6574,100.3397],[13.6589,100.3409],[13.6597,100.3409],[13.6606,100.3413],[13.6613,100.3413],[13.6625,100.3407],[13.6636,100.3406],[13.6655,100.3401],[13.6665,100.3403],[13.6677,100.3394],[13.6683,100.3393],[13.6692,100.3389],[13.6718,100.3387],[13.6727,100.3385],[13.6742,100.3385],[13.6762,100.338],[13.6771,100.3375],[13.677,100.3361],[13.6816,100.3334],[13.6834,100.3339],[13.6877,100.3326],[13.6909,100.332],[13.6917,100.332],[13.6923,100.3321],[13.6973,100.3314],[13.6999,100.3303],[13.7019,100.3303],[13.7019,100.3312],[13.702,100.3313],[13.7036,100.3312],[13.7065,100.3328],[13.7078,100.3333],[13.7088,100.3334],[13.71,100.3333],[13.71,100.3335],[13.7103,100.3335],[13.7123,100.3326],[13.7132,100.3348],[13.7116,100.3353],[13.7118,100.3372],[13.7126,100.3386],[13.714,100.3379],[13.715,100.3378],[13.7159,100.3387],[13.7176,100.3383],[13.7176,100.3381],[13.7182,100.3379],[13.7183,100.3379],[13.7211,100.3363],[13.7218,100.3362],[13.723,100.3364],[13.7242,100.3363],[13.726,100.3364],[13.7261,100.337],[13.7277,100.3364],[13.728,100.3365],[13.7291,100.3361],[13.7294,100.3365],[13.7318,100.3351],[13.7326,100.3351],[13.7352,100.3335],[13.7368,100.3328],[13.7391,100.3332],[13.7397,100.3331],[13.741,100.3326],[13.7441,100.3318],[13.7463,100.3318],[13.7483,100.3313],[13.7536,100.3318],[13.7547,100.3314],[13.7571,100.3313],[13.7588,100.3308],[13.7614,100.3305],[13.7627,100.33],[13.7651,100.3293],[13.7685,100.3291],[13.7763,100.3299],[13.7876,100.3304],[13.7923,100.3301],[13.7962,100.3295],[13.7992,100.3293],[13.8014,100.3288],[13.802,100.3288],[13.8021,100.3291],[13.8024,100.3291],[13.8041,100.3284]]],[[[13.9206,100.2651],[13.9349,100.2743],[13.9442,100.2844],[13.9634,100.2981],[13.9761,100.2807],[13.9849,100.272],[13.9894,100.2691],[13.9932,100.2678],[14.0015,100.2749],[14.0066,100.2667],[14.0118,100.2624],[14.0166,100.2595],[14.0217,100.2574],[14.0265,100.2561],[14.0328,100.2555],[14.0386,100.2558],[14.0469,100.258],[14.0514,100.26],[14.0562,100.263],[14.0605,100.2668],[14.0646,100.2718],[14.0668,100.2735],[14.0693,100.2739],[14.0709,100.2736],[14.0727,100.2736],[14.0739,100.2745],[14.0756,100.2748],[14.0817,100.2766],[14.0887,100.277],[14.0988,100.2771],[14.1086,100.278],[14.1206,100.2794],[14.1256,100.2797],[14.1336,100.2903],[14.1361,100.2931],[14.1384,100.2944],[14.1394,100.2955],[14.1402,100.2971],[14.1398,100.2988],[14.1389,100.3008],[14.1361,100.3081],[14.1332,100.3132],[14.1293,100.3222],[14.1279,100.3333],[14.115,100.3444],[14.1053,100.3421],[14.0971,100.3416],[14.0922,100.3401],[14.077,100.3347],[14.0693,100.3333],[14.0672,100.3324],[14.0608,100.3317],[14.0531,100.3323],[14.0478,100.3334],[14.0434,100.3346],[14.0384,100.3365],[14.0249,100.3428],[14.0225,100.3435],[14.0178,100.3458],[14.0083,100.3511],[14.0008,100.3556],[13.9953,100.3605],[13.9943,100.3611],[13.9924,100.3642],[13.9921,100.365],[13.9909,100.3716],[13.9889,100.3806],[13.9948,100.3811],[13.9835,100.4254],[13.9814,100.4341],[13.9808,100.4356],[13.9799,100.4371],[13.9742,100.4442],[13.9681,100.4526],[13.9673,100.4522],[13.9669,100.4526],[13.9664,100.4533],[13.9661,100.4541],[13.9663,100.4545],[13.966,100.4551],[13.9621,100.4588],[13.9615,100.4596],[13.9606,100.4618],[13.9602,100.4638],[13.9597,100.4645],[13.9582,100.4657],[13.9583,100.4665],[13.9587,100.4665],[13.9598,100.467],[13.96,100.4673],[13.9602,100.468],[13.9599,100.4693],[13.9601,100.47],[13.9607,100.4706],[13.9637,100.4724],[13.9611,100.4751],[13.9608,100.4759],[13.9587,100.478],[13.9571,100.4793],[13.9557,100.4808],[13.9542,100.4818],[13.9512,100.4846],[13.9505,100.486],[13.9501,100.4863],[13.9475,100.4873],[13.9465,100.4885],[13.946,100.4886],[13.9449,100.4875],[13.944,100.488],[13.9432,100.4886],[13.9425,100.4894],[13.9421,100.4905],[13.9411,100.4913],[13.941,100.4924],[13.9406,100.493],[13.9405,100.4935],[13.9408,100.4939],[13.9402,100.4953],[13.9398,100.4953],[13.9396,100.4957],[13.939,100.4978],[13.9384,100.4981],[13.9378,100.4995],[13.9375,100.5022],[13.9393,100.5035],[13.9415,100.5054],[13.9425,100.5069],[13.9434,100.5088],[13.9438,100.5105],[13.9439,100.515],[13.9436,100.5203],[13.9435,100.5233],[13.9441,100.5282],[13.9445,100.5298],[13.9451,100.5313],[13.9456,100.5322],[13.9475,100.5348],[13.949,100.5364],[13.9525,100.5386],[13.9539,100.5389],[13.9558,100.539],[13.9555,100.542],[13.9554,100.5422],[13.9552,100.5421],[13.9547,100.5413],[13.9535,100.542],[13.954,100.5428],[13.9544,100.5441],[13.9543,100.5442],[13.9535,100.5439],[13.953,100.5444],[13.953,100.5448],[13.9534,100.5454],[13.9533,100.5456],[13.9526,100.5456],[13.9525,100.5458],[13.9527,100.5471],[13.9527,100.5484],[13.9521,100.5491],[13.9517,100.5512],[13.9511,100.5526],[13.9514,100.5534],[13.9504,100.5541],[13.9504,100.5543],[13.9514,100.5545],[13.9515,100.5547],[13.9515,100.555],[13.9502,100.5562],[13.9501,100.5568],[13.9498,100.5572],[13.9505,100.5584],[13.9507,100.5596],[13.9507,100.5603],[13.9504,100.5605],[13.95,100.5606],[13.95,100.561],[13.9494,100.5615],[13.9494,100.5617],[13.9499,100.5621],[13.9496,100.5628],[13.9498,100.5634],[13.9497,100.564],[13.9505,100.5647],[13.9506,100.5658],[13.9503,100.5667],[13.951,100.5667],[13.9515,100.5677],[13.8498,100.5438],[13.8499,100.5435],[13.8495,100.5434],[13.8475,100.5386],[13.8466,100.5374],[13.8462,100.5362],[13.8451,100.535],[13.8442,100.5338],[13.8424,100.532],[13.8417,100.531],[13.8398,100.5291],[13.8344,100.5228],[13.8339,100.5223],[13.8307,100.5188],[13.8286,100.5159],[13.8276,100.5158],[13.8271,100.5154],[13.8262,100.5132],[13.8247,100.5131],[13.8249,100.5126],[13.8259,100.5121],[13.8261,100.5118],[13.8262,100.511],[13.8252,100.5107],[13.8256,100.5095],[13.8255,100.5093],[13.8248,100.5093],[13.8246,100.5096],[13.8245,100.5101],[13.8242,100.5101],[13.8236,100.5096],[13.8234,100.5087],[13.8228,100.5077],[13.8215,100.5076],[13.8212,100.5072],[13.8194,100.5064],[13.819,100.5063],[13.8161,100.5075],[13.8141,100.5142],[13.8132,100.5152],[13.8017,100.5025],[13.8009,100.5013],[13.8002,100.4999],[13.7913,100.4753],[13.7902,100.4719],[13.789,100.4663],[13.7899,100.4666],[13.7921,100.4679],[13.7949,100.4697],[13.7972,100.464],[13.7982,100.459],[13.7995,100.4423],[13.7995,100.4401],[13.8007,100.4228],[13.8014,100.4107],[13.8024,100.3827],[13.8025,100.3741],[13.8038,100.3335],[13.8042,100.3279],[13.8105,100.325],[13.8797,100.2923],[13.9111,100.2772],[13.915,100.2744],[13.9206,100.2651]]]];   // เส้นขอบภาค (รวมสาขา) ตามลำดับ TUR_REGIONS
let turFontReady = null;
function turEnsureFont() {
  if (!TUR_CANVAS) return Promise.resolve(false);
  if (turFontReady) return turFontReady;
  turFontReady = (async () => {
    const fs = require('fs'), path = require('path');
    const files = { 'Sarabun-Bold.ttf': 'TurSarabunBold', 'Sarabun-Regular.ttf': 'TurSarabun' };
    for (const [f, fam] of Object.entries(files)) {
      const p = path.join('/tmp', f);
      try {
        if (!fs.existsSync(p)) {
          const r = await axios.get(`https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/${f}`, { responseType: 'arraybuffer', timeout: 20000 });
          fs.writeFileSync(p, Buffer.from(r.data));
        }
        TUR_CANVAS.GlobalFonts.registerFromPath(p, fam);
      } catch (e) { console.error('[TurMap] font', f, e.message); turFontReady = null; return false; }
    }
    return true;
  })();
  return turFontReady;
}
function shadeCol(hex, f) { const n = parseInt(hex.slice(1), 16), m = v => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${m(n >> 16 & 255)},${m(n >> 8 & 255)},${m(n & 255)})`; }
const TUR_MAP_BOX = { minLat: 13.475, maxLat: 14.155, minLon: 100.245, maxLon: 100.965 };
async function renderTurbidityMap(S, title) {
  await turEnsureFont();
  const W = 1040, H = 1040, PAD = 20;
  const cv = TUR_CANVAS.createCanvas(W, H), ctx = cv.getContext('2d');
  const k = Math.cos(13.8 * Math.PI / 180);
  const bw = (TUR_MAP_BOX.maxLon - TUR_MAP_BOX.minLon) * k, bh = TUR_MAP_BOX.maxLat - TUR_MAP_BOX.minLat;
  const sc = Math.min((W - 2 * PAD) / bw, (H - 2 * PAD) / bh);
  const ox = (W - bw * sc) / 2, oy = (H - bh * sc) / 2;
  const X = lon => ox + (lon - TUR_MAP_BOX.minLon) * k * sc, Y = lat => oy + (TUR_MAP_BOX.maxLat - lat) * sc;
  const regOf = br => TUR_REGIONS.findIndex(r => r.br.includes(br));
  ctx.fillStyle = '#f1f5f9'; ctx.fillRect(0, 0, W, H);
  // ทะเล (อ่าวไทย) — แถบล่างอ่อนๆ
  ctx.fillStyle = '#dbeafe'; ctx.fillRect(0, Y(13.53), W, H - Y(13.53));
  const ring = (pts) => { ctx.beginPath(); pts.forEach(([la, lo], i) => i ? ctx.lineTo(X(lo), Y(la)) : ctx.moveTo(X(lo), Y(la))); ctx.closePath(); };
  // พื้นที่สาขา ลงสีตามภาค + เส้นขอบสาขาสีขาว
  for (const b of TUR_BRANCH_POLY) {
    const ri = regOf(b.n), col = ri >= 0 ? TUR_REGIONS[ri].col : '#94a3b8';
    ring(b.c); ctx.globalAlpha = 0.40; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  // เส้นขอบภาค (บริการ 1–5) — เข้ม หนา
  TUR_REGION_OUTLINE.forEach((rings, ri) => rings.forEach(pts => {
    ring(pts); ctx.lineJoin = 'round'; ctx.lineWidth = 6; ctx.strokeStyle = shadeCol(TUR_REGIONS[ri].col, 0.75); ctx.stroke();
  }));
  // ชื่อสาขา
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '21px TurSarabunBold';
  const NAME_POS = {"ภาษีเจริญ":[13.6928,100.3807],"บางเขน":[13.8862,100.6476],"มีนบุรี":[13.8597,100.8264],"ทุ่งมหาเมฆ":[13.7022,100.5266],"บางกอกน้อย":[13.77,100.4415],"สุวรรณภูมิ":[13.6723,100.7839],"บางบัวทอง":[13.9541,100.3422],"มหาสวัสดิ์":[13.8561,100.3611],"พระโขนง":[13.6707,100.6469],"สุขสวัสดิ์":[13.5669,100.5106],"นนทบุรี":[13.8712,100.5154],"แม้นศรี":[13.7585,100.5147],"สมุทรปราการ":[13.5552,100.6867],"ตากสิน":[13.6076,100.4159],"สุขุมวิท":[13.7517,100.679],"พญาไท":[13.7843,100.562],"ลาดพร้าว":[13.8028,100.6293],"ประชาชื่น":[13.9199,100.5894]};   // จุดวางชื่อสาขา (polylabel — ใจกลางพื้นที่)
  for (const b of TUR_BRANCH_POLY) {
    const [cla, clo] = NAME_POS[b.n] || b.cen, x = X(clo), y = Y(cla);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeText(b.n, x, y);
    ctx.fillStyle = '#334155'; ctx.fillText(b.n, x, y);
  }
  const fill = v => v == null ? '#94a3b8' : v <= 4 ? '#16a34a' : v <= 5 ? '#f59e0b' : '#dc2626';
  // จุดสถานี (สถานีน้ำออกโรงงาน = สี่เหลี่ยม) — สี = ค่าเฉลี่ย, วงส้ม = มีช่วงเกิน 4 NTU
  const ids = Object.keys(TUR_STATIONS).sort((a, b) => ((S[a] && S[a].max) || 0) - ((S[b] && S[b].max) || 0));
  for (const id of ids) {
    const [, , la, lo] = TUR_STATIONS[id]; if (la == null) continue;
    const x = X(lo), y = Y(la), d = S[id];
    if (d && d.max > 4) { ctx.beginPath(); ctx.arc(x, y, 17, 0, 7); ctx.fillStyle = '#f97316'; ctx.fill(); }
    ctx.beginPath();
    if (TUR_PLANT_IDS.includes(id)) ctx.rect(x - 10, y - 10, 20, 20); else ctx.arc(x, y, 11, 0, 7);
    ctx.fillStyle = fill(d && d.avg); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  // ป้ายภาค: ตำแหน่ง = จุดกลางของสาขาที่ใหญ่ที่สุดในภาค (กำหนดเองให้ไม่ทับจุด)
  // [lat, lon ของป้าย, (lat, lon จุดชี้ ถ้าป้ายอยู่นอกพื้นที่)]
  const LABEL = [[13.505, 100.800], [14.075, 100.640, 13.790, 100.575], [13.905, 100.860], [13.545, 100.330], [14.075, 100.420]];
  TUR_REGIONS.forEach((r, i) => {
    const g = turGroupStats(turRegionIds(r), S); const [la, lo, ala, alo] = LABEL[i];
    const x = X(lo), y = Y(la), w = 236, h = 92;
    if (ala != null) {   // เส้นชี้จากป้ายไปยังพื้นที่
      const ax = X(alo), ay = Y(ala);
      ctx.strokeStyle = r.col; ctx.lineWidth = 4; ctx.setLineDash([10, 6]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ax, ay); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ax, ay, 9, 0, 7); ctx.fillStyle = r.col; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    ctx.globalAlpha = 0.94; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 16); ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 4; ctx.strokeStyle = r.col; ctx.stroke();
    ctx.fillStyle = r.col; ctx.beginPath(); ctx.roundRect(x - w / 2 + 10, y - h / 2 + 10, 72, 72, 14); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = '56px TurSarabunBold'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x - w / 2 + 46, y + 2);
    ctx.textAlign = 'left'; ctx.fillStyle = '#334155'; ctx.font = '24px TurSarabunBold';
    ctx.fillText(r.name, x - w / 2 + 94, y - 20);
    ctx.fillStyle = fill(g.avg); ctx.font = '42px TurSarabunBold';
    const vt = g.avg == null ? '–' : g.avg.toFixed(2); ctx.fillText(vt, x - w / 2 + 94, y + 20);
    const vw = ctx.measureText(vt).width;
    ctx.fillStyle = '#64748b'; ctx.font = '20px TurSarabunBold'; ctx.fillText('NTU', x - w / 2 + 100 + vw, y + 26);
  });
  // หัวเรื่อง + คำอธิบาย
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 0.92; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(18, 18, 520, 74, 14); ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = '#0f172a'; ctx.font = '32px TurSarabunBold'; ctx.fillText('ความขุ่นเฉลี่ยรายภาค (NTU)', 34, 55);
  ctx.fillStyle = '#64748b'; ctx.font = '22px TurSarabun'; ctx.fillText(title, 34, 82);
  const lg = [['#16a34a', '≤ 4'], ['#f59e0b', '> 4–5'], ['#dc2626', '> 5'], ['#f97316', 'มีช่วงเกิน 4']];
  ctx.globalAlpha = 0.92; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(W - 258, 18, 240, 280, 14); ctx.fill(); ctx.globalAlpha = 1;
  lg.forEach(([c, t], i) => {
    const y = 54 + i * 42;
    ctx.beginPath(); ctx.arc(W - 230, y, 12, 0, 7);
    if (i === 3) { ctx.lineWidth = 6; ctx.strokeStyle = c; ctx.stroke(); } else { ctx.fillStyle = c; ctx.fill(); }
    ctx.fillStyle = '#0f172a'; ctx.font = '26px TurSarabun'; ctx.fillText(t, W - 206, y + 9);
  });
  ctx.fillStyle = '#64748b'; ctx.fillRect(W - 240, 214, 20, 20); ctx.font = '24px TurSarabun'; ctx.fillStyle = '#0f172a'; ctx.fillText('น้ำออกโรงงาน', W - 206, 232);
  ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.arc(W - 230, 266, 10, 0, 7); ctx.fill(); ctx.fillStyle = '#0f172a'; ctx.fillText('สถานีระบบจ่าย', W - 206, 274);
  return cv.toBuffer('image/png');
}

const TUR_PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://frc-line-bot-production.up.railway.app');
const turRangeTitle = dayOffset => { const st = bkkMidnight(dayOffset), d = thaiDate(new Date(st + 12 * 3600e3)); return dayOffset < 0 ? `${d} (ทั้งวัน)` : `${d} · 0.00 – ${thaiTime()} น.`; };

const turRegionBtn = (r, i, dayOffset) => ({ type: 'button', style: 'primary', height: 'sm', color: r.col, flex: 1,
  action: { type: 'message', label: r.name, text: `ขุ่นบริการ ${i + 1}${dayOffset < 0 ? ' เมื่อวาน' : ''}` } });

// รายละเอียดบริการ N: ทุกสถานีในพื้นที่สาขาของภาค (แยกตามสาขา) — ไม่รวมสถานีน้ำออกโรงงาน
async function replyTurbidityRegion(replyToken, idx, dayOffset = 0) {
  try {
    const r = TUR_REGIONS[idx];
    if (!r) return lineReply(replyToken, withQuickReply([{ type: 'text', text: 'ไม่พบบริการนี้ (มี บริการ 1–5)' }]));
    const start = bkkMidnight(dayOffset), end = dayOffset < 0 ? bkkMidnight(dayOffset + 1) : null;
    const S = await loadTurbidityStats(start, end);
    const dayLabel = thaiDate(new Date(start + 12 * 3600e3));
    const ids = turRegionIds(r), g = turGroupStats(ids, S);
    const f2 = v => v == null ? '–' : v.toFixed(2);
    const c = { g: 0, y: 0, r: 0 }; ids.forEach(id => { if (S[id]) { const a = S[id].avg; c[a <= 4 ? 'g' : a <= 5 ? 'y' : 'r']++; } });
    const head = { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: 'สถานี', size: 'xxs', color: COLORS.textMuted, flex: 6 },
      { type: 'text', text: 'เฉลี่ย', size: 'xxs', color: COLORS.textMuted, flex: 2, align: 'end' },
      { type: 'text', text: 'สูงสุด', size: 'xxs', color: COLORS.textMuted, flex: 2, align: 'end' } ] };
    const stRow = id => { const d = S[id], nm = TUR_STATIONS[id][0];
      return { type: 'box', layout: 'horizontal', paddingTop: '3px', paddingBottom: '3px', contents: [
        { type: 'text', text: `${turDot(d && d.avg)} ${nm}`, size: 'xs', color: COLORS.textPrimary, flex: 6, wrap: true },
        { type: 'text', text: d ? f2(d.avg) : '–', size: 'xs', weight: 'bold', color: turColor(d && d.avg), flex: 2, align: 'end', gravity: 'center' },
        { type: 'text', text: d ? f2(d.max) : '–', size: 'xs', weight: 'bold', color: turColor(d && d.max), flex: 2, align: 'end', gravity: 'center' },
      ] }; };
    const body = [
      { type: 'box', layout: 'horizontal', paddingAll: '10px', cornerRadius: '8px', backgroundColor: r.bg, contents: [
        { type: 'box', layout: 'vertical', flex: 0, width: '44px', height: '44px', cornerRadius: '12px', backgroundColor: r.col, justifyContent: 'center', alignItems: 'center',
          contents: [{ type: 'text', text: String(idx + 1), size: 'xl', weight: 'bold', color: '#ffffff', align: 'center' }] },
        { type: 'box', layout: 'vertical', flex: 5, margin: 'md', contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `เฉลี่ย ${f2(g.avg)}`, size: 'md', weight: 'bold', color: turColor(g.avg), flex: 0 },
            { type: 'text', text: ` · สูงสุด ${f2(g.max)} NTU`, size: 'xs', color: turColor(g.max), flex: 0, gravity: 'bottom' } ] },
          { type: 'text', text: `🟢${c.g} 🟡${c.y} 🔴${c.r}  ·  มีข้อมูล ${g.n}/${g.tot} สถานี`, size: 'xxs', color: COLORS.textSecondary },
        ] },
      ] },
      head,
    ];
    r.br.forEach(b => {
      const list = ids.filter(id => TUR_STATIONS[id][1] === b);
      if (!list.length) return;
      body.push({ type: 'text', text: `▸ สาขา${b}`, size: 'sm', weight: 'bold', color: r.col, margin: 'md' });
      body.push({ type: 'separator', color: r.col });
      list.forEach(id => body.push(stRow(id)));
    });
    body.push({ type: 'text', text: 'เกณฑ์ 🟢 ≤4 · 🟡 >4–5 · 🔴 >5 NTU · ⚪ ไม่มีข้อมูล', size: 'xxs', color: COLORS.textMuted, margin: 'md', wrap: true });
    const back = dayOffset < 0 ? 'ขุ่นเมื่อวาน' : 'สรุปความขุ่น';
    return lineReply(replyToken, withQuickReply([{
      type: 'flex', altText: `💧 ความขุ่น ${r.name} ${dayLabel} — เฉลี่ย ${f2(g.avg)} สูงสุด ${f2(g.max)} NTU`,
      contents: { type: 'bubble', size: 'mega',
        header: makeHeader(`💧 ความขุ่น — ${r.name}`, dayOffset < 0 ? `${dayLabel} (ทั้งวัน)` : `${dayLabel} · 0.00 – ${thaiTime()} น.`, TUR_HEADER_COL, IMAGES.logo),
        body: { type: 'box', layout: 'vertical', paddingAll: '10px', paddingTop: '8px', contents: body },
        footer: { type: 'box', layout: 'vertical', paddingAll: '6px', spacing: 'xs', contents: [
          { type: 'box', layout: 'horizontal', spacing: 'xs', contents: TUR_REGIONS.map((x, i) => ({ type: 'button', style: i === idx ? 'secondary' : 'primary', height: 'sm', color: i === idx ? undefined : x.col, flex: 1,
            action: { type: 'message', label: String(i + 1), text: `ขุ่นบริการ ${i + 1}${dayOffset < 0 ? ' เมื่อวาน' : ''}` } })) },
          { type: 'button', style: 'primary', height: 'sm', color: '#0f172a', action: { type: 'message', label: '↩ กลับภาพรวมความขุ่น', text: back } },
        ] },
      },
    }]));
  } catch (err) {
    console.error('[Turbidity] region error:', err);
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ความขุ่นรายบริการ error: ' + err.message }]));
  }
}

async function replyTurbiditySummary(replyToken, dayOffset = 0) {
  try {
    const start = bkkMidnight(dayOffset), end = dayOffset < 0 ? bkkMidnight(dayOffset + 1) : null;
    const S = await loadTurbidityStats(start, end);
    const dayLabel = thaiDate(new Date(start + 12 * 3600e3));   // เที่ยงวันของวันนั้น (กันข้ามวันจาก timezone)
    if (!Object.keys(S).length)
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: `💧 ยังไม่มีข้อมูลความขุ่น${dayOffset < 0 ? 'ของเมื่อวาน' : 'สะสมวันนี้'}\n(เริ่มเก็บข้อมูลความขุ่นตั้งแต่ 3 ต.ค. 69 16:12 น.)` }]));

    const all = Object.keys(TUR_STATIONS), has = all.filter(id => S[id]);
    const cls = v => v == null ? 'na' : v <= 4 ? 'g' : v <= 5 ? 'y' : 'r';
    const cnt = ids => { const c = { g: 0, y: 0, r: 0, n: ids.length }; ids.forEach(id => { if (S[id]) c[cls(S[id].avg)]++; }); return c; };
    const C = cnt(all), total = has.length;
    const pct = total ? Math.round(C.g / total * 100) : 0;
    let oe, ot, ob;
    if (C.r === 0 && C.y === 0) { oe = '🟢'; ot = 'ดี'; ob = '#ecfdf5'; }
    else if (C.r === 0)         { oe = '🟡'; ot = 'เฝ้าระวัง'; ob = '#fffbeb'; }
    else                        { oe = '🔴'; ot = 'ต้องติดตาม'; ob = '#fef2f2'; }
    const avgAll = has.reduce((a, id) => a + S[id].avg, 0) / total;
    const maxId = has.reduce((a, id) => S[id].max > S[a].max ? id : a, has[0]);
    const minId = has.reduce((a, id) => S[id].min < S[a].min ? id : a, has[0]);
    const f2 = v => v == null ? '–' : v.toFixed(2);
    const exceed = has.filter(id => S[id].max > 4).sort((a, b) => S[b].max - S[a].max);

    // บล็อกใหญ่: ไอคอน 3D ซ้าย + เนื้อหาขวา (สไตล์เดียวกับการ์ดคลอรีน)
    const bigBlock = (icon, title, bg, hint, inner) => ({
      type: 'box', layout: 'vertical', margin: 'sm', paddingAll: '8px', cornerRadius: '8px', backgroundColor: bg,
      contents: [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          { type: 'image', url: icon, size: '36px', aspectMode: 'fit', aspectRatio: '1:1', flex: 0 },
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: COLORS.textPrimary, flex: 5, gravity: 'center' },
          ...(hint ? [{ type: 'text', text: hint, size: 'xxs', color: COLORS.textMuted, flex: 3, align: 'end', gravity: 'center' }] : []),
        ] },
        { type: 'box', layout: 'vertical', margin: 'xs', contents: inner },
      ],
    });
    // โรงงาน: ช่อง 2×2 — ชื่อ · ค่าเฉลี่ย (ใหญ่) · ค่าสูงสุด (เล็ก)
    const plantCell = p => { const g = turGroupStats(p.ids, S); return {
      type: 'box', layout: 'vertical', flex: 1, paddingAll: '4px', cornerRadius: '6px', backgroundColor: '#ffffffb3',
      contents: [
        { type: 'text', text: p.name.replace('รง.', ''), size: 'xxs', color: COLORS.textSecondary, align: 'center' },
        { type: 'text', text: f2(g.avg), size: 'md', weight: 'bold', color: turColor(g.avg), align: 'center' },
        { type: 'text', text: f2(g.max), size: 'xxs', color: turColor(g.max), align: 'center' },
      ] }; };
    // บริการ 1–5: แถวแตะได้ → รายละเอียดภาค
    const regionLine = (r, i) => { const ids = turRegionIds(r), g = turGroupStats(ids, S); return {
      type: 'box', layout: 'horizontal', margin: 'xs', paddingAll: '5px', cornerRadius: '6px', backgroundColor: '#ffffffb3', spacing: 'sm',
      action: { type: 'message', label: r.name, text: `ขุ่นบริการ ${i + 1}${dayOffset < 0 ? ' เมื่อวาน' : ''}` },
      contents: [
        { type: 'box', layout: 'vertical', flex: 0, width: '22px', height: '22px', cornerRadius: '6px', backgroundColor: r.col, justifyContent: 'center', alignItems: 'center',
          contents: [{ type: 'text', text: String(i + 1), size: 'xs', weight: 'bold', color: '#ffffff', align: 'center' }] },
        { type: 'text', text: r.name, size: 'xs', color: COLORS.textPrimary, flex: 4, gravity: 'center' },
        { type: 'text', text: `${ids.length} สถานี`, size: 'xxs', color: COLORS.textMuted, flex: 3, gravity: 'center' },
        { type: 'text', text: f2(g.avg), size: 'sm', weight: 'bold', color: turColor(g.avg), flex: 3, align: 'end', gravity: 'center' },
        { type: 'text', text: f2(g.max), size: 'xxs', color: turColor(g.max), flex: 3, align: 'end', gravity: 'center' },
        { type: 'text', text: '›', size: 'sm', color: '#a78bfa', flex: 0, gravity: 'center' },
      ] }; };

    const body = [
      { type: 'box', layout: 'horizontal', paddingAll: '10px', cornerRadius: '8px', backgroundColor: ob, contents: [
        { type: 'text', text: oe, size: 'xl', flex: 0, gravity: 'center' },
        { type: 'box', layout: 'vertical', flex: 5, margin: 'sm', contents: [
          { type: 'text', text: `ภาพรวม (ค่าเฉลี่ย): ${ot}`, size: 'sm', weight: 'bold', color: COLORS.textPrimary },
          { type: 'text', text: `ค่าเฉลี่ยผ่านเกณฑ์ ≤4 NTU ${C.g}/${total} สถานี (${pct}%)`, size: 'xxs', color: COLORS.textSecondary },
          makeProgressBar(pct, pct >= 90 ? COLORS.good : pct >= 70 ? COLORS.warn : COLORS.bad),
        ] },
      ] },
      { type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm', contents: [
        makeCountBox('เขียว ≤4', C.g, COLORS.good),
        makeCountBox('เหลือง >4–5', C.y, COLORS.warn),
        makeCountBox('แดง >5', C.r, COLORS.bad),
      ] },
      { type: 'separator', margin: 'sm' },
      makeStatRow('ความขุ่นเฉลี่ย', `${avgAll.toFixed(2)} NTU`),
      makeStatRow('สูงสุด / ต่ำสุด', `${f2(S[maxId].max)} / ${f2(S[minId].min)} NTU`),
      { type: 'separator', margin: 'sm' },
      bigBlock(IMAGES.iconSend, 'น้ำออกจากโรงงานผลิตน้ำ', '#dbeafe', 'เฉลี่ย · สูงสุด', [
        { type: 'box', layout: 'horizontal', spacing: 'xs', contents: TUR_PLANTS.map(plantCell) },
      ]),
      bigBlock(IMAGES.iconMonitor, 'น้ำในระบบจ่าย', '#ede9fe', 'เฉลี่ย · สูงสุด', [
        ...TUR_REGIONS.map(regionLine),
        { type: 'text', text: 'แตะแต่ละภาคเพื่อดูรายสถานี ›', size: 'xxs', color: '#7c3aed', margin: 'sm' },
      ]),
    ];
    if (exceed.length) {
      body.push({ type: 'separator', margin: 'xs' });
      body.push({ type: 'box', layout: 'vertical', margin: 'xs', paddingAll: '8px', cornerRadius: '6px', backgroundColor: COLORS.bgWarm, contents: [
        { type: 'text', text: `⚠️ ต้องติดตาม — ค่าสูงสุดเกิน 4 NTU (${exceed.length})`, size: 'xxs', weight: 'bold', color: COLORS.bad },
        ...exceed.slice(0, 5).map(id => ({ type: 'text', size: 'xxs', color: COLORS.textSecondary, wrap: true,
          text: `${turDot(S[id].max)} ${TUR_STATIONS[id][0].substring(0, 24)} — ${S[id].max.toFixed(2)} NTU (${thaiTime(new Date(S[id].maxTs))} น.)` })),
      ] });
    }
    body.push({ type: 'text', text: `เกณฑ์ 🟢 ≤4 · 🟡 >4–5 · 🔴 >5 NTU · ไม่มีข้อมูล ${all.length - total} สถานี`, size: 'xxs', color: COLORS.textMuted, margin: 'sm', wrap: true });

    const flex = {
      type: 'flex', altText: `💧 ความขุ่น ${dayLabel} — ${oe}${ot} เฉลี่ย ${avgAll.toFixed(2)} NTU`,
      contents: { type: 'bubble', size: 'mega',
        ...(TUR_CANVAS ? { hero: { type: 'image', url: `${TUR_PUBLIC_URL}/turbidity-map.png?d=${dayOffset < 0 ? -1 : 0}&t=${Date.now()}`,
          size: 'full', aspectRatio: '1:1', aspectMode: 'cover', action: { type: 'uri', label: 'รายงานเต็ม', uri: TUR_REPORT_URL } } } : {}),
        header: makeHeader('💧 ความขุ่นน้ำประปา (Turbidity)', dayOffset < 0 ? `${dayLabel} (ทั้งวัน)` : `${dayLabel} · 0.00 – ${thaiTime()} น.`, TUR_HEADER_COL, IMAGES.logo),
        body: { type: 'box', layout: 'vertical', paddingAll: '10px', paddingTop: '8px', contents: body },
      },
    };
    return lineReply(replyToken, withQuickReply([flex]));
  } catch (err) {
    console.error('[Turbidity] summary error:', err);
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ สรุปความขุ่น error: ' + err.message }]));
  }
}

async function replyDailySummary(replyToken) {
  try {
    const snap = await loadTodayHistorySnap();   // [ประหยัดดาวน์โหลด] เดิมโหลด history ทั้งก้อน 7 วัน
    if (!snap.exists()) {
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่พบข้อมูลประวัติ' }]));
    }

    const todayMs = bkkMidnight();   // [แก้ ต.ค.69] เที่ยงคืนเวลาไทย (เดิม setHours(0) บน UTC = 07:00 น. ไทย)
    const stationReadings = {};
    snap.forEach(cs => {
      const code = cs.key;
      if (code.startsWith('_')) return;
      cs.forEach(ps => {
        const p = ps.val();
        if (p && p.ts >= todayMs && p.frc != null && p.frc > 0) {
          if (!stationReadings[code]) stationReadings[code] = [];
          stationReadings[code].push(p.frc);
        }
      });
    });

    if (Object.keys(stationReadings).length === 0) {
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: '📊 ยังไม่มีข้อมูลสะสมวันนี้' }]));
    }

    const sensors = await fetchSensors();
    const sMap = {};
    for (const s of sensors) { sMap[String(s.id)] = s; sMap[String(s.id).replace(/\/|\./g,'-')] = s; }

    const daily = Object.entries(stationReadings).map(([code, r]) => {
      const avg = r.reduce((a,b) => a+b, 0) / r.length;
      const s = sMap[code] || {};
      return { id: code, name: s.name || code, frc: parseFloat(avg.toFixed(3)), type: s.type || 'monitor' };
    });

    const sendS = daily.filter(s => getStationType(s) === 'send');
    const pumpS = daily.filter(s => getStationType(s) === 'pump');
    const monS  = daily.filter(s => getStationType(s) === 'monitor');

    function cnt(list, thType) {
      let ok=0, watch=0, low=0, high=0;
      for (const s of list) {
        const th = getThreshold(thType, s.id);
        if (s.frc > th.high) high++; else if (s.frc >= th.good) ok++; else if (s.frc >= th.watch) watch++; else low++;
      }
      return { ok, watch, low, high, total: list.length };
    }

    const sc = cnt(sendS,'send'), pc = cnt(pumpS,'pump'), mc = cnt(monS,'monitor');
    const total = daily.length;
    const avgFrc = (daily.reduce((a,s) => a+s.frc, 0) / total).toFixed(2);
    const allOk = sc.ok+pc.ok+mc.ok, allWatch = sc.watch+pc.watch+mc.watch;
    const allLow = sc.low+pc.low+mc.low, allHigh = sc.high+pc.high+mc.high;

    const normalPct = total > 0 ? Math.round((allOk/total)*100) : 0;
    let oe, ot, ob;
    if (normalPct >= 90) { oe='🟢'; ot='ดี'; ob='#ecfdf5'; }
    else if (normalPct >= 70) { oe='🟡'; ot='พอใช้'; ob='#fffbeb'; }
    else { oe='🔴'; ot='ต้องติดตาม'; ob='#fef2f2'; }

    const avgSend = sendS.length ? (sendS.reduce((a,s)=>a+s.frc,0)/sendS.length).toFixed(2) : '-';
    const avgPump = pumpS.length ? (pumpS.reduce((a,s)=>a+s.frc,0)/pumpS.length).toFixed(2) : '-';
    const avgMon  = monS.length  ? (monS.reduce((a,s)=>a+s.frc,0)/monS.length).toFixed(2)   : '-';

    function typeRow(iconUrl, label, count, avg, bgTint, thType) {
      const th = THRESHOLDS[thType] || THRESHOLDS.monitor;
      return {
        type:"box",layout:"horizontal",margin:"xs",
        paddingAll:"8px",paddingStart:"10px",cornerRadius:"8px",
        backgroundColor:bgTint||COLORS.bgCard,
        contents:[
          {type:"box",layout:"vertical",flex:0,width:"56px",height:"56px",justifyContent:"center",alignItems:"center",
           contents:[{type:"image",url:iconUrl,size:"56px",aspectMode:"fit",aspectRatio:"1:1"}]},
          {type:"box",layout:"vertical",flex:5,margin:"md",justifyContent:"center",
           contents:[
             {type:"box",layout:"horizontal",contents:[
               {type:"text",text:label,size:"sm",weight:"bold",color:COLORS.textPrimary,flex:3},
               {type:"text",text:`${avg}`,size:"md",color:COLORS.accent,weight:"bold",flex:0},
               {type:"text",text:" mg/L",size:"xxs",color:COLORS.textMuted,flex:0,gravity:"bottom"}
             ]},
             {type:"text",text:`ดี≥${th.good}  ระวัง${th.watch}-${th.good}  ต่ำ<${th.low}`,size:"xxs",color:COLORS.textMuted,margin:"none"},
             {type:"text",text:`✅${count.ok} ⚠️${count.watch} ❌${count.low} 🔶${count.high}  ·  ${count.total} สถานี`,size:"xxs",color:COLORS.textSecondary,margin:"none"},
           ]}
        ]
      };
    }

    const body = [
      {type:"box",layout:"horizontal",paddingAll:"10px",cornerRadius:"8px",backgroundColor:ob,
       contents:[
         {type:"text",text:oe,size:"xl",flex:0,gravity:"center"},
         {type:"box",layout:"vertical",flex:5,margin:"sm",contents:[
           {type:"text",text:`ภาพรวม: ${ot}`,size:"sm",weight:"bold",color:COLORS.textPrimary},
           {type:"text",text:`ปกติ ${allOk}/${total} สถานี (${normalPct}%)`,size:"xxs",color:COLORS.textSecondary},
           makeProgressBar(normalPct, normalPct>=80?COLORS.good:normalPct>=50?COLORS.warn:COLORS.bad),
         ]}
       ]},
      {type:"box",layout:"horizontal",margin:"sm",spacing:"sm",contents:[
        makeCountBox("ดี",allOk,COLORS.good),makeCountBox("ระวัง",allWatch,COLORS.warn),
        makeCountBox("ต่ำ",allLow,COLORS.bad),makeCountBox("สูง",allHigh,COLORS.high),
      ]},
      {type:"separator",margin:"sm"},
      makeStatRow("FRC เฉลี่ยทั้งวัน",`${avgFrc} mg/L`),
      {type:"separator",margin:"sm"},
      typeRow(IMAGES.iconSend,"สูบส่ง",sc,avgSend,"#dbeafe",'send'),
      typeRow(IMAGES.iconPump,"สูบจ่าย",pc,avgPump,"#d1fae5",'pump'),
      typeRow(IMAGES.iconMonitor,"Monitor",mc,avgMon,"#ede9fe",'monitor'),
    ];

    // สถานีค่าต่ำ (แสดงสั้นๆ)
    const lowStations = daily.filter(s => { const t=getThreshold(s.type,s.id); return s.frc<t.low; }).sort((a,b)=>a.frc-b.frc).slice(0,3);
    if (lowStations.length > 0) {
      body.push({type:"separator",margin:"xs"});
      body.push({type:"box",layout:"vertical",margin:"xs",paddingAll:"8px",cornerRadius:"6px",backgroundColor:COLORS.bgWarm,
        contents:[
          {type:"text",text:"⚠️ ต้องติดตาม",size:"xxs",weight:"bold",color:COLORS.bad},
          ...lowStations.map(s => {
            const st = frcStatus(s.frc,s.type,s.id);
            return {type:"text",text:`${st.emoji} ${(s.name||s.id).substring(0,25)} — ${s.frc.toFixed(2)} mg/L`,size:"xxs",color:COLORS.textSecondary,wrap:true};
          })
        ]
      });
    }

    return lineReply(replyToken, withQuickReply([{
      type:"flex",altText:`📊 สรุปวัน — ${oe}${ot} FRC ${avgFrc} mg/L`,
      contents:{
        type:"bubble",size:"mega",
        header:{
          type:"box",layout:"vertical",backgroundColor:COLORS.headerDark,paddingAll:"16px",paddingBottom:"14px",
          contents:[{
            type:"box",layout:"horizontal",spacing:"lg",alignItems:"center",
            contents:[
              {type:"box",layout:"vertical",flex:0,width:"40px",height:"40px",cornerRadius:"12px",backgroundColor:"#ffffff20",justifyContent:"center",alignItems:"center",
               contents:[{type:"image",url:IMAGES.logo,size:"32px",aspectMode:"fit",aspectRatio:"1:1"}]},
              {type:"box",layout:"vertical",flex:5,contents:[
                {type:"text",text:"📊 สรุปประจำวัน",color:"#ffffff",weight:"bold",size:"lg",wrap:true},
                {type:"text",text:`(เวลา 0.00 น. – ปัจจุบัน)`,color:"#ffffffe0",size:"sm",weight:"bold",margin:"xs",wrap:true},
                {type:"text",text:`${thaiDate()} ${thaiTime()} น.`,color:"#ffffffaa",size:"xs",margin:"xs",wrap:true},
              ]}
            ]
          }]
        },
        body:{type:"box",layout:"vertical",paddingAll:"10px",paddingTop:"8px",contents:body},
        footer:{type:"box",layout:"horizontal",paddingAll:"6px",spacing:"xs",contents:[
          {type:"button",action:{type:"message",label:"📋 ตารางสรุปวัน",text:"ตารางสรุปวัน"},height:"sm",style:"primary",color:COLORS.accent,flex:1},
          {type:"button",action:{type:"uri",label:"🗺️ แผนที่",uri:CONTOUR_URL},height:"sm",style:"primary",color:"#0f172a",flex:1},
        ]}
      }
    }],['chlorine','table','low','ec','map']));
  } catch(err) {
    console.error('[Daily Summary Error]', err.message);
    return lineReply(replyToken, withQuickReply([{type:'text',text:'❌ สรุปวัน error: '+err.message}]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ตารางสรุป FRC แยกตามเขต (เหมือนเดิม + Quick Reply)
// ═══════════════════════════════════════════════════════════════════════════════

async function replyDailyTable(replyToken) {
  const sensors = await fetchSensors();
  if (!sensors.length) return lineReply(replyToken, withQuickReply([{ type: 'text', text: '❌ ไม่สามารถดึงข้อมูลได้' }]));

  // ── Zone Groups: จับคู่ตามเส้นทางน้ำจริง (ROOT_SOURCE_MAP) ──
  // match ด้วยชื่อสถานี (substring) เพื่อความแม่นยำ
  const ZONE_GROUPS = [
    {
      key: 'TR1', title: 'TR1 — สูบส่งน้ำบางเขน 1', color: '#831843',
      stations: ['TR1', 'ลุมพินี', 'พหลโยธิน', 'สำโรง', 'ทุ่งมหาเมฆ', 'ศิครินทร์', 'หาดอมรา', 'เอจีซี แฟลทกลาส', 'สมุทรปราการ', 'โรงไฟฟ้าพระนครใต้']
    },
    {
      key: 'TR2', title: 'TR2 — สูบส่งน้ำบางเขน 2', color: '#831843',
      stations: ['TR2', 'ลาดพร้าว', 'คลองเตย', 'โอสถสภา', 'เกร็ดตระการ', 'ศูนย์วิทยาศาสตร์เพื่อการศึกษา', 'สุขุมวิท']
    },
    {
      key: 'TR3', title: 'TR3 — สูบส่งน้ำบางเขน 3', color: '#831843',
      stations: ['TR3', 'บางพลี', 'มีนบุรี', 'ลาดกระบัง', 'คลองด่าน', 'บางปู', 'มหาจักรออโตพาร์ท', 'บางชัน', 'เทียนฟ้า', 'สุวรรณภูมิ', 'หัวเฉียว']
    },
    {
      key: 'MH', title: 'MH — สูบส่งน้ำมหาสวัสดิ์', color: '#581c87',
      stations: ['สูบส่งน้ำมหาสวัสดิ์', 'MTR', 'ราษฎร์บูรณะ', 'เพชรเกษม', 'ท่าพระ', 'พระจอมเกล้าธนบุรี', 'บางขุนเทียน', 'ศูนย์กีฬาเฉลิมพระเกียรติ', 'เอเชียอาคเนย์', 'เรือนจำพิเศษธนบุรี', 'คนชราบางแค', 'สวัสดิการสังคมผู้สูงอายุ']
    },
    {
      key: 'MDIS', title: 'MDIS — สูบจ่ายน้ำมหาสวัสดิ์', color: '#581c87',
      stations: ['สูบจ่ายน้ำมหาสวัสดิ์', 'MDIS', 'บดินทรเดชา', 'บางบัวทอง', 'ไทรน้อย', 'ราชวินิต', 'ตั้งพิรุฬห์ธรรม']
    },
    {
      key: 'Dis1', title: 'Dis1 — สูบจ่ายน้ำบางเขน 1', color: '#1e3a5f',
      stations: ['Dis1', 'นนทบุรี', 'กองพันทหารสื่อสาร', 'กองบัญชาการกองทัพไทย', 'ทหารขนส่ง', 'เตรียมอุดมศึกษาน้อมเกล้า']
    },
    {
      key: 'Dis2', title: 'Dis2 — สูบจ่ายน้ำบางเขน 2', color: '#1e3a5f',
      stations: ['Dis2', 'ซีจีเอช', 'สายไหม', 'ภูมิพลอดุลยเดช']
    },
    {
      key: 'THO', title: 'โรงงานผลิตน้ำธนบุรี', color: '#92400e',
      stations: ['ธนบุรี', 'ศิริราช']
    },
    {
      key: 'SAM', title: 'โรงงานผลิตน้ำสามเสน', color: '#065f46',
      stations: ['สามเสน', 'ดุสิต', 'จิตรลดา']
    },
  ];

  // match: ถ้าชื่อสถานีหรือ id มีคำใดคำหนึ่งใน stations[]
  function matchZone(s, zone) {
    const name = (s.name || '').toLowerCase();
    const id = String(s.id || '').toUpperCase();
    return zone.stations.some(keyword => {
      const kw = keyword.toLowerCase();
      return name.includes(kw) || id.includes(keyword.toUpperCase());
    });
  }

  const grouped = {};
  const assigned = new Set();
  for (const zone of ZONE_GROUPS) {
    grouped[zone.key] = sensors.filter(s => {
      if (assigned.has(String(s.id))) return false;
      if (matchZone(s, zone)) { assigned.add(String(s.id)); return true; }
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
    list.sort((a, b) => b.frc - a.frc);

    const rows = [
      {
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: "No.", size: "xxs", color: COLORS.textMuted, flex: 1, weight: "bold" },
          { type: "text", text: "สถานี", size: "xxs", color: COLORS.textMuted, flex: 8, weight: "bold" },
          { type: "text", text: "FRC", size: "xxs", color: COLORS.textMuted, flex: 2, align: "end", weight: "bold" }
        ]
      },
      { type: "separator", margin: "sm" }
    ];

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const st = frcStatus(s.frc, s.type, s.id);
      const fullName = s.name || String(s.id);
      rows.push({
        type: "box", layout: "horizontal", margin: "sm",
        contents: [
          { type: "text", text: `${i + 1}`, size: "xxs", color: COLORS.textMuted, flex: 1 },
          { type: "text", text: fullName, size: "xxs", color: COLORS.textPrimary, flex: 8, wrap: true },
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
// 📋 ตารางสรุปวัน — ค่าเฉลี่ย 0.00 น. – ปัจจุบัน แยกตามเขต
// ═══════════════════════════════════════════════════════════════════════════════

async function replyDailyTableSummary(replyToken) {
  try {
    const snap = await loadTodayHistorySnap();   // [ประหยัดดาวน์โหลด] เดิมโหลด history ทั้งก้อน 7 วัน
    if (!snap.exists()) return lineReply(replyToken, withQuickReply([{type:'text',text:'❌ ไม่พบข้อมูลประวัติ'}]));

    const todayMs = bkkMidnight();   // [แก้ ต.ค.69] เที่ยงคืนเวลาไทย (เดิม setHours(0) บน UTC = 07:00 น. ไทย)
    const stationReadings = {};
    snap.forEach(cs => {
      const code = cs.key;
      if (code.startsWith('_')) return;
      cs.forEach(ps => {
        const p = ps.val();
        if (p && p.ts >= todayMs && p.frc != null && p.frc > 0) {
          if (!stationReadings[code]) stationReadings[code] = [];
          stationReadings[code].push(p.frc);
        }
      });
    });
    if (Object.keys(stationReadings).length === 0) return lineReply(replyToken, withQuickReply([{type:'text',text:'📊 ยังไม่มีข้อมูลสะสมวันนี้'}]));

    const sensors = await fetchSensors();
    const sMap = {};
    for (const s of sensors) { sMap[String(s.id)] = s; sMap[String(s.id).replace(/\/|\./g,'-')] = s; }

    // คำนวณค่าเฉลี่ยทั้งวันต่อสถานี
    const dailyStations = Object.entries(stationReadings).map(([code, r]) => {
      const avg = r.reduce((a,b) => a+b, 0) / r.length;
      const s = sMap[code] || {};
      return { id: code, name: s.name || code, frc: parseFloat(avg.toFixed(3)), type: s.type || 'monitor' };
    });

    // Zone groups (reuse เดียวกับ replyDailyTable)
    const ZONE_GROUPS = [
      { key:'TR1', title:'TR1 — สูบส่งน้ำบางเขน 1', color:'#831843', stations:['TR1','ลุมพินี','พหลโยธิน','สำโรง','ทุ่งมหาเมฆ','ศิครินทร์','หาดอมรา','เอจีซี แฟลทกลาส','สมุทรปราการ','โรงไฟฟ้าพระนครใต้'] },
      { key:'TR2', title:'TR2 — สูบส่งน้ำบางเขน 2', color:'#831843', stations:['TR2','ลาดพร้าว','คลองเตย','โอสถสภา','เกร็ดตระการ','ศูนย์วิทยาศาสตร์เพื่อการศึกษา','สุขุมวิท'] },
      { key:'TR3', title:'TR3 — สูบส่งน้ำบางเขน 3', color:'#831843', stations:['TR3','บางพลี','มีนบุรี','ลาดกระบัง','คลองด่าน','บางปู','มหาจักรออโตพาร์ท','บางชัน','เทียนฟ้า','สุวรรณภูมิ','หัวเฉียว'] },
      { key:'MH', title:'MH — สูบส่งน้ำมหาสวัสดิ์', color:'#581c87', stations:['สูบส่งน้ำมหาสวัสดิ์','MTR','ราษฎร์บูรณะ','เพชรเกษม','ท่าพระ','พระจอมเกล้าธนบุรี','บางขุนเทียน','ศูนย์กีฬาเฉลิมพระเกียรติ','เอเชียอาคเนย์','เรือนจำพิเศษธนบุรี','คนชราบางแค','สวัสดิการสังคมผู้สูงอายุ'] },
      { key:'MDIS', title:'MDIS — สูบจ่ายน้ำมหาสวัสดิ์', color:'#581c87', stations:['สูบจ่ายน้ำมหาสวัสดิ์','MDIS','บดินทรเดชา','บางบัวทอง','ไทรน้อย','ราชวินิต','ตั้งพิรุฬห์ธรรม'] },
      { key:'Dis1', title:'Dis1 — สูบจ่ายน้ำบางเขน 1', color:'#1e3a5f', stations:['Dis1','นนทบุรี','กองพันทหารสื่อสาร','กองบัญชาการกองทัพไทย','ทหารขนส่ง','เตรียมอุดมศึกษาน้อมเกล้า'] },
      { key:'Dis2', title:'Dis2 — สูบจ่ายน้ำบางเขน 2', color:'#1e3a5f', stations:['Dis2','ซีจีเอช','สายไหม','ภูมิพลอดุลยเดช'] },
      { key:'THO', title:'โรงงานผลิตน้ำธนบุรี', color:'#92400e', stations:['ธนบุรี','ศิริราช'] },
      { key:'SAM', title:'โรงงานผลิตน้ำสามเสน', color:'#065f46', stations:['สามเสน','ดุสิต','จิตรลดา'] },
    ];

    function matchZone(s, zone) {
      const name = (s.name || '').toLowerCase();
      const id = String(s.id || '').toUpperCase();
      return zone.stations.some(kw => name.includes(kw.toLowerCase()) || id.includes(kw.toUpperCase()));
    }

    const grouped = {};
    const assigned = new Set();
    for (const zone of ZONE_GROUPS) {
      grouped[zone.key] = dailyStations.filter(s => {
        if (assigned.has(String(s.id))) return false;
        if (matchZone(s, zone)) { assigned.add(String(s.id)); return true; }
        return false;
      });
    }
    const unassigned = dailyStations.filter(s => !assigned.has(String(s.id)));
    if (unassigned.length > 0) {
      ZONE_GROUPS.push({ key:'OTHER', title:'อื่นๆ', color:'#374151', stations:[] });
      grouped['OTHER'] = unassigned;
    }

    const bubbles = [];
    for (const zone of ZONE_GROUPS) {
      const list = grouped[zone.key] || [];
      if (list.length === 0) continue;
      list.sort((a, b) => b.frc - a.frc);

      const rows = [
        { type:"box", layout:"horizontal", margin:"sm", contents:[
          { type:"text", text:"No.", size:"xxs", color:COLORS.textMuted, flex:1, weight:"bold" },
          { type:"text", text:"สถานี", size:"xxs", color:COLORS.textMuted, flex:8, weight:"bold" },
          { type:"text", text:"FRC avg", size:"xxs", color:COLORS.textMuted, flex:2, align:"end", weight:"bold" }
        ]},
        { type:"separator", margin:"sm" }
      ];

      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const st = frcStatus(s.frc, s.type, s.id);
        rows.push({ type:"box", layout:"horizontal", margin:"sm", contents:[
          { type:"text", text:`${i+1}`, size:"xxs", color:COLORS.textMuted, flex:1 },
          { type:"text", text:s.name||s.id, size:"xxs", color:COLORS.textPrimary, flex:8, wrap:true },
          { type:"text", text:s.frc.toFixed(2), size:"xxs", color:st.color, flex:2, align:"end", weight:"bold" }
        ]});
      }

      const avg = (list.reduce((a,s) => a+s.frc, 0) / list.length).toFixed(2);
      rows.push({ type:"separator", margin:"sm" });
      rows.push({ type:"box", layout:"horizontal", margin:"sm", contents:[
        { type:"text", text:"-", size:"xxs", color:"#ffffff00", flex:1 },
        { type:"text", text:"เฉลี่ย", size:"xxs", color:COLORS.textPrimary, flex:6, weight:"bold" },
        { type:"text", text:avg, size:"xxs", color:COLORS.textPrimary, flex:2, align:"end", weight:"bold" }
      ]});

      bubbles.push({
        type:"bubble", size:"mega",
        header:makeHeader(zone.title, `${list.length} สถานี | เฉลี่ยทั้งวัน`, zone.color),
        body:{ type:"box", layout:"vertical", paddingAll:"10px", spacing:"none", contents:rows }
      });
    }

    if (bubbles.length === 0) return lineReply(replyToken, withQuickReply([{type:'text',text:'❌ ไม่พบข้อมูล'}]));

    const totalS = dailyStations.length;
    const avgAll = (dailyStations.reduce((a,s) => a+s.frc, 0) / totalS).toFixed(2);

    const summaryBubble = {
      type:"bubble", size:"mega",
      header:makeHeader('📋 ตารางสรุปวัน (0.00 น. – ปัจจุบัน)', `${thaiDate()} ${thaiTime()} น. — เลื่อน → ดูแต่ละเขต`, COLORS.headerDark),
      body:{
        type:"box", layout:"vertical", paddingAll:"14px",
        contents:[
          makeStatRow("สถานีทั้งหมด", `${totalS} สถานี`),
          makeStatRow("FRC เฉลี่ยทั้งวัน", `${avgAll} mg/L`),
          { type:"separator", margin:"lg" },
          { type:"text", text:"📊 เฉลี่ยแยกตามเขตรับน้ำ", weight:"bold", size:"sm", color:COLORS.textPrimary, margin:"lg" },
          ...ZONE_GROUPS.filter(z => (grouped[z.key]||[]).length > 0).map(z => {
            const list = grouped[z.key];
            const avg = (list.reduce((a,s) => a+s.frc, 0) / list.length).toFixed(2);
            return { type:"box", layout:"horizontal", margin:"sm", contents:[
              { type:"text", text:z.title, size:"xxs", color:COLORS.textPrimary, flex:6, wrap:true },
              { type:"text", text:`${list.length}`, size:"xxs", color:COLORS.textMuted, flex:1, align:"end" },
              { type:"text", text:avg, size:"xxs", color:COLORS.textPrimary, flex:2, align:"end", weight:"bold" }
            ]};
          }),
          { type:"text", text:"← เลื่อนเพื่อดูรายละเอียด →", size:"xxs", color:COLORS.accent, margin:"lg", align:"center" }
        ]
      },
      footer:makeFooterButtons([
        { label:'📊 สรุปวัน', text:'สรุปวัน', primary:true },
        { label:'แผนที่', uri:CONTOUR_URL }
      ])
    };

    return lineReply(replyToken, withQuickReply([{
      type:"flex",
      altText:`📋 ตารางสรุปวัน — ${thaiDate()} FRC ${avgAll} mg/L`,
      contents:{ type:"carousel", contents:[summaryBubble, ...bubbles.slice(0, 11)] }
    }],['chlorine','daily','low','ec','map']));
  } catch(err) {
    console.error('[DailyTableSummary Error]', err.message);
    return lineReply(replyToken, withQuickReply([{type:'text',text:'❌ ตารางสรุปวัน error: '+err.message}]));
  }
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
                { type: "text", text: s.area || '-', size: "xs", color: COLORS.textMuted, flex: 2, align: "end" }
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

// สร้าง Carousel Flex message object (ใช้ซ้ำได้ทั้ง follow event และ เมนู)
function buildMenuCarousel() {
  const menuItems = [
    {
      image: `${IMG_BASE}/menu-contour.png`,
      title: "🗺️ Contour Map",
      desc: "แผนที่ Real-Time FRC/EC Contour\nZone Influence + EPANET Decay\n61 สถานี",
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

  return {
    type: "flex",
    altText: "📱 เมนู FRC Bot — เลื่อนเพื่อดูทั้งหมด",
    contents: { type: "carousel", contents: bubbles }
  };
}

function replyMenuCarousel(replyToken) {
  return lineReply(replyToken, withQuickReply([buildMenuCarousel()]));
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
          makeHelpRow("🔍", "ค้นหาสถานที่ [ชื่อ]", "บินไปในแผนที่ Contour"),
          makeHelpRow("📍", "ใกล้ฉัน", "ส่งตำแหน่ง → ดูสถานีใกล้"),
          { type: "separator" },
          { type: "text", text: "🔔 แจ้งเตือน", weight: "bold", size: "sm", color: COLORS.textPrimary },
          makeHelpRow("📢", "ส่งแจ้งเตือน", "ส่ง Push แจ้งเตือนค่าผิดปกติ Manual"),
          { type: "text", text: "อัตโนมัติ: ตรวจวันละครั้ง 08:00 น. · แจ้งเฉพาะค่าต่ำ · รวมทุกสถานีในข้อความเดียว", size: "xxs", color: COLORS.textMuted, wrap: true },
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
    // Layout: 2500x1686 — Glassmorphism v3
    // Row 1 (3 ปุ่ม): Nearby | FRC Report | ความนำไฟฟ้า
    // Row 2 (2 ปุ่ม): Contour Map | Search Station
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "FRC Bot Menu v3",
      chatBarText: "💧 เมนู FRC",
      areas: [
        // Row 1 (3 cells: 833+834+833 = 2500)
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: "message", label: "ใกล้ฉัน", text: "ใกล้ฉัน" } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: "message", label: "FRC Report", text: "คลอรีน" } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: "message", label: "ความนำไฟฟ้า", text: "ec" } },
        // Row 2 (2 cells: 1250+1250 = 2500)
        { bounds: { x: 0, y: 843, width: 1250, height: 843 }, action: { type: "uri", label: "Contour Map", uri: CONTOUR_URL } },
        { bounds: { x: 1250, y: 843, width: 1250, height: 843 }, action: { type: "message", label: "ค้นหาสถานี", text: "ค้นหาสถานที่" } },
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
        row1: ['📍 Nearby', '💧 FRC Report', '⚡ ความนำไฟฟ้า'],
        row2: ['🗺️ Contour Map (LIVE)', '🔍 Search Station']
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
        await handleTextMessage(event.replyToken, event.message.text, source?.userId, source?.type);
      }

      if (event.type === 'message' && event.message.type === 'location') {
        const { latitude, longitude } = event.message;
        await handleLocationMessage(event.replyToken, latitude, longitude);
      }

      if (event.type === 'follow') {
        // ส่งข้อความต้อนรับ + Carousel เมนู
        const welcomeText = {
          type: 'text',
          text: '💧 ยินดีต้อนรับสู่ Real-Time Contour Bot!\n\nสามารถกดเมนูด้านล่าง เพื่อเริ่มใช้งาน\nหรือพิมพ์ help เพื่อดูคำสั่ง\n\n🔔 Bot จะแจ้งเตือนอัตโนมัติเมื่อค่าผิดปกติ'
        };
        const carouselMsg = buildMenuCarousel();
        await lineReply(event.replyToken, withQuickReply([welcomeText, carouselMsg], ['chlorine', 'daily', 'ec', 'map', 'location', 'help']));
      }
    } catch (err) {
      console.error('[Webhook Error]', err.message);
    }
  }
});

// Health check
// 🗺️ รูปแผนที่ความขุ่น (hero ของการ์ด LINE) — ?d=0 วันนี้ / ?d=-1 เมื่อวาน
app.get('/turbidity-map.png', async (req, res) => {
  try {
    if (!TUR_CANVAS) return res.status(503).send('canvas not available');
    const d = Number(req.query.d) < 0 ? -1 : 0;
    const S = await loadTurbidityStats(bkkMidnight(d), d < 0 ? bkkMidnight(d + 1) : null);
    const png = await renderTurbidityMap(S, turRangeTitle(d));
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=120').send(png);
  } catch (e) { console.error('[TurMap] render error:', e); res.status(500).send('render error'); }
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    bot: 'FRC Chlorine LINE Bot v12.3',
    version: '12.3',
    time: new Date().toISOString(),
    targets: NOTIFY_TARGETS.size,
    security: {
      tokenFromEnv: !LINE_TOKEN.includes('YB99'),
      signatureVerification: !!LINE_SECRET,
      firebaseAdmin: true,
      firebaseServiceAccount: !!process.env.FIREBASE_SERVICE_ACCOUNT
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cron Jobs
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 📥 COLLECTOR — ผู้บันทึกประวัติเจ้าเดียว (แทน poll.yml + การเขียนจากหน้าเว็บ)
// กติกาเดียวทุกแหล่ง:
//   1) เช็คแหล่งข้อมูลตามรอบ cron
//   2) บันทึกเฉพาะเมื่อแหล่ง "มีรอบใหม่" (เวลาของแหล่งเปลี่ยน) → ไม่มีจุดซ้ำ
//   3) เวลาของจุด = เวลาของแหล่ง (TWQMS sourceDtm / bigdata datetimes) ไม่ใช่เวลาที่ดึง
//   4) key = ts (ms) ทุก node → prune ลบแบบเดียวกัน, เขียนซ้ำ key เดิม = ทับค่าเดิม ไม่เกิดจุดใหม่
//   5) ไม่มีค่า = ไม่บันทึก (ไม่เขียน 0 ปลอม)
// ทุกฟังก์ชันจับ error ภายในตัวเอง → collector มีปัญหา bot ส่วน LINE ไม่ล่มตาม
// ═══════════════════════════════════════════════════════════════════════════════

// เวลาจากแหล่ง กปน. ไม่มี timezone (เป็นเวลาไทย) — server Railway เป็น UTC จึงต้องเติม +07:00 เอง
function parseThaiTime(str) {
  if (!str) return NaN;
  const t = String(str).trim().replace(' ', 'T');
  return /([zZ]|[+-]\d\d:?\d\d)$/.test(t) ? Date.parse(t) : Date.parse(t + '+07:00');
}
const _num = v => { const x = parseFloat(v); return isNaN(x) ? null : x; };
const _okTs = ts => !isNaN(ts) && ts > Date.now() - 7 * 86400000 && ts < Date.now() + 15 * 60000;

// ── 1. TWQMS: FRC + EC ทุกสถานี → history/{สถานี}/{ts} + live | ความขุ่น → history_wq/{สถานี}/{ts} ──────────────────
const _lastTwqmsTs = {};   // สถานี → ts ล่าสุดที่บันทึกแล้ว (กันเขียนซ้ำ)
async function collectTwqms() {
  try {
    const res = await axios.get(MWA_API, { timeout: 20000 });
    const raw = res.data;
    const arr = Array.isArray(raw) ? raw : (raw.data || raw.stations || raw.result || []);
    const updates = {}, live = {};
    let nNew = 0, nTub = 0, srcLabel = '';
    for (const st of arr) {
      const id = st.stationCode || st.id;
      if (!id) continue;
      const safeId = String(id).replace(/[.#$\/\[\]]/g, '_');   // รูปแบบ key เดียวกับ poll.yml เดิม
      const ts  = parseThaiTime(st.sourceDtm);
      const frc = _num(st.value && st.value.frc_2);
      const ec  = _num(st.value && st.value.ecm_5);
      const tub = _num(st.value && st.value.tub_1);               // ความขุ่น (NTU)
      if (!_okTs(ts) || (frc == null && ec == null && tub == null)) continue;
      if (frc != null || ec != null) live[safeId] = { frc: frc ?? 0, ec, ts };   // สถานีที่มีแต่ความขุ่น ไม่ใส่ live (กัน FRC=0 ปลอม)
      if (_lastTwqmsTs[safeId] === ts) continue;                 // ยังเป็นรอบเดิม
      if (frc != null || ec != null) updates[`history/${safeId}/${ts}`] = { frc, ec, ts };
      // ความขุ่นแยกไว้นอก history/ — FRCContour โหลด history ทั้ง node จึงไม่ต้องดาวน์โหลดส่วนนี้
      if (tub != null) { updates[`history_wq/${safeId}/${ts}`] = { tub, ts }; nTub++; }
      _lastTwqmsTs[safeId] = ts; nNew++; srcLabel = st.sourceDtm;
    }
    if (nNew) {
      updates['live'] = live;                                    // อัปเดต live เฉพาะเมื่อมีรอบใหม่
      await db.ref().update(updates);                            // เขียนครั้งเดียวทั้งชุด
      console.log(`[Collect] TWQMS รอบ ${srcLabel} → บันทึก ${nNew} สถานี (ขุ่น ${nTub})`);
    }
  } catch (e) { console.error('[Collect] TWQMS error:', e.message); }
}

// ── 2. bigdata น้ำดิบ: ฟังก์ชันกลาง ดึงค่าล่าสุดรายสถานี ─────────────────────────
async function _fetchBigdataLatest(url, ids) {
  const resp = await axios.get(url, { timeout: 30000 });
  const records = (resp.data && resp.data.data) || [];
  const latest = {};
  for (const r of records) {
    if (!ids.includes(r.stn_id)) continue;
    if (!latest[r.stn_id] || r.datetimes > latest[r.stn_id].datetimes) latest[r.stn_id] = r;
  }
  return { records, latest };
}

// ── 2a. น้ำดิบเจ้าพระยา (สำแล ฯลฯ) → history/raw_{sid}/{ts}  (รูปแบบเดียวกับที่หน้าเว็บเคยเขียน) ──
const RAW_CP_API_URL = 'https://bigdata.mwa.co.th/data-service/internal/big-data/api/v1/783f543c-666c-35b4-795b-40dd2446b291/720721b3-cdaa-199d-9286-52f97cf00dfb/data?token=y0pBvoNbZSQWULB88PXeHBn2dHEgzaFyxSeH3V7a9jgWwn9VAmuGLhqkwrHLpdRm7wNn4DJsYLUT81JpZTwFqZkawNqdq2Osi1igZmYMlD37sKnU8Sy3aLgAQjKoHcdN';
const RAW_CP_IDS = ['S1','S3','S4','S6','S7','T1','T2','T3','T4'];
const _lastRawTs = {};
async function collectRawChaoPhraya() {
  try {
    const { latest } = await _fetchBigdataLatest(RAW_CP_API_URL, RAW_CP_IDS);
    const updates = {}; let n = 0;
    for (const [sid, r] of Object.entries(latest)) {
      const ts = parseThaiTime(r.datetimes), ec = _num(r.conducted);
      if (!_okTs(ts) || ec == null || ec <= 0) continue;
      if (_lastRawTs['cp_' + sid] === ts) continue;
      updates[`history/raw_${sid}/${ts}`] = { ec, temp: _num(r.temp), ts };
      _lastRawTs['cp_' + sid] = ts; n++;
    }
    if (n) {
      await db.ref().update(updates);
      console.log(`[Collect] น้ำดิบเจ้าพระยา → บันทึก ${n} สถานี | S1 EC=${latest.S1 ? latest.S1.conducted : '-'} (${latest.S1 ? latest.S1.datetimes : '-'})`);
    }
  } catch (e) { console.error('[Collect] น้ำดิบเจ้าพระยา error:', e.message); }
}

// ── 2b. น้ำดิบแม่กลอง → rawmk/{sid} (ค่าปัจจุบัน) + history/rawmk_{sid}/{ts} ──────
// [แก้] URL เดิมชี้ไป dataset เจ้าพระยา (ซ้ำกับ 2a) จึงไม่เคยเจอสถานีแม่กลอง → บันทึก 0 สถานีมาตลอด
//       ใช้ dataset แม่กลองตัวเดียวกับที่หน้าเว็บ (app.js MK_API) ใช้อยู่
const MK_API_URL = 'https://bigdata.mwa.co.th/data-service/internal/big-data/api/v1/783f543c-666c-35b4-795b-40dd2446b291/7e911fa9-0a52-970a-eef5-2170851f3530/data?token=3XSOeKch6WiCXcw37EWhVX0Z0mPLncwmwTY6fgkm6tVCaIuNU11IiRRydPCUadnFGvfV2mPPrLc6hUk87JtA6rJSPVKNEr0HhJOuRPQ0CR3v3kaFIzk71Bm1N8uqST2b';
const MK_STATION_IDS = ['T5','S16','S11','S9','S12','S13','S14'];
async function fetchAndSaveMkData() {
  try {
    const { records, latest } = await _fetchBigdataLatest(MK_API_URL, MK_STATION_IDS);
    const updates = {}; let n = 0;
    for (const [sid, r] of Object.entries(latest)) {
      const ts = parseThaiTime(r.datetimes), ec = _num(r.conducted);
      if (!_okTs(ts) || ec == null || ec <= 0) continue;
      updates[`rawmk/${sid}`] = {
        ec, temp: _num(r.temp) || 0, ph: _num(r.ph) || 0, turbid: _num(r.turbid) || 0,
        deo: _num(r.deo) || 0, salinity: _num(r.salinity) || 0, tds: _num(r.tds) || 0,
        time: r.datetimes, ts,
      };
      if (_lastRawTs['mk_' + sid] === ts) continue;
      updates[`history/rawmk_${sid}/${ts}`] = { ec, ts };      // เดิมใช้ push() + เวลาที่ดึง → จุดซ้ำทุก 10 นาที
      _lastRawTs['mk_' + sid] = ts; n++;
    }
    if (Object.keys(updates).length) await db.ref().update(updates);
    const found = Object.keys(latest);
    console.log(`[MK] records ${records.length} | พบ ${found.length} สถานี [${found.join(',')}] | บันทึกรอบใหม่ ${n} | S14 EC=${latest.S14 ? latest.S14.conducted : '-'}`);
  } catch (e) { console.error('[MK] ❌ fetch error:', e.message); }
}

// รันทันทีตอน start แล้วตามรอบ — เช็คถี่กว่ารอบอัปเดตของแหล่ง จะได้ไม่พลาดรอบ (บันทึกเฉพาะรอบใหม่อยู่แล้ว)
collectTwqms();
collectRawChaoPhraya();
fetchAndSaveMkData();
cron.schedule('*/5 * * * *',  collectTwqms,         { timezone: 'Asia/Bangkok' });
cron.schedule('*/10 * * * *', collectRawChaoPhraya, { timezone: 'Asia/Bangkok' });
cron.schedule('*/10 * * * *', fetchAndSaveMkData,   { timezone: 'Asia/Bangkok' });
// ── ⚡ EC Forecast (XGBoost) — พยากรณ์ EC ล่วงหน้า 24/48 ชม. ทุกชั่วโมง ──────
// รัน predict_ec.py → ดึง TWQMS ล่าสุด → เขียน /forecast/ec/{station} ใน Firebase
function runECForecast() {
  const p = spawn('python3', ['predict_ec.py'], {
    cwd: __dirname,
    env: { ...process.env, FIREBASE_URL: FB_DB_URL },   // ใช้ FB_DATABASE_URL เดิม ไม่ต้องตั้งใหม่
  });
  p.stdout.on('data', d => console.log(`[EC-Forecast] ${d.toString().trim()}`));
  p.stderr.on('data', d => console.error(`[EC-Forecast] ⚠️ ${d.toString().trim()}`));
  p.on('close', code => {
    if (code !== 0) console.error(`[EC-Forecast] ❌ exit code ${code}`);
  });
  p.on('error', err => console.error(`[EC-Forecast] ❌ spawn error: ${err.message}`));
}

// [ปิด ต.ค.69] เลิกใช้ XGBoost แล้ว (ไม่ได้แสดงผลที่ใด) — เปิดกลับได้โดยตั้งตัวแปร EC_FORECAST=on ใน Railway
// (การเก็บ /history_ec ทุกชั่วโมงด้านล่างยังทำงานตามปกติ — ใช้วิเคราะห์เวลาเดินน้ำ/EC ย้อนหลัง)
if (process.env.EC_FORECAST === 'on') {
  setTimeout(runECForecast, 2 * 60 * 1000);
  cron.schedule('5 * * * *', runECForecast, { timezone: 'Asia/Bangkok' });
} else {
  console.log('[EC-Forecast] ปิดอยู่ (ตั้ง EC_FORECAST=on เพื่อเปิด)');
}

// [v12.3] เปลี่ยนจากตรวจทุก 1 ชม. → ตรวจวันละครั้ง แล้วรวมทุกสถานีผิดปกติส่งเป็น broadcast เดียว (ประหยัด broadcast quota)
// [29/08/69] แจ้งเตือนวาระเปลี่ยนเซ็นเซอร์/อุปกรณ์ ทุกวันที่ 1 เวลา 08:00
// ส่งหาทุกคนใน NOTIFY_TARGETS ชุดเดียวกับ alert คุณภาพน้ำ
cron.schedule('0 8 1 * *', async () => {
  console.log(`[Cron] แจ้งเตือนวาระเปลี่ยนเซ็นเซอร์ประจำเดือน — targets ${NOTIFY_TARGETS.size} คน`);
  const bcClient = { pushMessage: async ({ messages }) => {
    for (const t of NOTIFY_TARGETS) await linePush(t, messages);
  } };
  try {
    const r = await checkEquipmentDue(bcClient, 'broadcast');
    console.log(`[Cron] วาระเซ็นเซอร์: sent=${r.sent} groups=${r.groups ?? 0}`);
  } catch (e) { console.error('[Cron] วาระเซ็นเซอร์ error:', e.message); }
}, { timezone: 'Asia/Bangkok' });

cron.schedule('0 8 * * *', () => {
  console.log(`[Cron] ตรวจ FRC alert ประจำวัน (08:00 น.) — ${new Date().toISOString()}`);
  checkAlerts();
}, { timezone: 'Asia/Bangkok' });

cron.schedule('*/10 * * * *', async () => {
  try {
    const sensors = await fetchSensors();
    if (!sensors.length) return;
    const ts = Date.now();
    // [29/08/69] ตัดการเขียน history/{station} ออก — poll.yml (GitHub Action ทุก 5 นาที)
    // เป็นผู้เขียน history เจ้าเดียว: กัน key ปนสองแบบ (push-ID vs timestamp),
    // ลดข้อมูลซ้ำซ้อน ~2 เท่า และลดภาระ prune รายวัน
    // (การอ่าน history ของ bot สำหรับกราฟ/สถิติ ยังทำงานปกติ — poll.yml เติมข้อมูลให้)

    // ── เขียน EC ล่าสุดลง /history_ec/{YYYYMMDDHH} สำหรับ predict_ec.py ──
    // key = ชื่อไทยของสถานี (sanitize อักขระต้องห้ามของ Firebase: . $ # [ ] /)
    const ecKey = (name) => name.replace(/[.\$#\[\]\/]/g, '_');
    const ecObj = {};
    for (const s of sensors) {
      if (s.ec != null && !isNaN(s.ec) && s.ec > 0) ecObj[ecKey(s.name)] = s.ec;
    }
    if (Object.keys(ecObj).length) {
      const d = new Date(ts + 7 * 3600 * 1000);  // เวลาไทย
      const hourKey = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}${String(d.getUTCHours()).padStart(2,'0')}`;
      await db.ref(`history_ec/${hourKey}`).update(ecObj);
      console.log(`[Cron] บันทึก EC ${Object.keys(ecObj).length} สถานี → history_ec/${hourKey}`);
    }
  } catch(e) {
    console.error('[Cron] EC save error:', e.message);
  }
}, { timezone: 'Asia/Bangkok' });

// [v12.2] ปิด broadcast สรุปวัน — ไม่ส่งอัตโนมัติแล้ว (ยังเรียก manual ได้ทาง chat)
// cron.schedule('0 8 * * *', () => {
//   console.log(`[Cron] ส่งสรุปวัน 08:00 — ${new Date().toISOString()}`);
//   handleBroadcastDaily(null);
// }, { timezone: 'Asia/Bangkok' });

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 FRC Chlorine LINE Bot v12.3 running on port ${PORT}`);
  console.log(`   Webhook URL: POST /webhook`);
  console.log(`   Rich Menu Setup: POST /setup-richmenu`);
  console.log(`   🔒 Token from env: ${!LINE_TOKEN.includes('YB99') ? '✅' : '⚠️ ใช้ hardcoded — ควรย้ายเป็น env var'}`);
  console.log(`   🔒 Signature verify: ${LINE_SECRET ? '✅' : '⚠️ ปิดอยู่ — ตั้ง LINE_CHANNEL_SECRET'}`);
  loadTargets();
});
