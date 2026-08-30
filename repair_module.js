/* ═══════════════════════════════════════════════════════════════
   repair_module.js — ระบบแจ้งซ่อมตู้วัดคุณภาพน้ำ (สำหรับ piphatbot)
   - ออกใบเลขต่อจากระบบเดิม: online{เลขรัน}/{ปี พ.ศ. 2 หลัก} (เลขรันต่อเนื่องข้ามปี)
   - 1 สถานี/วัน = 1 ใบ (พารามิเตอร์เพิ่มถูกรวมเข้าใบเดิม ไม่ส่งเมลซ้ำ)
   - ส่งเมลถึงบริษัทผ่าน Google Apps Script webhook (HTTPS)
   ENV ที่ต้องตั้งใน Railway:
     MAIL_WEBHOOK   = URL Web App ของ Apps Script (gas_mail.gs)
     MAIL_SECRET    = คำลับ ตรงกับ SECRET ใน script
     REPAIR_TO      = อีเมลปลายทาง (ทดสอบ: boribannukul@gmail.com)
     REPAIR_CC      = (ไม่บังคับ) คั่นด้วย ,
   ═══════════════════════════════════════════════════════════════ */
// [30/08/69] เปลี่ยนจาก SMTP เป็น HTTPS webhook (Google Apps Script)
// เหตุผล: Railway บล็อกพอร์ต SMTP ขาออก (Connection timeout)
// ENV: MAIL_WEBHOOK = URL Apps Script Web App, MAIL_SECRET = token ตรงกับใน script

