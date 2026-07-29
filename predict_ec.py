"""
predict_ec.py — Inference รายชั่วโมงบน Railway (Firebase Admin SDK)

รอบการทำงาน (cron ทุกชั่วโมง):
  1. อ่าน EC ล่าสุดทุกสถานี — จาก Firebase /live ก่อน (ที่ FRCContour เขียนไว้)
     ถ้าไม่มีค่อย fallback ไป TWQMS public API
  2. เก็บลง buffer /history_ec/{YYYYMMDDHH}
  3. สร้าง features จาก buffer -> พยากรณ์ +24/+48 ชม. ทุกสถานี
  4. เขียน /forecast/ec = {ts, data:{station:{...}}}  (ตาม RTDB rules ที่บังคับ {data, ts})

Auth: env FIREBASE_SERVICE_ACCOUNT (JSON ก้อนเดียว) — ตัวเดียวกับ server.js
"""
import json, os, unicodedata
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd
import firebase_admin
from firebase_admin import credentials, db as fdb
import xgboost as xgb

BKK = timezone(timedelta(hours=7))
MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
FB_DB_URL = os.environ.get("FB_DATABASE_URL") or os.environ.get("FIREBASE_URL")

# URL ของ models.tar.gz ใน GitHub Release (แก้เป็น repo จริง)
MODELS_URL = os.environ.get("MODELS_URL",
    "https://github.com/piphatboribannukul/REPO/releases/download/models-v1/models.tar.gz")

if not os.path.isdir(MODEL_DIR):
    import tarfile
    _tgz = os.path.join(os.path.dirname(__file__), "models.tar.gz")
    # ถ้าไม่มีไฟล์ในเครื่อง → ดาวน์โหลดจาก GitHub Release
    if not os.path.exists(_tgz):
        import urllib.request
        print(f"[EC] ดาวน์โหลดโมเดลจาก Release ...")
        urllib.request.urlretrieve(MODELS_URL, _tgz)
        print(f"[EC] ดาวน์โหลดเสร็จ ({os.path.getsize(_tgz)//1024//1024} MB)")
    with tarfile.open(_tgz) as _t:
        _t.extractall(os.path.dirname(__file__) or ".")
    print("[EC] แตกโมเดลแล้ว")

def init_firebase():
    if firebase_admin._apps:
        return
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if sa:
        cred = credentials.Certificate(json.loads(sa))
        firebase_admin.initialize_app(cred, {"databaseURL": FB_DB_URL})
        print("[EC] Firebase Admin: service account")
    else:
        firebase_admin.initialize_app(options={"databaseURL": FB_DB_URL})
        print("[EC] Firebase Admin: no service account (public rules)")

cfg = json.load(open(os.path.join(MODEL_DIR, "config.json"), encoding="utf-8"))
FEATS_BY_FP = cfg["feature_order_by_fp"]
TR1, MS = cfg["sources"]["bangkhen"], cfg["sources"]["mahasawat"]
TWQMS_PUBLIC = "https://twqonline.mwa.co.th/TWQMSServicepublic/api/mwaonmobile/getStations"

_models = {}
def get_model(station, fp):
    key = (station, fp)
    if key not in _models:
        info = cfg["stations"].get(station, {}).get("horizons", {}).get(str(fp))
        if not info:
            return None
        m = xgb.Booster()  # core API — ไม่ต้องพึ่ง scikit-learn
        m.load_model(os.path.join(MODEL_DIR, info["model_file"]))
        _models[key] = m
    return _models[key]

def predict_one(model, X):
    """X = DataFrame 1 แถว มี feature names ครบ → คืนค่าพยากรณ์ (float)"""
    return float(model.predict(xgb.DMatrix(X))[0])

def norm(s):
    return unicodedata.normalize("NFC", str(s)).strip()

