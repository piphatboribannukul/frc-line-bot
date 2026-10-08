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
    return { ok: true, via: 'broadcast' };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.log(`[Broadcast] ไม่สำเร็จ: ${errMsg} — fallback เป็น Push`);
    // โควตาเดือนนี้หมด → push ก็ใช้โควตาเดียวกัน ไม่ต้องลองซ้ำ
    if (/monthly limit|quota/i.test(errMsg)) return { ok: false, via: 'broadcast', error: errMsg };
    var bcErr = errMsg;
  }
  if (NOTIFY_TARGETS.size === 0) { console.log('[Push] ไม่มี target'); return { ok: false, error: (bcErr || '') + ' · ไม่มี target สำหรับ push' }; }
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
  return { ok: sent > 0, via: 'push', sent, failed, error: bcErr };
}

// 📊 โควตาข้อความ LINE ของเดือนนี้ (ฟรี 300) — ไม่ใช้โควตาในการเรียกดู
async function lineQuota() {
  const h = { headers: { Authorization: `Bearer ${LINE_TOKEN}` } };
  try {
    const [q, c] = await Promise.all([axios.get(`${LINE_API}/quota`, h), axios.get(`${LINE_API}/quota/consumption`, h)]);
    return { limit: q.data.type === 'limited' ? q.data.value : null, used: c.data.totalUsage };
  } catch (e) { return { error: e.response?.data?.message || e.message }; }
}

// 🌅 ส่งสรุปความขุ่นตอนเช้า (cron 08:00 หรือสั่งมือ) — บันทึกผลลง bot_status/morning ให้ตรวจย้อนหลังได้
async function sendMorningTurbidity(trigger = 'cron') {
  const st = { ts: Date.now(), trigger };
  try {
    const msgs = await replyParamSummary(null, 'tub', 0);   // วันนี้ 00:00–ปัจจุบัน
    if (!Array.isArray(msgs) || !msgs.length) throw new Error('สร้างการ์ดไม่สำเร็จ');
    Object.assign(st, await lineBroadcast(msgs));
  } catch (e) { Object.assign(st, { ok: false, error: e.message }); }
  Object.assign(st, { quota: await lineQuota() });
  console.log(`[Morning] ${st.ok ? '✅ ส่งแล้ว' : '❌ ไม่สำเร็จ'} (${trigger}) ${st.error || ''} · โควตา ${st.quota.used ?? '?'}/${st.quota.limit ?? '?'}`);
  try { await db.ref('bot_status/morning').set(st); } catch (e) {}
  return st;
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
    chlorine: { type: 'action', action: { type: 'message', label: '🧪 คลอรีน', text: 'สรุปคลอรีน' } },
    daily:    { type: 'action', action: { type: 'message', label: '📊 สรุปวัน', text: 'สรุปวัน' } },
    ec:       { type: 'action', action: { type: 'message', label: '⚡ EC', text: 'สรุป EC' } },
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
  // ── เมนูรายงานคุณภาพน้ำ: "สรุป" / "สรุปคุณภาพน้ำ" / "สรุปค่า" / "รายงานคุณภาพน้ำ" → เลือก คลอรีน / ความขุ่น / ความนำไฟฟ้า
  //    (สรุปคลอรีน / สรุป FRC → การ์ดคลอรีน [กฎ /คลอรีน|frc/ ด้านล่าง], สรุปความขุ่น / สรุปขุ่น → การ์ดความขุ่น)
  { const t = msg.replace(/\s+/g, '');
    // ── โควตา / สถานะสรุปเช้า (ตอบด้วย reply = ไม่เสียโควตา) · "ส่งสรุปเช้า" = ส่งซ้ำทันที (ใช้โควตา)
    if (/^(โควตา|quota|สถานะสรุปเช้า)$/i.test(t)) {
      const q = await lineQuota(); let m = null; try { m = (await db.ref('bot_status/morning').once('value')).val(); } catch (e) {}
      const last = m ? `${m.ok ? '✅ ส่งสำเร็จ' : '❌ ไม่สำเร็จ'} ${new Date(m.ts).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} น.${m.error ? `\nสาเหตุ: ${m.error}` : ''}` : '— ยังไม่มีบันทึก —';
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: `📊 โควตาข้อความ LINE เดือนนี้\nใช้ไป ${q.used ?? '?'} / ${q.limit ?? 'ไม่จำกัด'} ข้อความ${q.limit ? ` (เหลือ ${q.limit - (q.used || 0)})` : ''}${q.error ? `\n(อ่านโควตาไม่ได้: ${q.error})` : ''}\n\n🌅 สรุปเช้าครั้งล่าสุด\n${last}\n\nส่งซ้ำ: พิมพ์ "ส่งสรุปเช้า"` }]));
    }
    if (/^ส่งสรุปเช้า$/.test(t)) {
      const r = await sendMorningTurbidity('manual');
      return lineReply(replyToken, [{ type: 'text', text: r.ok ? `✅ ส่งสรุปความขุ่นแล้ว (${r.via}) · โควตา ${r.quota.used}/${r.quota.limit}` : `❌ ส่งไม่สำเร็จ: ${r.error || '-'}\nโควตา ${r.quota.used ?? '?'}/${r.quota.limit ?? '?'}` }]);
    }
    // ── [ต.ค.69] คำสั้น "คลอรีน" / "ec" → ระบบสรุปใหม่ (ค่าเฉลี่ยวันนี้ + แผนที่ + บริการ 1–5)
    //    การ์ด Real-Time เดิม (ค่า ณ ตอนนี้ · สูบส่ง/สูบจ่าย/Monitor) ยังเรียกได้: "คลอรีนตอนนี้" / "ค่าปัจจุบัน" / "สถานะ"
    if (/^(คลอรีน|คลอรีนอิสระ|คลอรีนอิสระคงเหลือ|frc|chlorine)$/i.test(t)) return replyParamSummary(replyToken, 'frc', 0);
    if (/^(ec|ความนำไฟฟ้า|ความนำ|ค่าec|conductivity)$/i.test(t)) return replyParamSummary(replyToken, 'ec', 0);
    if (/^(คลอรีน|frc)(ตอนนี้|ปัจจุบัน|realtime|เรียลไทม์)$|^ค่าปัจจุบัน$/i.test(t)) return replyCurrentStatus(replyToken);
    if (/^(ec|ความนำไฟฟ้า)(ตอนนี้|ปัจจุบัน|realtime|เรียลไทม์)$/i.test(t)) return replyECStatus(replyToken);
    // ── ตัด/คืนค่าสถานี: "ตัดค่า คลอรีน ศิริราช [เหตุผล]" · "คืนค่า คลอรีน ศิริราช" · "รายการตัดค่า"
    { const m = msg.trim().match(/^(ตัดค่า|คืนค่า)\s+(คลอรีน|frc|ขุ่น|ความขุ่น|ec|ความนำไฟฟ้า)\s+(\S+)\s*(.*)$/i);
      if (m) {
        const pk = /ขุ่น/.test(m[2]) ? 'tub' : /คลอรีน|frc/i.test(m[2]) ? 'frc' : 'ec', P = WQP[pk];
        const hits = Object.keys(TUR_STATIONS).filter(id => id.toLowerCase() === m[3].toLowerCase() || TUR_STATIONS[id][0].includes(m[3]));
        if (hits.length !== 1) return lineReply(replyToken, [{ type: 'text', text: hits.length ? `พบหลายสถานี ระบุให้ชัดขึ้น:\n${hits.map(id => `${id} ${TUR_STATIONS[id][0]}`).join('\n')}` : `ไม่พบสถานี "${m[3]}"` }]);
        const id = hits[0];
        if (m[1] === 'ตัดค่า') await db.ref(`wq_exclude/${pk}/${id}`).set({ reason: m[4] || 'เซนเซอร์ผิดปกติ', by: userId || '', ts: Date.now() });
        else await db.ref(`wq_exclude/${pk}/${id}`).remove();
        _wqEx.t = 0; Object.keys(_wqCache).forEach(k => delete _wqCache[k]);
        return lineReply(replyToken, withQuickReply([{ type: 'text', text: m[1] === 'ตัดค่า'
          ? `🚫 ตัด${P.short} ${TUR_STATIONS[id][0]} (${id}) ออกจากการคำนวณแล้ว\nเหตุผล: ${m[4] || 'เซนเซอร์ผิดปกติ'}\nคืนค่า: พิมพ์ "คืนค่า ${m[2]} ${m[3]}"`
          : `✅ คืน${P.short} ${TUR_STATIONS[id][0]} (${id}) กลับเข้าการคำนวณแล้ว` }]));
      } }
    if (/^รายการตัดค่า$/.test(t)) {
      const ex = (await db.ref('wq_exclude').once('value')).val() || {};
      const lines = Object.entries(ex).flatMap(([pk, o]) => Object.entries(o || {}).map(([id, x]) => `• ${WQP[pk] ? WQP[pk].short : pk}: ${(TUR_STATIONS[id] || [id])[0]} (${id}) — ${x.reason || ''} · ตั้งแต่ ${thaiDate(new Date(x.ts))}`));
      return lineReply(replyToken, withQuickReply([{ type: 'text', text: `🚫 สถานีที่ตัดออกจากการคำนวณ (${lines.length})\n${lines.join('\n') || '— ไม่มี —'}` }]));
    }
    if (/^(สรุป|สรุปคุณภาพน้ำ|สรุปค่า|รายงานคุณภาพน้ำ|คุณภาพน้ำ)$/i.test(t)) return replyWaterQualityMenu(replyToken);
    // คำทั่วไป เช่น "สรุปรายงาน" "รายงาน" "report" ที่ไม่ได้ระบุพารามิเตอร์ → เมนูเลือกก่อนเสมอ
    //   (ยกเว้น สรุปวัน / ตาราง / ส่ง… / แจ้งซ่อม ที่มีคำสั่งเฉพาะอยู่แล้ว)
    if (/สรุป|รายงาน|report|summary/i.test(t) && !/คลอรีน|frc|ขุ่น|turb|(^|[^a-z])ec([^a-z]|$)|ความนำ|conduct|วัน|daily|ตาราง|table|ส่ง|broadcast|ซ่อม/i.test(t))
      return replyWaterQualityMenu(replyToken);
    { const m = t.match(/^(ขุ่น|ความขุ่น|คลอรีน|frc|ec|ความนำไฟฟ้า|ความนำ)โรงงาน(เมื่อวาน)?$/i);
      if (m) return replyParamPlants(replyToken, /ขุ่น/.test(m[1]) ? 'tub' : /คลอรีน|frc/i.test(m[1]) ? 'frc' : 'ec', m[2] ? -1 : 0); }
    { const m = t.match(/^(ขุ่น|ความขุ่น|คลอรีน|frc|ec|ความนำไฟฟ้า|ความนำ)สูบจ่าย(เมื่อวาน)?$/i);
      if (m) return replyParamPumps(replyToken, /ขุ่น/.test(m[1]) ? 'tub' : /คลอรีน|frc/i.test(m[1]) ? 'frc' : 'ec', m[2] ? -1 : 0); }
    { const m = t.match(/^(คลอรีน|frc|ec|ความนำไฟฟ้า|ความนำ)บริการ([1-5])(เมื่อวาน)?$/i);
      if (m) return replyParamRegion(replyToken, /คลอรีน|frc/i.test(m[1]) ? 'frc' : 'ec', Number(m[2]) - 1, m[3] ? -1 : 0); }
    if (/^(สรุป)?(คลอรีน|frc)เมื่อวาน$|^เมื่อวาน(คลอรีน|frc)$/i.test(t)) return replyParamSummary(replyToken, 'frc', -1);
    if (/^สรุป(คลอรีน|คลอรีนอิสระ|คลอรีนอิสระคงเหลือ|frc)(วันนี้)?$/i.test(t)) return replyParamSummary(replyToken, 'frc', 0);
    if (/^(สรุป)?(ec|ความนำไฟฟ้า|ความนำ|conduct\w*)เมื่อวาน$/i.test(t)) return replyParamSummary(replyToken, 'ec', -1);
    if (/^สรุป(ความนำไฟฟ้า|ความนำ|ec|conduct\w*)(วันนี้)?$/i.test(t)) return replyParamSummary(replyToken, 'ec', 0);
  }

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
const TUR_PUMPS = [   // สถานีสูบจ่ายน้ำ แบ่งฝั่งตะวันตก/ตะวันออก (แม่น้ำเจ้าพระยา)
  { name: 'ฝั่งตะวันตก', ids: ['SW08','SW09','SW10'] },
  { name: 'ฝั่งตะวันออก', ids: ['SW02','SW01','SW03','SW04','SW05','SW06','SW07','SW11'] },
];
const TUR_HEADER_COL = '#a16207';
function turHeader(title, sub) {   // หัวการ์ดแบบเตี้ย: โลโก้ กปน. บนวงกลมขาว + 2 บรรทัด
  return { type: 'box', layout: 'horizontal', backgroundColor: TUR_HEADER_COL, paddingAll: '10px', paddingStart: '12px', spacing: 'md', alignItems: 'center',
    contents: [
      { type: 'box', layout: 'vertical', flex: 0, width: '40px', height: '40px', cornerRadius: '20px', backgroundColor: '#ffffff', justifyContent: 'center', alignItems: 'center',
        contents: [{ type: 'image', url: `${TUR_PUBLIC_URL}/mwa-logo.png`, size: '36px', aspectMode: 'fit', aspectRatio: '1:1' }] },
      { type: 'box', layout: 'vertical', flex: 5, contents: [
        { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: sub, color: '#ffffffd9', size: 'xxs', wrap: true },
      ] },
    ] };
}

// อ่าน history_wq ช่วงเวลา → สถิติรายสถานี {avg,max,maxTs,min,n}
// เที่ยงคืนเวลาไทย (server Railway เป็น UTC — ห้ามใช้ setHours(0) ตรงๆ) · dayOffset -1 = เมื่อวาน
function bkkMidnight(dayOffset = 0) {
  const b = new Date(Date.now() + 7 * 3600e3);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - 7 * 3600e3 + dayOffset * 86400e3;
}
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
// บริการ 1–5 = สถานีในพื้นที่สาขา ไม่รวมน้ำออกโรงงานและสถานีสูบจ่าย (มีบล็อกของตัวเองแล้ว ไม่นับซ้ำ)
const TUR_PUMP_IDS = TUR_PUMPS.flatMap(p => p.ids);
const turRegionIds = r => Object.keys(TUR_STATIONS).filter(id => r.br.includes(TUR_STATIONS[id][1]) && !TUR_PLANT_IDS.includes(id) && !TUR_PUMP_IDS.includes(id));