const REPAIR_STATIONS = [{"name": "สถานีสูบจ่ายน้ำลุมพินี", "al": ["สจ.ลุมพินี", "LP"]}, {"name": "สำนักงานประปาสาขาทุ่งมหาเมฆ", "al": ["สสท", "ทุ่งมหาเมฆ"]}, {"name": "สถานีสูบจ่ายน้ำพหลโยธิน", "al": ["สจ.พหลโยธิน", "พหลโยธิน", "สจ.พหล"]}, {"name": "สถานีสูบจ่ายน้ำลาดพร้าว", "al": ["สจ.ลาดพร้าว", "ลาดพร้าว", "LA"]}, {"name": "บริษัท โอสถสภา จำกัด (มหาชน)", "al": ["โอสถสภา", "โอสถ", "บ.โอสถสภา", "บ.โอสถ"]}, {"name": "สถานคุ้มครองและพัฒนาอาชีพบ้านเกร็ดตระการ", "al": ["บ้านเกร็ต", "บ้านเกร็ด", "บ้านเกร็ดตระการ", "บ้านเกร็ตตระการ"]}, {"name": "สถานีสูบจ่ายน้ำคลองเตย", "al": ["สจ.คลองเตย", "คลองเตย", "KT"]}, {"name": "ศูนย์วิทยาศาสตร์เพื่อการศึกษาแห่งชาติ", "al": ["ท้องฟ้าจำลอง", "ท้องฟ้า"]}, {"name": "สำนักงานประปาสาขาสุขุมวิท-พระโขนง", "al": ["สสส", "สสพ", "สุขุมวิท", "สำนักงานประปาสุขุมวิท"]}, {"name": "สถานีสูบจ่ายน้ำสำโรง", "al": ["สจ.สำโรง", "สำโรง", "SR"]}, {"name": "บริษัท ศิครินทร์ จำกัด (มหาชน) (โรงพยาบาลศิครินทร์)", "al": ["โรงพยาบาลศิครินทร์", "รพ.ศิครินทร์", "ศิครินทร์"]}, {"name": "โรงเรียนหาดอมราอักษรลักษณ์วิทยา", "al": ["โรงเรียนหาดอมรา", "โรงเรียนหาดอมราอักษรณ์", "หาดอมรา", "โรงเรียนหาด"]}, {"name": "บริษัท เอจีซี แฟลทกลาส (ประเทศไทย) จำกัด (มหาชน)บริษัท เอจีซี แฟลทกลาส (ประเทศไทย) จำกัด (มหาชน) , กระจกไทย , กระจก ,กระจกไทยอาซาฮี , เอจีซี , agc"}, {"name": "สำนักงานประปาสาขาสมุทรปราการ", "al": ["สสป", "สำนักงานสมุทรปราการ", "สมุทรปราการ"]}, {"name": "โรงไฟฟ้าพระนครใต้", "al": ["รฟฟ.พระนครใต้", "รฟฟ", "พระนครใต้"]}, {"name": "สถานีสูบจ่ายน้ำมีนบุรี", "al": ["สจ.มีนบุรี", "MB"]}, {"name": "บริษัท มหาจักรออโตพาร์ท จำกัด", "al": ["มหาจักร", "บ.มหาจักร", "มหาจักรออโต้พาร์ท", "บ.มหาจักรออโต้พาร์ท"]}, {"name": "สำนักงานประปาสาขามีนบุรี", "al": ["สสมบ", "สำนักงานมีนบุรี"]}, {"name": "นิคมอุตสาหกรรมบางชัน", "al": ["นิคมบางชัน", "นิคมฯบางชัน", "บางชัน"]}, {"name": "ศูนย์ไตเทียมเทียนฟ้าประชาการุณย์", "al": ["ศูนย์ไตเทียม", "ศูนย์ไต", "ศูนย์ไตฯ", "เทียนฟ้า", "ศูนย์ไตเทียมเทียนฟ้า"]}, {"name": "สถานีสูบจ่ายน้ำลาดกระบัง", "al": ["สจ.ลาดกระบัง", "LK"]}, {"name": "บริษัท ท่าอากาศยานไทย มหาชน จำกัด (สุวรรณภูมิ)", "al": ["ท่าอากาศยาน", "สุวรรณภูมิ", "ท่าอากาศยานสุวรรณภูมิ"]}, {"name": "นิคมอุตสาหกรรมลาดกระบัง", "al": ["นิคมฯลาด", "นิคมลาด", "นิคมฯลาดกระบัง", "นิคมฯลาดกระบัง"]}, {"name": "มหาวิทยาลัยหัวเฉียวเฉลิมพระเกียรติ (วิทยาเขตบางพลี)", "al": ["ม.หัวเฉียว", "ม.หัวเฉียวเฉลิมพระเกียรติ", "ม.หัวเฉียวฯ", "หัวเฉียว"]}, {"name": "สถานีสูบจ่ายน้ำบางพลี", "al": ["สจ.บางพลี", "BP"]}, {"name": "นิคมอุตสาหกรรมบางพลี", "al": ["นิคมฯบางพลี", "นิคมอุตฯบางพลี", "นิคมบางพลี"]}, {"name": "สถานีตำรวจภูธรคลองด่าน", "al": ["สภ.คลองด่าน", "คลองด่าน"]}, {"name": "นิคมอุตสาหกรรมบางปู", "al": ["นิคมฯบางปู", "นิคมอุตฯบางปู", "บางปู"]}, {"name": "สำนักงานประปาสาขานนทบุรี", "al": ["สสน", "สำนักงานประปานนทบุรี", "นนทบุรี"]}, {"name": "กองพันทหารสื่อสาร กองบัญชาการกองทัพไทย", "al": ["กองพัน", "กองพันทหารสื่อสาร", "กองพันทหาร"]}, {"name": "โรงเรียนทหารขนส่ง กรมการขนส่งทหารบก", "al": ["ขสทบ", "ขนส่ง", "ทหารขนส่ง", "รร.ขสทบ", "ขนส่งทหารบก"]}, {"name": "โรงพยาบาลซีจีเอช สายไหม", "al": ["รพ.สายไหม", "สายไหม", "โรงพยาบาลสายไหม"]}, {"name": "โรงพยาบาลภูมิพลอดุลยเดช", "al": ["รพ.ภูมิพลฯ", "รพ.ภูมิพล", "ภูมิพล"]}, {"name": "สถานีสูบจ่ายน้ำราษฎร์บูรณะ", "al": ["สจ.ราษฎร์บูรณะ", "ราษฎร์บูรณะ", "RB"]}, {"name": "ม.เทคโนโลยีพระจอมเกล้าธนบุรี (วิทยาเขตบางขุนเทียน)", "al": ["มจธ.บางขุนเทียน", "มจธ", "บางขุนเทียน"]}, {"name": "ศูนย์กีฬาเฉลิมพระเกียรติ", "al": ["ศูนย์กีฬา", "ศูนย์กีฬาฯ"]}, {"name": "สถานีสูบจ่ายน้ำเพชรเกษม", "al": ["สจ.เพชรเกษม", "PK", "เพชรเกษม"]}, {"name": "มหาวิทยาลัยเอเชียอาคเนย์", "al": ["ม.เอเชีย", "เอเชีย"]}, {"name": "เรือนจำพิเศษธนบุรี", "al": ["เรือนจำ", "เรือนจำธนบุรี", "เรือนจำพิเศษ"]}, {"name": "สถานีสูบจ่ายน้ำท่าพระ", "al": ["สจ.ท่าพระ", "TP", "ท่าพระ"]}, {"name": "ศูนย์พัฒนาการจัดสวัสดิการสังคมผู้สูงอายุบ้านบางแค (บ้านพักคนชราบางแค)", "al": ["บ้านบางแค", "บางแค", "บ้านพักคนชราบางแค", "บ้านพักคนชรา"]}, {"name": "โรงเรียนบดินทรเดชา (สิงห์ สิงหเสนี) นนทบุรี", "al": ["โรงเรียนบดินทร์", "รร.บดินทร์", "รร.บดิน", "โรงเรียนบดิน", "รร.บดินทรเดชา", "โรงเรียนบดินทร์เดชา"]}, {"name": "โรงเรียนตั้งพิรุฬห์ธรรม", "al": ["รร.ตั้งพิรุฬ", "โรงเรียนตั้งพิรุฬ", "ตั้งพิรุฬ"]}, {"name": "สำนักงานประปาสาขาบางบัวทอง", "al": ["สสบท", "สำนักงานประปาบางบัวทอง", "บางบัวทอง"]}, {"name": "โรงเรียนราชวินิต นนทบุรี", "al": ["รร.ราชวินิต", "โรงเรียนราชวินิต", "ราชวินิต"]}, {"name": "โรงเรียนเตรียมอุดมศึกษาน้อมเกล้า นนทบุรี", "al": ["รร.เตรียม", "รร.เตรียมอุดม", "โรงเรียนเตรียม", "โรงเรียนเตรียมอุดม", "เตรียม", "เตรียอุดม"]}, {"name": "สถานีตำรวจภูธรไทรน้อย", "al": ["สภ.ไทรน้อย", "ไทรน้อย", "สถานีไทรน้อย", "สถานีตำรวจไทรน้อย"]}, {"name": "โรงพยาบาลศิริราช", "al": ["รพ.ศิริราช", "ศิริราช"]}, {"name": "พระราชวังดุสิต สวนจิตรลดา", "al": ["วังสวนจิตร", "พระราชวังสวนจิตร", "พระราชวังดุสิต", "วังดุสิต", "สวนจิต", "สวนจิตร"]}, {"name": "โรงพยาบาลสมเด็จพระปิ่นเกล้า กรมแพทย์ทหารเรือ", "al": ["โรงพยาบาลสมเด็จพระปิ่นเกล้า", "รพ.สมเด็จ", "รพ.สมเด็จพระปิ่นเกล้า", "โรงพยาบาลสมเด็จ"]}];

