/* ═══════════════════════════════════════════════════════════════
   linebot_equipment_alert.js v3 — แจ้งเตือนวาระเปลี่ยนเซ็นเซอร์ รายเดือน
   ส่งทุกวันที่ 1 เวลา 08:00 · แจ้งล่วงหน้า 2 เดือน / 1 เดือน / เดือนที่ต้องเปลี่ยน

   ติดตั้งใน piphatbot:
     const cron = require('node-cron');
     const { checkEquipmentDue } = require('./linebot_equipment_alert');
     cron.schedule('0 8 1 * *', () => checkEquipmentDue(client, LINE_TARGET_ID),
                   { timezone: 'Asia/Bangkok' });
   คำสั่งแชท: ข้อความ "เซ็นเซอร์" → checkEquipmentDue(client, sourceId, {always:true})
   ═══════════════════════════════════════════════════════════════ */

const FB_URL = 'https://frc-contour-default-rtdb.asia-southeast1.firebasedatabase.app';

async function fbGet(path) {
  const r = await fetch(`${FB_URL}/${path}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${path} ${r.status}`);
  return r.json();
}
function thNow() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  return new Date(s + 'T00:00:00+07:00');
}
function dueDate(startISO, lifeM) {
  if (!startISO || !lifeM) return null;
  const d = new Date(startISO + 'T00:00:00+07:00');
  d.setMonth(d.getMonth() + Number(lifeM));
  return d;
}
const thD = d => d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit' });
const paramThai = pk => pk.replace(/_/g, ' ')
  .replace('คลอรีนอิสระคงเหลือ (FRC)', 'คลอรีนอิสระคงเหลือ');
function itemLabel(pk, part) {
  const pm = paramThai(pk);
  if (part === 'Sensor') return 'เซ็นเซอร์ ' + pm;
  return part + ' ' + pm;   // เช่น Cartridge คลอรีนอิสระคงเหลือ
}

async function checkEquipmentDue(client, to, opt = {}) {
  const eq = (await fbGet('equipment')) || {};
  const now = thNow();
  const thYM = d => { const [y, m] = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }).split('-'); return (+y) * 12 + (+m) - 1; };
  const curM = thYM(now);

  // รวมชิ้นเหมือนกัน (พารามิเตอร์/ชิ้นส่วน/ยี่ห้อ/อายุ/วันครบ) เป็นกลุ่มเดียว นับจำนวนสถานี
  const groups = {};   // key -> {label, brand, lifeM, due, mAhead, stations:Set}
  for (const [sid, params] of Object.entries(eq))
    for (const [pk, parts] of Object.entries(params || {}))
      for (const p of Object.values(parts || {})) {
        const d = dueDate(p.start, p.lifeM);
        if (!d) continue;
        const mAhead = thYM(d) - curM;   // เทียบเดือนตามปฏิทินไทย (กัน getMonth เพี้ยนข้ามเขตเวลา ณ วันที่ 1)
        if (mAhead > 2) continue;                       // ไกลกว่า 2 เดือน ยังไม่แจ้ง
        const key = [pk, p.part, p.brand, p.lifeM, d.toISOString().slice(0, 10)].join('|');
        (groups[key] = groups[key] || {
          label: itemLabel(pk, p.part) + (p.note ? ` (${p.note})` : ''),
          brand: p.brand || '-', lifeM: p.lifeM, due: d, mAhead, stations: new Set()
        }).stations.add(sid);
      }

  const g = Object.values(groups).sort((a, b) => a.due - b.due);
  const line = x => `* ${x.label} ยี่ห้อ ${x.brand} ครบกำหนด ${x.lifeM} เดือน วันที่ ${thD(x.due)}` +
    ` — ${x.stations.size} สถานี`;

  const late = g.filter(x => x.mAhead < 0);
  const m0   = g.filter(x => x.mAhead === 0);
  const m1   = g.filter(x => x.mAhead === 1);
  const m2   = g.filter(x => x.mAhead === 2);

  if (!late.length && !m0.length && !m1.length && !m2.length) {
    if (opt.always)
      await client.pushMessage({ to, messages: [{ type: 'text', text: '✅ ไม่มีเซ็นเซอร์ครบกำหนดเปลี่ยนภายใน 2 เดือนข้างหน้า' }] });
    return { sent: !!opt.always, groups: 0 };
  }

  const L = ['🔔⚙️ แจ้งเตือนวาระการเปลี่ยนเซ็นเซอร์',
             'และอุปกรณ์ตู้วัดคุณภาพน้ำ',
             '━━━━━━━━━━━━━━━'];
  if (late.length) { L.push('', '🔴 ค้างเปลี่ยน (เลยกำหนดแล้ว)'); late.forEach(x => L.push(line(x))); }
  if (m0.length)   { L.push('', '🔧 ครบกำหนดเดือนนี้ — ดำเนินการเปลี่ยน'); m0.forEach(x => L.push(line(x))); }
  if (m1.length)   { L.push('', '🟡 ล่วงหน้า 1 เดือน — เตรียมของ/นัดหมายเข้าพื้นที่'); m1.forEach(x => L.push(line(x))); }
  if (m2.length)   { L.push('', '📦 ล่วงหน้า 2 เดือน — เพื่อเตรียมการล่วงหน้า'); m2.forEach(x => L.push(line(x) + ' (อีก 2 เดือน)')); }
  L.push('━━━━━━━━━━━━━━━', '📋 รายละเอียด/บันทึกการเปลี่ยน: กด icon Contour → รายงาน → เปลี่ยนอุปกรณ์');

  await client.pushMessage({ to, messages: [{ type: 'text', text: L.join('\n') }] });
  return { sent: true, groups: g.length };
}

module.exports = { checkEquipmentDue };