// ═══════════════════════════════════════════════════════════════════════════════
// 🗺️ แผนที่ความขุ่น (PNG) สำหรับ hero ของการ์ด LINE — ลงสีพื้นที่ตามภาค (บริการ 1–5), จุดสถานีตามเกณฑ์
// ต้องมี dependency "@napi-rs/canvas" — ถ้าติดตั้งไม่ได้ การ์ดจะส่งแบบไม่มีแผนที่ (ไม่กระทบส่วนอื่น)
// ฟอนต์ไทย Sarabun ดาวน์โหลดจาก GitHub ครั้งแรกแล้วเก็บไว้ใน /tmp
// ═══════════════════════════════════════════════════════════════════════════════
let TUR_CANVAS = null;
try { TUR_CANVAS = require('@napi-rs/canvas'); } catch (e) { console.warn('[TurMap] @napi-rs/canvas ไม่พร้อม — การ์ดความขุ่นจะไม่มีแผนที่:', e.message); }
const TUR_BRANCH_POLY = [{"n":"ภาษีเจริญ","c":[[13.723,100.4705],[13.7244,100.4681],[13.7253,100.4671],[13.7281,100.4652],[13.7325,100.4627],[13.735,100.4622],[13.7364,100.462],[13.7389,100.4616],[13.7417,100.4616],[13.7444,100.462],[13.7441,100.4606],[13.7436,100.4596],[13.7436,100.4588],[13.7439,100.4579],[13.7439,100.4572],[13.7436,100.4568],[13.7432,100.457],[13.7429,100.4569],[13.7421,100.4564],[13.7419,100.4553],[13.7424,100.455],[13.7425,100.4544],[13.742,100.454],[13.7418,100.4534],[13.7411,100.4523],[13.7411,100.4507],[13.7404,100.4498],[13.7409,100.4491],[13.7403,100.4479],[13.7403,100.4473],[13.7407,100.4462],[13.7406,100.4444],[13.7401,100.4432],[13.7405,100.4406],[13.7402,100.44],[13.74,100.4391],[13.74,100.4351],[13.7403,100.4337],[13.7403,100.4324],[13.7408,100.4319],[13.7421,100.4312],[13.7423,100.4309],[13.7424,100.4303],[13.7422,100.4297],[13.7424,100.4272],[13.7428,100.4257],[13.7435,100.4249],[13.7436,100.424],[13.7442,100.4215],[13.7446,100.4209],[13.7456,100.4197],[13.7472,100.4168],[13.7491,100.4082],[13.7498,100.404],[13.7502,100.4024],[13.751,100.3971],[13.753,100.3806],[13.7536,100.3732],[13.7538,100.3658],[13.7538,100.3631],[13.7536,100.3611],[13.7521,100.3522],[13.7512,100.3481],[13.7492,100.3444],[13.7491,100.3414],[13.7478,100.3347],[13.7476,100.3314],[13.7463,100.3318],[13.7441,100.3318],[13.741,100.3326],[13.7397,100.3332],[13.7392,100.3332],[13.7368,100.3328],[13.7352,100.3335],[13.7326,100.3351],[13.7323,100.3351],[13.7318,100.335],[13.7294,100.3365],[13.7293,100.3365],[13.7291,100.3361],[13.728,100.3365],[13.7277,100.3363],[13.7261,100.337],[13.726,100.3364],[13.7242,100.3363],[13.723,100.3364],[13.7221,100.3362],[13.7218,100.3362],[13.7211,100.3363],[13.7182,100.338],[13.7182,100.3379],[13.7176,100.3381],[13.7177,100.3383],[13.7159,100.3387],[13.715,100.3377],[13.714,100.3379],[13.7132,100.3382],[13.7126,100.3386],[13.7118,100.3372],[13.7116,100.3352],[13.7132,100.3348],[13.713,100.3342],[13.7123,100.3325],[13.7103,100.3335],[13.71,100.3336],[13.71,100.3333],[13.7088,100.3334],[13.7078,100.3333],[13.7065,100.3328],[13.7036,100.3312],[13.702,100.3313],[13.7019,100.3312],[13.7019,100.3303],[13.6999,100.3303],[13.6974,100.3314],[13.6926,100.332],[13.6923,100.3321],[13.6917,100.332],[13.6909,100.332],[13.6877,100.3326],[13.6834,100.3339],[13.6816,100.3334],[13.677,100.3361],[13.6772,100.3375],[13.6762,100.338],[13.6742,100.3385],[13.6727,100.3385],[13.6718,100.3387],[13.6692,100.3389],[13.6684,100.3393],[13.6677,100.3394],[13.6664,100.3403],[13.6658,100.3401],[13.6655,100.3401],[13.6636,100.3406],[13.6625,100.3407],[13.6617,100.3412],[13.6613,100.3413],[13.6606,100.3413],[13.6597,100.3409],[13.6589,100.3409],[13.6574,100.3397],[13.6567,100.3394],[13.6554,100.3394],[13.6543,100.3396],[13.653,100.3389],[13.6518,100.3386],[13.6515,100.3386],[13.6511,100.3388],[13.6503,100.3386],[13.6431,100.3382],[13.6424,100.3383],[13.639,100.3407],[13.6388,100.341],[13.6389,100.3417],[13.6392,100.3423],[13.6393,100.3437],[13.6393,100.3453],[13.6402,100.3478],[13.6404,100.3486],[13.6403,100.3503],[13.6401,100.3503],[13.6402,100.3519],[13.6403,100.3521],[13.6409,100.352],[13.6408,100.3538],[13.6409,100.3544],[13.6412,100.3544],[13.6419,100.3541],[13.6421,100.3542],[13.6422,100.3546],[13.6418,100.3548],[13.6418,100.3549],[13.6422,100.3558],[13.6423,100.3561],[13.6411,100.3569],[13.6369,100.3583],[13.6367,100.3585],[13.6348,100.3585],[13.6342,100.3586],[13.6344,100.36],[13.6333,100.3601],[13.6334,100.3611],[13.6333,100.3612],[13.6329,100.3612],[13.6329,100.3616],[13.6315,100.3617],[13.6314,100.3619],[13.6315,100.3624],[13.6313,100.3627],[13.6312,100.363],[13.6308,100.3627],[13.6299,100.3632],[13.6296,100.363],[13.6294,100.363],[13.6289,100.3638],[13.6282,100.3645],[13.628,100.3649],[13.6274,100.365],[13.6274,100.3651],[13.6277,100.3656],[13.6274,100.366],[13.6272,100.3672],[13.627,100.3673],[13.6263,100.3671],[13.6261,100.3674],[13.6258,100.3689],[13.6256,100.3691],[13.6256,100.3697],[13.6253,100.3702],[13.6256,100.3709],[13.6255,100.3711],[13.6249,100.3714],[13.6244,100.3712],[13.6231,100.3716],[13.6208,100.3719],[13.6207,100.372],[13.6208,100.373],[13.6201,100.3729],[13.6191,100.3745],[13.6185,100.3751],[13.6675,100.43],[13.6732,100.4296],[13.6785,100.429],[13.6803,100.4286],[13.6888,100.4276],[13.6917,100.427],[13.6945,100.4267],[13.6981,100.4265],[13.6996,100.4267],[13.7073,100.4262],[13.7225,100.4693],[13.723,100.4705]],"cen":[13.6862,100.3805]},{"n":"บางเขน","c":[[13.9314,100.6418],[13.9318,100.6405],[13.9322,100.64],[13.9328,100.6398],[13.9344,100.6398],[13.935,100.6259],[13.9487,100.6252],[13.9505,100.6223],[13.9271,100.6265],[13.9261,100.6264],[13.8998,100.611],[13.8977,100.6077],[13.8971,100.607],[13.8955,100.6057],[13.8911,100.5988],[13.8885,100.5955],[13.8816,100.5893],[13.8797,100.5881],[13.8786,100.5879],[13.8589,100.5864],[13.8566,100.5874],[13.8521,100.5876],[13.85,100.5882],[13.8463,100.5888],[13.8438,100.5897],[13.8441,100.5909],[13.8453,100.594],[13.8457,100.5957],[13.8458,100.5969],[13.8461,100.5976],[13.8463,100.5987],[13.8468,100.6023],[13.8481,100.6043],[13.8489,100.6058],[13.8492,100.6069],[13.8491,100.6086],[13.8491,100.614],[13.8484,100.6196],[13.8481,100.6208],[13.8472,100.6217],[13.8466,100.6227],[13.8458,100.6235],[13.8435,100.6278],[13.8431,100.6284],[13.8426,100.6287],[13.8427,100.6311],[13.8425,100.633],[13.8439,100.636],[13.8436,100.6367],[13.8448,100.6373],[13.8457,100.6386],[13.8462,100.6394],[13.8466,100.6409],[13.8474,100.6462],[13.8462,100.6485],[13.8464,100.65],[13.8469,100.6521],[13.8468,100.6531],[13.8474,100.6555],[13.8478,100.6565],[13.8477,100.6587],[13.8486,100.6589],[13.8486,100.6592],[13.8488,100.6592],[13.8491,100.6612],[13.8498,100.6615],[13.8505,100.6632],[13.8506,100.6651],[13.8505,100.6657],[13.851,100.6676],[13.8524,100.6698],[13.8527,100.6708],[13.8535,100.6707],[13.8554,100.6742],[13.8573,100.6762],[13.858,100.6771],[13.8584,100.6788],[13.8584,100.6793],[13.8587,100.6803],[13.8598,100.681],[13.8607,100.6821],[13.8621,100.6831],[13.8628,100.6834],[13.8659,100.6839],[13.8666,100.6842],[13.8693,100.6857],[13.87,100.6855],[13.8728,100.6845],[13.8742,100.6844],[13.8746,100.6845],[13.8753,100.685],[13.8765,100.6864],[13.8779,100.6873],[13.8787,100.688],[13.8791,100.6887],[13.8797,100.6898],[13.8799,100.6899],[13.8803,100.6899],[13.8816,100.6893],[13.8836,100.6897],[13.8852,100.6903],[13.8857,100.6907],[13.8867,100.692],[13.8872,100.6914],[13.8885,100.6913],[13.8918,100.6915],[13.8969,100.6923],[13.898,100.6922],[13.8985,100.692],[13.8992,100.6916],[13.9003,100.6906],[13.9006,100.6904],[13.9013,100.6903],[13.9032,100.6895],[13.9049,100.6882],[13.9058,100.6877],[13.9077,100.687],[13.909,100.687],[13.9093,100.6869],[13.9102,100.6858],[13.9115,100.6835],[13.9137,100.6837],[13.9142,100.6842],[13.9145,100.685],[13.9152,100.6859],[13.9171,100.6875],[13.9175,100.6875],[13.9185,100.6873],[13.9207,100.6872],[13.923,100.688],[13.9238,100.6886],[13.9249,100.6887],[13.9259,100.6894],[13.9264,100.6894],[13.9292,100.6898],[13.931,100.6899],[13.9308,100.6892],[13.931,100.6863],[13.9309,100.686],[13.9308,100.6818],[13.9309,100.6782],[13.9305,100.6683],[13.9305,100.6636],[13.9308,100.6615],[13.9306,100.659],[13.931,100.6515],[13.9312,100.6502],[13.9312,100.6479],[13.9313,100.6471],[13.9314,100.6418]],"cen":[13.8966,100.6494]},{"n":"มีนบุรี","c":[[13.7378,100.8789],[13.7542,100.8894],[13.7665,100.8965],[13.79,100.9096],[13.7909,100.9104],[13.7948,100.9175],[13.8014,100.9288],[13.8029,100.9297],[13.8133,100.9376],[13.8144,100.9386],[13.8381,100.9078],[13.8415,100.9091],[13.8437,100.9107],[13.8446,100.9116],[13.8468,100.9128],[13.8474,100.909],[13.8477,100.9081],[13.8489,100.9022],[13.8541,100.9034],[13.859,100.9047],[13.8591,100.9055],[13.8598,100.9056],[13.8605,100.9063],[13.8658,100.9064],[13.8702,100.9062],[13.8805,100.9064],[13.8958,100.9079],[13.9062,100.909],[13.9447,100.9141],[13.9486,100.914],[13.9436,100.8648],[13.941,100.8433],[13.9401,100.837],[13.9396,100.8337],[13.9366,100.8208],[13.9369,100.8208],[13.9327,100.7995],[13.931,100.7918],[13.9277,100.7596],[13.9258,100.7471],[13.924,100.7327],[13.924,100.7277],[13.9224,100.7181],[13.9201,100.7078],[13.9195,100.7028],[13.9189,100.6924],[13.9191,100.6873],[13.9183,100.6873],[13.9175,100.6875],[13.9171,100.6875],[13.9152,100.6859],[13.9145,100.685],[13.9142,100.6842],[13.9137,100.6837],[13.9115,100.6835],[13.9102,100.6858],[13.9093,100.6869],[13.909,100.687],[13.9077,100.687],[13.9058,100.6877],[13.9049,100.6882],[13.9032,100.6895],[13.9013,100.6903],[13.9006,100.6904],[13.9003,100.6906],[13.8992,100.6916],[13.8985,100.692],[13.898,100.6922],[13.8969,100.6923],[13.8918,100.6915],[13.8885,100.6913],[13.8872,100.6914],[13.8867,100.692],[13.8857,100.6907],[13.8852,100.6903],[13.8836,100.6897],[13.8816,100.6893],[13.8803,100.6899],[13.8799,100.6899],[13.8797,100.6898],[13.8791,100.6887],[13.8787,100.688],[13.8779,100.6873],[13.8765,100.6864],[13.8753,100.685],[13.8746,100.6845],[13.8742,100.6844],[13.8728,100.6845],[13.87,100.6855],[13.8693,100.6857],[13.8666,100.6842],[13.8659,100.6839],[13.8628,100.6834],[13.8618,100.6829],[13.8607,100.6821],[13.8598,100.681],[13.8587,100.6803],[13.8584,100.6793],[13.8584,100.6788],[13.8581,100.6774],[13.8577,100.6767],[13.8554,100.6742],[13.8535,100.6707],[13.8527,100.6708],[13.8525,100.6709],[13.8523,100.6716],[13.8522,100.6738],[13.8515,100.677],[13.8504,100.6787],[13.8503,100.6797],[13.85,100.6804],[13.8491,100.6823],[13.848,100.6838],[13.8468,100.6843],[13.8451,100.6855],[13.8437,100.686],[13.8417,100.6864],[13.8402,100.6868],[13.8386,100.6877],[13.8382,100.6878],[13.836,100.6883],[13.835,100.6878],[13.8347,100.6878],[13.8329,100.6901],[13.8324,100.6905],[13.8309,100.6909],[13.8301,100.6919],[13.8248,100.6948],[13.8242,100.6952],[13.8232,100.6954],[13.8222,100.6954],[13.8216,100.6956],[13.8208,100.6961],[13.8203,100.6969],[13.8173,100.6965],[13.8165,100.6966],[13.8147,100.6968],[13.8126,100.6975],[13.8122,100.6978],[13.8112,100.6987],[13.8095,100.7014],[13.8089,100.7018],[13.8079,100.7021],[13.807,100.702],[13.8054,100.7011],[13.8047,100.7005],[13.8044,100.7005],[13.7976,100.7049],[13.7982,100.7061],[13.7851,100.7136],[13.7827,100.7149],[13.7815,100.7153],[13.7799,100.7155],[13.778,100.7163],[13.7779,100.7173],[13.7777,100.7173],[13.7777,100.7169],[13.7769,100.717],[13.7769,100.7177],[13.7762,100.7178],[13.7762,100.7175],[13.7759,100.7175],[13.7759,100.7178],[13.7756,100.7178],[13.7756,100.7173],[13.7754,100.7173],[13.7754,100.717],[13.7751,100.717],[13.7751,100.7168],[13.775,100.7168],[13.775,100.7174],[13.7746,100.7177],[13.7746,100.718],[13.7743,100.718],[13.7743,100.7178],[13.7732,100.7189],[13.7729,100.7196],[13.7716,100.7209],[13.7731,100.7215],[13.7729,100.7221],[13.7767,100.7237],[13.7762,100.7248],[13.776,100.7256],[13.7746,100.7337],[13.7762,100.7368],[13.7762,100.7375],[13.7758,100.7376],[13.7758,100.7382],[13.776,100.7384],[13.776,100.7388],[13.7738,100.7389],[13.7741,100.7463],[13.7767,100.7464],[13.7768,100.7538],[13.7777,100.7539],[13.7766,100.7557],[13.7757,100.7584],[13.7757,100.7594],[13.7758,100.7599],[13.7776,100.7614],[13.7783,100.7618],[13.7799,100.7637],[13.7817,100.7663],[13.7816,100.7675],[13.7819,100.7676],[13.782,100.7685],[13.7823,100.7686],[13.7825,100.7696],[13.7826,100.7712],[13.7825,100.773],[13.7831,100.7763],[13.7829,100.7769],[13.7825,100.7777],[13.7821,100.781],[13.7817,100.7824],[13.7819,100.7828],[13.7819,100.7837],[13.7818,100.7848],[13.7815,100.7865],[13.7813,100.789],[13.7815,100.7911],[13.782,100.7925],[13.7827,100.7934],[13.7834,100.7947],[13.7828,100.7959],[13.7816,100.8009],[13.7817,100.8037],[13.7816,100.8086],[13.782,100.8109],[13.7823,100.8122],[13.7828,100.8133],[13.7841,100.8143],[13.7842,100.8146],[13.7838,100.8149],[13.783,100.816],[13.7823,100.819],[13.7797,100.8228],[13.7777,100.8226],[13.777,100.8239],[13.7749,100.8264],[13.7724,100.8288],[13.7713,100.8295],[13.7698,100.83],[13.7674,100.8323],[13.7679,100.8345],[13.7675,100.8375],[13.7701,100.8401],[13.7706,100.8411],[13.7709,100.8425],[13.771,100.8439],[13.7707,100.8461],[13.7709,100.8491],[13.771,100.8559],[13.7704,100.858],[13.7703,100.8607],[13.7696,100.8617],[13.7678,100.8633],[13.767,100.8639],[13.7647,100.8648],[13.7635,100.8649],[13.7619,100.8655],[13.7603,100.8657],[13.7584,100.8665],[13.7546,100.8663],[13.7528,100.8666],[13.7497,100.8681],[13.7469,100.8702],[13.745,100.8719],[13.744,100.8722],[13.7417,100.8734],[13.7401,100.8741],[13.7388,100.8752],[13.7383,100.876],[13.7381,100.8769],[13.7378,100.8789]],"cen":[13.8431,100.7982]},{"n":"ทุ่งมหาเมฆ","c":[[13.7229,100.5526],[13.7327,100.5292],[13.738,100.5157],[13.7353,100.5159],[13.7325,100.5155],[13.7313,100.5149],[13.7305,100.5143],[13.73,100.5136],[13.7293,100.5123],[13.7272,100.5126],[13.7231,100.5127],[13.7211,100.5124],[13.7193,100.512],[13.7175,100.5115],[13.716,100.5107],[13.7146,100.5099],[13.7128,100.5085],[13.7117,100.5075],[13.7083,100.5039],[13.7068,100.5018],[13.7058,100.5],[13.7029,100.4945],[13.7019,100.493],[13.7007,100.4918],[13.7001,100.4913],[13.6988,100.4907],[13.696,100.49],[13.6948,100.4899],[13.6933,100.49],[13.6921,100.4905],[13.6912,100.4913],[13.6903,100.4925],[13.6888,100.4946],[13.6877,100.4969],[13.687,100.4985],[13.6866,100.5],[13.6854,100.5064],[13.6844,100.5134],[13.6832,100.5171],[13.6716,100.5309],[13.6698,100.5349],[13.6695,100.536],[13.6691,100.5382],[13.6692,100.5406],[13.6694,100.5418],[13.6709,100.5451],[13.6718,100.5468],[13.6738,100.5485],[13.6749,100.5491],[13.6772,100.551],[13.678,100.5514],[13.6823,100.5525],[13.6859,100.5527],[13.6906,100.5526],[13.6929,100.5521],[13.6971,100.5515],[13.6987,100.5514],[13.7002,100.5493],[13.7012,100.5483],[13.7019,100.5478],[13.7026,100.5476],[13.7034,100.5478],[13.7039,100.5481],[13.7092,100.5535],[13.7095,100.5538],[13.7102,100.5541],[13.7186,100.5532],[13.7196,100.5529],[13.7229,100.5526]],"cen":[13.7037,100.5219]},{"n":"บางกอกน้อย","c":[[13.7853,100.5048],[13.7924,100.5114],[13.7945,100.5131],[13.7973,100.5151],[13.7993,100.5161],[13.8016,100.517],[13.805,100.5176],[13.8102,100.5171],[13.8113,100.5166],[13.8132,100.5152],[13.8017,100.5025],[13.8007,100.501],[13.8001,100.4996],[13.7907,100.4733],[13.7899,100.4707],[13.7889,100.4663],[13.7899,100.4667],[13.7921,100.4679],[13.7949,100.4698],[13.7957,100.4675],[13.7967,100.4653],[13.7972,100.464],[13.7982,100.459],[13.7995,100.4423],[13.7995,100.4401],[13.8007,100.4228],[13.8014,100.4107],[13.8024,100.3827],[13.8025,100.3741],[13.8032,100.357],[13.8033,100.3482],[13.8038,100.3335],[13.8041,100.3284],[13.8024,100.3291],[13.8021,100.3291],[13.802,100.3288],[13.8014,100.3288],[13.7992,100.3293],[13.7962,100.3295],[13.7923,100.33],[13.7876,100.3304],[13.7763,100.3299],[13.7711,100.3294],[13.7685,100.3291],[13.766,100.3292],[13.7651,100.3293],[13.7627,100.33],[13.7614,100.3305],[13.7588,100.3308],[13.7571,100.3313],[13.7547,100.3314],[13.7536,100.3318],[13.7483,100.3313],[13.7476,100.3314],[13.7477,100.3342],[13.7485,100.3388],[13.7491,100.3414],[13.7492,100.3444],[13.7512,100.3481],[13.7521,100.3522],[13.7536,100.3611],[13.7538,100.3631],[13.7538,100.3658],[13.7536,100.3732],[13.753,100.3806],[13.751,100.3971],[13.7502,100.4024],[13.7498,100.404],[13.7491,100.4082],[13.7472,100.4168],[13.7456,100.4197],[13.7446,100.4209],[13.7442,100.4215],[13.7436,100.424],[13.7435,100.4249],[13.7428,100.4257],[13.7424,100.4272],[13.7422,100.4297],[13.7424,100.4303],[13.7423,100.4309],[13.7421,100.4312],[13.7408,100.4319],[13.7403,100.4324],[13.7403,100.4337],[13.74,100.4351],[13.74,100.4391],[13.7402,100.44],[13.7405,100.4406],[13.7401,100.4432],[13.7406,100.4444],[13.7407,100.4462],[13.7403,100.4473],[13.7403,100.4479],[13.7409,100.4491],[13.7404,100.4498],[13.7411,100.4507],[13.7411,100.4523],[13.7418,100.4534],[13.742,100.454],[13.7425,100.4544],[13.7424,100.455],[13.7419,100.4553],[13.7421,100.4564],[13.7429,100.4569],[13.7432,100.457],[13.7436,100.4568],[13.7439,100.4572],[13.7439,100.4579],[13.7436,100.4588],[13.7436,100.4596],[13.7441,100.4606],[13.7444,100.462],[13.7417,100.4616],[13.7389,100.4616],[13.7364,100.462],[13.735,100.4622],[13.7327,100.4627],[13.7281,100.4652],[13.7253,100.4671],[13.7244,100.4681],[13.7226,100.4713],[13.7226,100.4724],[13.7224,100.4761],[13.7232,100.4803],[13.7244,100.4836],[13.7249,100.4844],[13.7284,100.4857],[13.7323,100.4863],[13.7351,100.4872],[13.7367,100.488],[13.7388,100.4888],[13.7403,100.4899],[13.7425,100.4919],[13.7442,100.4905],[13.7464,100.4889],[13.7476,100.4883],[13.7497,100.4878],[13.7523,100.4876],[13.7546,100.4876],[13.7571,100.488],[13.7599,100.4891],[13.7617,100.4905],[13.7656,100.4948],[13.7675,100.4963],[13.7701,100.4979],[13.7791,100.5015],[13.7836,100.5036],[13.7853,100.5048]],"cen":[13.7677,100.4128]},{"n":"สุวรรณภูมิ","c":[[13.6033,100.7203],[13.6024,100.728],[13.6022,100.7291],[13.6021,100.7326],[13.6018,100.7349],[13.6015,100.736],[13.6012,100.7385],[13.6012,100.7403],[13.6017,100.7432],[13.6017,100.7446],[13.601,100.7461],[13.5994,100.7481],[13.5991,100.7501],[13.5987,100.7517],[13.5986,100.7531],[13.5986,100.7535],[13.599,100.7545],[13.5996,100.7553],[13.5998,100.7558],[13.5997,100.7572],[13.5994,100.7588],[13.5994,100.7595],[13.5992,100.7601],[13.5984,100.7611],[13.598,100.7615],[13.5966,100.7667],[13.597,100.7711],[13.5967,100.7723],[13.5965,100.7745],[13.5961,100.777],[13.5957,100.7782],[13.5946,100.7805],[13.5938,100.7829],[13.5937,100.7845],[13.593,100.7881],[13.593,100.7902],[13.592,100.7943],[13.5913,100.7965],[13.5908,100.7986],[13.5906,100.7991],[13.5902,100.7992],[13.5887,100.8039],[13.5879,100.8043],[13.5873,100.8042],[13.5866,100.8036],[13.5858,100.8023],[13.5854,100.8021],[13.5847,100.8024],[13.5839,100.8032],[13.5815,100.8084],[13.5812,100.8106],[13.5808,100.8116],[13.5802,100.8124],[13.5793,100.8133],[13.5792,100.8143],[13.5783,100.817],[13.5779,100.8176],[13.5769,100.8184],[13.5767,100.8191],[13.5768,100.8199],[13.5771,100.8203],[13.578,100.8213],[13.5781,100.8222],[13.578,100.8228],[13.5774,100.8237],[13.576,100.8251],[13.5753,100.8256],[13.5752,100.8261],[13.5763,100.8283],[13.577,100.8293],[13.5779,100.8299],[13.5784,100.8305],[13.5785,100.8313],[13.5786,100.8325],[13.578,100.8335],[13.5776,100.8339],[13.5767,100.8342],[13.5752,100.8342],[13.5746,100.8344],[13.574,100.8347],[13.5733,100.8354],[13.5744,100.8376],[13.5744,100.8397],[13.5751,100.8414],[13.5757,100.8423],[13.5761,100.8443],[13.5761,100.8454],[13.5764,100.8463],[13.5772,100.8476],[13.5773,100.8509],[13.5776,100.8525],[13.5763,100.8531],[13.5759,100.8536],[13.5759,100.8553],[13.5764,100.8574],[13.5749,100.8626],[13.5729,100.8691],[13.5723,100.8724],[13.5718,100.874],[13.5722,100.876],[13.5714,100.8787],[13.5714,100.8803],[13.5716,100.8823],[13.5645,100.8902],[13.5641,100.8909],[13.5615,100.8938],[13.5541,100.9041],[13.5566,100.9052],[13.5577,100.9059],[13.5589,100.9066],[13.5604,100.9077],[13.5617,100.9081],[13.5631,100.9091],[13.5652,100.9111],[13.5673,100.9118],[13.5677,100.9121],[13.5687,100.9136],[13.5692,100.9139],[13.5713,100.9152],[13.5732,100.9151],[13.5744,100.9146],[13.5767,100.9139],[13.5776,100.9133],[13.5784,100.9123],[13.5789,100.9111],[13.5799,100.9095],[13.5806,100.9077],[13.5807,100.907],[13.5833,100.9071],[13.5856,100.9067],[13.5872,100.9068],[13.592,100.9073],[13.5926,100.9085],[13.5928,100.9097],[13.5926,100.9114],[13.5922,100.913],[13.5923,100.9137],[13.5927,100.9147],[13.5946,100.9184],[13.5948,100.9194],[13.5946,100.9207],[13.5933,100.9238],[13.5931,100.9245],[13.5932,100.9246],[13.5975,100.9281],[13.5986,100.9294],[13.5993,100.9305],[13.6104,100.939],[13.6165,100.9443],[13.6182,100.9458],[13.629,100.9575],[13.632,100.9606],[13.6325,100.9609],[13.6359,100.9622],[13.6441,100.9651],[13.6442,100.9642],[13.6448,100.9623],[13.6455,100.9586],[13.647,100.954],[13.6483,100.9536],[13.6529,100.9527],[13.654,100.9526],[13.6553,100.9526],[13.6561,100.9547],[13.657,100.9549],[13.6581,100.9548],[13.6589,100.9561],[13.66,100.9568],[13.6619,100.9576],[13.6626,100.9557],[13.6635,100.9526],[13.6656,100.9469],[13.6754,100.9186],[13.6842,100.8946],[13.689,100.8801],[13.6899,100.8775],[13.697,100.8607],[13.6985,100.8576],[13.6994,100.8552],[13.7022,100.8568],[13.7378,100.8789],[13.7381,100.8769],[13.7383,100.876],[13.7388,100.8752],[13.7401,100.8741],[13.7417,100.8734],[13.744,100.8722],[13.745,100.8719],[13.7469,100.8702],[13.7497,100.8681],[13.7528,100.8666],[13.7546,100.8663],[13.7584,100.8665],[13.7603,100.8657],[13.7619,100.8655],[13.7635,100.8649],[13.7647,100.8648],[13.767,100.8639],[13.7678,100.8633],[13.7696,100.8617],[13.7703,100.8607],[13.7704,100.858],[13.771,100.8559],[13.7709,100.8491],[13.7707,100.8461],[13.771,100.8439],[13.7709,100.8425],[13.7706,100.8411],[13.7701,100.8401],[13.7675,100.8375],[13.7679,100.8345],[13.7674,100.8323],[13.7698,100.83],[13.7713,100.8295],[13.7724,100.8288],[13.7749,100.8264],[13.777,100.8239],[13.7777,100.8226],[13.7797,100.8228],[13.7823,100.819],[13.783,100.816],[13.7838,100.8149],[13.7842,100.8146],[13.7841,100.8143],[13.7828,100.8133],[13.7823,100.8122],[13.782,100.8109],[13.7816,100.8086],[13.7817,100.8037],[13.7816,100.8009],[13.7828,100.7959],[13.7834,100.7947],[13.7827,100.7934],[13.782,100.7925],[13.7815,100.7911],[13.7813,100.789],[13.7815,100.7865],[13.7818,100.7848],[13.7819,100.7837],[13.7819,100.7828],[13.7817,100.7824],[13.7821,100.781],[13.7825,100.7777],[13.7829,100.7769],[13.7831,100.7763],[13.7825,100.773],[13.7826,100.7712],[13.7825,100.7696],[13.7823,100.7686],[13.782,100.7685],[13.7819,100.7676],[13.7816,100.7675],[13.7817,100.7663],[13.7799,100.7637],[13.7783,100.7618],[13.7776,100.7614],[13.7758,100.7599],[13.7757,100.7594],[13.7757,100.7584],[13.7766,100.7557],[13.7777,100.7539],[13.7768,100.7538],[13.7767,100.7464],[13.7741,100.7463],[13.7738,100.7389],[13.776,100.7388],[13.776,100.7384],[13.7758,100.7382],[13.7758,100.7376],[13.7762,100.7375],[13.7762,100.7368],[13.7746,100.7337],[13.776,100.7256],[13.7762,100.7248],[13.7767,100.7237],[13.7729,100.7221],[13.7731,100.7215],[13.7716,100.7209],[13.7729,100.7196],[13.7732,100.7189],[13.7743,100.7178],[13.7743,100.718],[13.7746,100.718],[13.7746,100.7177],[13.775,100.7174],[13.775,100.7168],[13.7751,100.7168],[13.7751,100.717],[13.7754,100.717],[13.7754,100.7173],[13.7756,100.7173],[13.7756,100.7178],[13.7759,100.7178],[13.7759,100.7175],[13.7762,100.7175],[13.7762,100.7178],[13.7769,100.7177],[13.7769,100.717],[13.7771,100.7169],[13.7777,100.7169],[13.7777,100.7173],[13.7779,100.7173],[13.778,100.7163],[13.777,100.7166],[13.7726,100.7162],[13.7715,100.7159],[13.7668,100.7131],[13.7653,100.7125],[13.7639,100.7112],[13.7624,100.7103],[13.7615,100.7094],[13.761,100.709],[13.7577,100.7069],[13.7567,100.7065],[13.7565,100.7071],[13.7564,100.7082],[13.7564,100.7097],[13.7479,100.7092],[13.7447,100.7091],[13.7393,100.7087],[13.7387,100.7088],[13.7379,100.7086],[13.7372,100.7087],[13.7317,100.7083],[13.7307,100.7083],[13.7241,100.7089],[13.7075,100.7114],[13.7061,100.7115],[13.7013,100.7124],[13.7012,100.711],[13.6952,100.7099],[13.6951,100.7102],[13.6913,100.7098],[13.6902,100.7096],[13.6883,100.709],[13.6877,100.7086],[13.6847,100.7073],[13.6809,100.7066],[13.6786,100.7064],[13.6789,100.7055],[13.6746,100.7046],[13.6744,100.7052],[13.6725,100.7045],[13.6641,100.6998],[13.6627,100.6993],[13.6586,100.6985],[13.6535,100.698],[13.6546,100.6932],[13.6519,100.6928],[13.6514,100.6929],[13.6514,100.6924],[13.6506,100.6924],[13.6513,100.6892],[13.6502,100.6883],[13.6483,100.688],[13.6478,100.687],[13.6467,100.6866],[13.6464,100.686],[13.644,100.6834],[13.6433,100.6828],[13.6422,100.6823],[13.639,100.6815],[13.6374,100.6809],[13.6365,100.6806],[13.6341,100.6791],[13.631,100.6786],[13.6273,100.6784],[13.6268,100.6781],[13.626,100.6754],[13.6235,100.6758],[13.6229,100.6756],[13.6223,100.6752],[13.6218,100.6753],[13.6205,100.6747],[13.6188,100.6724],[13.6172,100.6721],[13.6158,100.6716],[13.6149,100.6715],[13.614,100.671],[13.6141,100.6722],[13.6134,100.6758],[13.6128,100.6771],[13.6115,100.6819],[13.6111,100.685],[13.61,100.6885],[13.6096,100.6893],[13.6094,100.6905],[13.6088,100.6926],[13.6082,100.6939],[13.6076,100.6965],[13.607,100.6983],[13.6064,100.7025],[13.6057,100.7049],[13.6057,100.7078],[13.6055,100.7083],[13.6047,100.7095],[13.6041,100.7097],[13.6035,100.7104],[13.6034,100.7119],[13.6035,100.7132],[13.6031,100.7173],[13.6033,100.7203]],"cen":[13.669,100.8197]},{"n":"บางบัวทอง","c":[[13.9142,100.4662],[13.9158,100.4669],[13.917,100.4678],[13.9184,100.47],[13.9187,100.4722],[13.9183,100.4748],[13.9177,100.4771],[13.9156,100.4818],[13.9149,100.4847],[13.9146,100.4877],[13.9146,100.4914],[13.9156,100.4938],[13.9171,100.4958],[13.9191,100.4973],[13.9209,100.4983],[13.9236,100.4991],[13.9257,100.4993],[13.9319,100.5004],[13.9343,100.501],[13.9374,100.5022],[13.9378,100.4995],[13.9384,100.4981],[13.939,100.4978],[13.9391,100.497],[13.9396,100.4963],[13.9396,100.4957],[13.9398,100.4953],[13.9402,100.4953],[13.9408,100.4939],[13.9405,100.4935],[13.9406,100.493],[13.941,100.4924],[13.941,100.4918],[13.9411,100.4913],[13.9421,100.4905],[13.9425,100.4894],[13.944,100.488],[13.9449,100.4875],[13.946,100.4886],[13.9465,100.4885],[13.9475,100.4873],[13.9494,100.4867],[13.9501,100.4863],[13.9505,100.486],[13.9512,100.4846],[13.9542,100.4818],[13.9557,100.4808],[13.9571,100.4792],[13.958,100.4787],[13.9587,100.478],[13.9608,100.4759],[13.961,100.4751],[13.9637,100.4724],[13.9607,100.4706],[13.9601,100.47],[13.9599,100.4693],[13.9602,100.4687],[13.9602,100.468],[13.9601,100.4673],[13.9598,100.467],[13.9592,100.4668],[13.9587,100.4665],[13.9582,100.4665],[13.9582,100.4657],[13.9591,100.4649],[13.9597,100.4645],[13.9602,100.4638],[13.9606,100.4618],[13.9612,100.4605],[13.9615,100.4596],[13.9621,100.4588],[13.966,100.4551],[13.9663,100.4545],[13.9661,100.4542],[13.9664,100.4533],[13.9669,100.4526],[13.9673,100.4522],[13.9681,100.4526],[13.9742,100.4442],[13.9788,100.4383],[13.9799,100.437],[13.9808,100.4356],[13.9814,100.4341],[13.9835,100.4254],[13.9948,100.3811],[13.9889,100.3806],[13.9909,100.3716],[13.9921,100.365],[13.9924,100.3642],[13.9943,100.3611],[13.9953,100.3605],[14.0008,100.3556],[14.0083,100.3511],[14.0178,100.3457],[14.0225,100.3435],[14.0249,100.3428],[14.0384,100.3365],[14.0434,100.3346],[14.0478,100.3334],[14.0531,100.3323],[14.0608,100.3316],[14.0648,100.332],[14.0672,100.3324],[14.0693,100.3333],[14.077,100.3347],[14.0922,100.3401],[14.0971,100.3415],[14.1053,100.3421],[14.1151,100.3444],[14.1279,100.3333],[14.1293,100.3222],[14.1332,100.3132],[14.1361,100.3081],[14.1389,100.3008],[14.1398,100.2989],[14.1402,100.2971],[14.1394,100.2955],[14.1384,100.2944],[14.1361,100.2931],[14.1336,100.2903],[14.1256,100.2797],[14.1206,100.2794],[14.1086,100.278],[14.0988,100.2771],[14.0887,100.277],[14.0817,100.2766],[14.0756,100.2748],[14.0739,100.2745],[14.0727,100.2736],[14.0709,100.2736],[14.0693,100.2739],[14.0668,100.2735],[14.0646,100.2719],[14.0605,100.2668],[14.0562,100.263],[14.0514,100.26],[14.0469,100.258],[14.0386,100.2558],[14.0328,100.2555],[14.0265,100.2561],[14.0217,100.2574],[14.0167,100.2595],[14.0118,100.2624],[14.0066,100.2667],[14.0015,100.2749],[13.9932,100.2678],[13.9894,100.2691],[13.9849,100.272],[13.9761,100.2807],[13.9634,100.2981],[13.9442,100.2844],[13.9349,100.2743],[13.9206,100.2651],[13.915,100.2744],[13.9111,100.2772],[13.8959,100.2845],[13.8988,100.2906],[13.899,100.2905],[13.9003,100.2935],[13.9019,100.2977],[13.9024,100.2982],[13.9033,100.2995],[13.9037,100.3004],[13.9049,100.3058],[13.9062,100.3075],[13.9061,100.3106],[13.9067,100.3144],[13.9085,100.3236],[13.9091,100.3235],[13.9095,100.3247],[13.91,100.3355],[13.9101,100.3406],[13.9096,100.3468],[13.9092,100.3482],[13.9089,100.3503],[13.9094,100.3562],[13.9097,100.3571],[13.9098,100.3582],[13.9097,100.3624],[13.91,100.3637],[13.9105,100.3695],[13.9105,100.3723],[13.9102,100.3737],[13.9087,100.3757],[13.9083,100.3762],[13.9083,100.3771],[13.9085,100.3783],[13.9093,100.3809],[13.9095,100.3821],[13.909,100.3859],[13.9096,100.3873],[13.9098,100.3889],[13.9079,100.3963],[13.9077,100.3974],[13.908,100.3998],[13.9071,100.4024],[13.9063,100.4075],[13.9051,100.4071],[13.8994,100.4075],[13.874,100.4099],[13.8769,100.448],[13.8763,100.4526],[13.8742,100.4577],[13.8726,100.4609],[13.8711,100.4645],[13.8704,100.4671],[13.8699,100.471],[13.8701,100.4718],[13.8701,100.4736],[13.8704,100.4764],[13.8727,100.4762],[13.8756,100.4766],[13.8779,100.4776],[13.8857,100.4849],[13.8909,100.4891],[13.895,100.4906],[13.8967,100.4904],[13.8995,100.489],[13.9002,100.4863],[13.9013,100.4768],[13.9024,100.4735],[13.9056,100.4699],[13.9097,100.4671],[13.912,100.4665],[13.9142,100.4662]],"cen":[14.004,100.3122]},{"n":"มหาสวัสดิ์","c":[[13.9102,100.3737],[13.9105,100.3723],[13.9105,100.3695],[13.91,100.3637],[13.9097,100.3624],[13.9098,100.3582],[13.9097,100.3571],[13.9094,100.3562],[13.9089,100.3503],[13.9092,100.3482],[13.9096,100.3468],[13.9101,100.3406],[13.91,100.3355],[13.9095,100.3247],[13.9091,100.3235],[13.9085,100.3236],[13.9067,100.3144],[13.9061,100.3106],[13.9062,100.3075],[13.9049,100.3058],[13.9037,100.3004],[13.9033,100.2995],[13.9024,100.2982],[13.9019,100.2977],[13.9003,100.2935],[13.899,100.2905],[13.8988,100.2906],[13.8959,100.2845],[13.8797,100.2923],[13.8105,100.325],[13.8042,100.3279],[13.8038,100.3335],[13.8033,100.3482],[13.8032,100.357],[13.8025,100.3741],[13.8024,100.3827],[13.8014,100.4107],[13.8007,100.4228],[13.7995,100.4401],[13.7995,100.4423],[13.7982,100.459],[13.7972,100.464],[13.7967,100.4653],[13.7957,100.4675],[13.7949,100.4698],[13.7921,100.4679],[13.7899,100.4667],[13.7889,100.4663],[13.7899,100.4707],[13.7907,100.4733],[13.8001,100.4996],[13.8007,100.501],[13.8017,100.5025],[13.8132,100.5152],[13.8141,100.5142],[13.8163,100.5069],[13.8179,100.5037],[13.8198,100.5022],[13.8209,100.5015],[13.8259,100.4996],[13.8286,100.498],[13.8331,100.4947],[13.8355,100.4928],[13.8391,100.4911],[13.8421,100.4903],[13.8447,100.4899],[13.8469,100.4892],[13.8484,100.488],[13.8499,100.4863],[13.8508,100.4843],[13.8521,100.4817],[13.8532,100.4807],[13.8561,100.4788],[13.8619,100.4775],[13.8704,100.4764],[13.8701,100.4736],[13.8701,100.4718],[13.8699,100.471],[13.8704,100.4671],[13.8711,100.4645],[13.8726,100.4609],[13.8742,100.4577],[13.8763,100.4526],[13.8769,100.448],[13.874,100.4099],[13.8994,100.4075],[13.9051,100.4071],[13.9063,100.4075],[13.9071,100.4024],[13.908,100.3998],[13.9077,100.3974],[13.9079,100.3963],[13.9098,100.3889],[13.9096,100.3873],[13.909,100.3859],[13.9095,100.3821],[13.9093,100.3809],[13.9085,100.3783],[13.9083,100.3771],[13.9083,100.3762],[13.9087,100.3757],[13.9102,100.3737]],"cen":[13.8498,100.3965]},{"n":"พระโขนง","c":[[13.614,100.671],[13.6149,100.6715],[13.6158,100.6716],[13.6172,100.6721],[13.6188,100.6724],[13.6205,100.6747],[13.6218,100.6753],[13.6223,100.6752],[13.6229,100.6756],[13.6235,100.6758],[13.626,100.6754],[13.6268,100.6781],[13.6273,100.6784],[13.631,100.6786],[13.6341,100.6791],[13.6365,100.6806],[13.6374,100.6809],[13.639,100.6815],[13.6422,100.6823],[13.643,100.6826],[13.644,100.6834],[13.6464,100.686],[13.6467,100.6866],[13.6478,100.687],[13.6483,100.688],[13.6502,100.6883],[13.6512,100.6891],[13.6513,100.6892],[13.6506,100.6924],[13.6514,100.6924],[13.6514,100.6929],[13.6519,100.6928],[13.6546,100.6932],[13.6535,100.698],[13.6586,100.6985],[13.6627,100.6993],[13.6641,100.6998],[13.6717,100.7041],[13.6744,100.7052],[13.6746,100.7046],[13.6789,100.7055],[13.6786,100.7064],[13.6809,100.7066],[13.6847,100.7073],[13.6877,100.7086],[13.6883,100.709],[13.6913,100.7098],[13.6951,100.7102],[13.6952,100.7099],[13.7012,100.711],[13.7013,100.7124],[13.7061,100.7115],[13.7075,100.7114],[13.7241,100.7089],[13.7239,100.7089],[13.7241,100.6822],[13.7239,100.6733],[13.7149,100.6392],[13.7147,100.6376],[13.7147,100.6366],[13.7146,100.6357],[13.7146,100.635],[13.7149,100.6344],[13.7149,100.6335],[13.7146,100.6326],[13.7149,100.6321],[13.7155,100.6295],[13.7152,100.6289],[13.7151,100.6282],[13.7144,100.628],[13.7134,100.6269],[13.7129,100.6262],[13.7123,100.6258],[13.7128,100.6253],[13.7129,100.6248],[13.7147,100.6242],[13.7147,100.6238],[13.7145,100.6232],[13.7145,100.6225],[13.7142,100.6223],[13.7131,100.6221],[13.7123,100.6214],[13.7104,100.6213],[13.7104,100.6208],[13.7113,100.6201],[13.7115,100.6192],[13.7113,100.6188],[13.7106,100.6183],[13.7098,100.6164],[13.71,100.616],[13.7104,100.6158],[13.7107,100.6158],[13.7114,100.6164],[13.713,100.6157],[13.7132,100.6153],[13.7133,100.6148],[13.7132,100.6144],[13.7127,100.6139],[13.7126,100.6134],[13.7128,100.6126],[13.7131,100.6124],[13.7153,100.6122],[13.7155,100.6121],[13.7156,100.6117],[13.7155,100.6106],[13.7159,100.6088],[13.7159,100.6074],[13.7154,100.6065],[13.7142,100.6055],[13.7138,100.6032],[13.7135,100.6023],[13.7131,100.6019],[13.7116,100.6017],[13.7111,100.6014],[13.7111,100.601],[13.712,100.5994],[13.7122,100.5983],[13.7119,100.5978],[13.7107,100.5971],[13.7102,100.5966],[13.7088,100.5923],[13.7076,100.5911],[13.7061,100.5903],[13.7055,100.5896],[13.7049,100.5875],[13.7034,100.5808],[13.7029,100.5807],[13.6986,100.581],[13.6966,100.5835],[13.6911,100.5888],[13.6885,100.5893],[13.6849,100.5897],[13.684,100.5895],[13.6822,100.589],[13.681,100.5884],[13.6746,100.5836],[13.6674,100.5776],[13.6642,100.5748],[13.6614,100.5718],[13.6569,100.5716],[13.6568,100.5718],[13.6575,100.5726],[13.6577,100.5733],[13.6584,100.5738],[13.6585,100.574],[13.6584,100.5742],[13.6562,100.5763],[13.6559,100.5762],[13.6558,100.5752],[13.6554,100.5747],[13.655,100.5748],[13.6538,100.5758],[13.6528,100.5761],[13.6527,100.5763],[13.6534,100.577],[13.6532,100.5774],[13.6529,100.5777],[13.6527,100.5779],[13.6531,100.5786],[13.653,100.5794],[13.6528,100.5798],[13.6525,100.5801],[13.6524,100.5806],[13.6524,100.5815],[13.6522,100.5818],[13.6518,100.5837],[13.652,100.5846],[13.6513,100.585],[13.6511,100.5856],[13.6506,100.5861],[13.6507,100.5869],[13.6505,100.588],[13.6505,100.5887],[13.6498,100.5895],[13.6495,100.5905],[13.6495,100.5911],[13.649,100.5916],[13.6492,100.5918],[13.6498,100.5917],[13.65,100.5918],[13.6502,100.5922],[13.65,100.5932],[13.6495,100.5931],[13.6491,100.5926],[13.6489,100.5925],[13.6486,100.5927],[13.6485,100.5931],[13.6485,100.5955],[13.6463,100.5985],[13.6454,100.6004],[13.6445,100.6011],[13.6442,100.6016],[13.6439,100.6026],[13.6427,100.604],[13.6414,100.6069],[13.6408,100.6077],[13.6399,100.6085],[13.6377,100.6128],[13.6362,100.6148],[13.6354,100.6166],[13.634,100.6185],[13.6337,100.6198],[13.632,100.6219],[13.6318,100.6227],[13.6313,100.6239],[13.6297,100.6268],[13.6296,100.628],[13.6283,100.6297],[13.628,100.6309],[13.6272,100.6321],[13.6264,100.6342],[13.6257,100.6353],[13.6253,100.6367],[13.6249,100.6373],[13.6241,100.6383],[13.6235,100.6401],[13.6229,100.6409],[13.6222,100.6425],[13.6215,100.6447],[13.6201,100.6476],[13.6198,100.6494],[13.6192,100.6512],[13.6192,100.6523],[13.6184,100.6542],[13.6181,100.6553],[13.6178,100.6578],[13.617,100.6598],[13.6168,100.6615],[13.6164,100.6621],[13.6148,100.663],[13.6143,100.6636],[13.6145,100.6652],[13.614,100.671]],"cen":[13.669,100.6407]},{"n":"สุขสวัสดิ์","c":[[13.6986,100.581],[13.7007,100.5767],[13.7022,100.573],[13.705,100.5657],[13.7057,100.5635],[13.7063,100.5611],[13.7064,100.5597],[13.7063,100.5569],[13.7057,100.5553],[13.7046,100.5538],[13.7029,100.5523],[13.7012,100.5517],[13.6991,100.5513],[13.6971,100.5515],[13.6929,100.5521],[13.6906,100.5526],[13.6859,100.5527],[13.6823,100.5525],[13.678,100.5514],[13.6772,100.551],[13.6749,100.5491],[13.6738,100.5485],[13.6718,100.5468],[13.6702,100.5437],[13.6694,100.5418],[13.6692,100.5406],[13.6691,100.5382],[13.6695,100.536],[13.6698,100.5349],[13.6716,100.5309],[13.6832,100.5171],[13.6844,100.5134],[13.6851,100.5083],[13.6859,100.5033],[13.6866,100.5],[13.687,100.4985],[13.6877,100.4969],[13.6888,100.4946],[13.6903,100.4925],[13.6917,100.4909],[13.6921,100.4905],[13.6933,100.49],[13.6948,100.4899],[13.6948,100.4874],[13.695,100.4866],[13.6947,100.4853],[13.6948,100.4841],[13.6947,100.4827],[13.6945,100.4825],[13.6934,100.4821],[13.6929,100.4803],[13.6926,100.4798],[13.6903,100.4764],[13.689,100.4749],[13.6882,100.4737],[13.6884,100.4731],[13.6895,100.4723],[13.6905,100.4718],[13.6905,100.4716],[13.6899,100.4701],[13.6895,100.4686],[13.6878,100.4693],[13.6868,100.4691],[13.6864,100.4696],[13.6841,100.4701],[13.683,100.4706],[13.6824,100.4701],[13.6805,100.4703],[13.6791,100.4708],[13.6787,100.4702],[13.6784,100.469],[13.675,100.4703],[13.6741,100.4681],[13.6737,100.4666],[13.669,100.4679],[13.664,100.469],[13.6574,100.4707],[13.6548,100.4711],[13.6489,100.4724],[13.6396,100.4735],[13.6354,100.4747],[13.6343,100.475],[13.6321,100.4751],[13.6312,100.4755],[13.6306,100.4756],[13.6299,100.4755],[13.6296,100.4753],[13.629,100.4741],[13.6286,100.474],[13.6278,100.4744],[13.6273,100.4744],[13.6268,100.4735],[13.626,100.4729],[13.6255,100.4724],[13.6263,100.449],[13.6219,100.4502],[13.6218,100.4504],[13.6215,100.4504],[13.6206,100.4497],[13.6204,100.4497],[13.6201,100.45],[13.6188,100.4502],[13.6181,100.4501],[13.6171,100.4503],[13.6167,100.4502],[13.6159,100.4506],[13.6156,100.451],[13.6157,100.4512],[13.6152,100.4514],[13.615,100.4514],[13.6146,100.4512],[13.6122,100.4512],[13.6114,100.4515],[13.6109,100.4513],[13.6105,100.4517],[13.6098,100.4517],[13.6094,100.4519],[13.6078,100.4524],[13.6069,100.453],[13.606,100.4532],[13.606,100.4538],[13.6059,100.4538],[13.6054,100.4536],[13.6044,100.4538],[13.603,100.4533],[13.6024,100.4527],[13.6016,100.4524],[13.6008,100.4523],[13.6004,100.4521],[13.5984,100.4522],[13.5976,100.4515],[13.5967,100.4509],[13.5959,100.451],[13.5953,100.4509],[13.5946,100.4509],[13.5935,100.4501],[13.5928,100.4493],[13.5924,100.4493],[13.5918,100.4491],[13.5912,100.4493],[13.5907,100.4491],[13.5903,100.4488],[13.59,100.4485],[13.5895,100.4483],[13.5893,100.4478],[13.589,100.4475],[13.588,100.4476],[13.5876,100.4473],[13.5873,100.4467],[13.5869,100.4465],[13.5863,100.4467],[13.5852,100.4463],[13.5848,100.4463],[13.5833,100.4466],[13.5824,100.4466],[13.5626,100.4448],[13.5541,100.4443],[13.5491,100.445],[13.546,100.4456],[13.5409,100.4464],[13.5408,100.4466],[13.5403,100.4466],[13.5376,100.447],[13.5297,100.4485],[13.509,100.452],[13.4997,100.4538],[13.4995,100.4543],[13.5002,100.4557],[13.5002,100.4573],[13.5,100.459],[13.4995,100.4591],[13.4993,100.4603],[13.4949,100.4626],[13.4948,100.4638],[13.4951,100.4648],[13.4956,100.4657],[13.4962,100.4661],[13.4968,100.4673],[13.4975,100.4683],[13.4979,100.4684],[13.4978,100.4691],[13.4969,100.4691],[13.497,100.4704],[13.4979,100.4703],[13.4986,100.4709],[13.4985,100.4721],[13.4971,100.4719],[13.4972,100.4723],[13.4977,100.473],[13.498,100.4731],[13.4977,100.475],[13.497,100.475],[13.4969,100.4775],[13.4973,100.4777],[13.4969,100.4782],[13.4968,100.4791],[13.4966,100.4796],[13.4968,100.4806],[13.4957,100.4809],[13.496,100.4831],[13.4971,100.483],[13.4973,100.4832],[13.4975,100.4863],[13.497,100.4865],[13.497,100.4872],[13.4979,100.4891],[13.4985,100.4892],[13.4984,100.4895],[13.4965,100.4899],[13.4966,100.4901],[13.4963,100.4904],[13.4965,100.4909],[13.4967,100.4915],[13.4979,100.4917],[13.4982,100.4925],[13.4995,100.4924],[13.4994,100.4931],[13.5,100.4931],[13.4999,100.4935],[13.4997,100.494],[13.4991,100.4943],[13.4988,100.4957],[13.4988,100.4977],[13.4999,100.4978],[13.5,100.5006],[13.4997,100.5009],[13.4999,100.5021],[13.5002,100.5029],[13.5005,100.5044],[13.5006,100.5067],[13.5011,100.5078],[13.5013,100.5107],[13.5015,100.511],[13.501,100.5119],[13.5006,100.5123],[13.5006,100.5132],[13.5001,100.5138],[13.5003,100.5141],[13.5013,100.5143],[13.5013,100.5146],[13.5007,100.5146],[13.5008,100.5148],[13.5011,100.5149],[13.5001,100.5162],[13.5009,100.5168],[13.5013,100.5167],[13.5017,100.5169],[13.5016,100.52],[13.5021,100.52],[13.5024,100.5215],[13.5029,100.5219],[13.5026,100.5229],[13.5029,100.5229],[13.5031,100.5241],[13.5023,100.5243],[13.5022,100.5271],[13.5025,100.5272],[13.5026,100.5276],[13.503,100.5279],[13.5031,100.5285],[13.5036,100.5291],[13.5035,100.5305],[13.5031,100.5306],[13.5031,100.5321],[13.5024,100.533],[13.5017,100.533],[13.5017,100.5341],[13.503,100.534],[13.5032,100.5344],[13.503,100.5348],[13.5033,100.5354],[13.5036,100.5355],[13.5037,100.5368],[13.5041,100.5369],[13.5042,100.5396],[13.505,100.5406],[13.5057,100.5433],[13.5061,100.5433],[13.506,100.5469],[13.5057,100.547],[13.5056,100.5475],[13.5059,100.5476],[13.5059,100.5479],[13.5062,100.5485],[13.5056,100.5486],[13.5056,100.549],[13.5059,100.5491],[13.5057,100.5525],[13.5062,100.5537],[13.5069,100.5541],[13.5069,100.5545],[13.5072,100.5545],[13.5077,100.5552],[13.5075,100.5618],[13.5082,100.5619],[13.5088,100.563],[13.5092,100.563],[13.5096,100.5638],[13.5088,100.5642],[13.5091,100.5652],[13.509,100.5658],[13.5087,100.5662],[13.5093,100.5666],[13.509,100.567],[13.5097,100.5677],[13.5096,100.5684],[13.5099,100.5683],[13.5103,100.5685],[13.5103,100.5689],[13.5096,100.5694],[13.5093,100.5691],[13.5091,100.5693],[13.5095,100.57],[13.5103,100.5701],[13.5106,100.5709],[13.5106,100.5717],[13.5104,100.5719],[13.5096,100.572],[13.5098,100.5724],[13.5101,100.5722],[13.5101,100.5726],[13.5104,100.5725],[13.5108,100.573],[13.5101,100.5736],[13.5095,100.5728],[13.5092,100.573],[13.5092,100.5732],[13.5098,100.5738],[13.5091,100.5741],[13.5092,100.5747],[13.512,100.5771],[13.513,100.5788],[13.5137,100.5791],[13.5137,100.579],[13.5176,100.5832],[13.5177,100.584],[13.5204,100.5862],[13.5241,100.5886],[13.5255,100.589],[13.5333,100.5882],[13.5341,100.5884],[13.5348,100.5887],[13.5354,100.5892],[13.5366,100.5907],[13.5373,100.593],[13.5571,100.5776],[13.5594,100.5769],[13.5623,100.5764],[13.5696,100.5766],[13.573,100.5779],[13.5768,100.5805],[13.5842,100.5862],[13.5923,100.5909],[13.5951,100.5922],[13.5978,100.5926],[13.6023,100.592],[13.6051,100.5915],[13.6074,100.5906],[13.6091,100.5887],[13.61,100.5868],[13.6107,100.5848],[13.6112,100.5795],[13.6111,100.5758],[13.6113,100.5665],[13.6118,100.5639],[13.6126,100.5613],[13.614,100.5577],[13.6166,100.5534],[13.619,100.5499],[13.6208,100.5481],[13.627,100.5427],[13.6358,100.5373],[13.6388,100.5361],[13.6422,100.5351],[13.6461,100.5343],[13.6485,100.534],[13.653,100.5341],[13.654,100.5344],[13.6569,100.5356],[13.6586,100.5366],[13.6596,100.5377],[13.6604,100.5388],[13.6609,100.5407],[13.6609,100.5415],[13.6608,100.5427],[13.6603,100.545],[13.6595,100.548],[13.6588,100.5502],[13.658,100.5518],[13.6561,100.5567],[13.6558,100.5581],[13.6558,100.5599],[13.6561,100.5619],[13.6567,100.5641],[13.6582,100.5676],[13.6613,100.5718],[13.6642,100.5748],[13.6674,100.5776],[13.6746,100.5836],[13.681,100.5884],[13.6822,100.589],[13.684,100.5895],[13.6849,100.5897],[13.6885,100.5893],[13.6911,100.5888],[13.6966,100.5835],[13.6986,100.581]],"cen":[13.6006,100.5222]},{"n":"นนทบุรี","c":[[13.9556,100.5418],[13.9557,100.5407],[13.9558,100.539],[13.9539,100.5389],[13.9526,100.5386],[13.9507,100.5376],[13.949,100.5364],[13.9475,100.5348],[13.9456,100.5322],[13.9451,100.5313],[13.9445,100.5298],[13.9441,100.5282],[13.9435,100.5233],[13.9436,100.5203],[13.9439,100.515],[13.9438,100.5105],[13.9434,100.5088],[13.9425,100.5069],[13.9415,100.5054],[13.9393,100.5035],[13.9374,100.5022],[13.9343,100.501],[13.9319,100.5004],[13.9257,100.4993],[13.9236,100.4991],[13.9209,100.4983],[13.9191,100.4973],[13.9171,100.4958],[13.9156,100.4938],[13.9146,100.4914],[13.9146,100.4877],[13.9149,100.4847],[13.9156,100.4818],[13.9177,100.4771],[13.9183,100.4748],[13.9187,100.4722],[13.9184,100.47],[13.917,100.4678],[13.9158,100.4669],[13.9142,100.4662],[13.912,100.4665],[13.9097,100.4671],[13.9056,100.4699],[13.9024,100.4735],[13.9013,100.4768],[13.9002,100.4863],[13.8995,100.489],[13.8967,100.4904],[13.895,100.4906],[13.8909,100.4891],[13.8857,100.4849],[13.8779,100.4776],[13.8756,100.4766],[13.8727,100.4762],[13.8619,100.4775],[13.8599,100.4779],[13.8561,100.4788],[13.8532,100.4807],[13.8521,100.4817],[13.8508,100.4843],[13.8499,100.4863],[13.8484,100.488],[13.8469,100.4892],[13.8447,100.4899],[13.8421,100.4903],[13.8391,100.4911],[13.8355,100.4928],[13.8331,100.4947],[13.8286,100.498],[13.8259,100.4996],[13.8209,100.5015],[13.8198,100.5022],[13.8179,100.5037],[13.8163,100.5069],[13.8161,100.5075],[13.819,100.5063],[13.8194,100.5064],[13.8212,100.5072],[13.8215,100.5076],[13.8224,100.5076],[13.8228,100.5077],[13.8234,100.5087],[13.8236,100.5096],[13.8242,100.5101],[13.8245,100.5101],[13.8246,100.5096],[13.8248,100.5093],[13.8252,100.5092],[13.8255,100.5093],[13.8252,100.5107],[13.8253,100.5108],[13.8262,100.511],[13.8261,100.5118],[13.8259,100.5121],[13.8249,100.5126],[13.8247,100.5128],[13.8247,100.5131],[13.8262,100.5132],[13.8269,100.5147],[13.8271,100.5154],[13.8276,100.5158],[13.8286,100.5159],[13.8307,100.5188],[13.8329,100.5212],[13.8339,100.5223],[13.8344,100.5228],[13.8398,100.5291],[13.8417,100.531],[13.8424,100.532],[13.8442,100.5339],[13.8451,100.535],[13.8462,100.5362],[13.8467,100.5374],[13.8475,100.5386],[13.8495,100.5434],[13.8499,100.5435],[13.8498,100.5438],[13.9515,100.5678],[13.951,100.5667],[13.9503,100.5667],[13.9504,100.5663],[13.9506,100.5658],[13.9505,100.5647],[13.9504,100.5645],[13.9497,100.564],[13.9498,100.5634],[13.9496,100.5628],[13.9499,100.5621],[13.9498,100.5619],[13.9494,100.5617],[13.9494,100.5615],[13.95,100.561],[13.95,100.5605],[13.9504,100.5605],[13.9507,100.5603],[13.9507,100.5596],[13.9505,100.5584],[13.9498,100.5572],[13.9501,100.5568],[13.9502,100.5562],[13.9515,100.555],[13.9515,100.5547],[13.9514,100.5545],[13.9504,100.5543],[13.9504,100.5541],[13.9514,100.5534],[13.9511,100.5526],[13.9517,100.5512],[13.9518,100.5505],[13.952,100.5498],[13.9521,100.5491],[13.9527,100.5484],[13.9526,100.5476],[13.9527,100.5471],[13.9525,100.5458],[13.9526,100.5456],[13.9533,100.5456],[13.9534,100.5454],[13.9533,100.5451],[13.953,100.5448],[13.953,100.5444],[13.9535,100.5439],[13.9538,100.5439],[13.9543,100.5442],[13.9544,100.5441],[13.9545,100.5438],[13.954,100.5428],[13.9535,100.5421],[13.9547,100.5413],[13.9553,100.5422],[13.9556,100.5418]],"cen":[13.8864,100.519]},{"n":"แม้นศรี","c":[[13.8,100.52],[13.8002,100.5194],[13.8002,100.5164],[13.7973,100.5151],[13.7945,100.5131],[13.7924,100.5114],[13.7845,100.5042],[13.7836,100.5036],[13.7791,100.5015],[13.7701,100.4979],[13.7675,100.4963],[13.7656,100.4948],[13.7617,100.4905],[13.7599,100.4891],[13.7571,100.488],[13.7546,100.4876],[13.7523,100.4876],[13.7497,100.4878],[13.7476,100.4883],[13.746,100.4892],[13.7442,100.4905],[13.7417,100.4926],[13.7406,100.4939],[13.7398,100.4954],[13.739,100.4979],[13.737,100.5063],[13.7362,100.508],[13.7357,100.5088],[13.735,100.5096],[13.7338,100.5106],[13.731,100.5118],[13.7293,100.5123],[13.73,100.5136],[13.7305,100.5143],[13.7313,100.5149],[13.7325,100.5155],[13.7353,100.5159],[13.738,100.5157],[13.7327,100.5292],[13.7229,100.5526],[13.7264,100.5523],[13.7484,100.5498],[13.7482,100.5539],[13.7481,100.554],[13.7482,100.5543],[13.7484,100.5587],[13.7482,100.561],[13.7478,100.5631],[13.7551,100.5648],[13.7553,100.5638],[13.7558,100.559],[13.7558,100.5568],[13.756,100.5559],[13.756,100.5551],[13.7561,100.5544],[13.7561,100.554],[13.7559,100.5539],[13.756,100.5531],[13.7559,100.5526],[13.7556,100.5524],[13.756,100.5524],[13.7566,100.5521],[13.7586,100.5505],[13.7597,100.548],[13.7598,100.5475],[13.7605,100.5471],[13.7605,100.546],[13.7614,100.5454],[13.7617,100.5446],[13.7624,100.5438],[13.7628,100.5431],[13.7637,100.5423],[13.764,100.5415],[13.7646,100.5409],[13.7648,100.5403],[13.7651,100.5402],[13.7654,100.54],[13.7656,100.5395],[13.7666,100.5381],[13.7668,100.5375],[13.7675,100.5371],[13.7677,100.5365],[13.7682,100.5362],[13.7686,100.5354],[13.7699,100.534],[13.7743,100.5278],[13.7976,100.5373],[13.7996,100.5331],[13.7982,100.5323],[13.7984,100.5308],[13.7988,100.5289],[13.7988,100.5281],[13.7986,100.527],[13.7993,100.5256],[13.7992,100.5249],[13.7996,100.5239],[13.7997,100.5229],[13.8,100.5223],[13.8,100.52]],"cen":[13.7615,100.5177]},{"n":"สมุทรปราการ","c":[[13.614,100.671],[13.6145,100.6652],[13.6143,100.6636],[13.6148,100.663],[13.6164,100.6621],[13.6168,100.6615],[13.617,100.6598],[13.6178,100.6578],[13.6181,100.6553],[13.6184,100.6542],[13.6192,100.6523],[13.6192,100.6512],[13.6198,100.6494],[13.6201,100.6476],[13.6215,100.6447],[13.6229,100.6409],[13.6235,100.6401],[13.6241,100.6383],[13.6249,100.6373],[13.6253,100.6367],[13.6257,100.6353],[13.6264,100.6342],[13.6272,100.6321],[13.628,100.6309],[13.6283,100.6297],[13.6296,100.628],[13.6297,100.6268],[13.6313,100.6239],[13.6318,100.6227],[13.632,100.6219],[13.6337,100.6198],[13.634,100.6185],[13.6354,100.6166],[13.6362,100.6148],[13.6377,100.6128],[13.6399,100.6085],[13.6408,100.6077],[13.6414,100.6069],[13.6427,100.604],[13.6439,100.6026],[13.6442,100.6016],[13.6445,100.6011],[13.6454,100.6004],[13.6463,100.5985],[13.6485,100.5955],[13.6485,100.5931],[13.6486,100.5927],[13.6489,100.5925],[13.6491,100.5926],[13.6495,100.5931],[13.65,100.5932],[13.6502,100.5922],[13.65,100.5918],[13.6498,100.5917],[13.6492,100.5918],[13.649,100.5916],[13.6495,100.5911],[13.6495,100.5905],[13.6498,100.5895],[13.6505,100.5887],[13.6505,100.588],[13.6507,100.5869],[13.6506,100.5861],[13.6511,100.5856],[13.6513,100.585],[13.652,100.5846],[13.6518,100.5837],[13.6522,100.5818],[13.6524,100.5815],[13.6524,100.5806],[13.6525,100.5801],[13.6528,100.5798],[13.653,100.5794],[13.6531,100.5786],[13.6527,100.5779],[13.6529,100.5777],[13.6532,100.5774],[13.6534,100.577],[13.6527,100.5763],[13.6528,100.5761],[13.6538,100.5758],[13.655,100.5748],[13.6554,100.5747],[13.6558,100.5752],[13.6559,100.5762],[13.6562,100.5763],[13.6576,100.575],[13.6585,100.574],[13.6577,100.5733],[13.6575,100.5726],[13.6568,100.5718],[13.6569,100.5716],[13.6613,100.5718],[13.6582,100.5676],[13.6567,100.5641],[13.6561,100.5619],[13.6557,100.5589],[13.6558,100.5576],[13.6561,100.5567],[13.658,100.5518],[13.6588,100.5502],[13.66,100.5464],[13.6608,100.5427],[13.6609,100.5407],[13.6604,100.5388],[13.6596,100.5377],[13.6586,100.5366],[13.6569,100.5356],[13.6534,100.5341],[13.6518,100.534],[13.6485,100.534],[13.6461,100.5343],[13.6422,100.5351],[13.6388,100.5361],[13.6358,100.5373],[13.627,100.5427],[13.6208,100.5481],[13.619,100.5499],[13.6166,100.5534],[13.614,100.5577],[13.6126,100.5613],[13.6118,100.5639],[13.6113,100.5665],[13.6111,100.5758],[13.6112,100.5795],[13.6107,100.5848],[13.61,100.5868],[13.6091,100.5887],[13.6074,100.5906],[13.6051,100.5915],[13.6023,100.592],[13.5978,100.5926],[13.5951,100.5922],[13.5923,100.5909],[13.5842,100.5862],[13.5768,100.5805],[13.573,100.5779],[13.5696,100.5766],[13.5623,100.5764],[13.5594,100.5769],[13.5571,100.5776],[13.5373,100.593],[13.5376,100.5958],[13.5376,100.5982],[13.5376,100.6041],[13.5374,100.6117],[13.5359,100.6152],[13.5355,100.6158],[13.5334,100.6181],[13.5323,100.6202],[13.5303,100.6221],[13.5271,100.6226],[13.5246,100.6216],[13.5241,100.6221],[13.5221,100.6234],[13.5212,100.6242],[13.5195,100.6264],[13.5175,100.6312],[13.5155,100.6349],[13.5136,100.6381],[13.5131,100.6398],[13.5116,100.6468],[13.5099,100.658],[13.5093,100.6597],[13.5058,100.6654],[13.5027,100.678],[13.5002,100.6929],[13.4965,100.7177],[13.4961,100.7294],[13.491,100.7675],[13.4845,100.8037],[13.4825,100.8175],[13.475,100.8396],[13.4735,100.8497],[13.4811,100.8506],[13.4867,100.8511],[13.4957,100.8521],[13.4876,100.8716],[13.4896,100.8717],[13.4904,100.8715],[13.4942,100.8725],[13.498,100.8722],[13.5002,100.8726],[13.502,100.8727],[13.5077,100.8726],[13.5087,100.8722],[13.5125,100.8716],[13.513,100.8716],[13.5163,100.8724],[13.5183,100.8735],[13.5199,100.874],[13.5206,100.8741],[13.5231,100.8722],[13.5237,100.8721],[13.5245,100.8723],[13.5255,100.8727],[13.527,100.8738],[13.5287,100.8745],[13.5344,100.8755],[13.5357,100.8761],[13.5385,100.877],[13.5423,100.8784],[13.547,100.8794],[13.548,100.8795],[13.5485,100.8799],[13.551,100.8835],[13.5517,100.8841],[13.5538,100.8849],[13.5571,100.8864],[13.5575,100.887],[13.5576,100.8891],[13.5578,100.8895],[13.5586,100.8898],[13.5595,100.8899],[13.562,100.8894],[13.5632,100.8893],[13.5644,100.8899],[13.5645,100.8902],[13.5716,100.8823],[13.5714,100.8803],[13.5714,100.8787],[13.5722,100.876],[13.5718,100.874],[13.5723,100.8724],[13.5729,100.8691],[13.5749,100.8626],[13.5764,100.8574],[13.5759,100.8553],[13.5759,100.8536],[13.5763,100.8531],[13.5776,100.8525],[13.5773,100.8509],[13.5772,100.8476],[13.5764,100.8463],[13.5761,100.8454],[13.5761,100.8443],[13.5757,100.8423],[13.5751,100.8414],[13.5744,100.8397],[13.5744,100.8376],[13.5733,100.8354],[13.574,100.8347],[13.5746,100.8344],[13.5752,100.8342],[13.5767,100.8342],[13.5776,100.8339],[13.578,100.8335],[13.5787,100.8323],[13.5784,100.8305],[13.5779,100.8299],[13.577,100.8293],[13.5763,100.8283],[13.5752,100.8261],[13.5753,100.8256],[13.576,100.8251],[13.5774,100.8237],[13.578,100.8228],[13.5781,100.8222],[13.578,100.8213],[13.5771,100.8203],[13.5768,100.8199],[13.5767,100.8191],[13.5769,100.8184],[13.5779,100.8176],[13.5783,100.817],[13.5792,100.8143],[13.5793,100.8133],[13.5802,100.8124],[13.5808,100.8116],[13.5812,100.8106],[13.5815,100.8084],[13.5839,100.8032],[13.5847,100.8024],[13.5854,100.8021],[13.5858,100.8023],[13.5866,100.8036],[13.5873,100.8042],[13.5879,100.8043],[13.5887,100.8039],[13.5902,100.7992],[13.5906,100.7991],[13.5908,100.7986],[13.5913,100.7965],[13.5924,100.7929],[13.593,100.7902],[13.593,100.7881],[13.5937,100.7845],[13.5938,100.7829],[13.5946,100.7805],[13.5957,100.7782],[13.5961,100.777],[13.5965,100.7745],[13.5967,100.7723],[13.597,100.7711],[13.5966,100.7667],[13.598,100.7615],[13.5984,100.7611],[13.5992,100.7601],[13.5994,100.7595],[13.5994,100.7588],[13.5997,100.7572],[13.5998,100.7558],[13.5996,100.7553],[13.599,100.7545],[13.5986,100.7535],[13.5986,100.7531],[13.5987,100.7517],[13.5991,100.7501],[13.5994,100.7481],[13.601,100.7461],[13.6017,100.7446],[13.6017,100.7432],[13.6012,100.7403],[13.6012,100.7385],[13.6015,100.736],[13.6018,100.7349],[13.6021,100.7326],[13.6022,100.7291],[13.6024,100.728],[13.6033,100.7203],[13.6031,100.7173],[13.6035,100.7132],[13.6034,100.7119],[13.6035,100.7105],[13.6041,100.7097],[13.6047,100.7095],[13.6055,100.7083],[13.6057,100.7078],[13.6057,100.7049],[13.6064,100.7025],[13.607,100.6983],[13.6076,100.6965],[13.6082,100.6939],[13.6088,100.6926],[13.6094,100.6905],[13.6096,100.6893],[13.61,100.6885],[13.6111,100.685],[13.6115,100.6819],[13.6128,100.6771],[13.6134,100.6758],[13.6141,100.6722],[13.614,100.671]],"cen":[13.5679,100.7315]},{"n":"ตากสิน","c":[[13.7293,100.5123],[13.731,100.5118],[13.7338,100.5106],[13.735,100.5096],[13.7357,100.5088],[13.7362,100.508],[13.737,100.5063],[13.7374,100.5049],[13.7387,100.4991],[13.7398,100.4954],[13.7406,100.4939],[13.7417,100.4926],[13.7425,100.4919],[13.7403,100.4899],[13.7383,100.4886],[13.7367,100.488],[13.7351,100.4872],[13.7332,100.4865],[13.7323,100.4863],[13.7284,100.4857],[13.7276,100.4855],[13.7249,100.4844],[13.7244,100.4836],[13.7232,100.4803],[13.7224,100.4761],[13.7226,100.4724],[13.7226,100.4713],[13.723,100.4705],[13.7225,100.4693],[13.7073,100.4262],[13.6996,100.4267],[13.6981,100.4265],[13.6945,100.4267],[13.6917,100.427],[13.6888,100.4276],[13.6803,100.4286],[13.6785,100.429],[13.6732,100.4296],[13.6675,100.43],[13.6186,100.3752],[13.6159,100.3753],[13.6136,100.3757],[13.6137,100.376],[13.6094,100.3763],[13.6098,100.3767],[13.6094,100.3771],[13.6067,100.3772],[13.6066,100.3771],[13.6026,100.3783],[13.5985,100.3805],[13.5938,100.3833],[13.5928,100.3815],[13.5919,100.381],[13.5912,100.3809],[13.591,100.3815],[13.5906,100.3818],[13.5903,100.3827],[13.5894,100.3835],[13.5892,100.3842],[13.5884,100.3845],[13.5877,100.3842],[13.5876,100.3844],[13.5876,100.3851],[13.5874,100.3853],[13.5869,100.3848],[13.5867,100.3849],[13.5864,100.3853],[13.5863,100.3853],[13.5861,100.3847],[13.5859,100.385],[13.5859,100.3857],[13.5856,100.3857],[13.5855,100.3853],[13.5852,100.3853],[13.5851,100.3861],[13.5848,100.3863],[13.5837,100.3863],[13.582,100.387],[13.5777,100.3877],[13.5757,100.3883],[13.5751,100.3886],[13.575,100.3889],[13.5742,100.3894],[13.5725,100.3898],[13.5717,100.3899],[13.5704,100.3906],[13.5689,100.3905],[13.5672,100.3909],[13.5654,100.3907],[13.5645,100.3911],[13.563,100.391],[13.5628,100.3913],[13.563,100.392],[13.5629,100.3922],[13.5625,100.3923],[13.5623,100.3927],[13.5617,100.3927],[13.5612,100.3932],[13.561,100.3931],[13.5607,100.3926],[13.5605,100.3925],[13.5603,100.3932],[13.5599,100.3928],[13.5596,100.3931],[13.5594,100.393],[13.5584,100.3933],[13.558,100.3943],[13.5578,100.394],[13.5575,100.3939],[13.5559,100.3942],[13.5557,100.3946],[13.5554,100.3948],[13.5549,100.3946],[13.5546,100.3946],[13.5545,100.3951],[13.5537,100.3952],[13.5535,100.3954],[13.5532,100.3958],[13.5532,100.3964],[13.5527,100.397],[13.5526,100.3981],[13.5529,100.3989],[13.5527,100.3991],[13.5524,100.3991],[13.5523,100.3995],[13.5526,100.4003],[13.5525,100.4012],[13.553,100.4017],[13.5529,100.4021],[13.5529,100.4026],[13.5532,100.4029],[13.5534,100.4034],[13.5551,100.4045],[13.5551,100.4048],[13.5546,100.4054],[13.5545,100.406],[13.5542,100.4064],[13.5543,100.4067],[13.5549,100.4072],[13.5547,100.4074],[13.5542,100.4084],[13.5547,100.4089],[13.5547,100.4097],[13.5549,100.4107],[13.5556,100.4122],[13.556,100.4122],[13.5563,100.412],[13.5566,100.412],[13.5569,100.4123],[13.5568,100.413],[13.5574,100.4134],[13.5573,100.4136],[13.5567,100.414],[13.5567,100.4143],[13.5571,100.415],[13.5561,100.4152],[13.5545,100.4147],[13.5539,100.4149],[13.5533,100.4149],[13.5524,100.4147],[13.5514,100.4144],[13.551,100.4148],[13.55,100.4167],[13.5488,100.4175],[13.5467,100.4194],[13.546,100.4198],[13.5443,100.42],[13.5435,100.4194],[13.5431,100.4193],[13.5426,100.4194],[13.5414,100.4187],[13.5409,100.4186],[13.5402,100.4178],[13.5392,100.4152],[13.5384,100.4146],[13.538,100.4149],[13.5367,100.4145],[13.5364,100.4139],[13.5358,100.4136],[13.5353,100.4126],[13.5314,100.4129],[13.529,100.4122],[13.5281,100.4118],[13.5275,100.4113],[13.5262,100.4111],[13.5258,100.4105],[13.5252,100.4105],[13.5247,100.4104],[13.5235,100.4087],[13.5216,100.408],[13.5212,100.4078],[13.5208,100.4072],[13.5204,100.4069],[13.5199,100.4067],[13.5189,100.4065],[13.5183,100.4066],[13.5078,100.4061],[13.5076,100.4063],[13.493,100.4097],[13.4929,100.4099],[13.4927,100.4106],[13.4935,100.4187],[13.4938,100.4239],[13.4943,100.4261],[13.4947,100.4274],[13.4951,100.4312],[13.4951,100.433],[13.4961,100.4393],[13.4961,100.4405],[13.4967,100.4421],[13.4976,100.4486],[13.4986,100.4513],[13.4986,100.4519],[13.4991,100.452],[13.4991,100.4523],[13.4993,100.4524],[13.4998,100.4536],[13.4997,100.4538],[13.509,100.452],[13.5297,100.4485],[13.5376,100.447],[13.5403,100.4466],[13.5408,100.4466],[13.5409,100.4464],[13.546,100.4456],[13.5491,100.445],[13.5541,100.4443],[13.5626,100.4448],[13.5824,100.4466],[13.5833,100.4466],[13.5848,100.4463],[13.5852,100.4463],[13.5863,100.4467],[13.5869,100.4465],[13.5873,100.4467],[13.5876,100.4473],[13.588,100.4476],[13.589,100.4475],[13.5893,100.4478],[13.5895,100.4483],[13.59,100.4485],[13.5903,100.4488],[13.5907,100.4491],[13.5912,100.4493],[13.5918,100.4491],[13.5924,100.4493],[13.5928,100.4493],[13.5935,100.4501],[13.5946,100.4509],[13.5953,100.4509],[13.5959,100.451],[13.5967,100.4509],[13.5976,100.4515],[13.5984,100.4522],[13.6004,100.4521],[13.6008,100.4523],[13.6016,100.4524],[13.6024,100.4527],[13.603,100.4533],[13.6044,100.4538],[13.6054,100.4536],[13.6059,100.4538],[13.606,100.4538],[13.606,100.4532],[13.6069,100.453],[13.6078,100.4524],[13.6094,100.4519],[13.6098,100.4517],[13.6105,100.4517],[13.6109,100.4513],[13.6114,100.4515],[13.6122,100.4512],[13.6146,100.4512],[13.615,100.4514],[13.6152,100.4514],[13.6157,100.4512],[13.6156,100.451],[13.6159,100.4506],[13.6167,100.4502],[13.6171,100.4503],[13.6181,100.4501],[13.6188,100.4502],[13.6201,100.45],[13.6204,100.4497],[13.6206,100.4497],[13.6215,100.4504],[13.6218,100.4504],[13.6219,100.4502],[13.6263,100.449],[13.6255,100.4724],[13.626,100.4729],[13.6268,100.4735],[13.6273,100.4744],[13.6278,100.4744],[13.6285,100.474],[13.6289,100.4741],[13.6292,100.4743],[13.6297,100.4754],[13.6302,100.4756],[13.6308,100.4756],[13.6321,100.4751],[13.6343,100.475],[13.6354,100.4747],[13.6396,100.4735],[13.6489,100.4724],[13.6548,100.4711],[13.6574,100.4707],[13.664,100.469],[13.669,100.4679],[13.6737,100.4666],[13.6741,100.4681],[13.675,100.4703],[13.6784,100.469],[13.6787,100.4702],[13.6791,100.4708],[13.6805,100.4703],[13.6824,100.4701],[13.683,100.4706],[13.6841,100.4701],[13.6864,100.4696],[13.6868,100.4691],[13.6878,100.4693],[13.6895,100.4686],[13.6899,100.4701],[13.6905,100.4716],[13.6905,100.4718],[13.6895,100.4723],[13.6884,100.4731],[13.6882,100.4737],[13.689,100.4749],[13.6903,100.4764],[13.6926,100.4798],[13.6929,100.4803],[13.6934,100.4821],[13.6945,100.4825],[13.6947,100.4827],[13.6948,100.4841],[13.6947,100.4853],[13.695,100.4866],[13.6948,100.4874],[13.6948,100.4899],[13.6967,100.4901],[13.6988,100.4907],[13.7001,100.4913],[13.7014,100.4925],[13.7029,100.4945],[13.7058,100.5],[13.7068,100.5018],[13.7083,100.5039],[13.7117,100.5075],[13.7146,100.5099],[13.716,100.5107],[13.7175,100.5115],[13.7211,100.5124],[13.7231,100.5127],[13.7253,100.5127],[13.7272,100.5126],[13.7293,100.5123]],"cen":[13.6176,100.4128]},{"n":"สุขุมวิท","c":[[13.7476,100.5652],[13.7482,100.561],[13.7484,100.5587],[13.7482,100.5543],[13.7481,100.554],[13.7482,100.5539],[13.7484,100.5498],[13.7264,100.5523],[13.7196,100.5529],[13.7187,100.5532],[13.7104,100.5541],[13.7099,100.554],[13.7092,100.5535],[13.7039,100.5481],[13.703,100.5477],[13.7022,100.5477],[13.7016,100.5479],[13.7002,100.5493],[13.6987,100.5514],[13.6991,100.5513],[13.7012,100.5517],[13.7029,100.5523],[13.7046,100.5538],[13.7057,100.5553],[13.7063,100.5569],[13.7064,100.5597],[13.7063,100.5611],[13.7057,100.5635],[13.705,100.5657],[13.7007,100.5767],[13.6986,100.581],[13.7029,100.5807],[13.7034,100.5808],[13.7049,100.5875],[13.7055,100.5896],[13.7061,100.5903],[13.7076,100.5911],[13.7088,100.5923],[13.7102,100.5966],[13.7107,100.5971],[13.7119,100.5978],[13.7122,100.5983],[13.712,100.5994],[13.7111,100.601],[13.7111,100.6014],[13.7116,100.6017],[13.7131,100.6019],[13.7135,100.6023],[13.7138,100.6032],[13.7142,100.6055],[13.7154,100.6065],[13.7159,100.6072],[13.7159,100.6088],[13.7155,100.6106],[13.7156,100.6117],[13.7155,100.6121],[13.7153,100.6122],[13.7131,100.6124],[13.7128,100.6126],[13.7126,100.6134],[13.7127,100.6139],[13.7132,100.6144],[13.7133,100.6148],[13.7132,100.6153],[13.713,100.6157],[13.7114,100.6164],[13.7107,100.6158],[13.7104,100.6158],[13.71,100.616],[13.7098,100.6164],[13.7106,100.6183],[13.7113,100.6188],[13.7115,100.6192],[13.7113,100.6201],[13.7104,100.6208],[13.7104,100.6213],[13.7123,100.6214],[13.7131,100.6221],[13.7142,100.6223],[13.7145,100.6225],[13.7145,100.6232],[13.7147,100.6238],[13.7147,100.6242],[13.7129,100.6248],[13.7128,100.6253],[13.7123,100.6258],[13.7129,100.6262],[13.7134,100.6269],[13.7144,100.628],[13.7151,100.6282],[13.7152,100.6289],[13.7155,100.6295],[13.7149,100.6321],[13.7146,100.6326],[13.7149,100.6335],[13.7149,100.6344],[13.7146,100.635],[13.7146,100.6357],[13.7147,100.6366],[13.7147,100.6376],[13.7149,100.6392],[13.7239,100.6733],[13.7241,100.6822],[13.7239,100.7089],[13.7317,100.7083],[13.7372,100.7087],[13.7379,100.7086],[13.7387,100.7088],[13.7393,100.7087],[13.7447,100.7091],[13.7479,100.7092],[13.7564,100.7097],[13.7564,100.7082],[13.7565,100.7071],[13.7567,100.7065],[13.7577,100.7069],[13.761,100.709],[13.7615,100.7094],[13.7624,100.7103],[13.7639,100.7112],[13.7653,100.7125],[13.7668,100.7131],[13.7715,100.7159],[13.7726,100.7162],[13.7772,100.7165],[13.7799,100.7155],[13.7815,100.7153],[13.7829,100.7147],[13.7982,100.7061],[13.7957,100.7015],[13.7877,100.6873],[13.7791,100.6714],[13.7737,100.6619],[13.7699,100.6548],[13.7659,100.6498],[13.7652,100.6483],[13.765,100.6474],[13.7635,100.6342],[13.7621,100.6208],[13.7617,100.6192],[13.7614,100.6163],[13.7607,100.6145],[13.7504,100.6034],[13.7474,100.6003],[13.743,100.5987],[13.7417,100.5986],[13.7407,100.5988],[13.741,100.5979],[13.7411,100.5971],[13.7433,100.5852],[13.7448,100.5792],[13.7454,100.576],[13.7457,100.5739],[13.7462,100.5722],[13.747,100.5676],[13.7476,100.5652]],"cen":[13.7484,100.6553]},{"n":"พญาไท","c":[[13.8566,100.5874],[13.8589,100.5864],[13.8584,100.5857],[13.8582,100.584],[13.8579,100.5835],[13.858,100.5815],[13.8574,100.5778],[13.8574,100.5762],[13.857,100.5749],[13.857,100.5736],[13.8566,100.5726],[13.8564,100.571],[13.8563,100.5689],[13.8558,100.5665],[13.8556,100.5662],[13.8557,100.5656],[13.8554,100.5653],[13.8554,100.5652],[13.8233,100.5479],[13.8166,100.5446],[13.815,100.544],[13.8126,100.5434],[13.8072,100.5412],[13.803,100.5398],[13.797,100.537],[13.7743,100.5278],[13.7699,100.534],[13.7686,100.5354],[13.7682,100.5362],[13.7677,100.5365],[13.7675,100.5371],[13.7668,100.5375],[13.7666,100.5381],[13.7656,100.5395],[13.7654,100.54],[13.7651,100.5402],[13.7648,100.5403],[13.7646,100.5409],[13.764,100.5415],[13.7637,100.5423],[13.7628,100.5431],[13.7624,100.5438],[13.7617,100.5446],[13.7614,100.5454],[13.7605,100.546],[13.7605,100.5471],[13.7598,100.5475],[13.7597,100.548],[13.7586,100.5505],[13.7566,100.5521],[13.756,100.5524],[13.7556,100.5524],[13.7559,100.5526],[13.756,100.5531],[13.7559,100.5539],[13.7561,100.554],[13.7561,100.5544],[13.756,100.5551],[13.756,100.5559],[13.7558,100.5568],[13.7558,100.559],[13.7553,100.5638],[13.7551,100.5648],[13.7478,100.5631],[13.7476,100.5652],[13.747,100.5676],[13.7462,100.5722],[13.7457,100.5739],[13.7454,100.576],[13.7448,100.5792],[13.7433,100.5852],[13.7411,100.5971],[13.741,100.5979],[13.7407,100.5988],[13.7417,100.5986],[13.743,100.5987],[13.7474,100.6003],[13.751,100.6041],[13.7522,100.6031],[13.7572,100.5978],[13.7604,100.596],[13.7624,100.5948],[13.7636,100.5946],[13.765,100.5948],[13.766,100.5947],[13.7686,100.5938],[13.7727,100.5931],[13.7743,100.5931],[13.7769,100.5935],[13.7793,100.5935],[13.7797,100.5933],[13.7816,100.592],[13.7836,100.5914],[13.7864,100.5901],[13.7872,100.59],[13.7894,100.59],[13.7917,100.5894],[13.7962,100.5893],[13.7982,100.5891],[13.8004,100.589],[13.8016,100.5888],[13.803,100.5883],[13.8043,100.5887],[13.8085,100.5887],[13.8105,100.589],[13.8121,100.5884],[13.8127,100.5885],[13.8137,100.5889],[13.8149,100.5889],[13.8162,100.5893],[13.8178,100.5895],[13.8195,100.5892],[13.8225,100.5893],[13.8241,100.589],[13.8259,100.5895],[13.829,100.5899],[13.8318,100.5898],[13.8334,100.59],[13.8359,100.5907],[13.8376,100.591],[13.839,100.5908],[13.8407,100.5903],[13.844,100.5897],[13.8463,100.5888],[13.85,100.5882],[13.8521,100.5876],[13.8566,100.5874]],"cen":[13.7997,100.5636]},{"n":"ลาดพร้าว","c":[[13.8505,100.6785],[13.8515,100.677],[13.8522,100.6738],[13.8523,100.6716],[13.8525,100.6709],[13.8527,100.6708],[13.8524,100.6698],[13.8516,100.6684],[13.8512,100.668],[13.8509,100.6674],[13.8505,100.6657],[13.8506,100.6651],[13.8505,100.6634],[13.85,100.6619],[13.8498,100.6615],[13.8491,100.6612],[13.8488,100.6593],[13.8486,100.6592],[13.8486,100.6589],[13.8477,100.6587],[13.8478,100.6565],[13.8474,100.6555],[13.8468,100.6531],[13.8469,100.6521],[13.8464,100.65],[13.8462,100.6485],[13.8474,100.6462],[13.8466,100.6409],[13.8462,100.6394],[13.8457,100.6386],[13.8448,100.6373],[13.8436,100.6367],[13.8439,100.636],[13.8425,100.633],[13.8427,100.6311],[13.8426,100.6287],[13.8431,100.6284],[13.8435,100.6278],[13.8458,100.6235],[13.8466,100.6227],[13.8472,100.6217],[13.8481,100.6208],[13.8484,100.6196],[13.8491,100.614],[13.8491,100.6086],[13.8492,100.6069],[13.8489,100.6058],[13.8481,100.6043],[13.8468,100.6023],[13.8463,100.5987],[13.8461,100.5976],[13.8458,100.5969],[13.8457,100.5957],[13.8453,100.594],[13.8441,100.5909],[13.8438,100.5897],[13.8407,100.5903],[13.839,100.5908],[13.8373,100.591],[13.8323,100.5898],[13.829,100.5899],[13.8259,100.5895],[13.8241,100.589],[13.8225,100.5893],[13.8195,100.5892],[13.8178,100.5895],[13.8162,100.5893],[13.8149,100.5889],[13.8137,100.5889],[13.8125,100.5885],[13.8118,100.5885],[13.8105,100.589],[13.81,100.589],[13.8085,100.5887],[13.8043,100.5887],[13.803,100.5883],[13.8016,100.5888],[13.8004,100.589],[13.7982,100.5891],[13.7962,100.5893],[13.7917,100.5894],[13.7894,100.59],[13.7872,100.59],[13.7864,100.5901],[13.7836,100.5914],[13.7816,100.592],[13.7797,100.5933],[13.7793,100.5935],[13.7769,100.5935],[13.7743,100.5931],[13.7727,100.5931],[13.7686,100.5938],[13.766,100.5947],[13.765,100.5948],[13.7636,100.5946],[13.7624,100.5948],[13.7604,100.596],[13.7572,100.5978],[13.7522,100.6031],[13.751,100.6041],[13.7587,100.6125],[13.7605,100.6142],[13.7612,100.6156],[13.7615,100.6167],[13.7617,100.6192],[13.7621,100.6211],[13.7623,100.6242],[13.765,100.6474],[13.7656,100.6493],[13.7699,100.6548],[13.7737,100.6619],[13.7976,100.7049],[13.8046,100.7005],[13.806,100.7015],[13.807,100.702],[13.8079,100.7021],[13.8091,100.7018],[13.8095,100.7014],[13.8105,100.6997],[13.8119,100.698],[13.8126,100.6975],[13.8136,100.6971],[13.8151,100.6967],[13.817,100.6965],[13.8202,100.6969],[13.8208,100.6961],[13.8216,100.6956],[13.8222,100.6954],[13.8232,100.6954],[13.8242,100.6952],[13.8248,100.6948],[13.8301,100.6919],[13.8309,100.6909],[13.8324,100.6905],[13.8329,100.6901],[13.8347,100.6878],[13.835,100.6878],[13.836,100.6883],[13.8382,100.6878],[13.8386,100.6877],[13.8402,100.6868],[13.8417,100.6864],[13.8437,100.686],[13.8451,100.6855],[13.8468,100.6843],[13.848,100.6838],[13.8483,100.6835],[13.8491,100.6823],[13.8502,100.6801],[13.8505,100.6785]],"cen":[13.8019,100.6454]},{"n":"ประชาชื่น","c":[[13.9271,100.6265],[13.9505,100.6223],[13.9516,100.6193],[13.9535,100.616],[13.9543,100.614],[13.9537,100.6045],[13.9515,100.6048],[13.9505,100.6048],[13.9484,100.6052],[13.9441,100.6058],[13.9457,100.6019],[13.9483,100.5965],[13.9495,100.5932],[13.9503,100.5915],[13.951,100.5893],[13.9546,100.5739],[13.9544,100.5732],[13.9518,100.5687],[13.9515,100.5678],[13.8498,100.5438],[13.8499,100.5435],[13.8495,100.5434],[13.8475,100.5386],[13.8467,100.5374],[13.8462,100.5362],[13.8451,100.535],[13.8442,100.5339],[13.8424,100.532],[13.8417,100.531],[13.8398,100.5291],[13.8344,100.5228],[13.8339,100.5223],[13.8329,100.5212],[13.8307,100.5188],[13.8286,100.5159],[13.8276,100.5158],[13.8271,100.5154],[13.8269,100.5147],[13.8262,100.5132],[13.8247,100.5131],[13.8247,100.5128],[13.8249,100.5126],[13.8259,100.5121],[13.8261,100.5118],[13.8262,100.511],[13.8253,100.5108],[13.8252,100.5107],[13.8255,100.5093],[13.8252,100.5092],[13.8248,100.5093],[13.8246,100.5096],[13.8245,100.5101],[13.8242,100.5101],[13.8236,100.5096],[13.8234,100.5087],[13.8228,100.5077],[13.8224,100.5076],[13.8215,100.5076],[13.8212,100.5072],[13.8194,100.5064],[13.819,100.5063],[13.8161,100.5075],[13.8141,100.5142],[13.8132,100.5152],[13.8113,100.5166],[13.8102,100.5171],[13.805,100.5176],[13.8016,100.517],[13.8002,100.5164],[13.8002,100.5194],[13.7999,100.5208],[13.8,100.5223],[13.7997,100.5229],[13.7996,100.5239],[13.7992,100.5249],[13.7993,100.5256],[13.7987,100.5268],[13.7988,100.5289],[13.7984,100.5308],[13.7982,100.5323],[13.7996,100.5331],[13.7976,100.5373],[13.7975,100.5373],[13.803,100.5398],[13.8072,100.5412],[13.8126,100.5434],[13.815,100.544],[13.8171,100.5448],[13.8233,100.5479],[13.8554,100.5652],[13.8554,100.5653],[13.8557,100.5656],[13.8556,100.5662],[13.8558,100.5665],[13.8563,100.5689],[13.8564,100.571],[13.8566,100.5726],[13.857,100.5736],[13.857,100.5749],[13.8574,100.5762],[13.8574,100.5778],[13.858,100.5815],[13.8579,100.5835],[13.8582,100.584],[13.8584,100.5857],[13.8589,100.5864],[13.8786,100.5879],[13.8797,100.5881],[13.8804,100.5884],[13.8816,100.5893],[13.8885,100.5955],[13.8911,100.5988],[13.8955,100.6057],[13.8971,100.607],[13.8977,100.6077],[13.8998,100.611],[13.9261,100.6264],[13.9271,100.6265]],"cen":[13.8765,100.5689]}];
const TUR_REGION_OUTLINE = [[[[13.6933,100.49],[13.6953,100.4899],[13.6976,100.4903],[13.6994,100.4909],[13.7007,100.4918],[13.7019,100.493],[13.7029,100.4945],[13.7058,100.5],[13.7083,100.5039],[13.7128,100.5085],[13.716,100.5107],[13.7175,100.5115],[13.7193,100.512],[13.7231,100.5127],[13.7272,100.5127],[13.7293,100.5123],[13.73,100.5136],[13.7305,100.5143],[13.7313,100.5149],[13.7325,100.5155],[13.7353,100.5159],[13.7381,100.5157],[13.7327,100.5292],[13.7229,100.5526],[13.7264,100.5523],[13.7484,100.5498],[13.7482,100.5539],[13.7481,100.554],[13.7482,100.5543],[13.7484,100.5587],[13.7482,100.561],[13.7462,100.5722],[13.7457,100.5739],[13.7448,100.5792],[13.7433,100.5852],[13.7411,100.5971],[13.7411,100.5979],[13.7407,100.5987],[13.743,100.5987],[13.7474,100.6003],[13.7607,100.6145],[13.7614,100.6163],[13.7617,100.6192],[13.7621,100.6208],[13.7635,100.6342],[13.765,100.6474],[13.7652,100.6483],[13.7659,100.6498],[13.7699,100.6549],[13.7982,100.7061],[13.7829,100.7147],[13.7815,100.7153],[13.7799,100.7155],[13.777,100.7166],[13.7726,100.7162],[13.7715,100.7159],[13.7668,100.7131],[13.7653,100.7125],[13.7639,100.7112],[13.7624,100.7103],[13.7615,100.7094],[13.7577,100.7069],[13.7568,100.7065],[13.7565,100.7071],[13.7564,100.7082],[13.7564,100.7097],[13.7307,100.7083],[13.7241,100.7089],[13.7061,100.7115],[13.7013,100.7123],[13.7012,100.711],[13.6952,100.7099],[13.6951,100.7102],[13.6913,100.7098],[13.6883,100.709],[13.6877,100.7086],[13.6847,100.7073],[13.6786,100.7064],[13.6788,100.7055],[13.6746,100.7046],[13.6744,100.7052],[13.6717,100.7041],[13.6641,100.6998],[13.6627,100.6993],[13.6586,100.6985],[13.6536,100.698],[13.6546,100.6932],[13.6519,100.6928],[13.6514,100.6929],[13.6513,100.6924],[13.6506,100.6924],[13.6513,100.6892],[13.6501,100.6884],[13.6482,100.688],[13.6478,100.687],[13.6467,100.6866],[13.6464,100.686],[13.6433,100.6828],[13.6422,100.6823],[13.639,100.6815],[13.6365,100.6806],[13.6341,100.679],[13.631,100.6786],[13.6273,100.6784],[13.6268,100.6781],[13.626,100.6754],[13.6235,100.6758],[13.6229,100.6756],[13.6223,100.6752],[13.6218,100.6753],[13.6205,100.6747],[13.6188,100.6724],[13.6158,100.6716],[13.6149,100.6715],[13.614,100.6711],[13.614,100.6722],[13.6134,100.6758],[13.6128,100.6771],[13.6115,100.6819],[13.6111,100.685],[13.6101,100.6885],[13.6096,100.6893],[13.6094,100.6905],[13.6088,100.6926],[13.6082,100.6939],[13.6077,100.6965],[13.607,100.6983],[13.6064,100.7025],[13.6057,100.7049],[13.6057,100.7078],[13.6047,100.7095],[13.6041,100.7097],[13.6034,100.7105],[13.6034,100.7119],[13.6035,100.7132],[13.6031,100.7173],[13.6033,100.7203],[13.6024,100.728],[13.6022,100.7291],[13.6021,100.7326],[13.6018,100.7349],[13.6015,100.736],[13.6012,100.7385],[13.6012,100.7403],[13.6017,100.7432],[13.6017,100.7446],[13.601,100.7461],[13.5994,100.7481],[13.5991,100.7501],[13.5987,100.7517],[13.5986,100.7535],[13.599,100.7545],[13.5998,100.7558],[13.5994,100.7595],[13.5992,100.7601],[13.598,100.7615],[13.5966,100.7667],[13.597,100.7711],[13.5967,100.7723],[13.5961,100.777],[13.5946,100.7804],[13.5938,100.7829],[13.5937,100.7846],[13.593,100.7881],[13.593,100.7902],[13.5924,100.7929],[13.5913,100.7965],[13.5908,100.7986],[13.5907,100.799],[13.5902,100.7992],[13.5887,100.8039],[13.5879,100.8043],[13.5873,100.8042],[13.5866,100.8036],[13.5857,100.8023],[13.5854,100.8021],[13.5847,100.8024],[13.5839,100.8032],[13.5815,100.8084],[13.5812,100.8105],[13.5808,100.8116],[13.5802,100.8124],[13.5793,100.8133],[13.5792,100.8142],[13.5783,100.817],[13.5779,100.8176],[13.5769,100.8184],[13.5767,100.819],[13.5768,100.8198],[13.5771,100.8203],[13.578,100.8213],[13.5781,100.8222],[13.578,100.8228],[13.5774,100.8237],[13.576,100.8251],[13.5753,100.8256],[13.5752,100.8261],[13.5763,100.8283],[13.577,100.8293],[13.5779,100.8299],[13.5783,100.8305],[13.5787,100.8323],[13.578,100.8335],[13.5776,100.8339],[13.5767,100.8342],[13.5746,100.8344],[13.574,100.8347],[13.5733,100.8355],[13.5744,100.8376],[13.5743,100.8398],[13.5751,100.8414],[13.5757,100.8423],[13.5761,100.8443],[13.5761,100.8454],[13.5764,100.8463],[13.5772,100.8476],[13.5773,100.8509],[13.5776,100.8525],[13.5763,100.8531],[13.5759,100.8536],[13.5759,100.8553],[13.5764,100.8574],[13.5749,100.8626],[13.5729,100.8691],[13.5723,100.8724],[13.5718,100.874],[13.5722,100.876],[13.5714,100.8787],[13.5716,100.8823],[13.5645,100.8902],[13.5644,100.8899],[13.5632,100.8893],[13.562,100.8894],[13.5595,100.8899],[13.5586,100.8898],[13.5578,100.8895],[13.5576,100.8891],[13.5575,100.887],[13.5571,100.8864],[13.5517,100.8841],[13.551,100.8835],[13.5485,100.8799],[13.548,100.8795],[13.5423,100.8784],[13.5385,100.877],[13.5357,100.8761],[13.5344,100.8755],[13.5286,100.8745],[13.527,100.8738],[13.5255,100.8727],[13.5245,100.8723],[13.5237,100.8721],[13.5231,100.8722],[13.5206,100.8741],[13.5199,100.874],[13.5183,100.8735],[13.5163,100.8724],[13.513,100.8716],[13.5087,100.8722],[13.5077,100.8726],[13.502,100.8727],[13.5002,100.8726],[13.498,100.8722],[13.4942,100.8725],[13.4904,100.8715],[13.4896,100.8717],[13.4876,100.8716],[13.4956,100.8521],[13.4735,100.8497],[13.475,100.8396],[13.4825,100.8175],[13.4845,100.8037],[13.491,100.7675],[13.4961,100.7294],[13.4965,100.7177],[13.5002,100.6929],[13.5027,100.678],[13.5058,100.6654],[13.5093,100.6597],[13.5099,100.658],[13.5116,100.6468],[13.5131,100.6397],[13.5136,100.6381],[13.5155,100.6349],[13.5175,100.6312],[13.5195,100.6264],[13.5212,100.6242],[13.5221,100.6234],[13.5246,100.6216],[13.5271,100.6226],[13.5303,100.6221],[13.5323,100.6202],[13.5334,100.6181],[13.5359,100.6152],[13.5374,100.6117],[13.5377,100.6041],[13.5376,100.5982],[13.5376,100.5958],[13.5373,100.593],[13.5571,100.5776],[13.5594,100.5769],[13.5623,100.5764],[13.5696,100.5766],[13.573,100.5779],[13.5768,100.5805],[13.5842,100.5862],[13.5923,100.5909],[13.5951,100.5922],[13.5978,100.5926],[13.6051,100.5915],[13.6073,100.5906],[13.6091,100.5887],[13.61,100.5868],[13.6107,100.5848],[13.6112,100.5795],[13.611,100.5758],[13.6113,100.5665],[13.6118,100.5639],[13.6126,100.5613],[13.614,100.5577],[13.6166,100.5534],[13.619,100.5499],[13.6208,100.5481],[13.627,100.5427],[13.6358,100.5373],[13.6388,100.5361],[13.6422,100.5351],[13.6461,100.5343],[13.6485,100.534],[13.653,100.5341],[13.654,100.5344],[13.6569,100.5356],[13.6586,100.5366],[13.6597,100.5377],[13.6604,100.5388],[13.6609,100.5407],[13.6609,100.5415],[13.6604,100.545],[13.6596,100.548],[13.6588,100.5502],[13.6561,100.5567],[13.6558,100.5589],[13.6561,100.5619],[13.6567,100.5641],[13.6582,100.5676],[13.6613,100.5718],[13.6642,100.5748],[13.6674,100.5776],[13.6746,100.5836],[13.681,100.5884],[13.6822,100.589],[13.6849,100.5897],[13.6885,100.5893],[13.6911,100.5888],[13.6965,100.5835],[13.6986,100.581],[13.7007,100.5767],[13.7022,100.573],[13.7057,100.5635],[13.7063,100.5611],[13.7064,100.5597],[13.7063,100.5569],[13.7057,100.5553],[13.7046,100.5538],[13.7029,100.5523],[13.7012,100.5517],[13.6991,100.5513],[13.6971,100.5515],[13.6906,100.5526],[13.6859,100.5527],[13.6823,100.5525],[13.678,100.5514],[13.6772,100.551],[13.6749,100.5492],[13.6738,100.5485],[13.6718,100.5468],[13.6709,100.5451],[13.6694,100.5418],[13.6692,100.5406],[13.6691,100.5382],[13.6698,100.5349],[13.6716,100.5309],[13.6832,100.5171],[13.6844,100.5134],[13.6854,100.5064],[13.687,100.4985],[13.6888,100.4946],[13.6903,100.4924],[13.6917,100.4909],[13.6933,100.49]]],[[[13.7599,100.4891],[13.7617,100.4905],[13.7656,100.4948],[13.7675,100.4963],[13.7701,100.4979],[13.7791,100.5015],[13.7845,100.5042],[13.7924,100.5114],[13.7945,100.5131],[13.7973,100.5151],[13.8002,100.5164],[13.8,100.5223],[13.7992,100.5249],[13.7993,100.5256],[13.7987,100.5268],[13.7988,100.5288],[13.7982,100.5323],[13.7996,100.5331],[13.7976,100.5373],[13.803,100.5398],[13.8071,100.5412],[13.8126,100.5433],[13.815,100.544],[13.8166,100.5446],[13.8233,100.5479],[13.8381,100.5558],[13.8554,100.5652],[13.8557,100.5656],[13.8556,100.5662],[13.8563,100.5689],[13.8564,100.571],[13.8566,100.5725],[13.857,100.5736],[13.857,100.5749],[13.8574,100.5762],[13.8574,100.5778],[13.8579,100.5815],[13.8579,100.5835],[13.8582,100.584],[13.8584,100.5857],[13.8589,100.5864],[13.8566,100.5874],[13.8521,100.5876],[13.85,100.5882],[13.8463,100.5888],[13.8438,100.5898],[13.8441,100.5909],[13.8453,100.594],[13.8458,100.5969],[13.8461,100.5976],[13.8463,100.5986],[13.8468,100.6023],[13.8481,100.6043],[13.8492,100.6069],[13.8491,100.6086],[13.8491,100.614],[13.8484,100.6196],[13.8481,100.6208],[13.8472,100.6217],[13.8466,100.6227],[13.8458,100.6235],[13.8435,100.6278],[13.8426,100.6287],[13.8427,100.6311],[13.8425,100.633],[13.8439,100.636],[13.8436,100.6367],[13.8448,100.6373],[13.8457,100.6386],[13.8462,100.6394],[13.8466,100.6409],[13.8474,100.6462],[13.8462,100.6485],[13.8464,100.65],[13.8469,100.6521],[13.8468,100.6531],[13.8478,100.6565],[13.8478,100.6586],[13.8486,100.6589],[13.8486,100.6592],[13.8488,100.6593],[13.8491,100.6612],[13.8498,100.6615],[13.85,100.6619],[13.8505,100.6634],[13.8505,100.6657],[13.8509,100.6674],[13.8511,100.668],[13.8516,100.6684],[13.8524,100.6698],[13.8527,100.6708],[13.8525,100.6709],[13.8523,100.6716],[13.8522,100.6738],[13.8515,100.6769],[13.8504,100.6787],[13.8502,100.6801],[13.8491,100.6823],[13.848,100.6838],[13.8468,100.6843],[13.8451,100.6855],[13.8437,100.686],[13.8417,100.6864],[13.8402,100.6868],[13.8382,100.6878],[13.836,100.6883],[13.835,100.6878],[13.8347,100.6878],[13.8324,100.6905],[13.8309,100.6909],[13.8301,100.6919],[13.8242,100.6952],[13.8232,100.6954],[13.8222,100.6954],[13.8216,100.6956],[13.8208,100.6961],[13.8202,100.6969],[13.817,100.6965],[13.8151,100.6968],[13.8136,100.6971],[13.8126,100.6975],[13.8119,100.6981],[13.8106,100.6997],[13.8095,100.7014],[13.8091,100.7018],[13.8079,100.7021],[13.807,100.702],[13.806,100.7015],[13.8046,100.7005],[13.7976,100.7049],[13.7699,100.6549],[13.7659,100.6498],[13.7652,100.6483],[13.765,100.6474],[13.7635,100.6342],[13.7621,100.6208],[13.7617,100.6192],[13.7614,100.6163],[13.7607,100.6145],[13.7474,100.6003],[13.743,100.5987],[13.7407,100.5988],[13.7411,100.5979],[13.7411,100.5971],[13.7433,100.5852],[13.7448,100.5792],[13.7457,100.5739],[13.7462,100.5722],[13.7482,100.561],[13.7484,100.5587],[13.7482,100.5543],[13.7481,100.554],[13.7482,100.5539],[13.7484,100.5499],[13.7229,100.5526],[13.7327,100.5292],[13.738,100.5157],[13.7353,100.5159],[13.7325,100.5155],[13.7313,100.5149],[13.7305,100.5143],[13.73,100.5136],[13.7293,100.5123],[13.7311,100.5118],[13.7338,100.5106],[13.7357,100.5088],[13.737,100.5063],[13.7387,100.4991],[13.7401,100.4949],[13.7406,100.4939],[13.7417,100.4926],[13.7442,100.4905],[13.746,100.4892],[13.7476,100.4883],[13.7497,100.4878],[13.7523,100.4876],[13.7546,100.4876],[13.7571,100.488],[13.7599,100.4891]]],[[[13.819,100.5063],[13.8194,100.5064],[13.8211,100.5071],[13.8215,100.5076],[13.8228,100.5077],[13.8234,100.5087],[13.8236,100.5096],[13.8242,100.5101],[13.8245,100.5101],[13.8246,100.5096],[13.8248,100.5093],[13.8255,100.5093],[13.8252,100.5107],[13.8262,100.511],[13.8261,100.5118],[13.8259,100.5121],[13.8249,100.5126],[13.8247,100.5131],[13.8262,100.5132],[13.8271,100.5154],[13.8276,100.5158],[13.8286,100.5159],[13.8307,100.5188],[13.8339,100.5223],[13.8344,100.5228],[13.8398,100.5291],[13.8417,100.531],[13.8424,100.532],[13.8442,100.5338],[13.8451,100.535],[13.8462,100.5362],[13.8466,100.5374],[13.8475,100.5386],[13.8495,100.5433],[13.8499,100.5435],[13.8499,100.5438],[13.9515,100.5677],[13.9518,100.5687],[13.9544,100.5732],[13.9546,100.5739],[13.951,100.5893],[13.9503,100.5915],[13.9483,100.5965],[13.9457,100.6019],[13.9441,100.6057],[13.9537,100.6045],[13.9543,100.614],[13.9534,100.616],[13.9516,100.6194],[13.9505,100.6224],[13.9487,100.6252],[13.935,100.626],[13.9344,100.6399],[13.9322,100.64],[13.9318,100.6405],[13.9314,100.6418],[13.9313,100.6471],[13.9312,100.6479],[13.9312,100.6502],[13.9306,100.659],[13.9308,100.6615],[13.9305,100.6636],[13.9305,100.6683],[13.9309,100.6782],[13.9308,100.6818],[13.931,100.6863],[13.9308,100.6892],[13.931,100.6899],[13.9259,100.6894],[13.9249,100.6887],[13.9238,100.6886],[13.923,100.688],[13.9214,100.6873],[13.9205,100.6872],[13.9191,100.6873],[13.9189,100.6924],[13.9195,100.7028],[13.9201,100.7078],[13.9224,100.7181],[13.924,100.7277],[13.924,100.7327],[13.9258,100.7471],[13.9278,100.7596],[13.931,100.7918],[13.9327,100.7995],[13.9369,100.8208],[13.9366,100.8208],[13.9396,100.8337],[13.941,100.8433],[13.9436,100.8648],[13.9486,100.914],[13.9447,100.9141],[13.9062,100.9091],[13.8958,100.9079],[13.8806,100.9064],[13.8702,100.9062],[13.8658,100.9064],[13.8605,100.9063],[13.8598,100.9057],[13.8591,100.9055],[13.8589,100.9047],[13.8541,100.9034],[13.8489,100.9022],[13.8477,100.9081],[13.8474,100.909],[13.8468,100.9128],[13.8446,100.9115],[13.8437,100.9107],[13.8415,100.9091],[13.8381,100.9078],[13.8144,100.9386],[13.8029,100.9297],[13.8014,100.9289],[13.7948,100.9175],[13.7909,100.9104],[13.79,100.9096],[13.7665,100.8965],[13.7542,100.8894],[13.7294,100.8736],[13.7022,100.8567],[13.6994,100.8552],[13.6904,100.8763],[13.689,100.8801],[13.6842,100.8946],[13.6754,100.9186],[13.6635,100.9526],[13.6619,100.9576],[13.6599,100.9568],[13.6589,100.9561],[13.6581,100.9548],[13.657,100.9549],[13.6561,100.9547],[13.6553,100.9526],[13.6529,100.9527],[13.6483,100.9536],[13.647,100.954],[13.6455,100.9586],[13.6448,100.9623],[13.6441,100.9651],[13.6376,100.9628],[13.633,100.9611],[13.6315,100.9601],[13.6236,100.9516],[13.6165,100.9443],[13.6104,100.939],[13.5993,100.9305],[13.5975,100.9281],[13.5931,100.9245],[13.5946,100.9207],[13.5948,100.9194],[13.5946,100.9184],[13.5927,100.9147],[13.5923,100.9137],[13.5922,100.913],[13.5928,100.9097],[13.5926,100.9085],[13.592,100.9073],[13.5872,100.9067],[13.5856,100.9067],[13.5833,100.9071],[13.5807,100.907],[13.5803,100.9086],[13.5799,100.9095],[13.5784,100.9123],[13.5776,100.9134],[13.5767,100.914],[13.5732,100.9151],[13.5713,100.9152],[13.5692,100.9139],[13.5673,100.9118],[13.5652,100.9111],[13.5631,100.9091],[13.5617,100.9081],[13.5604,100.9077],[13.5589,100.9066],[13.5566,100.9052],[13.5541,100.9041],[13.5615,100.8938],[13.5641,100.8909],[13.5645,100.8902],[13.5716,100.8823],[13.5714,100.8787],[13.5722,100.876],[13.5718,100.874],[13.5723,100.8724],[13.5729,100.8691],[13.5749,100.8626],[13.5764,100.8574],[13.5759,100.8553],[13.5759,100.8536],[13.5763,100.8531],[13.5776,100.8524],[13.5773,100.8509],[13.5772,100.8476],[13.5764,100.8463],[13.5761,100.8454],[13.5761,100.8443],[13.5757,100.8423],[13.5751,100.8414],[13.5743,100.8398],[13.5744,100.8376],[13.5733,100.8354],[13.574,100.8347],[13.5746,100.8344],[13.5767,100.8342],[13.5776,100.8339],[13.578,100.8335],[13.5787,100.8323],[13.5783,100.8305],[13.5779,100.8299],[13.577,100.8293],[13.5763,100.8283],[13.5752,100.8261],[13.5753,100.8256],[13.576,100.8251],[13.5774,100.8237],[13.578,100.8228],[13.5781,100.8222],[13.578,100.8213],[13.5771,100.8203],[13.5768,100.8198],[13.5767,100.8191],[13.5769,100.8184],[13.5779,100.8176],[13.5783,100.817],[13.5792,100.8142],[13.5793,100.8133],[13.5802,100.8124],[13.5808,100.8116],[13.5812,100.8105],[13.5815,100.8084],[13.5839,100.8032],[13.5847,100.8024],[13.5854,100.8021],[13.5857,100.8023],[13.5866,100.8036],[13.5873,100.8042],[13.5879,100.8043],[13.5887,100.8039],[13.5902,100.7992],[13.5906,100.7991],[13.5908,100.7986],[13.5913,100.7965],[13.5924,100.7929],[13.593,100.7902],[13.593,100.7881],[13.5937,100.7846],[13.5938,100.7829],[13.5946,100.7804],[13.5961,100.777],[13.5967,100.7723],[13.597,100.7711],[13.5966,100.7667],[13.598,100.7615],[13.5992,100.7601],[13.5994,100.7595],[13.5998,100.7558],[13.599,100.7545],[13.5986,100.7535],[13.5987,100.7517],[13.5991,100.7501],[13.5994,100.7481],[13.601,100.7461],[13.6017,100.7446],[13.6017,100.7432],[13.6012,100.7403],[13.6012,100.7385],[13.6015,100.736],[13.6018,100.7349],[13.6021,100.7326],[13.6022,100.7291],[13.6024,100.728],[13.6033,100.7203],[13.6031,100.7173],[13.6035,100.7132],[13.6034,100.7119],[13.6034,100.7105],[13.6041,100.7097],[13.6047,100.7095],[13.6057,100.7078],[13.6057,100.7049],[13.6064,100.7025],[13.607,100.6983],[13.6077,100.6965],[13.6082,100.6939],[13.6088,100.6926],[13.6094,100.6905],[13.6096,100.6893],[13.6101,100.6885],[13.6111,100.685],[13.6115,100.6819],[13.6128,100.6771],[13.6134,100.6758],[13.614,100.6722],[13.614,100.671],[13.6149,100.6715],[13.6158,100.6716],[13.6188,100.6724],[13.6205,100.6747],[13.6218,100.6753],[13.6223,100.6752],[13.6229,100.6756],[13.6235,100.6758],[13.626,100.6754],[13.6268,100.6781],[13.6273,100.6784],[13.631,100.6786],[13.6341,100.679],[13.6365,100.6806],[13.639,100.6815],[13.6422,100.6823],[13.6433,100.6828],[13.6464,100.686],[13.6467,100.6866],[13.6478,100.687],[13.6483,100.688],[13.6501,100.6884],[13.6513,100.6892],[13.6507,100.6924],[13.6513,100.6924],[13.6514,100.6928],[13.6519,100.6928],[13.6546,100.6932],[13.6536,100.698],[13.6586,100.6985],[13.6627,100.6993],[13.6641,100.6998],[13.6725,100.7045],[13.6744,100.7052],[13.6746,100.7046],[13.6788,100.7055],[13.6787,100.7064],[13.6847,100.7073],[13.6878,100.7086],[13.6883,100.709],[13.6913,100.7098],[13.6951,100.7102],[13.6952,100.7099],[13.7012,100.711],[13.7013,100.7123],[13.7061,100.7115],[13.724,100.7089],[13.7307,100.7083],[13.7564,100.7097],[13.7564,100.7082],[13.7567,100.7065],[13.7577,100.7069],[13.761,100.709],[13.7624,100.7103],[13.7639,100.7112],[13.7653,100.7125],[13.7668,100.7131],[13.7715,100.7159],[13.7726,100.7162],[13.777,100.7166],[13.7799,100.7155],[13.7815,100.7153],[13.7829,100.7147],[13.7982,100.7061],[13.7976,100.7049],[13.8044,100.7005],[13.8047,100.7004],[13.8054,100.7011],[13.807,100.702],[13.8079,100.7021],[13.8089,100.7018],[13.8095,100.7014],[13.8112,100.6987],[13.8126,100.6975],[13.8147,100.6968],[13.8165,100.6966],[13.8173,100.6965],[13.8203,100.6969],[13.8208,100.6961],[13.8216,100.6956],[13.8222,100.6954],[13.8232,100.6954],[13.8242,100.6952],[13.8301,100.6919],[13.8309,100.6909],[13.8324,100.6905],[13.8347,100.6878],[13.835,100.6878],[13.836,100.6883],[13.8386,100.6877],[13.8402,100.6868],[13.8417,100.6864],[13.8437,100.686],[13.8451,100.6855],[13.8468,100.6843],[13.848,100.6838],[13.8491,100.6823],[13.85,100.6804],[13.8504,100.6787],[13.8515,100.677],[13.8522,100.6738],[13.8523,100.6716],[13.8527,100.6708],[13.8524,100.6698],[13.8516,100.6684],[13.8511,100.668],[13.8509,100.6674],[13.8505,100.6657],[13.8505,100.6634],[13.85,100.6619],[13.8498,100.6615],[13.8491,100.6612],[13.8488,100.6593],[13.8486,100.6592],[13.8486,100.6589],[13.8477,100.6587],[13.8478,100.6565],[13.8468,100.6531],[13.8469,100.6521],[13.8464,100.65],[13.8462,100.6485],[13.8474,100.6462],[13.8466,100.6409],[13.8462,100.6394],[13.8457,100.6386],[13.8448,100.6373],[13.8436,100.6366],[13.8439,100.636],[13.8425,100.633],[13.8427,100.6311],[13.8426,100.6287],[13.8435,100.6278],[13.8458,100.6235],[13.8466,100.6227],[13.8472,100.6217],[13.8481,100.6208],[13.8484,100.6196],[13.8491,100.614],[13.8491,100.6086],[13.8492,100.6069],[13.8481,100.6043],[13.8468,100.6023],[13.8463,100.5986],[13.8461,100.5976],[13.8458,100.5969],[13.8453,100.594],[13.8441,100.5909],[13.8438,100.5897],[13.8463,100.5888],[13.85,100.5882],[13.8521,100.5876],[13.8566,100.5874],[13.8588,100.5864],[13.8584,100.5857],[13.8582,100.584],[13.8579,100.5835],[13.8579,100.5815],[13.8574,100.5778],[13.8574,100.5762],[13.857,100.5749],[13.857,100.5736],[13.8566,100.5725],[13.8564,100.571],[13.8563,100.5689],[13.8556,100.5662],[13.8557,100.5656],[13.8554,100.5652],[13.8381,100.5558],[13.8233,100.5479],[13.8166,100.5446],[13.815,100.544],[13.8126,100.5433],[13.8071,100.5412],[13.803,100.5398],[13.7975,100.5373],[13.7996,100.5331],[13.7982,100.5323],[13.7988,100.5288],[13.7987,100.5268],[13.7992,100.5256],[13.7992,100.5249],[13.8,100.5223],[13.8002,100.5164],[13.8016,100.517],[13.805,100.5176],[13.8102,100.5171],[13.8113,100.5166],[13.8132,100.5152],[13.8141,100.5142],[13.8161,100.5075],[13.819,100.5063]]],[[[13.8041,100.3284],[13.8038,100.3335],[13.8025,100.3741],[13.8024,100.3827],[13.8014,100.4107],[13.8007,100.4228],[13.7995,100.4401],[13.7995,100.4423],[13.7982,100.459],[13.7972,100.464],[13.7949,100.4697],[13.7921,100.4679],[13.7899,100.4666],[13.789,100.4664],[13.7907,100.4733],[13.8007,100.501],[13.8017,100.5025],[13.8132,100.5152],[13.8113,100.5166],[13.8102,100.5171],[13.805,100.5176],[13.8016,100.517],[13.7993,100.5161],[13.7973,100.5151],[13.7945,100.5131],[13.7924,100.5114],[13.7845,100.5042],[13.7791,100.5015],[13.7701,100.4979],[13.7675,100.4963],[13.7656,100.4948],[13.7617,100.4905],[13.7599,100.4891],[13.7571,100.488],[13.7546,100.4876],[13.7523,100.4876],[13.7497,100.4878],[13.7476,100.4883],[13.746,100.4892],[13.7442,100.4905],[13.7412,100.4931],[13.7404,100.4943],[13.7396,100.4961],[13.7387,100.4991],[13.7374,100.5049],[13.7366,100.5071],[13.7357,100.5088],[13.7343,100.5102],[13.7322,100.5113],[13.7293,100.5123],[13.7272,100.5127],[13.7253,100.5127],[13.7231,100.5127],[13.7211,100.5124],[13.7175,100.5115],[13.716,100.5107],[13.7146,100.5099],[13.7117,100.5075],[13.7084,100.5039],[13.7076,100.5028],[13.7058,100.5],[13.7029,100.4945],[13.7019,100.493],[13.7001,100.4913],[13.6988,100.4907],[13.696,100.49],[13.6933,100.49],[13.6921,100.4905],[13.6903,100.4924],[13.6888,100.4946],[13.687,100.4985],[13.6854,100.5064],[13.6844,100.5134],[13.6832,100.5171],[13.6716,100.5309],[13.6698,100.5349],[13.6691,100.5382],[13.6692,100.5406],[13.6694,100.5418],[13.6709,100.5451],[13.6718,100.5468],[13.6738,100.5485],[13.6749,100.5492],[13.6772,100.551],[13.678,100.5514],[13.6823,100.5525],[13.6859,100.5527],[13.6906,100.5526],[13.6971,100.5515],[13.6991,100.5513],[13.7012,100.5517],[13.7029,100.5523],[13.7046,100.5538],[13.7057,100.5553],[13.7063,100.5569],[13.7064,100.5597],[13.7063,100.5611],[13.7057,100.5635],[13.7022,100.573],[13.7007,100.5767],[13.6986,100.581],[13.6965,100.5835],[13.6911,100.5888],[13.6885,100.5893],[13.6849,100.5897],[13.6822,100.589],[13.681,100.5884],[13.6746,100.5836],[13.6674,100.5776],[13.6642,100.5748],[13.6613,100.5718],[13.6582,100.5676],[13.6567,100.5641],[13.6561,100.5619],[13.6558,100.5599],[13.6558,100.5576],[13.6561,100.5566],[13.6588,100.5502],[13.6596,100.548],[13.6606,100.5435],[13.6609,100.5407],[13.6604,100.5388],[13.6597,100.5377],[13.6586,100.5366],[13.6569,100.5356],[13.653,100.5341],[13.6485,100.534],[13.6461,100.5343],[13.6422,100.5351],[13.6388,100.5361],[13.6358,100.5373],[13.627,100.5427],[13.6208,100.5481],[13.619,100.5499],[13.6166,100.5534],[13.614,100.5577],[13.6126,100.5613],[13.6118,100.5639],[13.6113,100.5665],[13.611,100.5758],[13.6112,100.5795],[13.6107,100.5848],[13.61,100.5868],[13.6091,100.5887],[13.6074,100.5906],[13.6051,100.5915],[13.5978,100.5926],[13.5951,100.5922],[13.5923,100.5909],[13.5842,100.5862],[13.5768,100.5805],[13.573,100.5779],[13.5696,100.5766],[13.5623,100.5764],[13.5594,100.5769],[13.5571,100.5776],[13.5373,100.593],[13.5366,100.5907],[13.5354,100.5892],[13.5348,100.5887],[13.5333,100.5882],[13.5255,100.589],[13.5241,100.5886],[13.5204,100.5862],[13.5177,100.584],[13.5176,100.5832],[13.5138,100.579],[13.5137,100.5791],[13.513,100.5788],[13.512,100.5771],[13.5092,100.5747],[13.5091,100.5741],[13.5097,100.5738],[13.5092,100.5732],[13.5092,100.573],[13.5095,100.5728],[13.5101,100.5736],[13.5108,100.573],[13.5104,100.5725],[13.5101,100.5726],[13.5101,100.5723],[13.5098,100.5724],[13.5096,100.572],[13.5104,100.5719],[13.5106,100.5717],[13.5106,100.5709],[13.5103,100.5701],[13.5095,100.57],[13.5091,100.5693],[13.5093,100.5691],[13.5096,100.5693],[13.5103,100.5688],[13.5103,100.5685],[13.5099,100.5683],[13.5096,100.5684],[13.5097,100.5677],[13.509,100.567],[13.5092,100.5666],[13.5088,100.5662],[13.509,100.5658],[13.5091,100.5652],[13.5088,100.5642],[13.5095,100.5637],[13.5092,100.5631],[13.5088,100.563],[13.5082,100.5619],[13.5075,100.5617],[13.5077,100.5552],[13.5072,100.5545],[13.5069,100.5545],[13.5068,100.5541],[13.5062,100.5537],[13.5057,100.5525],[13.5059,100.5491],[13.5056,100.549],[13.5056,100.5486],[13.5062,100.5485],[13.5059,100.5476],[13.5057,100.5475],[13.5057,100.547],[13.506,100.5469],[13.5061,100.5434],[13.5057,100.5433],[13.505,100.5406],[13.5042,100.5396],[13.5041,100.5369],[13.5037,100.5368],[13.5036,100.5355],[13.5033,100.5354],[13.503,100.5348],[13.5032,100.5344],[13.503,100.534],[13.5017,100.5341],[13.5017,100.533],[13.5024,100.533],[13.5031,100.5321],[13.5031,100.5306],[13.5035,100.5305],[13.5036,100.5291],[13.5031,100.5285],[13.503,100.5279],[13.5026,100.5276],[13.5025,100.5272],[13.5022,100.5271],[13.5023,100.5243],[13.5031,100.524],[13.5029,100.5229],[13.5026,100.5229],[13.5029,100.5219],[13.5024,100.5215],[13.5021,100.52],[13.5016,100.52],[13.5017,100.5169],[13.5013,100.5167],[13.5009,100.5168],[13.5001,100.5162],[13.5011,100.515],[13.5007,100.5146],[13.5013,100.5146],[13.5013,100.5143],[13.5003,100.5141],[13.5001,100.5138],[13.5006,100.5132],[13.5006,100.5124],[13.5011,100.5119],[13.5015,100.511],[13.5011,100.5078],[13.5006,100.5067],[13.5005,100.5044],[13.5003,100.5029],[13.4999,100.5021],[13.4997,100.5009],[13.5,100.5006],[13.4999,100.4978],[13.4988,100.4977],[13.4988,100.4957],[13.4991,100.4943],[13.4997,100.494],[13.5,100.4932],[13.4995,100.4931],[13.4994,100.4924],[13.4982,100.4925],[13.4979,100.4917],[13.4967,100.4915],[13.4963,100.4904],[13.4966,100.4902],[13.4966,100.4899],[13.4984,100.4895],[13.4985,100.4893],[13.4979,100.4891],[13.497,100.4872],[13.497,100.4865],[13.4975,100.4863],[13.4973,100.4832],[13.4971,100.483],[13.496,100.4831],[13.4958,100.4809],[13.4968,100.4805],[13.4966,100.4796],[13.4969,100.4782],[13.4972,100.4777],[13.4969,100.4775],[13.497,100.475],[13.4977,100.4749],[13.498,100.4731],[13.4977,100.473],[13.4972,100.4723],[13.4971,100.4719],[13.4985,100.4721],[13.4986,100.4709],[13.4979,100.4703],[13.497,100.4704],[13.4969,100.4691],[13.4978,100.4691],[13.4979,100.4684],[13.4975,100.4683],[13.4968,100.4673],[13.4962,100.4661],[13.4956,100.4657],[13.4951,100.4648],[13.4948,100.4638],[13.4949,100.4626],[13.4993,100.4603],[13.4996,100.4591],[13.5,100.4589],[13.5002,100.4573],[13.5002,100.4557],[13.4995,100.4543],[13.4998,100.4535],[13.4993,100.4524],[13.499,100.4523],[13.4991,100.452],[13.4986,100.4519],[13.4986,100.4513],[13.4976,100.4486],[13.4967,100.4421],[13.4961,100.4405],[13.4961,100.4393],[13.4951,100.433],[13.4947,100.4274],[13.4938,100.4239],[13.4935,100.4187],[13.4927,100.4106],[13.493,100.4097],[13.5076,100.4063],[13.5078,100.4061],[13.5199,100.4067],[13.5204,100.4069],[13.5216,100.408],[13.5235,100.4087],[13.5247,100.4104],[13.5258,100.4105],[13.5262,100.4111],[13.5275,100.4113],[13.5281,100.4118],[13.529,100.4122],[13.5314,100.4129],[13.5353,100.4126],[13.5358,100.4135],[13.5364,100.4139],[13.5368,100.4145],[13.538,100.4149],[13.5384,100.4146],[13.5392,100.4152],[13.5402,100.4178],[13.5409,100.4186],[13.5414,100.4187],[13.5426,100.4194],[13.5431,100.4193],[13.5435,100.4194],[13.5445,100.42],[13.546,100.4198],[13.5468,100.4194],[13.5488,100.4175],[13.55,100.4167],[13.551,100.4148],[13.5514,100.4144],[13.5524,100.4147],[13.5533,100.4149],[13.5545,100.4147],[13.5561,100.4152],[13.557,100.4151],[13.5567,100.414],[13.5573,100.4137],[13.5574,100.4135],[13.5568,100.413],[13.5569,100.4123],[13.5566,100.412],[13.5557,100.4122],[13.5549,100.4107],[13.5547,100.4097],[13.5547,100.4089],[13.5542,100.4084],[13.5549,100.4072],[13.5543,100.4067],[13.5542,100.4064],[13.5545,100.406],[13.5546,100.4054],[13.5551,100.4048],[13.5551,100.4045],[13.5534,100.4034],[13.5529,100.4026],[13.553,100.4017],[13.5525,100.4011],[13.5526,100.4003],[13.5523,100.3993],[13.5524,100.3991],[13.5527,100.3991],[13.5529,100.3989],[13.5526,100.3981],[13.5526,100.3972],[13.5532,100.3964],[13.5532,100.3958],[13.5536,100.3953],[13.5545,100.3951],[13.5546,100.3946],[13.5553,100.3948],[13.5556,100.3947],[13.556,100.3942],[13.5576,100.3939],[13.558,100.3943],[13.5584,100.3933],[13.5594,100.393],[13.5596,100.3931],[13.5599,100.3928],[13.5603,100.3932],[13.5605,100.3925],[13.5612,100.3932],[13.5617,100.3927],[13.5623,100.3926],[13.5625,100.3923],[13.5629,100.3922],[13.563,100.392],[13.5628,100.3913],[13.563,100.391],[13.5645,100.3911],[13.5654,100.3907],[13.5672,100.3909],[13.5689,100.3905],[13.5704,100.3906],[13.5717,100.3899],[13.5742,100.3894],[13.5757,100.3883],[13.5777,100.3877],[13.582,100.387],[13.5837,100.3863],[13.5848,100.3863],[13.5851,100.3861],[13.5852,100.3853],[13.5855,100.3853],[13.5856,100.3857],[13.5859,100.3857],[13.5859,100.385],[13.5861,100.3847],[13.5863,100.3853],[13.5869,100.3848],[13.5874,100.3853],[13.5876,100.3851],[13.5877,100.3842],[13.5884,100.3845],[13.5891,100.3842],[13.5898,100.3831],[13.5903,100.3827],[13.5906,100.3818],[13.591,100.3815],[13.5912,100.3809],[13.5919,100.381],[13.5928,100.3815],[13.5938,100.3833],[13.6021,100.3784],[13.6066,100.3771],[13.6067,100.3772],[13.6094,100.3771],[13.6097,100.3767],[13.6094,100.3763],[13.6136,100.376],[13.6136,100.3757],[13.6159,100.3753],[13.6185,100.3752],[13.6185,100.3751],[13.6191,100.3745],[13.6201,100.3729],[13.6208,100.373],[13.6207,100.372],[13.6244,100.3712],[13.6249,100.3714],[13.6253,100.3713],[13.6256,100.371],[13.6253,100.3703],[13.6256,100.3697],[13.6256,100.3691],[13.6258,100.3689],[13.6262,100.3672],[13.6264,100.3671],[13.6271,100.3673],[13.6273,100.3671],[13.6274,100.366],[13.6277,100.3656],[13.6274,100.365],[13.628,100.3649],[13.6282,100.3644],[13.6294,100.363],[13.6297,100.363],[13.6299,100.3632],[13.6308,100.3627],[13.6312,100.363],[13.6315,100.3624],[13.6315,100.3617],[13.6329,100.3616],[13.6329,100.3612],[13.6334,100.3611],[13.6333,100.3601],[13.6344,100.36],[13.6342,100.3587],[13.6348,100.3585],[13.6367,100.3585],[13.6411,100.3569],[13.6423,100.3561],[13.6422,100.3558],[13.6418,100.3549],[13.6422,100.3546],[13.6421,100.3542],[13.6409,100.3544],[13.6408,100.3538],[13.6409,100.352],[13.6403,100.3521],[13.6402,100.3519],[13.6401,100.3503],[13.6404,100.3503],[13.6404,100.3486],[13.6402,100.3478],[13.6393,100.3453],[13.6393,100.3438],[13.6388,100.341],[13.639,100.3407],[13.6428,100.3382],[13.6503,100.3386],[13.6508,100.3388],[13.6518,100.3386],[13.653,100.3389],[13.6543,100.3396],[13.6563,100.3393],[13.6574,100.3397],[13.6589,100.3409],[13.6597,100.3409],[13.6606,100.3413],[13.6613,100.3413],[13.6625,100.3407],[13.6636,100.3406],[13.6655,100.3401],[13.6665,100.3403],[13.6677,100.3394],[13.6683,100.3393],[13.6692,100.3389],[13.6718,100.3387],[13.6727,100.3385],[13.6742,100.3385],[13.6762,100.338],[13.6771,100.3375],[13.677,100.3361],[13.6816,100.3334],[13.6834,100.3339],[13.6877,100.3326],[13.6909,100.332],[13.6917,100.332],[13.6923,100.3321],[13.6973,100.3314],[13.6999,100.3303],[13.7019,100.3303],[13.7019,100.3312],[13.702,100.3313],[13.7036,100.3312],[13.7065,100.3328],[13.7078,100.3333],[13.7088,100.3334],[13.71,100.3333],[13.71,100.3335],[13.7103,100.3335],[13.7123,100.3326],[13.7132,100.3348],[13.7116,100.3353],[13.7118,100.3372],[13.7126,100.3386],[13.714,100.3379],[13.715,100.3378],[13.7159,100.3387],[13.7176,100.3383],[13.7176,100.3381],[13.7182,100.3379],[13.7183,100.3379],[13.7211,100.3363],[13.7218,100.3362],[13.723,100.3364],[13.7242,100.3363],[13.726,100.3364],[13.7261,100.337],[13.7277,100.3364],[13.728,100.3365],[13.7291,100.3361],[13.7294,100.3365],[13.7318,100.3351],[13.7326,100.3351],[13.7352,100.3335],[13.7368,100.3328],[13.7391,100.3332],[13.7397,100.3331],[13.741,100.3326],[13.7441,100.3318],[13.7463,100.3318],[13.7483,100.3313],[13.7536,100.3318],[13.7547,100.3314],[13.7571,100.3313],[13.7588,100.3308],[13.7614,100.3305],[13.7627,100.33],[13.7651,100.3293],[13.7685,100.3291],[13.7763,100.3299],[13.7876,100.3304],[13.7923,100.3301],[13.7962,100.3295],[13.7992,100.3293],[13.8014,100.3288],[13.802,100.3288],[13.8021,100.3291],[13.8024,100.3291],[13.8041,100.3284]]],[[[13.9206,100.2651],[13.9349,100.2743],[13.9442,100.2844],[13.9634,100.2981],[13.9761,100.2807],[13.9849,100.272],[13.9894,100.2691],[13.9932,100.2678],[14.0015,100.2749],[14.0066,100.2667],[14.0118,100.2624],[14.0166,100.2595],[14.0217,100.2574],[14.0265,100.2561],[14.0328,100.2555],[14.0386,100.2558],[14.0469,100.258],[14.0514,100.26],[14.0562,100.263],[14.0605,100.2668],[14.0646,100.2718],[14.0668,100.2735],[14.0693,100.2739],[14.0709,100.2736],[14.0727,100.2736],[14.0739,100.2745],[14.0756,100.2748],[14.0817,100.2766],[14.0887,100.277],[14.0988,100.2771],[14.1086,100.278],[14.1206,100.2794],[14.1256,100.2797],[14.1336,100.2903],[14.1361,100.2931],[14.1384,100.2944],[14.1394,100.2955],[14.1402,100.2971],[14.1398,100.2988],[14.1389,100.3008],[14.1361,100.3081],[14.1332,100.3132],[14.1293,100.3222],[14.1279,100.3333],[14.115,100.3444],[14.1053,100.3421],[14.0971,100.3416],[14.0922,100.3401],[14.077,100.3347],[14.0693,100.3333],[14.0672,100.3324],[14.0608,100.3317],[14.0531,100.3323],[14.0478,100.3334],[14.0434,100.3346],[14.0384,100.3365],[14.0249,100.3428],[14.0225,100.3435],[14.0178,100.3458],[14.0083,100.3511],[14.0008,100.3556],[13.9953,100.3605],[13.9943,100.3611],[13.9924,100.3642],[13.9921,100.365],[13.9909,100.3716],[13.9889,100.3806],[13.9948,100.3811],[13.9835,100.4254],[13.9814,100.4341],[13.9808,100.4356],[13.9799,100.4371],[13.9742,100.4442],[13.9681,100.4526],[13.9673,100.4522],[13.9669,100.4526],[13.9664,100.4533],[13.9661,100.4541],[13.9663,100.4545],[13.966,100.4551],[13.9621,100.4588],[13.9615,100.4596],[13.9606,100.4618],[13.9602,100.4638],[13.9597,100.4645],[13.9582,100.4657],[13.9583,100.4665],[13.9587,100.4665],[13.9598,100.467],[13.96,100.4673],[13.9602,100.468],[13.9599,100.4693],[13.9601,100.47],[13.9607,100.4706],[13.9637,100.4724],[13.9611,100.4751],[13.9608,100.4759],[13.9587,100.478],[13.9571,100.4793],[13.9557,100.4808],[13.9542,100.4818],[13.9512,100.4846],[13.9505,100.486],[13.9501,100.4863],[13.9475,100.4873],[13.9465,100.4885],[13.946,100.4886],[13.9449,100.4875],[13.944,100.488],[13.9432,100.4886],[13.9425,100.4894],[13.9421,100.4905],[13.9411,100.4913],[13.941,100.4924],[13.9406,100.493],[13.9405,100.4935],[13.9408,100.4939],[13.9402,100.4953],[13.9398,100.4953],[13.9396,100.4957],[13.939,100.4978],[13.9384,100.4981],[13.9378,100.4995],[13.9375,100.5022],[13.9393,100.5035],[13.9415,100.5054],[13.9425,100.5069],[13.9434,100.5088],[13.9438,100.5105],[13.9439,100.515],[13.9436,100.5203],[13.9435,100.5233],[13.9441,100.5282],[13.9445,100.5298],[13.9451,100.5313],[13.9456,100.5322],[13.9475,100.5348],[13.949,100.5364],[13.9525,100.5386],[13.9539,100.5389],[13.9558,100.539],[13.9555,100.542],[13.9554,100.5422],[13.9552,100.5421],[13.9547,100.5413],[13.9535,100.542],[13.954,100.5428],[13.9544,100.5441],[13.9543,100.5442],[13.9535,100.5439],[13.953,100.5444],[13.953,100.5448],[13.9534,100.5454],[13.9533,100.5456],[13.9526,100.5456],[13.9525,100.5458],[13.9527,100.5471],[13.9527,100.5484],[13.9521,100.5491],[13.9517,100.5512],[13.9511,100.5526],[13.9514,100.5534],[13.9504,100.5541],[13.9504,100.5543],[13.9514,100.5545],[13.9515,100.5547],[13.9515,100.555],[13.9502,100.5562],[13.9501,100.5568],[13.9498,100.5572],[13.9505,100.5584],[13.9507,100.5596],[13.9507,100.5603],[13.9504,100.5605],[13.95,100.5606],[13.95,100.561],[13.9494,100.5615],[13.9494,100.5617],[13.9499,100.5621],[13.9496,100.5628],[13.9498,100.5634],[13.9497,100.564],[13.9505,100.5647],[13.9506,100.5658],[13.9503,100.5667],[13.951,100.5667],[13.9515,100.5677],[13.8498,100.5438],[13.8499,100.5435],[13.8495,100.5434],[13.8475,100.5386],[13.8466,100.5374],[13.8462,100.5362],[13.8451,100.535],[13.8442,100.5338],[13.8424,100.532],[13.8417,100.531],[13.8398,100.5291],[13.8344,100.5228],[13.8339,100.5223],[13.8307,100.5188],[13.8286,100.5159],[13.8276,100.5158],[13.8271,100.5154],[13.8262,100.5132],[13.8247,100.5131],[13.8249,100.5126],[13.8259,100.5121],[13.8261,100.5118],[13.8262,100.511],[13.8252,100.5107],[13.8256,100.5095],[13.8255,100.5093],[13.8248,100.5093],[13.8246,100.5096],[13.8245,100.5101],[13.8242,100.5101],[13.8236,100.5096],[13.8234,100.5087],[13.8228,100.5077],[13.8215,100.5076],[13.8212,100.5072],[13.8194,100.5064],[13.819,100.5063],[13.8161,100.5075],[13.8141,100.5142],[13.8132,100.5152],[13.8017,100.5025],[13.8009,100.5013],[13.8002,100.4999],[13.7913,100.4753],[13.7902,100.4719],[13.789,100.4663],[13.7899,100.4666],[13.7921,100.4679],[13.7949,100.4697],[13.7972,100.464],[13.7982,100.459],[13.7995,100.4423],[13.7995,100.4401],[13.8007,100.4228],[13.8014,100.4107],[13.8024,100.3827],[13.8025,100.3741],[13.8038,100.3335],[13.8042,100.3279],[13.8105,100.325],[13.8797,100.2923],[13.9111,100.2772],[13.915,100.2744],[13.9206,100.2651]]]];   // เส้นขอบภาค (รวมสาขา) ตามลำดับ TUR_REGIONS
const TUR_DISTRICTS = [[[13.709,100.6],[13.698,100.581],[13.702,100.573],[13.706,100.562],[13.706,100.557],[13.71,100.554],[13.72,100.553],[13.743,100.552],[13.724,100.58],[13.71,100.599],[13.709,100.6]],[[13.726,100.513],[13.721,100.512],[13.717,100.511],[13.711,100.507],[13.707,100.501],[13.71,100.496],[13.713,100.493],[13.72,100.493],[13.726,100.493],[13.726,100.494],[13.727,100.493],[13.739,100.499],[13.736,100.508],[13.734,100.51],[13.729,100.512],[13.726,100.513]],[[13.894,100.793],[13.891,100.798],[13.887,100.795],[13.884,100.793],[13.88,100.788],[13.855,100.797],[13.848,100.796],[13.844,100.79],[13.84,100.782],[13.834,100.772],[13.832,100.768],[13.83,100.764],[13.828,100.761],[13.825,100.754],[13.822,100.749],[13.825,100.747],[13.835,100.744],[13.838,100.736],[13.835,100.722],[13.825,100.715],[13.822,100.712],[13.819,100.704],[13.816,100.697],[13.822,100.695],[13.831,100.691],[13.835,100.688],[13.84,100.687],[13.848,100.683],[13.851,100.678],[13.853,100.671],[13.857,100.676],[13.858,100.68],[13.863,100.683],[13.87,100.686],[13.875,100.685],[13.88,100.69],[13.885,100.69],[13.887,100.691],[13.897,100.692],[13.901,100.691],[13.908,100.687],[13.912,100.684],[13.914,100.685],[13.918,100.729],[13.914,100.792],[13.897,100.793],[13.894,100.793]],[[13.856,100.675],[13.852,100.671],[13.85,100.679],[13.848,100.684],[13.84,100.687],[13.835,100.688],[13.831,100.691],[13.822,100.695],[13.818,100.697],[13.811,100.7],[13.808,100.702],[13.802,100.702],[13.787,100.686],[13.79,100.674],[13.798,100.673],[13.806,100.665],[13.812,100.663],[13.818,100.661],[13.826,100.661],[13.835,100.657],[13.834,100.649],[13.842,100.648],[13.847,100.648],[13.848,100.656],[13.85,100.658],[13.856,100.663],[13.856,100.666],[13.857,100.674],[13.856,100.675]],[[13.859,100.587],[13.853,100.588],[13.851,100.588],[13.845,100.589],[13.839,100.591],[13.835,100.591],[13.831,100.59],[13.828,100.59],[13.823,100.589],[13.82,100.589],[13.818,100.59],[13.815,100.589],[13.812,100.589],[13.809,100.589],[13.804,100.589],[13.803,100.585],[13.803,100.582],[13.802,100.58],[13.801,100.577],[13.801,100.575],[13.8,100.573],[13.799,100.57],[13.797,100.567],[13.795,100.566],[13.795,100.56],[13.795,100.557],[13.796,100.555],[13.796,100.552],[13.796,100.549],[13.798,100.537],[13.81,100.542],[13.813,100.543],[13.818,100.545],[13.82,100.544],[13.822,100.537],[13.852,100.552],[13.853,100.555],[13.855,100.564],[13.856,100.566],[13.856,100.569],[13.857,100.573],[13.857,100.576],[13.858,100.583],[13.859,100.587]],[[13.71,100.471],[13.709,100.477],[13.698,100.48],[13.691,100.481],[13.684,100.489],[13.679,100.488],[13.677,100.486],[13.674,100.484],[13.669,100.48],[13.659,100.47],[13.659,100.461],[13.665,100.452],[13.673,100.452],[13.676,100.449],[13.682,100.449],[13.684,100.447],[13.686,100.444],[13.688,100.442],[13.696,100.436],[13.705,100.437],[13.708,100.445],[13.71,100.453],[13.713,100.458],[13.717,100.466],[13.712,100.468],[13.71,100.471]],[[13.95,100.622],[13.926,100.626],[13.899,100.611],[13.897,100.607],[13.895,100.606],[13.893,100.603],[13.891,100.599],[13.888,100.595],[13.889,100.59],[13.889,100.588],[13.89,100.585],[13.891,100.583],[13.904,100.579],[13.908,100.569],[13.911,100.567],[13.914,100.561],[13.952,100.569],[13.953,100.571],[13.954,100.575],[13.952,100.587],[13.944,100.606],[13.955,100.613],[13.95,100.622]],[[13.801,100.575],[13.769,100.573],[13.76,100.566],[13.755,100.564],[13.756,100.559],[13.756,100.555],[13.756,100.554],[13.757,100.552],[13.758,100.551],[13.76,100.548],[13.761,100.547],[13.761,100.546],[13.762,100.544],[13.764,100.548],[13.787,100.561],[13.791,100.561],[13.795,100.567],[13.799,100.567],[13.8,100.571],[13.8,100.574],[13.801,100.575]],[[13.8,100.52],[13.8,100.524],[13.799,100.527],[13.799,100.529],[13.798,100.532],[13.798,100.537],[13.754,100.517],[13.757,100.516],[13.764,100.509],[13.772,100.501],[13.778,100.501],[13.786,100.505],[13.795,100.513],[13.8,100.516],[13.8,100.52]],[[13.801,100.42],[13.799,100.443],[13.799,100.452],[13.798,100.461],[13.795,100.47],[13.793,100.468],[13.789,100.466],[13.785,100.466],[13.781,100.467],[13.78,100.468],[13.779,100.467],[13.779,100.466],[13.779,100.462],[13.779,100.461],[13.779,100.46],[13.777,100.458],[13.777,100.457],[13.776,100.456],[13.768,100.454],[13.763,100.454],[13.755,100.46],[13.751,100.462],[13.745,100.462],[13.744,100.46],[13.744,100.457],[13.743,100.457],[13.742,100.455],[13.742,100.454],[13.741,100.452],[13.741,100.45],[13.741,100.449],[13.741,100.446],[13.74,100.443],[13.741,100.441],[13.74,100.44],[13.74,100.433],[13.741,100.432],[13.742,100.43],[13.742,100.427],[13.744,100.423],[13.745,100.42],[13.748,100.416],[13.749,100.406],[13.788,100.41],[13.801,100.42]],[[13.804,100.335],[13.803,100.364],[13.803,100.379],[13.802,100.403],[13.788,100.41],[13.749,100.406],[13.751,100.397],[13.753,100.38],[13.754,100.37],[13.754,100.365],[13.745,100.356],[13.741,100.358],[13.738,100.357],[13.738,100.353],[13.737,100.347],[13.737,100.344],[13.738,100.337],[13.743,100.335],[13.747,100.336],[13.753,100.335],[13.757,100.333],[13.765,100.33],[13.777,100.331],[13.786,100.331],[13.798,100.33],[13.804,100.329],[13.804,100.335]],[[13.662,100.48],[13.658,100.483],[13.658,100.487],[13.66,100.494],[13.656,100.496],[13.659,100.503],[13.661,100.507],[13.659,100.511],[13.662,100.516],[13.652,100.518],[13.646,100.519],[13.644,100.517],[13.638,100.517],[13.631,100.516],[13.628,100.514],[13.624,100.515],[13.619,100.516],[13.616,100.517],[13.613,100.516],[13.611,100.519],[13.607,100.52],[13.601,100.513],[13.597,100.507],[13.596,100.502],[13.595,100.499],[13.591,100.499],[13.587,100.494],[13.588,100.49],[13.591,100.484],[13.596,100.481],[13.599,100.477],[13.603,100.477],[13.606,100.48],[13.611,100.481],[13.616,100.481],[13.619,100.479],[13.622,100.474],[13.625,100.472],[13.627,100.474],[13.629,100.475],[13.632,100.475],[13.645,100.473],[13.66,100.47],[13.662,100.48]],[[13.726,100.493],[13.722,100.493],[13.714,100.493],[13.71,100.496],[13.705,100.499],[13.702,100.493],[13.699,100.491],[13.695,100.49],[13.695,100.487],[13.695,100.483],[13.696,100.48],[13.698,100.48],[13.705,100.478],[13.709,100.477],[13.71,100.473],[13.711,100.468],[13.712,100.469],[13.716,100.469],[13.719,100.47],[13.721,100.472],[13.722,100.473],[13.723,100.48],[13.725,100.484],[13.727,100.486],[13.73,100.486],[13.733,100.487],[13.736,100.488],[13.74,100.49],[13.742,100.492],[13.739,100.499],[13.727,100.493],[13.726,100.494],[13.726,100.493]],[[13.786,100.47],[13.761,100.49],[13.757,100.488],[13.749,100.488],[13.746,100.483],[13.746,100.48],[13.746,100.478],[13.745,100.475],[13.743,100.471],[13.743,100.464],[13.745,100.462],[13.751,100.462],[13.759,100.457],[13.763,100.454],[13.768,100.454],[13.774,100.455],[13.776,100.457],[13.777,100.457],[13.778,100.46],[13.779,100.461],[13.779,100.462],[13.779,100.464],[13.779,100.467],[13.779,100.468],[13.78,100.467],[13.784,100.466],[13.787,100.466],[13.787,100.469],[13.786,100.47]],[[13.746,100.49],[13.742,100.491],[13.739,100.489],[13.735,100.487],[13.732,100.487],[13.729,100.486],[13.726,100.485],[13.724,100.484],[13.722,100.476],[13.723,100.472],[13.724,100.468],[13.73,100.464],[13.734,100.463],[13.739,100.462],[13.743,100.462],[13.743,100.464],[13.743,100.471],[13.745,100.475],[13.746,100.478],[13.746,100.48],[13.746,100.483],[13.747,100.489],[13.746,100.49]],[[13.819,100.628],[13.812,100.633],[13.806,100.638],[13.802,100.639],[13.792,100.641],[13.787,100.643],[13.783,100.648],[13.773,100.654],[13.774,100.663],[13.769,100.668],[13.762,100.669],[13.756,100.67],[13.749,100.678],[13.749,100.672],[13.747,100.666],[13.743,100.664],[13.74,100.663],[13.738,100.659],[13.743,100.648],[13.747,100.645],[13.75,100.638],[13.748,100.629],[13.745,100.618],[13.744,100.61],[13.751,100.604],[13.76,100.614],[13.762,100.621],[13.763,100.63],[13.775,100.629],[13.79,100.626],[13.8,100.619],[13.808,100.619],[13.819,100.628]],[[13.681,100.447],[13.679,100.448],[13.675,100.45],[13.667,100.453],[13.658,100.458],[13.657,100.466],[13.652,100.472],[13.635,100.475],[13.63,100.475],[13.628,100.474],[13.625,100.472],[13.623,100.474],[13.62,100.478],[13.618,100.479],[13.613,100.482],[13.608,100.48],[13.605,100.479],[13.602,100.476],[13.598,100.473],[13.595,100.469],[13.598,100.467],[13.603,100.466],[13.604,100.465],[13.605,100.461],[13.604,100.458],[13.605,100.456],[13.606,100.454],[13.603,100.453],[13.599,100.452],[13.595,100.451],[13.592,100.449],[13.589,100.448],[13.587,100.447],[13.571,100.446],[13.555,100.445],[13.545,100.446],[13.525,100.449],[13.5,100.454],[13.498,100.452],[13.498,100.449],[13.497,100.447],[13.497,100.445],[13.496,100.441],[13.496,100.439],[13.495,100.435],[13.495,100.433],[13.495,100.432],[13.495,100.429],[13.495,100.427],[13.494,100.426],[13.493,100.423],[13.493,100.421],[13.493,100.419],[13.493,100.417],[13.493,100.414],[13.493,100.413],[13.493,100.411],[13.495,100.41],[13.518,100.406],[13.523,100.407],[13.536,100.414],[13.539,100.415],[13.543,100.42],[13.549,100.418],[13.552,100.415],[13.557,100.415],[13.559,100.417],[13.562,100.413],[13.56,100.407],[13.558,100.395],[13.561,100.393],[13.563,100.391],[13.566,100.391],[13.569,100.391],[13.57,100.389],[13.572,100.388],[13.574,100.387],[13.575,100.387],[13.578,100.387],[13.579,100.385],[13.58,100.385],[13.582,100.385],[13.584,100.385],[13.585,100.386],[13.586,100.386],[13.586,100.385],[13.588,100.385],[13.589,100.384],[13.59,100.383],[13.591,100.382],[13.594,100.383],[13.602,100.378],[13.611,100.378],[13.621,100.378],[13.681,100.447]],[[13.886,100.613],[13.885,100.618],[13.883,100.624],[13.884,100.627],[13.886,100.633],[13.887,100.639],[13.885,100.643],[13.885,100.653],[13.886,100.654],[13.882,100.656],[13.879,100.663],[13.881,100.665],[13.881,100.669],[13.88,100.673],[13.88,100.674],[13.88,100.678],[13.875,100.684],[13.87,100.686],[13.863,100.683],[13.858,100.68],[13.857,100.676],[13.857,100.671],[13.855,100.664],[13.852,100.658],[13.848,100.659],[13.847,100.652],[13.846,100.639],[13.843,100.629],[13.848,100.621],[13.849,100.607],[13.846,100.596],[13.85,100.588],[13.859,100.587],[13.867,100.587],[13.874,100.588],[13.882,100.59],[13.891,100.599],[13.895,100.606],[13.896,100.609],[13.889,100.609],[13.886,100.613]],[[13.704,100.519],[13.701,100.525],[13.7,100.53],[13.695,100.533],[13.694,100.527],[13.693,100.525],[13.688,100.522],[13.686,100.519],[13.684,100.515],[13.686,100.502],[13.688,100.496],[13.692,100.492],[13.694,100.49],[13.698,100.49],[13.701,100.493],[13.707,100.501],[13.711,100.507],[13.711,100.51],[13.707,100.516],[13.704,100.519]],[[13.754,100.37],[13.753,100.38],[13.751,100.397],[13.749,100.408],[13.745,100.413],[13.738,100.415],[13.736,100.417],[13.732,100.422],[13.714,100.426],[13.698,100.427],[13.694,100.427],[13.692,100.427],[13.686,100.425],[13.685,100.423],[13.68,100.414],[13.676,100.406],[13.674,100.403],[13.67,100.395],[13.669,100.392],[13.669,100.388],[13.671,100.385],[13.68,100.384],[13.688,100.382],[13.692,100.381],[13.706,100.375],[13.728,100.364],[13.733,100.362],[13.741,100.358],[13.745,100.356],[13.754,100.365],[13.754,100.37]],[[13.85,100.544],[13.821,100.543],[13.819,100.545],[13.815,100.544],[13.81,100.543],[13.804,100.54],[13.8,100.533],[13.798,100.531],[13.799,100.527],[13.799,100.525],[13.8,100.522],[13.8,100.516],[13.805,100.518],[13.811,100.517],[13.814,100.514],[13.816,100.507],[13.821,100.507],[13.823,100.508],[13.823,100.509],[13.824,100.51],[13.825,100.51],[13.826,100.509],[13.825,100.511],[13.826,100.511],[13.825,100.513],[13.826,100.513],[13.826,100.514],[13.827,100.515],[13.829,100.516],[13.831,100.519],[13.835,100.523],[13.836,100.525],[13.837,100.526],[13.842,100.532],[13.845,100.534],[13.847,100.537],[13.849,100.543],[13.85,100.544]],[[13.678,100.64],[13.673,100.643],[13.671,100.644],[13.67,100.645],[13.669,100.651],[13.668,100.654],[13.664,100.652],[13.654,100.65],[13.653,100.65],[13.654,100.644],[13.653,100.643],[13.654,100.641],[13.653,100.64],[13.652,100.638],[13.652,100.631],[13.654,100.63],[13.659,100.619],[13.659,100.617],[13.662,100.615],[13.663,100.614],[13.663,100.613],[13.658,100.612],[13.659,100.609],[13.661,100.608],[13.661,100.602],[13.659,100.601],[13.661,100.597],[13.662,100.596],[13.669,100.579],[13.678,100.587],[13.682,100.592],[13.682,100.594],[13.68,100.6],[13.682,100.607],[13.684,100.611],[13.679,100.627],[13.678,100.64]],[[13.694,100.438],[13.69,100.44],[13.688,100.442],[13.687,100.443],[13.686,100.444],[13.684,100.446],[13.684,100.447],[13.683,100.447],[13.621,100.378],[13.621,100.377],[13.621,100.373],[13.624,100.371],[13.626,100.371],[13.626,100.37],[13.626,100.367],[13.63,100.367],[13.633,100.366],[13.635,100.363],[13.637,100.355],[13.641,100.352],[13.641,100.35],[13.644,100.347],[13.649,100.345],[13.652,100.347],[13.655,100.348],[13.655,100.349],[13.657,100.351],[13.658,100.353],[13.659,100.356],[13.661,100.357],[13.661,100.359],[13.662,100.361],[13.665,100.37],[13.668,100.376],[13.67,100.379],[13.671,100.386],[13.668,100.388],[13.669,100.393],[13.673,100.4],[13.675,100.403],[13.677,100.409],[13.682,100.418],[13.685,100.424],[13.688,100.428],[13.691,100.433],[13.694,100.438]],[[13.787,100.506],[13.783,100.503],[13.767,100.496],[13.773,100.483],[13.787,100.468],[13.789,100.466],[13.793,100.481],[13.8,100.501],[13.813,100.515],[13.81,100.517],[13.805,100.518],[13.798,100.516],[13.793,100.512],[13.787,100.506]],[[13.718,100.517],[13.722,100.513],[13.729,100.512],[13.732,100.516],[13.738,100.516],[13.733,100.529],[13.726,100.544],[13.718,100.517]],[[13.847,100.646],[13.844,100.648],[13.839,100.648],[13.835,100.649],[13.835,100.653],[13.836,100.657],[13.834,100.661],[13.83,100.662],[13.825,100.66],[13.82,100.661],[13.815,100.662],[13.813,100.663],[13.81,100.663],[13.806,100.665],[13.806,100.669],[13.8,100.671],[13.796,100.674],[13.792,100.674],[13.787,100.677],[13.781,100.675],[13.777,100.667],[13.775,100.663],[13.774,100.662],[13.772,100.659],[13.774,100.654],[13.778,100.652],[13.784,100.647],[13.786,100.646],[13.787,100.643],[13.791,100.641],[13.794,100.64],[13.799,100.64],[13.803,100.639],[13.805,100.638],[13.807,100.636],[13.811,100.633],[13.815,100.632],[13.816,100.631],[13.819,100.626],[13.818,100.624],[13.828,100.629],[13.844,100.637],[13.847,100.641],[13.847,100.646]],[[13.753,100.517],[13.753,100.519],[13.751,100.523],[13.75,100.528],[13.749,100.535],[13.75,100.539],[13.749,100.543],[13.748,100.548],[13.733,100.529],[13.74,100.516],[13.753,100.517]],[[13.737,100.667],[13.732,100.708],[13.708,100.711],[13.701,100.711],[13.685,100.707],[13.673,100.705],[13.662,100.699],[13.657,100.694],[13.664,100.674],[13.667,100.666],[13.671,100.662],[13.672,100.656],[13.669,100.648],[13.671,100.644],[13.679,100.64],[13.689,100.638],[13.698,100.635],[13.703,100.644],[13.703,100.651],[13.708,100.649],[13.713,100.65],[13.718,100.651],[13.729,100.652],[13.734,100.655],[13.737,100.667]],[[13.763,100.509],[13.757,100.516],[13.754,100.517],[13.74,100.516],[13.739,100.514],[13.747,100.504],[13.756,100.506],[13.763,100.509]],[[13.798,100.537],[13.796,100.549],[13.796,100.552],[13.796,100.555],[13.795,100.557],[13.795,100.56],[13.791,100.561],[13.787,100.561],[13.764,100.548],[13.763,100.543],[13.765,100.541],[13.765,100.54],[13.768,100.537],[13.769,100.535],[13.771,100.533],[13.774,100.528],[13.798,100.537]],[[13.706,100.606],[13.706,100.609],[13.706,100.614],[13.705,100.617],[13.704,100.622],[13.705,100.632],[13.702,100.634],[13.698,100.635],[13.694,100.637],[13.69,100.638],[13.682,100.639],[13.678,100.64],[13.679,100.627],[13.684,100.611],[13.682,100.607],[13.68,100.6],[13.682,100.594],[13.682,100.592],[13.685,100.589],[13.691,100.588],[13.695,100.585],[13.706,100.606]],[[13.741,100.501],[13.74,100.495],[13.742,100.492],[13.747,100.489],[13.753,100.488],[13.758,100.488],[13.761,100.49],[13.767,100.496],[13.772,100.5],[13.767,100.507],[13.755,100.506],[13.742,100.501],[13.741,100.501]],[[13.742,100.427],[13.74,100.432],[13.74,100.44],[13.741,100.444],[13.741,100.449],[13.742,100.453],[13.742,100.456],[13.744,100.458],[13.742,100.462],[13.733,100.463],[13.724,100.468],[13.72,100.471],[13.717,100.466],[13.713,100.458],[13.71,100.453],[13.708,100.445],[13.705,100.437],[13.696,100.436],[13.688,100.429],[13.694,100.427],[13.714,100.426],[13.736,100.417],[13.745,100.413],[13.745,100.42],[13.743,100.426],[13.742,100.427]],[[13.854,100.808],[13.844,100.806],[13.833,100.807],[13.826,100.806],[13.822,100.802],[13.817,100.801],[13.809,100.802],[13.808,100.807],[13.801,100.8],[13.794,100.795],[13.799,100.783],[13.782,100.782],[13.783,100.773],[13.782,100.765],[13.779,100.763],[13.776,100.759],[13.778,100.746],[13.776,100.736],[13.776,100.728],[13.778,100.721],[13.79,100.711],[13.8,100.704],[13.806,100.702],[13.81,100.701],[13.816,100.697],[13.819,100.702],[13.822,100.712],[13.823,100.715],[13.837,100.722],[13.836,100.73],[13.835,100.743],[13.825,100.747],[13.822,100.749],[13.825,100.754],[13.828,100.76],[13.83,100.763],[13.832,100.768],[13.834,100.771],[13.84,100.782],[13.844,100.789],[13.848,100.796],[13.85,100.8],[13.853,100.806],[13.854,100.808]],[[13.718,100.552],[13.716,100.554],[13.705,100.554],[13.699,100.552],[13.692,100.552],[13.682,100.552],[13.676,100.55],[13.673,100.547],[13.671,100.544],[13.67,100.535],[13.68,100.521],[13.685,100.519],[13.687,100.521],[13.692,100.524],[13.693,100.526],[13.694,100.529],[13.706,100.531],[13.707,100.538],[13.704,100.543],[13.707,100.543],[13.714,100.545],[13.718,100.552]],[[13.765,100.54],[13.764,100.542],[13.762,100.545],[13.761,100.546],[13.76,100.547],[13.759,100.548],[13.757,100.552],[13.756,100.552],[13.756,100.554],[13.756,100.556],[13.756,100.56],[13.755,100.565],[13.748,100.561],[13.748,100.552],[13.748,100.548],[13.749,100.543],[13.75,100.539],[13.749,100.535],[13.75,100.528],[13.751,100.523],[13.753,100.519],[13.772,100.531],[13.77,100.534],[13.768,100.537],[13.767,100.538],[13.765,100.54]],[[13.695,100.49],[13.689,100.495],[13.685,100.511],[13.678,100.523],[13.674,100.522],[13.673,100.522],[13.671,100.521],[13.67,100.521],[13.669,100.52],[13.668,100.519],[13.667,100.518],[13.663,100.518],[13.66,100.512],[13.66,100.508],[13.66,100.504],[13.656,100.5],[13.659,100.495],[13.657,100.489],[13.658,100.484],[13.662,100.482],[13.665,100.481],[13.673,100.483],[13.675,100.485],[13.678,100.487],[13.682,100.488],[13.69,100.482],[13.695,100.483],[13.695,100.487],[13.695,100.49]],[[13.782,100.799],[13.782,100.81],[13.783,100.815],[13.778,100.823],[13.77,100.83],[13.768,100.838],[13.771,100.846],[13.77,100.86],[13.764,100.865],[13.755,100.866],[13.745,100.872],[13.739,100.875],[13.697,100.861],[13.702,100.829],[13.711,100.803],[13.716,100.772],[13.716,100.765],[13.717,100.745],[13.718,100.72],[13.732,100.708],[13.751,100.71],[13.76,100.708],[13.769,100.715],[13.777,100.717],[13.776,100.726],[13.775,100.731],[13.777,100.739],[13.778,100.755],[13.777,100.761],[13.781,100.764],[13.782,100.769],[13.782,100.778],[13.79,100.783],[13.798,100.79],[13.789,100.796],[13.784,100.794],[13.782,100.799]],[[13.849,100.607],[13.849,100.612],[13.848,100.621],[13.846,100.624],[13.843,100.629],[13.843,100.631],[13.844,100.637],[13.828,100.629],[13.81,100.62],[13.795,100.61],[13.795,100.606],[13.8,100.603],[13.801,100.6],[13.8,100.598],[13.802,100.593],[13.803,100.588],[13.808,100.589],[13.811,100.589],[13.814,100.589],[13.817,100.59],[13.819,100.589],[13.822,100.589],[13.826,100.59],[13.83,100.59],[13.833,100.59],[13.839,100.591],[13.845,100.592],[13.846,100.597],[13.848,100.604],[13.849,100.607]],[[13.8,100.615],[13.8,100.621],[13.797,100.624],[13.788,100.626],[13.784,100.631],[13.775,100.628],[13.767,100.63],[13.763,100.63],[13.763,100.627],[13.762,100.619],[13.761,100.614],[13.758,100.611],[13.755,100.608],[13.755,100.6],[13.761,100.596],[13.764,100.595],[13.766,100.595],[13.773,100.593],[13.777,100.594],[13.782,100.592],[13.787,100.59],[13.792,100.59],[13.798,100.589],[13.803,100.588],[13.802,100.595],[13.8,100.598],[13.8,100.602],[13.8,100.604],[13.795,100.606],[13.795,100.61],[13.8,100.615]],[[13.748,100.559],[13.748,100.565],[13.746,100.575],[13.743,100.585],[13.741,100.598],[13.741,100.599],[13.738,100.599],[13.738,100.602],[13.735,100.605],[13.728,100.605],[13.723,100.606],[13.721,100.606],[13.72,100.605],[13.719,100.607],[13.718,100.606],[13.715,100.607],[13.714,100.604],[13.713,100.602],[13.712,100.603],[13.711,100.603],[13.71,100.604],[13.709,100.604],[13.708,100.605],[13.707,100.606],[13.709,100.6],[13.714,100.593],[13.742,100.553],[13.748,100.55],[13.748,100.559]],[[13.748,100.601],[13.744,100.611],[13.746,100.62],[13.749,100.633],[13.749,100.64],[13.745,100.647],[13.743,100.647],[13.738,100.659],[13.734,100.655],[13.729,100.652],[13.718,100.651],[13.713,100.65],[13.708,100.649],[13.703,100.651],[13.703,100.644],[13.704,100.632],[13.705,100.618],[13.706,100.61],[13.706,100.606],[13.708,100.605],[13.711,100.603],[13.712,100.602],[13.714,100.606],[13.719,100.607],[13.721,100.606],[13.727,100.606],[13.738,100.603],[13.738,100.598],[13.745,100.6],[13.748,100.601]],[[13.796,100.701],[13.793,100.709],[13.781,100.715],[13.777,100.717],[13.77,100.715],[13.765,100.713],[13.761,100.709],[13.757,100.707],[13.757,100.71],[13.745,100.709],[13.738,100.709],[13.732,100.706],[13.736,100.677],[13.738,100.659],[13.739,100.661],[13.74,100.663],[13.742,100.663],[13.743,100.664],[13.744,100.665],[13.747,100.666],[13.748,100.671],[13.749,100.672],[13.749,100.676],[13.749,100.678],[13.752,100.679],[13.756,100.67],[13.758,100.67],[13.762,100.669],[13.764,100.669],[13.769,100.668],[13.777,100.668],[13.787,100.686],[13.796,100.701]],[[13.73,100.513],[13.733,100.511],[13.736,100.509],[13.737,100.506],[13.742,100.501],[13.747,100.504],[13.738,100.515],[13.736,100.516],[13.731,100.515],[13.73,100.513]],[[13.72,100.553],[13.718,100.552],[13.719,100.549],[13.711,100.542],[13.705,100.544],[13.703,100.54],[13.705,100.533],[13.701,100.531],[13.699,100.528],[13.704,100.521],[13.705,100.515],[13.71,100.517],[13.711,100.509],[13.716,100.511],[13.719,100.512],[13.718,100.518],[13.726,100.544],[13.72,100.553]],[[13.931,100.642],[13.93,100.665],[13.926,100.689],[13.922,100.687],[13.916,100.687],[13.913,100.684],[13.909,100.687],[13.904,100.689],[13.899,100.692],[13.893,100.692],[13.887,100.692],[13.883,100.69],[13.879,100.689],[13.874,100.684],[13.88,100.681],[13.879,100.676],[13.881,100.674],[13.881,100.67],[13.88,100.667],[13.879,100.663],[13.883,100.656],[13.886,100.654],[13.884,100.653],[13.883,100.643],[13.887,100.64],[13.885,100.634],[13.885,100.628],[13.883,100.624],[13.884,100.619],[13.886,100.614],[13.889,100.609],[13.896,100.609],[13.95,100.624],[13.939,100.625],[13.932,100.64],[13.931,100.642]],[[13.738,100.359],[13.706,100.375],[13.688,100.382],[13.671,100.385],[13.67,100.379],[13.664,100.367],[13.661,100.359],[13.659,100.355],[13.656,100.35],[13.655,100.347],[13.656,100.339],[13.661,100.341],[13.67,100.339],[13.682,100.334],[13.694,100.332],[13.704,100.332],[13.707,100.333],[13.712,100.333],[13.711,100.337],[13.715,100.338],[13.719,100.335],[13.723,100.337],[13.728,100.336],[13.735,100.337],[13.737,100.347],[13.738,100.357],[13.738,100.359]],[[13.903,100.909],[13.876,100.906],[13.861,100.906],[13.859,100.905],[13.849,100.902],[13.842,100.91],[13.809,100.934],[13.801,100.928],[13.792,100.913],[13.778,100.903],[13.764,100.895],[13.739,100.88],[13.739,100.875],[13.745,100.871],[13.755,100.866],[13.764,100.865],[13.77,100.86],[13.771,100.844],[13.768,100.837],[13.772,100.829],[13.78,100.823],[13.784,100.815],[13.782,100.808],[13.783,100.797],[13.785,100.794],[13.794,100.795],[13.801,100.8],[13.808,100.807],[13.809,100.803],[13.816,100.802],[13.822,100.802],[13.826,100.805],[13.83,100.806],[13.842,100.807],[13.851,100.809],[13.85,100.799],[13.879,100.788],[13.884,100.792],[13.887,100.794],[13.891,100.797],[13.893,100.796],[13.897,100.793],[13.931,100.793],[13.936,100.836],[13.944,100.895],[13.936,100.913],[13.903,100.909]],[[13.89,100.584],[13.889,100.588],[13.889,100.59],[13.885,100.592],[13.882,100.589],[13.878,100.588],[13.872,100.588],[13.871,100.587],[13.866,100.587],[13.862,100.587],[13.858,100.586],[13.858,100.581],[13.857,100.575],[13.857,100.573],[13.856,100.567],[13.855,100.565],[13.854,100.558],[13.852,100.552],[13.85,100.544],[13.914,100.561],[13.911,100.567],[13.908,100.569],[13.904,100.579],[13.891,100.583],[13.89,100.584]],[[13.803,100.588],[13.798,100.589],[13.792,100.59],[13.787,100.59],[13.782,100.592],[13.777,100.594],[13.773,100.593],[13.766,100.595],[13.764,100.595],[13.761,100.596],[13.755,100.6],[13.75,100.603],[13.747,100.6],[13.742,100.593],[13.745,100.576],[13.747,100.567],[13.758,100.565],[13.762,100.567],[13.771,100.573],[13.801,100.576],[13.802,100.579],[13.802,100.581],[13.803,100.583],[13.803,100.588]],[[13.89,100.331],[13.887,100.325],[13.89,100.321],[13.881,100.32],[13.886,100.31],[13.885,100.299],[13.876,100.295],[13.887,100.289],[13.912,100.277],[13.921,100.266],[13.944,100.284],[13.982,100.274],[13.993,100.268],[14.009,100.266],[14.031,100.272],[14.055,100.273],[14.07,100.274],[14.077,100.275],[14.103,100.277],[14.139,100.296],[14.133,100.313],[14.129,100.332],[14.123,100.34],[14.102,100.342],[14.087,100.338],[14.06,100.332],[14.038,100.337],[14.018,100.346],[13.997,100.35],[13.973,100.356],[13.942,100.35],[13.924,100.333],[13.915,100.327],[13.905,100.328],[13.894,100.329],[13.89,100.331]],[[13.837,100.425],[13.83,100.435],[13.828,100.443],[13.831,100.457],[13.826,100.467],[13.83,100.471],[13.833,100.474],[13.83,100.479],[13.824,100.482],[13.826,100.487],[13.819,100.491],[13.819,100.502],[13.816,100.506],[13.81,100.512],[13.792,100.477],[13.794,100.469],[13.798,100.46],[13.8,100.426],[13.802,100.391],[13.803,100.359],[13.825,100.332],[13.821,100.349],[13.822,100.372],[13.831,100.399],[13.826,100.402],[13.828,100.411],[13.83,100.415],[13.831,100.417],[13.833,100.419],[13.834,100.421],[13.835,100.422],[13.836,100.423],[13.837,100.425]],[[13.985,100.397],[13.983,100.401],[13.985,100.409],[13.983,100.417],[13.979,100.42],[13.976,100.424],[13.97,100.428],[13.968,100.431],[13.964,100.435],[13.958,100.44],[13.953,100.444],[13.947,100.45],[13.93,100.445],[13.92,100.446],[13.898,100.445],[13.894,100.449],[13.887,100.45],[13.885,100.448],[13.881,100.448],[13.878,100.449],[13.876,100.448],[13.873,100.447],[13.872,100.443],[13.87,100.433],[13.863,100.429],[13.866,100.424],[13.871,100.421],[13.88,100.415],[13.888,100.399],[13.895,100.386],[13.904,100.376],[13.889,100.362],[13.89,100.351],[13.888,100.332],[13.894,100.329],[13.905,100.328],[13.915,100.327],[13.924,100.333],[13.942,100.35],[13.973,100.356],[13.997,100.35],[13.992,100.364],[13.986,100.394],[13.985,100.397]],[[13.892,100.397],[13.882,100.41],[13.873,100.42],[13.866,100.423],[13.863,100.428],[13.87,100.433],[13.871,100.444],[13.864,100.448],[13.858,100.443],[13.85,100.442],[13.838,100.434],[13.836,100.425],[13.836,100.423],[13.835,100.422],[13.834,100.421],[13.833,100.419],[13.831,100.417],[13.83,100.415],[13.828,100.411],[13.826,100.402],[13.831,100.399],[13.822,100.372],[13.821,100.349],[13.825,100.332],[13.844,100.31],[13.864,100.3],[13.883,100.298],[13.885,100.304],[13.881,100.311],[13.886,100.319],[13.889,100.324],[13.887,100.33],[13.892,100.346],[13.89,100.357],[13.895,100.362],[13.897,100.379],[13.894,100.393],[13.892,100.397]],[[13.986,100.415],[13.981,100.435],[13.967,100.454],[13.971,100.464],[13.961,100.476],[13.955,100.481],[13.947,100.487],[13.945,100.487],[13.941,100.492],[13.941,100.494],[13.939,100.497],[13.937,100.5],[13.941,100.505],[13.944,100.513],[13.945,100.53],[13.953,100.539],[13.956,100.542],[13.954,100.542],[13.954,100.544],[13.953,100.546],[13.952,100.549],[13.951,100.553],[13.951,100.555],[13.951,100.559],[13.949,100.561],[13.95,100.563],[13.95,100.566],[13.877,100.55],[13.88,100.545],[13.885,100.53],[13.891,100.506],[13.894,100.502],[13.895,100.497],[13.886,100.485],[13.889,100.48],[13.892,100.474],[13.893,100.464],[13.889,100.455],[13.894,100.449],[13.898,100.445],[13.92,100.446],[13.93,100.445],[13.947,100.45],[13.953,100.444],[13.958,100.44],[13.964,100.435],[13.968,100.431],[13.97,100.428],[13.976,100.424],[13.979,100.42],[13.983,100.417],[13.985,100.409],[13.983,100.401],[13.985,100.397],[13.991,100.385],[13.986,100.415]],[[13.895,100.499],[13.893,100.504],[13.887,100.52],[13.881,100.54],[13.878,100.549],[13.85,100.543],[13.845,100.535],[13.838,100.527],[13.835,100.523],[13.829,100.517],[13.827,100.515],[13.825,100.513],[13.826,100.511],[13.825,100.509],[13.824,100.51],[13.822,100.508],[13.817,100.505],[13.819,100.501],[13.819,100.491],[13.826,100.487],[13.824,100.481],[13.831,100.479],[13.832,100.473],[13.83,100.47],[13.825,100.466],[13.831,100.456],[13.828,100.442],[13.832,100.431],[13.844,100.442],[13.854,100.442],[13.86,100.447],[13.868,100.448],[13.872,100.446],[13.874,100.449],[13.878,100.448],[13.881,100.448],[13.883,100.447],[13.887,100.45],[13.89,100.454],[13.893,100.463],[13.892,100.474],[13.889,100.48],[13.886,100.485],[13.895,100.496],[13.895,100.499]],[[13.702,100.829],[13.688,100.859],[13.679,100.858],[13.67,100.859],[13.665,100.853],[13.661,100.85],[13.654,100.848],[13.649,100.848],[13.645,100.852],[13.639,100.848],[13.632,100.842],[13.631,100.84],[13.628,100.839],[13.625,100.838],[13.62,100.837],[13.618,100.839],[13.616,100.842],[13.61,100.84],[13.605,100.842],[13.601,100.84],[13.596,100.837],[13.584,100.832],[13.578,100.83],[13.575,100.829],[13.574,100.824],[13.574,100.822],[13.571,100.824],[13.57,100.828],[13.565,100.826],[13.567,100.816],[13.57,100.809],[13.562,100.804],[13.567,100.797],[13.554,100.792],[13.549,100.789],[13.55,100.786],[13.549,100.782],[13.557,100.763],[13.581,100.768],[13.586,100.771],[13.59,100.77],[13.596,100.778],[13.599,100.779],[13.602,100.782],[13.605,100.783],[13.61,100.784],[13.615,100.786],[13.619,100.785],[13.636,100.783],[13.651,100.785],[13.67,100.791],[13.676,100.786],[13.675,100.779],[13.674,100.772],[13.676,100.763],[13.69,100.772],[13.701,100.779],[13.706,100.785],[13.71,100.781],[13.708,100.812],[13.702,100.829]],[[13.645,100.963],[13.62,100.946],[13.599,100.928],[13.595,100.921],[13.592,100.912],[13.592,100.907],[13.581,100.907],[13.578,100.912],[13.571,100.915],[13.564,100.91],[13.557,100.906],[13.557,100.9],[13.564,100.891],[13.563,100.889],[13.558,100.889],[13.557,100.886],[13.548,100.88],[13.539,100.877],[13.528,100.874],[13.522,100.873],[13.516,100.872],[13.507,100.873],[13.49,100.871],[13.486,100.864],[13.475,100.847],[13.477,100.836],[13.48,100.827],[13.483,100.817],[13.486,100.813],[13.485,100.802],[13.486,100.794],[13.487,100.791],[13.49,100.779],[13.504,100.783],[13.509,100.784],[13.513,100.787],[13.516,100.784],[13.516,100.78],[13.52,100.777],[13.528,100.764],[13.535,100.767],[13.541,100.769],[13.547,100.772],[13.552,100.78],[13.55,100.783],[13.552,100.787],[13.549,100.79],[13.561,100.794],[13.562,100.802],[13.568,100.807],[13.57,100.812],[13.565,100.823],[13.566,100.829],[13.571,100.826],[13.573,100.822],[13.574,100.824],[13.575,100.829],[13.578,100.83],[13.581,100.832],[13.594,100.835],[13.6,100.84],[13.603,100.842],[13.609,100.84],[13.615,100.842],[13.618,100.839],[13.619,100.837],[13.624,100.838],[13.627,100.839],[13.631,100.84],[13.632,100.841],[13.639,100.847],[13.64,100.851],[13.649,100.848],[13.654,100.847],[13.66,100.85],[13.664,100.853],[13.669,100.857],[13.678,100.858],[13.687,100.859],[13.689,100.88],[13.672,100.928],[13.666,100.946],[13.66,100.953],[13.653,100.953],[13.646,100.956],[13.645,100.963]],[[13.718,100.73],[13.716,100.76],[13.716,100.771],[13.717,100.78],[13.708,100.783],[13.703,100.782],[13.695,100.775],[13.686,100.77],[13.675,100.767],[13.675,100.775],[13.676,100.783],[13.677,100.79],[13.665,100.793],[13.644,100.778],[13.628,100.783],[13.617,100.786],[13.613,100.785],[13.608,100.783],[13.604,100.782],[13.601,100.781],[13.597,100.779],[13.597,100.772],[13.589,100.771],[13.585,100.77],[13.56,100.763],[13.553,100.774],[13.546,100.772],[13.541,100.769],[13.535,100.766],[13.526,100.764],[13.524,100.759],[13.525,100.753],[13.53,100.717],[13.535,100.689],[13.537,100.687],[13.541,100.686],[13.545,100.685],[13.552,100.687],[13.554,100.69],[13.565,100.677],[13.572,100.677],[13.576,100.676],[13.583,100.674],[13.589,100.675],[13.593,100.673],[13.601,100.671],[13.607,100.668],[13.614,100.669],[13.617,100.662],[13.619,100.652],[13.622,100.644],[13.625,100.637],[13.631,100.63],[13.642,100.637],[13.652,100.65],[13.667,100.653],[13.672,100.657],[13.671,100.662],[13.665,100.672],[13.663,100.676],[13.656,100.696],[13.664,100.7],[13.675,100.705],[13.687,100.708],[13.701,100.711],[13.71,100.711],[13.718,100.72],[13.718,100.73]],[[13.671,100.581],[13.64,100.591],[13.63,100.583],[13.636,100.571],[13.634,100.564],[13.629,100.562],[13.626,100.56],[13.624,100.557],[13.621,100.554],[13.614,100.547],[13.612,100.545],[13.611,100.543],[13.608,100.54],[13.605,100.536],[13.603,100.533],[13.605,100.523],[13.61,100.52],[13.612,100.518],[13.614,100.517],[13.618,100.516],[13.621,100.516],[13.625,100.515],[13.629,100.514],[13.635,100.518],[13.639,100.517],[13.644,100.518],[13.648,100.519],[13.653,100.517],[13.666,100.518],[13.667,100.518],[13.668,100.52],[13.669,100.521],[13.671,100.521],[13.672,100.522],[13.675,100.522],[13.678,100.523],[13.669,100.54],[13.676,100.55],[13.692,100.552],[13.705,100.554],[13.706,100.562],[13.698,100.581],[13.688,100.589],[13.677,100.586],[13.671,100.581]],[[13.612,100.566],[13.598,100.592],[13.56,100.577],[13.541,100.597],[13.538,100.587],[13.534,100.586],[13.521,100.579],[13.515,100.572],[13.512,100.568],[13.508,100.561],[13.505,100.555],[13.504,100.549],[13.503,100.536],[13.503,100.528],[13.502,100.52],[13.502,100.515],[13.501,100.503],[13.502,100.494],[13.498,100.485],[13.497,100.471],[13.5,100.47],[13.5,100.467],[13.5,100.465],[13.499,100.462],[13.499,100.461],[13.5,100.459],[13.499,100.458],[13.499,100.457],[13.5,100.457],[13.5,100.456],[13.513,100.452],[13.535,100.448],[13.55,100.445],[13.559,100.445],[13.582,100.447],[13.587,100.447],[13.589,100.448],[13.592,100.449],[13.596,100.451],[13.599,100.452],[13.604,100.454],[13.606,100.454],[13.605,100.456],[13.605,100.458],[13.605,100.462],[13.604,100.465],[13.602,100.466],[13.598,100.467],[13.594,100.469],[13.599,100.473],[13.602,100.477],[13.599,100.477],[13.598,100.481],[13.592,100.484],[13.588,100.49],[13.587,100.492],[13.59,100.498],[13.594,100.499],[13.596,100.502],[13.598,100.506],[13.6,100.513],[13.605,100.523],[13.604,100.534],[13.606,100.537],[13.608,100.54],[13.611,100.543],[13.613,100.546],[13.615,100.549],[13.612,100.566]],[[13.664,100.592],[13.661,100.597],[13.661,100.602],[13.659,100.609],[13.663,100.613],[13.661,100.616],[13.658,100.621],[13.65,100.635],[13.653,100.64],[13.653,100.643],[13.642,100.637],[13.631,100.63],[13.625,100.637],[13.622,100.644],[13.619,100.652],[13.617,100.662],[13.614,100.669],[13.607,100.668],[13.601,100.671],[13.593,100.673],[13.589,100.675],[13.583,100.674],[13.576,100.676],[13.572,100.677],[13.565,100.677],[13.554,100.69],[13.552,100.687],[13.545,100.685],[13.541,100.686],[13.537,100.687],[13.535,100.689],[13.53,100.717],[13.525,100.753],[13.524,100.759],[13.52,100.777],[13.516,100.78],[13.516,100.784],[13.513,100.787],[13.509,100.784],[13.504,100.783],[13.49,100.779],[13.492,100.768],[13.494,100.761],[13.495,100.752],[13.497,100.743],[13.497,100.741],[13.499,100.729],[13.5,100.723],[13.501,100.714],[13.503,100.704],[13.507,100.688],[13.509,100.68],[13.511,100.674],[13.515,100.661],[13.516,100.655],[13.518,100.647],[13.52,100.645],[13.518,100.643],[13.519,100.642],[13.519,100.641],[13.526,100.627],[13.529,100.624],[13.53,100.623],[13.535,100.616],[13.542,100.596],[13.564,100.576],[13.604,100.592],[13.613,100.561],[13.621,100.555],[13.624,100.559],[13.626,100.561],[13.631,100.562],[13.636,100.566],[13.633,100.574],[13.629,100.587],[13.65,100.593],[13.664,100.592]]];   // เส้นเขต/อำเภอ (พื้นหลังจางๆ)
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
async function renderParamMap(P, S, title) {
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
  // ลายจุดจางๆ บนพื้นดิน + คลื่นในทะเล
  ctx.fillStyle = 'rgba(100,116,139,0.18)';
  for (let yy = 12; yy < Y(13.53); yy += 22) for (let xx = (yy / 22 % 2) * 11 + 6; xx < W; xx += 22) { ctx.beginPath(); ctx.arc(xx, yy, 1.6, 0, 7); ctx.fill(); }
  ctx.strokeStyle = 'rgba(59,130,246,0.25)'; ctx.lineWidth = 2;
  for (let yy = Y(13.53) + 20; yy < H; yy += 24) for (let xx = ((yy / 24) % 2) * 40; xx < W; xx += 80) { ctx.beginPath(); ctx.moveTo(xx, yy); ctx.quadraticCurveTo(xx + 10, yy - 6, xx + 20, yy); ctx.quadraticCurveTo(xx + 30, yy + 6, xx + 40, yy); ctx.stroke(); }
  // ชื่อพื้นที่รอบนอก
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(71,85,105,0.55)'; ctx.font = '26px TurSarabunBold';
  ctx.fillText('ปทุมธานี', X(100.735), Y(13.985)); ctx.fillText('สมุทรสาคร', 76, Y(13.63));
  ctx.fillStyle = 'rgba(37,99,235,0.55)'; ctx.font = '30px TurSarabunBold'; ctx.fillText('อ่าวไทย', X(100.62), Y(13.497));
  const ring = (pts) => { ctx.beginPath(); pts.forEach(([la, lo], i) => i ? ctx.lineTo(X(lo), Y(la)) : ctx.moveTo(X(lo), Y(la))); ctx.closePath(); };
  // พื้นที่สาขา ลงสีตามภาค + เส้นขอบสาขาสีขาว
  for (const b of TUR_BRANCH_POLY) {
    const ri = regOf(b.n), col = ri >= 0 ? TUR_REGIONS[ri].col : '#94a3b8';
    ring(b.c); ctx.globalAlpha = 0.40; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  // เส้นเขต/อำเภอ (จางๆ ให้เห็นรายละเอียดพื้นที่)
  ctx.setLineDash([5, 5]); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(51,65,85,0.28)';
  for (const r of TUR_DISTRICTS) { ring(r); ctx.stroke(); }
  ctx.setLineDash([]);
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
  const fill = v => WQ_HEX[wqCls(P, v)];
  // จุดสถานี (สถานีน้ำออกโรงงาน = สี่เหลี่ยม) — สี = ค่าเฉลี่ย, วงส้ม = มีช่วงเกิน 4 NTU
  const risk = d => d ? (P.risk === 'min' ? -d.min : d.max) : -1e9;
  const ids = Object.keys(TUR_STATIONS).sort((a, b) => risk(S[a]) - risk(S[b]));
  for (const id of ids) {
    const [, , la, lo] = TUR_STATIONS[id]; if (la == null) continue;
    const x = X(lo), y = Y(la), d = S[id];
    if (d && P.exceed(d)) { ctx.beginPath(); ctx.arc(x, y, 17, 0, 7); ctx.fillStyle = '#f97316'; ctx.fill(); }
    ctx.beginPath();
    if (TUR_PLANT_IDS.includes(id)) ctx.rect(x - 10, y - 10, 20, 20); else ctx.arc(x, y, 11, 0, 7);
    ctx.fillStyle = fill(d && d.avg); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  }
  // ป้ายภาค: ตำแหน่ง = จุดกลางของสาขาที่ใหญ่ที่สุดในภาค (กำหนดเองให้ไม่ทับจุด)
  // [lat, lon ของป้าย, (lat, lon จุดชี้ ถ้าป้ายอยู่นอกพื้นที่)]
  const LABEL = [[13.505, 100.800], [14.052, 100.640, 13.790, 100.575], [13.905, 100.860], [13.545, 100.330], [14.052, 100.420]];
  TUR_REGIONS.forEach((r, i) => {
    const g = wqGroup(P, turRegionIds(r), S); const [la, lo, ala, alo] = LABEL[i];
    const vt = wqFmt(P, g.avg); ctx.font = '42px TurSarabunBold'; const vw = ctx.measureText(vt).width;
    ctx.font = '20px TurSarabunBold'; const uw = ctx.measureText(P.unit).width;
    const x = X(lo), y = Y(la), w = Math.max(236, 100 + vw + 6 + uw + 18), h = 92;
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
    ctx.fillText(vt, x - w / 2 + 94, y + 20);
    ctx.fillStyle = '#64748b'; ctx.font = '20px TurSarabunBold'; ctx.fillText(P.unit, x - w / 2 + 100 + vw, y + 26);
  });
  // ทิศเหนือ + มาตราส่วน
  { const nx = 60, ny = Y(13.74);
    ctx.fillStyle = '#334155'; ctx.beginPath(); ctx.moveTo(nx, ny - 34); ctx.lineTo(nx + 14, ny + 6); ctx.lineTo(nx, ny - 4); ctx.lineTo(nx - 14, ny + 6); ctx.closePath(); ctx.fill();
    ctx.font = '22px TurSarabunBold'; ctx.textAlign = 'center'; ctx.fillText('N', nx, ny - 48);
    const px5 = X(100.245 + 5 / (111.32 * k)) - X(100.245), sx = 30, sy = ny + 50;
    ctx.fillStyle = '#334155'; ctx.fillRect(sx, sy, px5, 6); ctx.fillStyle = '#ffffff'; ctx.fillRect(sx + px5 / 2, sy + 1, px5 / 2 - 1, 4);
    ctx.fillStyle = '#334155'; ctx.font = '18px TurSarabun'; ctx.fillText('5 กม.', sx + px5 / 2, sy + 24); }
  // หัวเรื่อง + คำอธิบาย
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const ttl = `${P.short}เฉลี่ยรายภาค (${P.unit})`; ctx.font = '32px TurSarabunBold'; const tw = Math.max(ctx.measureText(ttl).width, 300) + 36;
  ctx.font = '28px TurSarabunBold'; const tw2 = ctx.measureText('🕗 ' + title).width + 36; ctx.font = '32px TurSarabunBold';
  ctx.globalAlpha = 0.94; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(18, 18, Math.max(tw, tw2), 104, 14); ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = '#0f172a'; ctx.fillText(ttl, 34, 55);
  ctx.fillStyle = '#fef3c7'; ctx.beginPath(); ctx.roundRect(28, 70, Math.max(tw, tw2) - 20, 42, 10); ctx.fill();
  ctx.fillStyle = '#92400e'; ctx.font = '28px TurSarabunBold'; ctx.fillText(title, 40, 100);
  const lg = [[WQ_HEX.g, P.legend[0]], [WQ_HEX.y, P.legend[1]], [WQ_HEX.r, P.legend[2]], ['#f97316', P.ringLabel]];
  ctx.globalAlpha = 0.92; ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(W - 288, 18, 270, 280, 14); ctx.fill(); ctx.globalAlpha = 1;
  lg.forEach(([c, t], i) => {
    const y = 54 + i * 42;
    ctx.beginPath(); ctx.arc(W - 260, y, 12, 0, 7);
    if (i === 3) { ctx.lineWidth = 6; ctx.strokeStyle = c; ctx.stroke(); } else { ctx.fillStyle = c; ctx.fill(); }
    ctx.fillStyle = '#0f172a'; ctx.font = '26px TurSarabun'; ctx.fillText(t, W - 236, y + 9);
  });
  ctx.fillStyle = '#64748b'; ctx.fillRect(W - 270, 214, 20, 20); ctx.font = '24px TurSarabun'; ctx.fillStyle = '#0f172a'; ctx.fillText('น้ำออกโรงงาน', W - 236, 232);
  ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.arc(W - 260, 266, 10, 0, 7); ctx.fill(); ctx.fillStyle = '#0f172a'; ctx.fillText('สถานีระบบจ่าย', W - 236, 274);
  return cv.toBuffer('image/png');
}
async function renderTurbidityMap(S, title) { return renderParamMap(WQP.tub, S, title); }

const TUR_PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://frc-line-bot-production.up.railway.app');
const turRangeTitle = dayOffset => { const st = bkkMidnight(dayOffset), d = thaiDate(new Date(st + 12 * 3600e3)); return dayOffset < 0 ? `${d} (ทั้งวัน)` : `${d} · 0.00 – ${thaiTime()} น.`; };

// 📊 เมนูเลือกรายงานคุณภาพน้ำ
async function replyWaterQualityMenu(replyToken) {
  const item = (emoji, title, sub, text, bg, col) => ({
    type: 'box', layout: 'horizontal', margin: 'sm', paddingAll: '12px', cornerRadius: '10px', backgroundColor: bg,
    action: { type: 'message', label: title, text },
    contents: [
      { type: 'text', text: emoji, size: 'xxl', flex: 0, gravity: 'center' },
      { type: 'box', layout: 'vertical', flex: 5, margin: 'lg', contents: [
        { type: 'text', text: title, size: 'md', weight: 'bold', color: col },
        { type: 'text', text: sub, size: 'xxs', color: COLORS.textSecondary, wrap: true },
      ] },
      { type: 'text', text: '›', size: 'xl', color: col, flex: 0, gravity: 'center' },
    ],
  });
  const flex = {
    type: 'flex', altText: '📊 รายงานคุณภาพน้ำ — เลือก คลอรีน / ความขุ่น / ความนำไฟฟ้า',
    contents: { type: 'bubble', size: 'mega',
      header: turHeader('📊 รายงานคุณภาพน้ำ', 'เลือกพารามิเตอร์ที่ต้องการดู'),
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
        item('🧪', 'คลอรีนอิสระคงเหลือ (FRC)', 'ค่าเฉลี่ยวันนี้ · โรงงานผลิตน้ำ · บริการ 1–5 · แผนที่', 'สรุปคลอรีน', '#fef2f2', '#be123c'),
        item('💧', 'ความขุ่น (Turbidity)', 'ค่าเฉลี่ยวันนี้ · โรงงานผลิตน้ำ · บริการ 1–5 · แผนที่', 'สรุปความขุ่น', '#eff6ff', '#1d4ed8'),
        item('⚡', 'ความนำไฟฟ้า (EC)', 'ค่าเฉลี่ยวันนี้ · โรงงานผลิตน้ำ · บริการ 1–5 · แผนที่', 'สรุป EC', '#fefce8', '#a16207'),
      ] },
    },
  };
  return lineReply(replyToken, [{ ...flex, quickReply: { items: [
    { type: 'action', action: { type: 'message', label: '🧪 คลอรีน', text: 'สรุปคลอรีน' } },
    { type: 'action', action: { type: 'message', label: '💧 ความขุ่น', text: 'สรุปความขุ่น' } },
    { type: 'action', action: { type: 'message', label: '⚡ ความนำไฟฟ้า', text: 'สรุป EC' } },
  ] } }]);
}