/* ชื่อเล่น/ชื่อที่คนเรียกจริง → คำในชื่อทางการ */
const STATION_ALIASES = {
  'ท้องฟ้าจำลอง': 'ศูนย์วิทยาศาสตร์เพื่อการศึกษาแห่งชาติ',
  'จิตรลดา': 'พระราชวังดุสิต',
  'สวนจิตร': 'พระราชวังดุสิต',
  'เอเชียอาคเนย์': 'มหาวิทยาลัยเอเชียอาคเนย์',
};

const REPAIR_COMPANY = 'บริษัท เพทโทร-อินสตรูเม้นท์ จำกัด';
const IN_HOUSE_ORG = 'กองบูรณาการคุณภาพน้ำ (กปน.)';
// 10 สถานีสูบจ่ายน้ำที่ กบน. ดูแลเอง — ไม่ส่งเมลผู้รับจ้าง
const IN_HOUSE = new Set(['ลาดพร้าว','คลองเตย','สำโรง','มีนบุรี','ลาดกระบัง','บางพลี','ราษฎร์บูรณะ','เพชรเกษม','ท่าพระ','ลุมพินี']
  .map(n => 'สถานีสูบจ่ายน้ำ' + n));
const companyOf = station => IN_HOUSE.has(station) ? IN_HOUSE_ORG : REPAIR_COMPANY;
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
const TH_WD=['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์'];
const TH_MO=['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
function thDateFull(iso) {   // "วันอาทิตย์ที่ 30 สิงหาคม 2569"
  const [y, m, d] = iso.split('-').map(Number);
  const wd = TH_WD[new Date(iso + 'T12:00:00+07:00').getDay()];
  return `วัน${wd}ที่ ${d} ${TH_MO[m - 1]} ${y + 543}`;
}

/* จับชื่อสถานีแบบยืดหยุ่น: ตัดคำนำหน้า, คะแนนจากคำที่ทับกัน */
function matchStation(text) {
  const norm = s => s.replace(/สถานีสูบจ่ายน้ำ|สำนักงานประปาสาขา|โรงพยาบาล|บริษัท|จำกัด|\(มหาชน\)|มหาวิทยาลัย|รพ\.|สจ\.|สปส\.|สนง\.|ม\./g, '')
                     .replace(/[\s().]/g, '').toUpperCase();
  const t = norm(text);
  if (!t) return { hits: [] };
  // token สำหรับรหัสย่อละติน/สั้น (LP, MB, สสส) — ต้องพิมพ์เป็นคำโดดเท่านั้น กันจับมั่วกลางคำ
  const tokens = new Set(text.trim().split(/\s+/).map(x => x.replace(/[().]/g, '').toUpperCase()));
  const hits = REPAIR_STATIONS.filter(s => {
    const n = norm(s.name);
    if (n.includes(t) || t.includes(n)) return true;
    for (const a of (s.al || [])) {
      const na = norm(a);
      if (!na) continue;
      if (/^[A-Z0-9]{1,4}$/.test(na) || na.length <= 3) {
        if (tokens.has(na)) return true;          // รหัสสั้น: จับเฉพาะคำโดด
      } else if (t.includes(na)) return true;      // ฉายาไทยยาว: จับแบบ substring
    }
    return false;
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
      <table style="width:100%;border-collapse:collapse;margin-bottom:6px;"><tr>
        <td style="width:70px;vertical-align:middle;">
          <img src="https://piphatboribannukul.github.io/FRCfirebase/mwa_logo.png" width="60" height="60" alt="กปน." style="display:block;">
        </td>
        <td style="vertical-align:middle;padding-left:10px;">
          <div style="font-size:15px;font-weight:700;">การประปานครหลวง</div>
          <div style="font-size:12.5px;color:#555;">${REPAIR_FROM_ORG} · ฝ่ายคุณภาพน้ำ</div>
        </td>
        <td style="vertical-align:middle;text-align:right;">
          <div style="font-size:17px;font-weight:800;">ใบแจ้งซ่อม</div>
          <div style="font-size:13px;"><b>เลขที่ ${t.no}</b></div>
        </td>
      </tr></table>
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

  const thBE = iso => { const [y,m,d]=iso.split('-').map(Number); return `${d}/${m}/${y+543}`; };
  async function sendRepairMail(t) {
    if (!process.env.MAIL_WEBHOOK) return { ok: false, err: 'ยังไม่ได้ตั้ง MAIL_WEBHOOK' };
    const inHouse = t.company === IN_HOUSE_ORG;
    // แถวลง Google Sheet (แท็บ Data) — 1 แถวต่อ 1 พารามิเตอร์ ตามโครงชีตเดิม
    const rows = t.items.map(it => ['', t.num, '', t.no, thBE(t.dateIssue), t.timeIssue,
      thBE(t.foundDate), t.foundTime, t.station, it.param, it.problem + (it.note ? ' (' + it.note + ')' : ''),
      t.reporter, t.company, '', '', '', '']);
    try {
      const r = await fetch(process.env.MAIL_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: process.env.MAIL_SECRET || '',
          rows,
          mail: inHouse ? null : {
            to: process.env.REPAIR_TO || 'boribannukul@gmail.com',
            cc: process.env.REPAIR_CC || '',
            subject: `ใบแจ้งซ่อม ${t.no} — ${t.station}`,
            html: emailHtml(t),
          },
        }),
        redirect: 'follow',
      });
      const body = await r.text();
      let j = {}; try { j = JSON.parse(body); } catch (_) {}
      if (j.ok) return { ok: true, inHouse };
      return { ok: false, err: j.error || ('HTTP ' + r.status) };
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
      reporter: reporter || '-', via: via || 'web', company: companyOf(station),
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
    if (!list.length) return `${thDateFull(today)}\nยังไม่มีใบแจ้งซ่อมวันนี้`;
    const L = [thDateFull(today)];
    list.forEach((t, i) => {
      const ps = (t.items || []).map(x => `${x.param} ${x.problem}`).join(', ');
      L.push(`${i + 1}. ${t.station} ${ps} (${t.timeIssue} น.)`);
    });
    L.push(`รวม ${list.length} ใบ`);
    return L.join('\n');
  }

  return { createTicket, todaySummaryText, parseRepairText, matchStation, thDateFull };
}

module.exports = { makeRepairApi, parseRepairText, matchStation };
