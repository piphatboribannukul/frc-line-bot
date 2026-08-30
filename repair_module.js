/* ═══════════════════════════════════════════════════════════════
   repair_module.js — ระบบแจ้งซ่อมตู้วัดคุณภาพน้ำ (สำหรับ piphatbot)
   - ออกใบเลขต่อจากระบบเดิม: online{เลขรัน}/{ปี พ.ศ. 2 หลัก} (เลขรันต่อเนื่องข้ามปี)
   - 1 สถานี/วัน = 1 ใบ (พารามิเตอร์เพิ่มถูกรวมเข้าใบเดิม ไม่ส่งเมลซ้ำ)
   - ส่งเมลถึงบริษัทผ่าน Gmail SMTP (nodemailer)
   ENV ที่ต้องตั้งใน Railway:
     MAIL_USER      = อีเมล Gmail ผู้ส่ง
     MAIL_APP_PASS  = Google App Password 16 ตัว
     REPAIR_TO      = อีเมลบริษัทปลายทาง (ทดสอบ: boribannukul@gmail.com)
     REPAIR_CC      = (ไม่บังคับ) คั่นด้วย ,
   ═══════════════════════════════════════════════════════════════ */
const nodemailer = require('nodemailer');

const REPAIR_STATIONS = [{"id": "SW01", "name": "สถานีสูบจ่ายน้ำลุมพินี"}, {"id": "SM02", "name": "สำนักงานประปาสาขาทุ่งมหาเมฆ"}, {"id": "SW11", "name": "สถานีสูบจ่ายน้ำพหลโยธิน"}, {"id": "SW02", "name": "สถานีสูบจ่ายน้ำลาดพร้าว"}, {"id": "S008", "name": "บริษัท โอสถสภา จำกัด (มหาชน)"}, {"id": "S009", "name": "สถานคุ้มครองและพัฒนาอาชีพบ้านเกร็ดตระการ"}, {"id": "SW03", "name": "สถานีสูบจ่ายน้ำคลองเตย"}, {"id": "S010", "name": "ศูนย์วิทยาศาสตร์เพื่อการศึกษาแห่งชาติ"}, {"id": "SM03", "name": "สำนักงานประปาสาขาสุขุมวิท-พระโขนง"}, {"id": "SW04", "name": "สถานีสูบจ่ายน้ำสำโรง"}, {"id": "S011", "name": "บริษัท ศิครินทร์ จำกัด (มหาชน) (โรงพยาบาลศิครินทร์)"}, {"id": "S012", "name": "โรงเรียนหาดอมราอักษรลักษณ์วิทยา"}, {"id": "S013", "name": "บริษัท เอจีซี แฟลทกลาส (ประเทศไทย) จำกัด (มหาชน)"}, {"id": "SM04", "name": "สำนักงานประปาสาขาสมุทรปราการ"}, {"id": "S014", "name": "โรงไฟฟ้าพระนครใต้"}, {"id": "SW05", "name": "สถานีสูบจ่ายน้ำมีนบุรี"}, {"id": "S015", "name": "บริษัท มหาจักรออโตพาร์ท จำกัด"}, {"id": "SM05", "name": "สำนักงานประปาสาขามีนบุรี"}, {"id": "S016", "name": "นิคมอุตสาหกรรมบางชัน"}, {"id": "S017", "name": "ศูนย์ไตเทียมเทียนฟ้าประชาการุณย์"}, {"id": "SW06", "name": "สถานีสูบจ่ายน้ำลาดกระบัง"}, {"id": "S019", "name": "บริษัท ท่าอากาศยานไทย มหาชน จำกัด (สุวรรณภูมิ)"}, {"id": "S018", "name": "นิคมอุตสาหกรรมลาดกระบัง"}, {"id": "S020", "name": "มหาวิทยาลัยหัวเฉียวเฉลิมพระเกียรติ (วิทยาเขตบางพลี)"}, {"id": "SW07", "name": "สถานีสูบจ่ายน้ำบางพลี"}, {"id": "S021", "name": "นิคมอุตสาหกรรมบางพลี"}, {"id": "S022", "name": "สถานีตำรวจภูธรคลองด่าน"}, {"id": "S023", "name": "นิคมอุตสาหกรรมบางปู"}, {"id": "SM01", "name": "สำนักงานประปาสาขานนทบุรี"}, {"id": "S003", "name": "กองพันทหารสื่อสาร กองบัญชาการกองทัพไทย"}, {"id": "S002", "name": "โรงเรียนทหารขนส่ง กรมการขนส่งทหารบก"}, {"id": "S005", "name": "โรงพยาบาลซีจีเอช สายไหม"}, {"id": "S004", "name": "โรงพยาบาลภูมิพลอดุลยเดช"}, {"id": "SW08", "name": "สถานีสูบจ่ายน้ำราษฎร์บูรณะ"}, {"id": "S026", "name": "ม.เทคโนโลยีพระจอมเกล้าธนบุรี (วิทยาเขตบางขุนเทียน)"}, {"id": "S025", "name": "ศูนย์กีฬาเฉลิมพระเกียรติ"}, {"id": "SW09", "name": "สถานีสูบจ่ายน้ำเพชรเกษม"}, {"id": "S027", "name": "มหาวิทยาลัยเอเชียอาคเนย์"}, {"id": "S028", "name": "เรือนจำพิเศษธนบุรี"}, {"id": "SW10", "name": "สถานีสูบจ่ายน้ำท่าพระ"}, {"id": "S024", "name": "ศูนย์พัฒนาการจัดสวัสดิการสังคมผู้สูงอายุบ้านบางแค (บ้านพักคนชราบางแค)"}, {"id": "S029", "name": "โรงเรียนบดินทรเดชา (สิงห์ สิงหเสนี) นนทบุรี"}, {"id": "S032", "name": "โรงเรียนตั้งพิรุฬห์ธรรม"}, {"id": "SM06", "name": "สำนักงานประปาสาขาบางบัวทอง"}, {"id": "S030", "name": "โรงเรียนราชวินิต นนทบุรี"}, {"id": "S001", "name": "โรงเรียนเตรียมอุดมศึกษาน้อมเกล้า นนทบุรี"}, {"id": "S031", "name": "สถานีตำรวจภูธรไทรน้อย"}, {"id": "S007", "name": "โรงพยาบาลศิริราช"}, {"id": "S006", "name": "พระราชวังดุสิต สวนจิตรลดา"}];