const turRegionBtn = (r, i, dayOffset) => ({ type: 'button', style: 'primary', height: 'sm', color: r.col, flex: 1,
  action: { type: 'message', label: r.name, text: `ขุ่นบริการ ${i + 1}${dayOffset < 0 ? ' เมื่อวาน' : ''}` } });

// รายละเอียดบริการ N: ทุกสถานีในพื้นที่สาขาของภาค (แยกตามสาขา) — ไม่รวมสถานีน้ำออกโรงงาน
async function replyTurbidityRegion(replyToken, idx, dayOffset = 0) { return replyParamRegion(replyToken, 'tub', idx, dayOffset); }

async function replyTurbiditySummary(replyToken, dayOffset = 0) { return replyParamSummary(replyToken, 'tub', dayOffset); }

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 สรุปคุณภาพน้ำ — ตัวกลางใช้ร่วม 3 พารามิเตอร์ (ความขุ่น / คลอรีน / ความนำไฟฟ้า)
// เกณฑ์ 3 สีตาม TWQMS (คำอธิบายเกณฑ์วัดคุณภาพน้ำ):
//   ความขุ่น  : เขียว ≤4 · เหลือง >4–5 · แดง >5 NTU
//   คลอรีน    : เขียว 0.20–2.00 · เหลือง <0.2 หรือ >2–5 · แดง ไม่พบ (<0.01) หรือ >5 mg/L
//   ความนำไฟฟ้า: เขียว ≤500 · เหลือง 501–1,200 · แดง >1,200 µS/cm
// ข้อมูล: ความขุ่น = history_wq/{สถานี}/{ts}.tub · คลอรีน/EC = history/{สถานี}/{ts}.frc/.ec (collector ทุก 15 นาที)
// ═══════════════════════════════════════════════════════════════════════════════
const WQP = {
  tub: { key: 'tub', node: 'history_wq', field: 'tub', short: 'ความขุ่น', title: '💧 ความขุ่นน้ำประปา', rTitle: 'รายงานความขุ่นน้ำประปาเฉลี่ย', en: 'Turbidity', unit: 'NTU', dec: 2,
    cls: v => v < 1 ? 'g' : v <= 4 ? 'y' : 'r', valid: v => v > 0 && v < 1000,   // เกณฑ์ กปน. (ต.ค.69): เขียว <1 · เหลือง 1–4 · แดง >4 NTU   // 0.00 พอดี = เซนเซอร์ error/ไม่มีข้อมูล
    risk: 'max', exceed: d => d.max > 4, exceedText: 'ค่าสูงสุดเกิน 4 NTU', ringLabel: 'มีช่วงเกิน 4',
    legend: ['< 1', '1–4', '> 4'], cnt: ['เขียว <1', 'เหลือง 1–4', 'แดง >4'], pass: '<1 NTU',
    cmd: 'สรุปความขุ่น', yCmd: 'ขุ่นเมื่อวาน', regionCmd: 'ขุ่นบริการ', plantCmd: 'ขุ่นโรงงาน', pumpCmd: 'ขุ่นสูบจ่าย', since: 'เริ่มเก็บข้อมูลความขุ่นตั้งแต่ 3 ต.ค. 69 16:12 น.' },
  frc: { key: 'frc', node: 'history', field: 'frc', short: 'คลอรีน', title: '🧪 คลอรีนอิสระคงเหลือ', rTitle: 'รายงานคลอรีนอิสระคงเหลือเฉลี่ย', en: 'FRC', unit: 'mg/L', dec: 2,
    cls: v => (v < 0.01 || v > 5) ? 'r' : (v < 0.2 || v > 2) ? 'y' : 'g', valid: v => v > 0 && v < 20,   // 0.00 พอดี = เซนเซอร์ error (TWQMS แสดง E) / poll.yml เขียน 0 แทนค่าว่าง → ไม่นำมาคำนวณ
    risk: 'min', exceed: d => d.min < 0.2 || d.max > 2, exceedText: 'มีช่วงนอกเกณฑ์ 0.2–2.0 mg/L', ringLabel: 'มีช่วงนอก 0.2–2',
    legend: ['0.2–2.0', '<0.2 / 2–5', 'ไม่พบ / >5'], cnt: ['เขียว 0.2–2', 'เหลือง', 'แดง'], pass: '0.2–2.0 mg/L',
    cmd: 'สรุปคลอรีน', yCmd: 'คลอรีนเมื่อวาน', regionCmd: 'คลอรีนบริการ', plantCmd: 'คลอรีนโรงงาน', pumpCmd: 'คลอรีนสูบจ่าย', since: 'ข้อมูลย้อนหลังเก็บ 7 วัน' },
  ec: { key: 'ec', node: 'history', field: 'ec', short: 'ความนำไฟฟ้า', title: '⚡ ความนำไฟฟ้า', rTitle: 'รายงานความนำไฟฟ้าเฉลี่ย', en: 'EC', unit: 'µS/cm', dec: 0,
    cls: v => v <= 500 ? 'g' : v <= 1200 ? 'y' : 'r', valid: v => v > 0 && v < 100000,
    risk: 'max', exceed: d => d.max > 500, exceedText: 'ค่าสูงสุดเกิน 500 µS/cm', ringLabel: 'มีช่วงเกิน 500',
    legend: ['≤ 500', '501–1,200', '> 1,200'], cnt: ['เขียว ≤500', 'เหลือง ≤1,200', 'แดง >1,200'], pass: '≤500 µS/cm',
    cmd: 'สรุป EC', yCmd: 'ECเมื่อวาน', regionCmd: 'ECบริการ', plantCmd: 'ECโรงงาน', pumpCmd: 'ECสูบจ่าย', since: 'ข้อมูลย้อนหลังเก็บ 7 วัน' },
};
// แตะแผนที่ → รายงานเว็บของพารามิเตอร์นั้น (ความขุ่น/EC ดึงข้อมูลชุดเดียวกับบอทเองถ้ายังไม่นำเข้าไฟล์)
const WQ_WEB = 'https://piphatboribannukul.github.io/FRCfirebase/';
const wqReportUrl = (pk, d) => `${WQ_WEB}${{ frc: 'report_frc', ec: 'report_ec', tub: 'report_turbidity' }[pk] || 'report_turbidity'}.html?d=${d < 0 ? -1 : 0}`;
const WQ_HEX = { g: '#16a34a', y: '#f59e0b', r: '#dc2626', na: '#94a3b8' };
const wqCls = (P, v) => v == null ? 'na' : P.cls(v);
const wqColor = (P, v) => ({ g: COLORS.good, y: COLORS.warn, r: COLORS.bad, na: '#94a3b8' })[wqCls(P, v)];
const wqDot = (P, v) => ({ g: '🟢', y: '🟡', r: '🔴', na: '⚪' })[wqCls(P, v)];
const wqFmt = (P, v) => v == null ? '–' : P.dec === 0 ? Math.round(v).toLocaleString('en-US') : v.toFixed(P.dec);
const wqRiskVal = (P, d) => d == null ? null : (P.risk === 'min' ? d.min : d.max);
const wqShort = n => { if (n.length <= 30) return n; const c = n.slice(0, 30), sp = c.lastIndexOf(' '); return (sp > 15 ? c.slice(0, sp) : c).replace(/[\s(]+$/, '') + '…'; };
const wqRiskLabel = P => P.risk === 'min' ? 'ต่ำสุด' : 'สูงสุด';

// 🚫 สถานีที่ตัดออกจากการคำนวณ (เซนเซอร์เสีย/ค่าค้าง) — เก็บใน Firebase: wq_exclude/{tub|frc|ec}/{สถานี} = { reason, by, ts }
//    จัดการผ่าน LINE: "ตัดค่า คลอรีน ศิริราช" / "คืนค่า คลอรีน ศิริราช" / "รายการตัดค่า"
let _wqEx = { t: 0, v: {} };
async function getWqExclude() {
  if (Date.now() - _wqEx.t < 60000) return _wqEx.v;
  try { _wqEx = { t: Date.now(), v: (await db.ref('wq_exclude').once('value')).val() || {} }; } catch (e) { console.error('[WQ] exclude load', e.message); }
  return _wqEx.v;
}
const _wqCache = {};
async function loadParamStats(P, startTs, endTs) {
  const ck = `${P.key}-${startTs}-${endTs || ''}`, hit = _wqCache[ck];
  if (hit && Date.now() - hit.t < 120000) return hit.v;
  const out = {}, EX = (await getWqExclude())[P.key] || {};
  await Promise.all(Object.keys(TUR_STATIONS).filter(id => !EX[id]).map(async id => {
    try {
      // หลักท้ายชั่วโมง (hour-ending): ช่วงวัน = (00:00, 24:00] → ไม่รวมจุด 00:00 พอดีของวันนี้ (เป็นชั่วโมง 24:00 ของเมื่อวาน)
      let q = db.ref(`${P.node}/${id}`).orderByKey().startAt(String(startTs + 1));
      if (endTs) q = q.endAt(String(endTs));
      const v = (await q.once('value')).val() || {};
      // จัดกลุ่มรายชั่วโมงแบบ "ท้ายชั่วโมง": ชั่วโมง 01:00 = (00:00, 01:00] ฯลฯ → เฉลี่ยรายวัน = เฉลี่ยของค่าเฉลี่ยรายชั่วโมง
      //   สูงสุด/ต่ำสุด = จุดเดียวที่สูง/ต่ำที่สุดในช่วง (ไม่ขึ้นกับการจัดกลุ่ม)
      let n = 0, max = null, maxTs = 0, min = null, minTs = 0; const hb = {};
      for (const p of Object.values(v)) {
        if (!p) continue;
        const t = Number(p[P.field]);
        if (p[P.field] == null || !isFinite(t) || !P.valid(t)) continue;
        const hi = Math.ceil((Number(p.ts) - startTs) / 3600e3);   // 1..24
        (hb[hi] = hb[hi] || { s: 0, c: 0 }); hb[hi].s += t; hb[hi].c++; n++;
        if (max == null || t > max) { max = t; maxTs = p.ts; }
        if (min == null || t < min) { min = t; minTs = p.ts; }
      }
      const hv = Object.values(hb).map(b => b.s / b.c);
      if (n) out[id] = { avg: hv.reduce((a, x) => a + x, 0) / hv.length, max, maxTs, min, minTs, n, h: hv.length };
    } catch (e) { console.error(`[WQ:${P.key}] load`, id, e.message); }
  }));
  _wqCache[ck] = { t: Date.now(), v: out };
  return out;
}
function wqGroup(P, ids, S) {
  const d = ids.filter(id => S[id]);
  if (!d.length) return { avg: null, max: null, min: null, risk: null, n: 0, tot: ids.length };
  const avg = d.reduce((a, id) => a + S[id].avg, 0) / d.length;
  const maxId = d.reduce((a, b) => S[b].max > S[a].max ? b : a), minId = d.reduce((a, b) => S[b].min < S[a].min ? b : a);
  const riskId = P.risk === 'min' ? minId : maxId;
  return { avg, max: S[maxId].max, min: S[minId].min, risk: wqRiskVal(P, S[riskId]), riskId, n: d.length, tot: ids.length };
}
const wqRange = dayOffset => { const st = bkkMidnight(dayOffset); return { start: st, end: dayOffset < 0 ? bkkMidnight(dayOffset + 1) : null, label: thaiDate(new Date(st + 12 * 3600e3)) }; };
const wqSub = (P, dayOffset, label) => `${P.en} · ${dayOffset < 0 ? `${label} (ทั้งวัน)` : `${label} · 0.00–${thaiTime()} น.`}`;

async function replyParamSummary(replyToken, pk, dayOffset = 0) {
  const P = WQP[pk];
  const send = msgs => replyToken ? lineReply(replyToken, msgs) : msgs;   // replyToken = null → คืนข้อความ (ใช้ส่ง push/broadcast)
  try {
    const R = wqRange(dayOffset), S = await loadParamStats(P, R.start, R.end);
    if (!Object.keys(S).length)
      return send( withQuickReply([{ type: 'text', text: `${P.title.split(' ')[0]} ยังไม่มีข้อมูล${P.short}${dayOffset < 0 ? 'ของเมื่อวาน' : 'สะสมวันนี้'}\n(${P.since})` }]));
    const all = Object.keys(TUR_STATIONS), has = all.filter(id => S[id]);
    const cnt = ids => { const c = { g: 0, y: 0, r: 0, n: ids.length }; ids.forEach(id => { if (S[id]) c[P.cls(S[id].avg)]++; }); return c; };
    const C = cnt(all), total = has.length, pct = total ? Math.round(C.g / total * 100) : 0;
    let oe, ot, ob;
    if (C.r === 0 && C.y === 0) { oe = '🟢'; ot = 'ดี'; ob = '#ecfdf5'; }
    else if (C.r === 0)         { oe = '🟡'; ot = 'เฝ้าระวัง'; ob = '#fffbeb'; }
    else                        { oe = '🔴'; ot = 'ต้องติดตาม'; ob = '#fef2f2'; }
    const G = wqGroup(P, all, S);
    const f = v => wqFmt(P, v), RL = wqRiskLabel(P);
    const exceed = has.filter(id => P.exceed(S[id])).sort((a, b) => P.risk === 'min' ? S[a].min - S[b].min : S[b].max - S[a].max);

    const stat = (label, v) => ({ type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: label, size: 'xs', color: COLORS.textSecondary, flex: 4, gravity: 'center' },
      { type: 'text', text: f(v), size: 'md', weight: 'bold', color: wqColor(P, v), flex: 3, align: 'end', gravity: 'center' },
      { type: 'text', text: P.unit, size: 'xxs', color: COLORS.textMuted, flex: 0, align: 'end', gravity: 'center', margin: 'sm' } ] });
    const bigBlock = (icon, title, bg, hint, inner, action, headRow) => ({
      type: 'box', layout: 'vertical', margin: 'sm', paddingAll: '6px', paddingStart: '8px', paddingEnd: '8px', cornerRadius: '8px', backgroundColor: bg,
      contents: [
        headRow || { type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', ...(action ? { action } : {}), contents: [
          { type: 'image', url: icon, size: '28px', aspectMode: 'fit', aspectRatio: '1:1', flex: 0 },
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: COLORS.textPrimary, flex: 5, gravity: 'center' },
          ...(hint ? [{ type: 'text', text: hint, size: 'xxs', color: '#64748b', flex: 3, align: 'end', gravity: 'center' }] : []),
        ] },
        { type: 'box', layout: 'vertical', margin: 'xs', spacing: 'xs', contents: inner },
      ],
    });
    const plantCell = p => { const g = wqGroup(P, p.ids, S); return {
      type: 'box', layout: 'vertical', flex: 1, paddingAll: '4px', cornerRadius: '6px', backgroundColor: '#ffffffb3',
      action: { type: 'message', label: p.name, text: `${P.plantCmd}${dayOffset < 0 ? ' เมื่อวาน' : ''}` },
      contents: [
        { type: 'text', text: p.name.replace('รง.', ''), size: 'xxs', color: COLORS.textSecondary, align: 'center' },
        { type: 'text', text: f(g.avg), size: 'md', weight: 'bold', color: wqColor(P, g.avg), align: 'center' },
        { type: 'text', text: f(g.risk), size: 'xxs', color: wqColor(P, g.risk), align: 'center' },
      ] }; };
    // ตารางโรงงาน 3 แถว (ชื่อ / เฉลี่ย / สูงสุด) — ทุกแถวใช้คอลัมน์เดียวกัน จึงตรงกันพอดี
    const PG = TUR_PLANTS.map(p => wqGroup(P, p.ids, S));
    const lblW = { type: 'box', layout: 'vertical', width: '36px', flex: 0, contents: [] };
    const plantTable = { type: 'box', layout: 'vertical', cornerRadius: '6px', backgroundColor: '#ffffffb3', paddingAll: '4px', spacing: 'none',
      action: { type: 'message', label: 'โรงงานผลิตน้ำ', text: `${P.plantCmd}${dayOffset < 0 ? ' เมื่อวาน' : ''}` },
      contents: [
        { type: 'box', layout: 'horizontal', spacing: 'xs', contents: [lblW, ...TUR_PLANTS.map(p => ({ type: 'text', text: p.name.replace('รง.', ''), size: 'xxs', color: COLORS.textSecondary, align: 'center', flex: 1 }))] },
        { type: 'box', layout: 'horizontal', spacing: 'xs', contents: [
          { type: 'box', layout: 'vertical', flex: 0, width: '36px', justifyContent: 'center', contents: [{ type: 'text', text: 'เฉลี่ย', size: 'xxs', color: COLORS.textSecondary, align: 'end' }] },
          ...PG.map(g => ({ type: 'text', text: f(g.avg), size: 'md', weight: 'bold', color: wqColor(P, g.avg), align: 'center', gravity: 'center', flex: 1 }))] },
        { type: 'box', layout: 'horizontal', spacing: 'xs', contents: [
          { type: 'box', layout: 'vertical', flex: 0, width: '36px', justifyContent: 'center', contents: [{ type: 'text', text: RL, size: 'xxs', color: COLORS.textSecondary, align: 'end' }] },
          ...PG.map(g => ({ type: 'text', text: f(g.risk), size: 'xxs', color: wqColor(P, g.risk), align: 'center', gravity: 'center', flex: 1 }))] },
      ] };
    // หัวบล็อก = ไอคอน + ชื่อ + "เฉลี่ย / สูงสุด" ในบรรทัดเดียว (ประหยัดความสูง) — โครงเดียวกับแถวข้อมูลจึงตรงคอลัมน์
    //   แถวข้อมูล: [ป้าย 26px]? ชื่อ(4) จำนวน(3) เฉลี่ย(3) สูงสุด(3) › · ช่องว่างระหว่างช่อง = sm(4px)
    const colLbl = (t, extra = {}) => ({ type: 'text', text: t, size: 'xxs', color: COLORS.textSecondary, flex: 3, align: 'end', gravity: 'bottom', ...extra });
    const headCols = (icon, title, withBadge) => ({ type: 'box', layout: 'horizontal', paddingStart: '5px', paddingEnd: '5px', spacing: 'sm', alignItems: 'center', contents: withBadge ? [
        { type: 'box', layout: 'vertical', flex: 0, width: '26px', contents: [{ type: 'image', url: icon, size: '26px', aspectMode: 'fit', aspectRatio: '1:1' }] },
        { type: 'text', text: title, size: 'sm', weight: 'bold', color: COLORS.textPrimary, flex: 7, margin: 'md' },   // ชื่อ(4)+จำนวน(3) + ช่องว่างที่หายไป 1 ช่อง
        colLbl('เฉลี่ย'), colLbl(RL),
        { type: 'text', text: '›', size: 'sm', color: '#ffffff00', flex: 0 },
      ] : [
        { type: 'box', layout: 'horizontal', flex: 7, spacing: 'sm', alignItems: 'center', contents: [
          { type: 'image', url: icon, size: '26px', aspectMode: 'fit', aspectRatio: '1:1', flex: 0 },
          { type: 'text', text: title, size: 'sm', weight: 'bold', color: COLORS.textPrimary, flex: 1 } ] },
        colLbl('เฉลี่ย', { margin: 'md' }), colLbl(RL),
        { type: 'text', text: '›', size: 'sm', color: '#ffffff00', flex: 0 },
      ] });
    // สถานีสูบจ่าย: ฝั่งตะวันตก/ตะวันออก (แตะ → รายสถานี)
    const pumpLine = p => { const g = wqGroup(P, p.ids, S); return {
      type: 'box', layout: 'horizontal', paddingAll: '4px', paddingStart: '5px', paddingEnd: '5px', cornerRadius: '6px', backgroundColor: '#ffffffb3', spacing: 'sm',
      action: { type: 'message', label: p.name, text: `${P.pumpCmd}${dayOffset < 0 ? ' เมื่อวาน' : ''}` },
      contents: [
        { type: 'text', text: p.name, size: 'xs', color: COLORS.textPrimary, flex: 4, gravity: 'center' },
        { type: 'text', text: `${p.ids.length} สถานี`, size: 'xxs', color: COLORS.textMuted, flex: 3, gravity: 'center' },
        { type: 'text', text: f(g.avg), size: 'sm', weight: 'bold', color: wqColor(P, g.avg), flex: 3, align: 'end', gravity: 'center' },
        { type: 'text', text: f(g.risk), size: 'xxs', color: wqColor(P, g.risk), flex: 3, align: 'end', gravity: 'center' },
        { type: 'text', text: '›', size: 'sm', color: '#10b981', flex: 0, gravity: 'center' },
      ] }; };
    const regionLine = (r, i) => { const ids = turRegionIds(r), g = wqGroup(P, ids, S); return {
      type: 'box', layout: 'horizontal', paddingAll: '4px', paddingStart: '5px', paddingEnd: '5px', cornerRadius: '6px', backgroundColor: '#ffffffb3', spacing: 'sm',
      action: { type: 'message', label: r.name, text: `${P.regionCmd} ${i + 1}${dayOffset < 0 ? ' เมื่อวาน' : ''}` },
      contents: [
        { type: 'box', layout: 'vertical', flex: 0, width: '26px', height: '22px', cornerRadius: '6px', backgroundColor: r.col, justifyContent: 'center', alignItems: 'center',
          contents: [{ type: 'text', text: String(i + 1), size: 'xs', weight: 'bold', color: '#ffffff', align: 'center' }] },
        { type: 'text', text: r.name, size: 'xs', color: COLORS.textPrimary, flex: 4, gravity: 'center' },
        { type: 'text', text: `${ids.length} สถานี`, size: 'xxs', color: COLORS.textMuted, flex: 3, gravity: 'center' },
        { type: 'text', text: f(g.avg), size: 'sm', weight: 'bold', color: wqColor(P, g.avg), flex: 3, align: 'end', gravity: 'center' },
        { type: 'text', text: f(g.risk), size: 'xxs', color: wqColor(P, g.risk), flex: 3, align: 'end', gravity: 'center' },
        { type: 'text', text: '›', size: 'sm', color: '#a78bfa', flex: 0, gravity: 'center' },
      ] }; };

    // แถบช่วงเวลาข้อมูล (เด่น) — ให้รู้ชัดว่าเป็นข้อมูลช่วงไหนเท่านั้น
    const endT = dayOffset < 0 ? '24:00' : thaiTime().replace(/\s*น\.?$/, '');
    const spanMin = dayOffset < 0 ? 1440 : Math.max(0, Math.round((Date.now() - R.start) / 60000));
    const spanTxt = spanMin >= 1440 ? 'ทั้งวัน 24 ชั่วโมง' : `${Math.floor(spanMin / 60)} ชั่วโมง${spanMin % 60 ? ` ${spanMin % 60} นาที` : ''}`;
    const timeBar = { type: 'box', layout: 'horizontal', paddingAll: '8px', paddingStart: '10px', cornerRadius: '8px', backgroundColor: '#fef3c7', borderColor: '#f59e0b', borderWidth: '1px', margin: 'none', spacing: 'sm', contents: [
      { type: 'text', text: '🕗', size: 'xl', flex: 0, gravity: 'center' },
      { type: 'box', layout: 'vertical', flex: 5, contents: [
        { type: 'text', text: `ข้อมูลช่วง 00:00–${endT} น.`, size: 'md', weight: 'bold', color: '#92400e' },
        { type: 'text', text: `${R.label} · ${spanTxt}`, size: 'xxs', color: '#b45309' },
      ] } ] };
    const body = [
      timeBar,
      bigBlock(IMAGES.iconSend, 'โรงงานผลิตน้ำ', '#dbeafe', null, [plantTable,
        { type: 'text', text: 'แตะเพื่อดูรายสถานี ›', size: 'xxs', color: '#1d4ed8' }]),
      bigBlock(IMAGES.iconPump, 'สถานีสูบจ่ายน้ำ', '#d1fae5', null, [
        ...TUR_PUMPS.map(pumpLine),
        { type: 'text', text: 'แตะเพื่อดูรายสถานี ›', size: 'xxs', color: '#047857' },
      ], null, headCols(IMAGES.iconPump, 'สถานีสูบจ่ายน้ำ', false)),
      bigBlock(IMAGES.iconMonitor, 'น้ำในระบบจ่าย', '#ede9fe', null, [
        ...TUR_REGIONS.map(regionLine),
        { type: 'text', text: 'แตะแต่ละภาคเพื่อดูรายสถานี ›', size: 'xxs', color: '#7c3aed' },
      ], null, headCols(IMAGES.iconMonitor, 'น้ำในระบบจ่าย', true)),
    ];
    if (exceed.length) {
      body.push({ type: 'separator', margin: 'xs' });
      body.push({ type: 'box', layout: 'vertical', margin: 'xs', paddingAll: '8px', cornerRadius: '6px', backgroundColor: COLORS.bgWarm, contents: [
        { type: 'text', text: `⚠️ ต้องติดตาม — ${P.exceedText} (${exceed.length})`, size: 'xxs', weight: 'bold', color: COLORS.bad, wrap: true },
        ...exceed.slice(0, 5).map(id => { const d = S[id], v = wqRiskVal(P, d), out = P.risk === 'min' && d.min >= 0.2 ? d.max : v, ts = out === d.max ? d.maxTs : d.minTs;
          return { type: 'text', size: 'xxs', color: COLORS.textSecondary, wrap: true,
            text: `${wqDot(P, out)} ${wqShort(TUR_STATIONS[id][0])} — ${f(out)} ${P.unit} (${thaiTime(new Date(ts))} น.)` }; }),
      ] });
    }
    const exN = Object.keys((await getWqExclude())[P.key] || {}).length;
    body.push({ type: 'text', text: `เกณฑ์ 🟢 ${P.legend[0]} · 🟡 ${P.legend[1]} · 🔴 ${P.legend[2]} ${P.unit} · ไม่มีข้อมูล ${all.length - total} สถานี${exN ? ` (ตัดออก ${exN} สถานีเพราะเซนเซอร์ผิดปกติ)` : ''}`, size: 'xxs', color: COLORS.textMuted, margin: 'sm', wrap: true });

    const flex = {
      type: 'flex', altText: `${P.title} ${R.label} 00:00–${endT} น. — ${oe}${ot} เฉลี่ย ${f(G.avg)} ${P.unit}`,
      contents: { type: 'bubble', size: 'mega',
        ...(TUR_CANVAS ? { hero: { type: 'image', url: `${TUR_PUBLIC_URL}/wq-map.png?p=${pk}&d=${dayOffset < 0 ? -1 : 0}&t=${Date.now()}`,
          size: 'full', aspectRatio: '1:1', aspectMode: 'cover', action: { type: 'uri', label: 'รายงานเต็ม', uri: wqReportUrl(pk, dayOffset) } } } : {}),
        header: turHeader(P.rTitle, 'ระบบตรวจสอบคุณภาพน้ำประปาออนไลน์'),
        body: { type: 'box', layout: 'vertical', paddingAll: '10px', paddingTop: '8px', contents: body },
      },
    };
    return send( withQuickReply([flex]));
  } catch (err) {
    console.error(`[WQ:${pk}] summary error:`, err);
    return send( withQuickReply([{ type: 'text', text: `❌ สรุป${P.short} error: ` + err.message }]));
  }
}