def fetch_latest_ec():
    """อ่าน EC ล่าสุดจาก /history_ec (ที่ server.js เขียนทุก 10 นาที)
    คืน dict {ชื่อสถานี: ec} ของชั่วโมงล่าสุดที่มีข้อมูล"""
    try:
        raw = fdb.reference("history_ec").get() or {}
    except Exception as e:
        print(f"[EC] อ่าน /history_ec ไม่ได้: {e}")
        return {}
    if not raw:
        return {}
    latest_key = max(raw.keys())  # YYYYMMDDHH ล่าสุด
    hour = raw[latest_key]
    out = {}
    for name, ec in hour.items():
        try:
            fv = float(ec)
            if 0 < fv < 2500:
                out[norm(name)] = fv
        except (TypeError, ValueError):
            pass
    return out

def fetch_from_twqms():
    import requests
    try:
        r = requests.get(TWQMS_PUBLIC, timeout=30)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"[EC] TWQMS public API ไม่ตอบ: {e}")
        return {}
    items = data if isinstance(data, list) else data.get("datas", data.get("data", []))
    out = {}
    for it in items:
        name = norm(it.get("stationName") or it.get("name") or "")
        ec = it.get("conductivity") or it.get("ec") or it.get("avg5") or it.get("cond")
        if name and ec is not None:
            try:
                fv = float(ec)
                if 0 < fv < 2500:
                    out[name] = fv
            except (TypeError, ValueError):
                pass
    return out

def append_buffer(readings, ts):
    fdb.reference(f"history_ec/{ts.strftime('%Y%m%d%H')}").update(readings)

def load_buffer(hours=200):
    raw = fdb.reference("history_ec").get() or {}
    rows = {}
    for key, stations in raw.items():
        try:
            t = pd.Timestamp(f"{key[:4]}-{key[4:6]}-{key[6:8]} {key[8:10]}:00")
        except Exception:
            continue
        if isinstance(stations, dict):
            rows[t] = stations
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame.from_dict(rows, orient="index").sort_index().tail(hours)

def build_features(hist, station, fp, now):
    FEATS = FEATS_BY_FP[str(fp)]
    col = fb_key(station)  # ชื่อคอลัมน์ใน buffer เป็นแบบ sanitized
    s = hist[col] if col in hist.columns else pd.Series(dtype=float)
    row = {}
    for f in FEATS:
        if f.startswith("self"):
            lag = int(f[4:]); row[f] = s.get(now - pd.Timedelta(hours=lag - fp), np.nan)
        elif f == "rm":
            w = s[(s.index > now - pd.Timedelta(hours=24)) & (s.index <= now)]
            row[f] = w.mean() if len(w) else np.nan
        elif f == "src_bk":
            bk = fb_key(TR1); row[f] = hist[bk].get(now, np.nan) if bk in hist.columns else np.nan
        elif f == "src_ms":
            ms = fb_key(MS); row[f] = hist[ms].get(now, np.nan) if ms in hist.columns else np.nan
        elif f == "h": row[f] = (now + pd.Timedelta(hours=fp)).hour
        elif f == "mo": row[f] = (now + pd.Timedelta(hours=fp)).month
    return pd.DataFrame([row])[FEATS]