const REPAIR_COMPANY = 'บริษัท เพทโทร-อินสตรูเม้นท์ จำกัด';
const REPAIR_FROM_ORG = 'กองบูรณาการคุณภาพน้ำ';

const PARAM_KEYS = [
  ['คลอรีนอิสระคงเหลือขาเข้า', /ขาเข้า/],
  ['คลอรีนอิสระคงเหลือขาออก', /ขาออก/],
  ['คลอรีนอิสระคงเหลือ', /คลอรีน|frc|chlorine/i],
  ['ความขุ่น', /ขุ่น|turb/i],
  ['พีเอช', /พีเอช|\bph\b/i],
  ['ความนำไฟฟ้า', /นำไฟฟ้า|conduct|\bec\b/i],
  ['ความเค็ม', /เค็ม|salin/i],
  ['หน้าจอ TWQ', /หน้าจอ|จอ|twq|monitor/i],
  ['อัตราการไหลน้ำเข้าตู้', /อัตราการไหล|โฟลว์|flow/i],
];
const PROBLEM_KEYS = [
  ['สูงผิดปกติ', /สูง/], ['ต่ำผิดปกติ', /ต่ำ/], ['แสดงค่า ERROR', /error|เออเร่อ|เอเร่อ/i],
  ['ค่าค้าง', /ค้าง/], ['ค่าหาย', /หาย/], ['ค่าแกว่ง ผิดปกติ', /แกว่ง|สวิง/],
  ['ติดลบ', /ติดลบ/], ['ดับ', /ดับ/],
];