// รายละเอียดโรงงานผลิตน้ำ: 4 โรงงาน แยกหัวข้อ + สถานีน้ำออกของแต่ละโรงงาน
async function replyParamPumps(replyToken, pk, dayOffset = 0) { return replyParamPlants(replyToken, pk, dayOffset, 'pump'); }
async function replyParamPlants(replyToken, pk, dayOffset = 0, kind = 'plant') {
  const P = WQP[pk];
  const GROUPS = kind === 'pump' ? TUR_PUMPS : TUR_PLANTS, GTITLE = kind === 'pump' ? 'สถานีสูบจ่ายน้ำ' : 'โรงงานผลิตน้ำ';
  const GICON = kind === 'pump' ? IMAGES.iconPump : IMAGES.iconSend, GBG = kind === 'pump' ? '#d1fae5' : '#dbeafe', GCOL = kind === 'pump' ? '#047857' : '#1d4ed8';
  try {
    const R = wqRange(dayOffset), S = await loadParamStats(P, R.start, R.end), f = v => wqFmt(P, v), RL = wqRiskLabel(P);
    const ids = GROUPS.flatMap(p => p.ids), g = wqGroup(P, ids, S);
    const body = [
      { type: 'box', layout: 'horizontal', paddingAll: '10px', cornerRadius: '8px', backgroundColor: GBG, spacing: 'md', contents: [
        { type: 'image', url: GICON, size: '44px', aspectMode: 'fit', aspectRatio: '1:1', flex: 0 },
        { type: 'box', layout: 'vertical', flex: 5, contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `เฉลี่ย ${f(g.avg)}`, size: 'md', weight: 'bold', color: wqColor(P, g.avg), flex: 0 },
            { type: 'text', text: ` · ${RL} ${f(g.risk)} ${P.unit}`, size: 'xs', color: wqColor(P, g.risk), flex: 0, gravity: 'bottom' } ] },
          { type: 'text', text: `${kind === 'pump' ? 'สถานีสูบจ่ายน้ำ ฝั่งตะวันตก/ตะวันออก' : 'น้ำออกจากโรงงาน 4 แห่ง'} · มีข้อมูล ${g.n}/${g.tot} สถานี`, size: 'xxs', color: COLORS.textSecondary },
        ] },
      ] },
      { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
        { type: 'text', text: 'สถานี', size: 'xxs', color: COLORS.textMuted, flex: 6 },
        { type: 'text', text: 'เฉลี่ย', size: 'xxs', color: COLORS.textMuted, flex: 2, align: 'end' },
        { type: 'text', text: RL, size: 'xxs', color: COLORS.textMuted, flex: 2, align: 'end' } ] },
    ];
    GROUPS.forEach(p => {
      const pg = wqGroup(P, p.ids, S);
      body.push({ type: 'box', layout: 'horizontal', margin: 'md', contents: [
        { type: 'text', text: `▸ ${p.name}`, size: 'sm', weight: 'bold', color: GCOL, flex: 6 },
        { type: 'text', text: f(pg.avg), size: 'sm', weight: 'bold', color: wqColor(P, pg.avg), flex: 2, align: 'end' },
        { type: 'text', text: f(pg.risk), size: 'sm', weight: 'bold', color: wqColor(P, pg.risk), flex: 2, align: 'end' } ] });
      body.push({ type: 'separator', color: GCOL });
      p.ids.forEach(id => { const d = S[id], rv = wqRiskVal(P, d);
        body.push({ type: 'box', layout: 'horizontal', paddingTop: '3px', paddingBottom: '3px', contents: [
          { type: 'text', text: `${wqDot(P, d && d.avg)} ${TUR_STATIONS[id][0]}`, size: 'xs', color: COLORS.textPrimary, flex: 6, wrap: true },
          { type: 'text', text: d ? f(d.avg) : '–', size: 'xs', weight: 'bold', color: wqColor(P, d && d.avg), flex: 2, align: 'end', gravity: 'center' },
          { type: 'text', text: d ? f(rv) : '–', size: 'xs', weight: 'bold', color: wqColor(P, rv), flex: 2, align: 'end', gravity: 'center' } ] }); });
    });
    body.push({ type: 'text', text: `เกณฑ์ 🟢 ${P.legend[0]} · 🟡 ${P.legend[1]} · 🔴 ${P.legend[2]} ${P.unit} · ⚪ ไม่มีข้อมูล`, size: 'xxs', color: COLORS.textMuted, margin: 'md', wrap: true });
    return lineReply(replyToken, withQuickReply([{
      type: 'flex', altText: `${P.title} ${GTITLE} ${R.label} — เฉลี่ย ${f(g.avg)} ${RL} ${f(g.risk)} ${P.unit}`,
      contents: { type: 'bubble', size: 'mega',
        header: turHeader(`${P.title.split(' ')[0]} ${P.short} — ${GTITLE}`, dayOffset < 0 ? `${R.label} (ทั้งวัน)` : `${R.label} · 0.00–${thaiTime()} น.`),
        body: { type: 'box', layout: 'vertical', paddingAll: '10px', paddingTop: '8px', contents: body },
        footer: { type: 'box', layout: 'vertical', paddingAll: '6px', contents: [
          { type: 'button', style: 'primary', height: 'sm', color: '#0f172a', action: { type: 'message', label: `↩ กลับภาพรวม${P.short}`, text: dayOffset < 0 ? P.yCmd : P.cmd } } ] },
      },
    }]));
  } catch (err) {
    console.error(`[WQ:${pk}] plants error:`, err);
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: `❌ ${P.short}${GTITLE} error: ` + err.message }]));
  }
}