def main():
    init_firebase()
    now = pd.Timestamp(datetime.now(BKK)).floor("h").tz_localize(None)
    readings = fetch_latest_ec(); src = "history_ec"
    if len(readings) < 5:
        tw = fetch_from_twqms()
        if len(tw) > len(readings): readings, src = tw, "twqms"
    print(f"[EC] [{now}] อ่านค่าล่าสุด {len(readings)} สถานี (จาก {src})")

    model_names = {norm(k): k for k in cfg["stations"]}
    # จับคู่ชื่อ: ตรงเป๊ะก่อน ถ้าไม่ได้ลอง prefix (ชื่อโมเดลถูกตัด 30 ตัวอักษรจาก Excel)
    matched = {}
    unmatched = []
    model_norm_list = list(model_names.items())  # [(norm_name, orig_name)]
    for k, v in readings.items():
        nk = norm(k)
        if nk in model_names:
            matched[model_names[nk]] = v
            continue
        # prefix: ชื่อโมเดล (สั้น) เป็นคำขึ้นต้นของชื่อ API (ยาว) หรือกลับกัน
        hit = None
        for mn, orig in model_norm_list:
            if len(mn) >= 10 and (nk.startswith(mn) or mn.startswith(nk[:30])):
                hit = orig
                break
        if hit:
            matched[hit] = v
        else:
            unmatched.append(k)
    if unmatched:
        print(f"[EC] ชื่อไม่ตรงโมเดล {len(unmatched)}: {unmatched[:8]}")
    # หมายเหตุ: server.js เขียน /history_ec ให้แล้วทุก 10 นาที
    # predict_ec.py แค่อ่าน buffer มาสร้าง features (ไม่ต้องเขียนซ้ำ)
    hist = load_buffer()
    if hist.empty:
        print("[EC] buffer ว่าง — ยังพยากรณ์ไม่ได้ (รอสะสม หรือ backfill)")
        return
    hist.index = pd.to_datetime(hist.index)

    data = {}
    for st in cfg["stations"]:
        entry = {"unit": "uS/cm"}; cur = None
        col = fb_key(st)
        if col in hist.columns and hist[col].notna().any():
            cur = float(hist[col].dropna().iloc[-1]); entry["current"] = round(cur, 1)
            win = hist[col].reindex(pd.date_range(now - pd.Timedelta(hours=47), now, freq="h"))
            entry["hist"] = [None if pd.isna(v) else round(float(v), 1) for v in win.values]
        vals = {}
        for fp in (24, 48):
            m = get_model(st, fp)
            if m is None: continue
            X = build_features(hist, st, fp, now)
            if X.notna().sum(axis=1).iloc[0] == 0: continue
            v = predict_one(m, X); vals[fp] = v
            entry[f"h{fp}"] = round(v, 1); entry[f"h{fp}_alert"] = v > 600
        if cur is not None and 24 in vals:
            p24, p48 = vals[24], vals.get(48, vals[24]); fc = []
            for h in range(1, 49):
                v = cur + (p24 - cur) * (h / 24) if h <= 24 else p24 + (p48 - p24) * ((h - 24) / 24)
                fc.append(round(v, 1))
            entry["fc"] = fc
        if "h24" in entry or "h48" in entry:
            entry["name"] = st  # เก็บชื่อจริงไว้ให้หน้าเว็บแสดง
            data[fb_key(st)] = entry

    payload = {"ts": int(now.timestamp() * 1000), "updated": now.isoformat(), "data": data}
    fdb.reference("forecast/ec").set(payload)
    n_alert = sum(1 for e in data.values() if e.get("h24_alert"))
    print(f"[EC] เขียนพยากรณ์ {len(data)} สถานี | เตือน >600: {n_alert}")

def fb_key(name):
    """แปลงชื่อสถานีเป็น Firebase key ที่ปลอดภัย (ห้ามมี . $ # [ ] /)"""
    for c in '.$#[]/':
        name = name.replace(c, '_')
    return name

def backfill_from_csv(csv_path, hours=300):
    init_firebase()
    dfm = pd.read_csv(csv_path, index_col=0, parse_dates=True).tail(hours)
    n = 0
    for ts, row in dfm.iterrows():
        vals = {fb_key(k): float(v) for k, v in row.items() if pd.notna(v)}
        if vals:
            fdb.reference(f"history_ec/{ts.strftime('%Y%m%d%H')}").update(vals)
            n += 1
    print(f"[EC] backfill {n} ชม. เข้า /history_ec เสร็จ")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "backfill":
        path = sys.argv[2] if len(sys.argv) > 2 else "ec_backfill.csv"
        backfill_from_csv(path)
    else:
        main()