function thYear2() {
  const y = new Date().toLocaleDateString('th-TH-u-ca-buddhist', { timeZone: 'Asia/Bangkok', year: 'numeric' });
  return String(y).replace(/\D/g, '').slice(-2);
}
function thDateISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}
function thTimeHM() {
  return new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
}
const thDateDisp = iso => { const [y,m,d]=iso.split('-').map(Number);
  return `${d}/${m}/${y+543}`; };

/* จับชื่อสถานีแบบยืดหยุ่น: ตัดคำนำหน้า, คะแนนจากคำที่ทับกัน */
function matchStation(text) {
  const norm = s => s.replace(/สถานีสูบจ่ายน้ำ|สำนักงานประปาสาขา|โรงพยาบาล|บริษัท|จำกัด|\(มหาชน\)|มหาวิทยาลัย|รพ\.|สจ\.|สปส\.|สนง\.|ม\./g, '')
                     .replace(/[\s().]/g, '');
  const t = norm(text);
  if (!t) return { hits: [] };
  const hits = REPAIR_STATIONS.filter(s => {
    const n = norm(s.name);
    return n.includes(t) || t.includes(n);
  });
  return { hits };
}
function parseRepairText(body) {
  // แยกรายการ "1. ... 2. ..." หรือบรรทัด หรือข้อความเดียว
  const chunks = body.split(/\s*\d+[.)]\s*/).map(s => s.trim()).filter(Boolean);
  const list = chunks.length ? chunks : [body.trim()];
  return list.map(chunk => {
    const { hits } = matchStation(chunk);
    let param = null, problem = null;
    for (const [name, re] of PARAM_KEYS) if (re.test(chunk)) { param = name; break; }
    for (const [name, re] of PROBLEM_KEYS) if (re.test(chunk)) { problem = name; break; }
    return { raw: chunk, hits, param, problem };
  });
}