async function replyParamRegion(replyToken, pk, idx, dayOffset = 0) {
  const P = WQP[pk];
  try {
    const r = TUR_REGIONS[idx];
    if (!r) return lineReply(replyToken, withQuickReply([{ type: 'text', text: 'ไม่พบบริการนี้ (มี บริการ 1–5)' }]));
    const R = wqRange(dayOffset), S = await loadParamStats(P, R.start, R.end);
    const ids = turRegionIds(r), g = wqGroup(P, ids, S), f = v => wqFmt(P, v), RL = wqRiskLabel(P);
    const c = { g: 0, y: 0, r: 0 }; ids.forEach(id => { if (S[id]) c[P.cls(S[id].avg)]++; });
    const head = { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      { type: 'text', text: 'สถานี', size: 'xxs', color: COLORS.textMuted, flex: 6 },
      { type: 'text', text: 'เฉลี่ย', size: 'xxs', color: COLORS.textMuted, flex: 2, align: 'end' },
      { type: 'text', text: RL, size: 'xxs', color: COLORS.textMuted, flex: 2, align: 'end' } ] };
    const stRow = id => { const d = S[id], rv = wqRiskVal(P, d);
      return { type: 'box', layout: 'horizontal', paddingTop: '3px', paddingBottom: '3px', contents: [
        { type: 'text', text: `${wqDot(P, d && d.avg)} ${TUR_STATIONS[id][0]}`, size: 'xs', color: COLORS.textPrimary, flex: 6, wrap: true },
        { type: 'text', text: d ? f(d.avg) : '–', size: 'xs', weight: 'bold', color: wqColor(P, d && d.avg), flex: 2, align: 'end', gravity: 'center' },
        { type: 'text', text: d ? f(rv) : '–', size: 'xs', weight: 'bold', color: wqColor(P, rv), flex: 2, align: 'end', gravity: 'center' },
      ] }; };
    const body = [
      { type: 'box', layout: 'horizontal', paddingAll: '10px', cornerRadius: '8px', backgroundColor: r.bg, contents: [
        { type: 'box', layout: 'vertical', flex: 0, width: '44px', height: '44px', cornerRadius: '12px', backgroundColor: r.col, justifyContent: 'center', alignItems: 'center',
          contents: [{ type: 'text', text: String(idx + 1), size: 'xl', weight: 'bold', color: '#ffffff', align: 'center' }] },
        { type: 'box', layout: 'vertical', flex: 5, margin: 'md', contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `เฉลี่ย ${f(g.avg)}`, size: 'md', weight: 'bold', color: wqColor(P, g.avg), flex: 0 },
            { type: 'text', text: ` · ${RL} ${f(g.risk)} ${P.unit}`, size: 'xs', color: wqColor(P, g.risk), flex: 0, gravity: 'bottom' } ] },
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
    body.push({ type: 'text', text: `เกณฑ์ 🟢 ${P.legend[0]} · 🟡 ${P.legend[1]} · 🔴 ${P.legend[2]} ${P.unit} · ⚪ ไม่มีข้อมูล`, size: 'xxs', color: COLORS.textMuted, margin: 'md', wrap: true });
    const back = dayOffset < 0 ? P.yCmd : P.cmd;
    return lineReply(replyToken, withQuickReply([{
      type: 'flex', altText: `${P.title} ${r.name} ${R.label} — เฉลี่ย ${f(g.avg)} ${RL} ${f(g.risk)} ${P.unit}`,
      contents: { type: 'bubble', size: 'mega',
        header: turHeader(`${P.title.split(' ')[0]} ${P.short} — ${r.name}`, dayOffset < 0 ? `${R.label} (ทั้งวัน)` : `${R.label} · 0.00–${thaiTime()} น.`),
        body: { type: 'box', layout: 'vertical', paddingAll: '10px', paddingTop: '8px', contents: body },
        footer: { type: 'box', layout: 'vertical', paddingAll: '6px', spacing: 'xs', contents: [
          { type: 'box', layout: 'horizontal', spacing: 'xs', contents: TUR_REGIONS.map((x, i) => ({ type: 'button', style: i === idx ? 'secondary' : 'primary', height: 'sm', color: i === idx ? undefined : x.col, flex: 1,
            action: { type: 'message', label: String(i + 1), text: `${P.regionCmd} ${i + 1}${dayOffset < 0 ? ' เมื่อวาน' : ''}` } })) },
          { type: 'button', style: 'primary', height: 'sm', color: '#0f172a', action: { type: 'message', label: `↩ กลับภาพรวม${P.short}`, text: back } },
        ] },
      },
    }]));
  } catch (err) {
    console.error(`[WQ:${pk}] region error:`, err);
    return lineReply(replyToken, withQuickReply([{ type: 'text', text: `❌ ${P.short}รายบริการ error: ` + err.message }]));
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
      { label: 'ดูค่าปัจจุบัน', text: 'คลอรีนตอนนี้', primary: true },
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

// ═══════════════════════════════════════════════════════════════════════════════
// 🧩 Rich menu: เปลี่ยนช่อง "FRC Report" → "รายงานคุณภาพน้ำ" (ใช้รูปเมนูปัจจุบันจาก LINE แล้ววาดช่องใหม่ทับ)
//   GET /richmenu/current.png            — รูปเมนูที่ใช้อยู่
//   GET /richmenu/preview.png            — ตัวอย่างหลังแทนช่อง (ยังไม่เปลี่ยนจริง)
//   GET /richmenu/apply?key=...          — สร้างเมนูใหม่ + ตั้งเป็นค่าเริ่มต้น (ช่องนั้นส่ง "รายงานคุณภาพน้ำ")
//   GET /richmenu/rollback?key=...&id=…  — กลับไปใช้เมนูเดิม
//   key = ตัวแปร ADMIN_KEY ใน Railway (ถ้าไม่ตั้ง ใช้ 'piphat')
// ═══════════════════════════════════════════════════════════════════════════════
const RM_KEY = process.env.ADMIN_KEY || 'piphat';
const lineAuth = { Authorization: `Bearer ${LINE_TOKEN}` };
async function rmCurrent() {
  const d = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers: lineAuth });
  const id = d.data.richMenuId;
  const [obj, img] = await Promise.all([
    axios.get(`https://api.line.me/v2/bot/richmenu/${id}`, { headers: lineAuth }),
    axios.get(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, { headers: lineAuth, responseType: 'arraybuffer' }),
  ]);
  return { id, menu: obj.data, image: Buffer.from(img.data), type: img.headers['content-type'] };
}
function rmTargetArea(menu) {
  let i = menu.areas.findIndex(a => /คลอรีน|frc/i.test((a.action && (a.action.text || a.action.label || a.action.uri)) || ''));
  if (i < 0) i = menu.areas.findIndex(a => { const b = a.bounds, x = menu.size.width * 0.75, y = menu.size.height * 0.25;
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height; });
  return i;
}
function rmDrawTile(c, W, H) {   // ช่อง "รายงานคุณภาพน้ำ" (ออกแบบที่ 1250×843 แล้ว scale)
  c.save(); c.scale(W / 1250, H / 843);
  const g = c.createLinearGradient(0, 0, 1250, 843); g.addColorStop(0, '#0f172a'); g.addColorStop(0.5, '#1e293b'); g.addColorStop(1, '#0b1220');
  c.fillStyle = g; c.fillRect(0, 0, 1250, 843);
  const cols = ['#14b8a6', '#3b82f6', '#f59e0b']; let x = 70, seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let i = 0; i < 26; i++) { const h = 180 + rnd() * 300; c.globalAlpha = 0.16; c.fillStyle = cols[i % 3]; c.fillRect(x, 843 - 120 - h, 30, h); x += 43; }
  c.globalAlpha = 1; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.fillStyle = '#94a3b8'; c.font = '26px TurSarabun'; c.fillText('E X E C U T I V E   S U M M A R Y', 625, 150);
  c.fillStyle = '#ffffff'; c.font = '78px TurSarabunBold'; c.fillText('Water Quality Report', 625, 240);
  c.fillStyle = '#93a4bd'; c.font = '30px TurSarabun'; c.fillText('FRC · Turbidity · EC', 625, 290);
  { const P = [['คลอรีนอิสระคงเหลือ', '#34d399'], ['ความขุ่น', '#60a5fa'], ['ความนำไฟฟ้า', '#fbbf24']], GAP = 64;
    c.font = '40px TurSarabunBold'; c.textAlign = 'left';
    const ws = P.map(([t]) => c.measureText(t).width), tot = ws.reduce((a, b) => a + b, 0) + GAP * 2;
    let px = 625 - tot / 2;
    P.forEach(([t, col], i) => {
      c.fillStyle = col; c.fillText(t, px, 395); px += ws[i];
      if (i < 2) { c.fillStyle = '#475569'; c.fillRect(px + GAP / 2 - 1, 352, 2, 58); px += GAP; }
    });
    c.textAlign = 'center'; }
  c.textAlign = 'left'; c.fillStyle = '#e11d48'; c.fillRect(60, 620, 64, 6);
  c.save(); c.transform(1, 0, -0.18, 1, 0, 0); c.fillStyle = '#ffffff'; c.font = '74px TurSarabunBold'; c.fillText('รายงานคุณภาพน้ำ', 60 + 0.18 * 715, 715); c.restore();
  c.fillStyle = '#e2e8f0'; c.font = '30px TurSarabun'; c.fillText('คลอรีนอิสระคงเหลือ · ความขุ่น · ความนำไฟฟ้า', 62, 762);
  c.fillStyle = '#cbd5e1'; c.font = '26px TurSarabun'; c.fillText('แตะเพื่อเลือกรายงาน', 62, 800);
  const a = c.createLinearGradient(0, 0, 1250, 0); a.addColorStop(0, '#3b82f6'); a.addColorStop(1, '#34d399'); c.fillStyle = a; c.fillRect(0, 837, 1250, 6);
  c.restore();
}
async function rmComposite() {
  if (!TUR_CANVAS) throw new Error('@napi-rs/canvas ไม่พร้อม');
  await turEnsureFont();
  const cur = await rmCurrent();
  const ai = rmTargetArea(cur.menu); if (ai < 0) throw new Error('หาช่อง FRC Report ในเมนูไม่เจอ');
  const b = cur.menu.areas[ai].bounds, { width: W, height: H } = cur.menu.size;
  const cv = TUR_CANVAS.createCanvas(W, H), c = cv.getContext('2d');
  c.drawImage(await TUR_CANVAS.loadImage(cur.image), 0, 0, W, H);
  c.save(); c.translate(b.x, b.y); c.beginPath(); c.rect(0, 0, b.width, b.height); c.clip(); rmDrawTile(c, b.width, b.height); c.restore();
  let q = 90, jpg = cv.toBuffer('image/jpeg', q);
  while (jpg.length > 1000000 && q > 50) { q -= 10; jpg = cv.toBuffer('image/jpeg', q); }   // LINE จำกัด 1 MB
  return { cur, ai, jpg };
}
app.get('/richmenu/current.png', async (req, res) => {
  try { const cur = await rmCurrent(); res.set('Content-Type', cur.type || 'image/png').send(cur.image); }
  catch (e) { res.status(500).send('อ่านเมนูไม่ได้ (อาจสร้างใน OA Manager ไม่ใช่ API): ' + (e.response ? JSON.stringify(e.response.data) : e.message)); }
});
app.get('/richmenu/preview.png', async (req, res) => {
  try { const r = await rmComposite(); res.set('Content-Type', 'image/jpeg').send(r.jpg); }
  catch (e) { res.status(500).send('preview error: ' + (e.response ? JSON.stringify(e.response.data) : e.message)); }
});
app.get('/richmenu/apply', async (req, res) => {
  if (req.query.key !== RM_KEY) return res.status(403).send('key ไม่ถูกต้อง');
  try {
    const { cur, ai, jpg } = await rmComposite();
    const m = cur.menu;
    const areas = m.areas.map((a, i) => i === ai ? { bounds: a.bounds, action: { type: 'message', label: 'รายงานคุณภาพน้ำ', text: 'รายงานคุณภาพน้ำ' } } : { bounds: a.bounds, action: a.action });
    const body = { size: m.size, selected: m.selected, name: 'water-quality-menu', chatBarText: m.chatBarText, areas };
    const cr = await axios.post('https://api.line.me/v2/bot/richmenu', body, { headers: { ...lineAuth, 'Content-Type': 'application/json' } });
    const newId = cr.data.richMenuId;
    await axios.post(`https://api-data.line.me/v2/bot/richmenu/${newId}/content`, jpg, { headers: { ...lineAuth, 'Content-Type': 'image/jpeg' }, maxBodyLength: Infinity });
    await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${newId}`, {}, { headers: lineAuth });
    console.log(`[RichMenu] เปลี่ยนช่อง "${(m.areas[ai].action || {}).label || ai}" → รายงานคุณภาพน้ำ | ใหม่ ${newId} | เดิม ${cur.id}`);
    res.json({ ok: true, newId, oldId: cur.id, rollback: `/richmenu/rollback?key=${RM_KEY}&id=${cur.id}` });
  } catch (e) { console.error('[RichMenu] apply error:', e.response ? e.response.data : e); res.status(500).send('apply error: ' + (e.response ? JSON.stringify(e.response.data) : e.message)); }
});
app.get('/richmenu/rollback', async (req, res) => {
  if (req.query.key !== RM_KEY) return res.status(403).send('key ไม่ถูกต้อง');
  try { await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${req.query.id}`, {}, { headers: lineAuth }); res.json({ ok: true, defaultRichMenu: req.query.id }); }
  catch (e) { res.status(500).send('rollback error: ' + (e.response ? JSON.stringify(e.response.data) : e.message)); }
});

// 🗺️ รูปแผนที่ความขุ่น (hero ของการ์ด LINE) — ?d=0 วันนี้ / ?d=-1 เมื่อวาน
// 📊 สถิติรายสถานี (JSON) ให้รายงานเว็บ (GitHub Pages) ใช้ — ชุดเดียวกับการ์ด LINE · ?p=tub|frc|ec ?d=0|-1
app.get('/wq-stats.json', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=120');
  try {
    const P = WQP[req.query.p] || WQP.tub, d = Number(req.query.d) < 0 ? -1 : 0, R = wqRange(d);
    const S = await loadParamStats(P, R.start, R.end);
    res.json({ p: P.key, start: R.start, end: R.end || Date.now(), label: R.label, stations: S });
  } catch (e) { console.error('[WQStats] error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/wq-exclude.json', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'public, max-age=60');
  try { res.json(await getWqExclude()); } catch (e) { res.status(500).json({}); }
});

// 🩺 สถานะการส่งสรุปเช้าครั้งล่าสุด + โควตา LINE (เปิดดูในเบราว์เซอร์ได้)
app.get('/bot-status.json', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  let morning = null; try { morning = (await db.ref('bot_status/morning').once('value')).val(); } catch (e) {}
  if (morning && morning.ts) morning.time = new Date(morning.ts).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  res.json({ now: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }), morning, quota: await lineQuota(), uptimeMin: Math.round(process.uptime() / 60) });
});