function makeRepairApi(db, opts) {
  const mailer = (process.env.MAIL_USER && process.env.MAIL_APP_PASS)
    ? nodemailer.createTransport({ service: 'gmail',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_APP_PASS } })
    : null;

  async function nextRepairNo() {
    const ref = db.ref('repairs_meta/lastNum');
    const snap = await ref.once('value');
    const num = (snap.val() || 4163) + 1;   // ต่อจาก online4163/69
    await ref.set(num);
    return { num, no: `online${num}/${thYear2()}` };
  }

  async function findTodayTicket(stationName) {
    const today = thDateISO();
    const snap = await db.ref('repairs').orderByChild('dateIssue').equalTo(today).once('value');
    const all = snap.val() || {};
    for (const [k, v] of Object.entries(all))
      if (v.station === stationName) return { key: k, ticket: v };
    return null;
  }

  function emailHtml(t) {
    const items = t.items.map(i => `<li>${i.param} — ${i.problem}${i.note ? ' ('+i.note+')' : ''}</li>`).join('');
    return `<div style="font-family:'Segoe UI',Tahoma,sans-serif;max-width:640px;border:1px solid #ccc;border-radius:8px;padding:20px;">
      <h2 style="text-align:center;margin:0 0 4px;">ใบแจ้งซ่อม</h2>
      <p style="text-align:right;margin:0;"><b>เลขที่ ${t.no}</b></p>
      <hr>
      <p><b>ส่งถึง:</b> ${REPAIR_COMPANY}<br>
         <b>จากหน่วยงาน:</b> ${REPAIR_FROM_ORG}</p>
      <p><b>แจ้งซ่อมที่สถานี:</b> ${t.station}<br>
         <b>วันที่พบปัญหา:</b> ${thDateDisp(t.foundDate)} เวลา ${t.foundTime} น.</p>
      <p><b>ปัญหาที่พบ:</b></p><ul>${items}</ul>
      <p><b>ผู้แจ้งซ่อม:</b> ${t.reporter}<br>
         <b>วันที่ออกใบแจ้งซ่อม:</b> ${thDateDisp(t.dateIssue)} เวลา ${t.timeIssue} น.</p>
      <hr><p style="color:#888;font-size:12px;">ออกใบอัตโนมัติจากระบบ FRCContour — กองบูรณาการคุณภาพน้ำ กปน.</p></div>`;
  }

  async function sendRepairMail(t) {
    if (!mailer) return { ok: false, err: 'ยังไม่ได้ตั้ง MAIL_USER/MAIL_APP_PASS' };
    try {
      await mailer.sendMail({
        from: `"ระบบแจ้งซ่อม ${REPAIR_FROM_ORG}" <${process.env.MAIL_USER}>`,
        to: process.env.REPAIR_TO || 'boribannukul@gmail.com',
        cc: process.env.REPAIR_CC || undefined,
        subject: `ใบแจ้งซ่อม ${t.no} — ${t.station}`,
        html: emailHtml(t),
      });
      return { ok: true };
    } catch (e) { return { ok: false, err: e.message }; }
  }

  /** สร้าง/รวมใบแจ้งซ่อม — items: [{param, problem, note?}] */
  async function createTicket({ station, items, foundDate, foundTime, reporter, via }) {
    const exist = await findTodayTicket(station);
    if (exist) {
      const cur = exist.ticket.items || [];
      const added = [];
      for (const it of items)
        if (!cur.some(c => c.param === it.param && c.problem === it.problem)) { cur.push(it); added.push(it); }
      if (!added.length)
        return { dup: true, no: exist.ticket.no, msg: `วันนี้มีใบแจ้งซ่อม ${exist.ticket.no} ของ ${station} รายการเดียวกันอยู่แล้ว — ไม่ส่งซ้ำ` };
      await db.ref(`repairs/${exist.key}/items`).set(cur);
      return { merged: true, no: exist.ticket.no, added,
        msg: `รวมเข้าใบเดิม ${exist.ticket.no} (${station}) เพิ่ม ${added.length} รายการ — ไม่ส่งเมลซ้ำ` };
    }
    const { num, no } = await nextRepairNo();
    const t = { no, num, station, items,
      dateIssue: thDateISO(), timeIssue: thTimeHM(),
      foundDate: foundDate || thDateISO(), foundTime: foundTime || thTimeHM(),
      reporter: reporter || '-', via: via || 'web', company: REPAIR_COMPANY,
      status: 'open', ts: Date.now() };
    const mail = await sendRepairMail(t);
    t.emailSent = mail.ok; if (!mail.ok) t.emailErr = mail.err;
    await db.ref('repairs').push(t);
    return { created: true, no, emailSent: mail.ok, emailErr: mail.err, ticket: t };
  }

  async function todaySummaryText() {
    const today = thDateISO();
    const snap = await db.ref('repairs').orderByChild('dateIssue').equalTo(today).once('value');
    const list = Object.values(snap.val() || {}).sort((a, b) => a.ts - b.ts);
    if (!list.length) return `วันนี้ (${thDateDisp(today)}) ยังไม่มีใบแจ้งซ่อม`;
    const L = [`🔧 ใบแจ้งซ่อมวันนี้ ${thDateDisp(today)} — ${list.length} ใบ`];
    list.forEach((t, i) => {
      const ps = (t.items || []).map(x => `${x.param} ${x.problem}`).join(', ');
      L.push(`${i + 1}. ${t.no} ${t.station} — ${ps} (${t.timeIssue})`);
    });
    return L.join('\n');
  }

  return { createTicket, todaySummaryText, parseRepairText, matchStation };
}

module.exports = { makeRepairApi, parseRepairText, matchStation };