// 🏛️ โลโก้ กปน. สำหรับหัวการ์ดรายงานคุณภาพน้ำ
const MWA_LOGO_PNG = Buffer.from('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', 'base64');
app.get('/mwa-logo.png', (req, res) => res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(MWA_LOGO_PNG));

// 🗺️ รูปแผนที่คุณภาพน้ำ (hero การ์ด) — ?p=tub|frc|ec  ?d=0 วันนี้ / -1 เมื่อวาน
app.get('/wq-map.png', async (req, res) => {
  try {
    if (!TUR_CANVAS) return res.status(503).send('canvas not available');
    const P = WQP[req.query.p] || WQP.tub, d = Number(req.query.d) < 0 ? -1 : 0, R = wqRange(d);
    const S = await loadParamStats(P, R.start, R.end);
    const png = await renderParamMap(P, S, d < 0 ? `${R.label} · 00:00–24:00 น.` : `${R.label} · 00:00–${thaiTime().replace(/\s*น\.?$/, '')} น.`);
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=120').send(png);
  } catch (e) { console.error('[WQMap] render error:', e); res.status(500).send('render error'); }
});
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

// [ต.ค.69] 08:00 น. — พักการแจ้งเตือนคลอรีน (checkAlerts) ไว้ก่อน → broadcast "สรุปความขุ่น 00:00–08:00 น. วันนี้" แทน
//   เปิดแจ้งเตือนคลอรีนกลับ: ตั้งตัวแปร MORNING_FRC_ALERT=on ใน Railway
//   ปิดสรุปความขุ่นตอนเช้า: ตั้งตัวแปร MORNING_TURBIDITY=off
// 🔁 กันพลาด: ถ้าบอทรีสตาร์ท/ไม่ได้ทำงานตอน 08:00 พอดี → ตรวจทุก 5 นาทีช่วง 08:05–09:55 ถ้าวันนี้ยังไม่ได้ส่ง ให้ส่งทันที (ส่งวันละครั้งเท่านั้น)
async function morningCatchUp() {
  if (process.env.MORNING_TURBIDITY === 'off') return;
  try {
    const m = (await db.ref('bot_status/morning').once('value')).val();
    if (m && m.ts >= bkkMidnight(0) && (m.ok || m.trigger !== 'cron')) return;   // วันนี้ส่งแล้ว (หรือมีคนสั่งมือแล้ว)
    if (m && m.ts >= bkkMidnight(0) && !m.ok && /monthly limit|quota/i.test(m.error || '')) return;   // โควตาหมด ไม่ลองซ้ำ
    console.log('[Morning] ยังไม่ได้ส่งสรุปเช้าวันนี้ → ส่งชดเชย');
    await sendMorningTurbidity('catch-up');
  } catch (e) { console.error('[Morning] catch-up error:', e.message); }
}
cron.schedule('5-55/5 8-9 * * *', morningCatchUp, { timezone: 'Asia/Bangkok' });

cron.schedule('0 8 * * *', async () => {
  if (process.env.MORNING_FRC_ALERT === 'on') {
    console.log(`[Cron] ตรวจ FRC alert ประจำวัน (08:00 น.)`);
    checkAlerts();
  }
  if (process.env.MORNING_TURBIDITY !== 'off') await sendMorningTurbidity('cron');   // 00:00–08:00 น. → broadcast ทุกคน
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
