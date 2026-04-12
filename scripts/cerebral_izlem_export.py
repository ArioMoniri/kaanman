#!/usr/bin/env python3
"""
cerebral_izlem_export.py — Cerebral Plus İzlem Tab Full Exporter (v4 — Incremental)

Usage:
    python3 cerebral_izlem_export.py <protocol_number> [--output FILE]

On first run: scrapes everything and writes JSON.
On subsequent runs: loads existing JSON, fetches only new/changed data, merges.
"""

import sys, os, json, time, re, hashlib
from datetime import datetime, timedelta
from html.parser import HTMLParser

try:
    import requests
except ImportError:
    sys.exit("ERROR: 'requests' not installed. Run:  pip3 install requests")

# ── Configuration ────────────────────────────────────────────────────────────
BASE = "https://cerebralplustr.acibadem.com.tr"
COOKIE_FILE = os.environ.get("COOKIES_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cookies", "cookies.json"))
DATE_ALL_START = "01.01.1900 00:00"
TIMEOUT = 45
RETRY_COUNT = 2
RETRY_DELAY = 3  # seconds between retries


# ── HTML Table Parser ────────────────────────────────────────────────────────
class TableParser(HTMLParser):
    """Parse HTML tables into list-of-dicts."""

    def __init__(self):
        super().__init__()
        self.tables = []
        self._in_table = False
        self._in_thead = False
        self._in_tbody = False
        self._in_tr = False
        self._in_th = False
        self._in_td = False
        self._headers = []
        self._current_row = []
        self._current_cell = ""
        self._rows = []
        self._current_headers = []

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        if t == "table":
            self._in_table = True
            self._headers = []
            self._rows = []
        elif t == "thead":
            self._in_thead = True
        elif t == "tbody":
            self._in_tbody = True
        elif t == "tr":
            self._in_tr = True
            self._current_row = []
        elif t == "th":
            self._in_th = True
            self._current_cell = ""
        elif t == "td":
            self._in_td = True
            self._current_cell = ""
        elif t == "br" and (self._in_td or self._in_th):
            self._current_cell += "\n"

    def handle_endtag(self, tag):
        t = tag.lower()
        if t == "table":
            if self._headers and self._rows:
                table_data = []
                for row in self._rows:
                    record = {}
                    for i, h in enumerate(self._headers):
                        record[h] = row[i].strip() if i < len(row) else ""
                    table_data.append(record)
                self.tables.append(table_data)
            elif self._rows:
                # No headers — use index keys
                table_data = []
                for row in self._rows:
                    record = {f"col_{i}": c.strip() for i, c in enumerate(row)}
                    table_data.append(record)
                if table_data:
                    self.tables.append(table_data)
            self._in_table = False
        elif t == "thead":
            self._in_thead = False
        elif t == "tbody":
            self._in_tbody = False
        elif t == "tr":
            if self._in_thead and self._current_row:
                self._headers = [c.strip() for c in self._current_row]
            elif self._current_row:
                self._rows.append(self._current_row)
            self._in_tr = False
        elif t == "th":
            self._current_row.append(self._current_cell)
            self._in_th = False
        elif t == "td":
            self._current_row.append(self._current_cell)
            self._in_td = False

    def handle_data(self, data):
        if self._in_th or self._in_td:
            self._current_cell += data


def parse_html_tables(html_text):
    """Return list of tables, each table is list of dicts."""
    parser = TableParser()
    parser.feed(html_text)
    return parser.tables


# ── Cookie Loader ────────────────────────────────────────────────────────────
def load_cookies(path):
    """Load cookies from browser-extension JSON export."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    jar = requests.cookies.RequestsCookieJar()
    items = data if isinstance(data, list) else data.get("cookies", data.get("data", []))
    for c in items:
        name = c.get("name", "")
        value = c.get("value", "")
        domain = c.get("domain", "").lstrip(".")
        path_c = c.get("path", "/")
        if name and value:
            jar.set(name, value, domain=domain, path=path_c)
    return jar


# ── Session Builder ──────────────────────────────────────────────────────────
def build_session(cookie_jar):
    s = requests.Session()
    s.cookies = cookie_jar
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{BASE}/CM/ehr/medicalcard",
        "Origin": BASE,
    })
    return s


# ── API Helpers ──────────────────────────────────────────────────────────────
def post(session, path, params, retries=RETRY_COUNT):
    """POST with retries. Returns response text or None."""
    url = f"{BASE}{path}"
    for attempt in range(retries + 1):
        try:
            r = session.post(url, params=params, timeout=TIMEOUT)
            if r.status_code == 500:
                # Server error — usually means no data for this episode/endpoint
                return None
            r.raise_for_status()
            return r.text
        except requests.exceptions.Timeout:
            if attempt < retries:
                log(f"    TIMEOUT {path}, retrying in {RETRY_DELAY}s... ({attempt+1}/{retries})")
                time.sleep(RETRY_DELAY)
            else:
                log(f"    TIMEOUT {path} after {retries+1} attempts, skipping")
                return None
        except requests.exceptions.HTTPError as e:
            log(f"    HTTP {r.status_code} {path}, skipping")
            return None
        except requests.exceptions.ConnectionError:
            if attempt < retries:
                log(f"    Connection error {path}, retrying in {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
            else:
                log(f"    Connection error {path} after {retries+1} attempts, skipping")
                return None
    return None


def fetch_and_parse(session, path, params, label):
    """Fetch an endpoint, parse HTML tables, return flat list of records."""
    log(f"  [*] {label}...")
    html = post(session, path, params)
    if html is None:
        return []
    tables = parse_html_tables(html)
    records = []
    for table in tables:
        records.extend(table)
    return records


# ── Episode Loader ───────────────────────────────────────────────────────────
def load_episodes(session, patient_id):
    """Fetch episode list HTML and parse episode cards."""
    log("Fetching episode list...")
    html = post(session, "/Cm/Ehr/PatientDetail_Complaints", {"patientId": patient_id})
    if not html:
        sys.exit("ERROR: Could not fetch episode list. Check cookies / patient ID.")

    episodes = []
    # Parse episode cards from HTML — look for card-item elements
    # Pattern: id="<episodeId>" data-oldcomplaint-id="<X>" data-date="<D>" etc.
    pattern = re.compile(
        r'id=["\'](\d+)["\']'
        r'.*?data-oldcomplaint-id=["\']([^"\']*)["\']'
        r'.*?data-service-id=["\']([^"\']*)["\']'
        r'.*?data-date=["\']([^"\']*)["\']'
        r'.*?data-doctor-code=["\']([^"\']*)["\']'
        r'.*?data-service-text=["\']([^"\']*)["\']'
        r'.*?data-facility-text=["\']([^"\']*)["\']',
        re.DOTALL
    )

    for m in pattern.finditer(html):
        episodes.append({
            "episodeId": m.group(1),
            "oldComplaintId": m.group(2),
            "serviceId": m.group(3),
            "date": m.group(4),
            "doctorCode": m.group(5),
            "serviceText": m.group(6),
            "facilityText": m.group(7),
        })

    if not episodes:
        # Fallback: try simpler parsing
        id_pattern = re.compile(r'class=["\']card-item\s+complaints["\'][^>]*id=["\'](\d+)["\']')
        old_pattern = re.compile(r'data-oldcomplaint-id=["\']([^"\']*)["\']')
        date_pattern = re.compile(r'data-date=["\']([^"\']*)["\']')
        svc_pattern = re.compile(r'data-service-text=["\']([^"\']*)["\']')
        fac_pattern = re.compile(r'data-facility-text=["\']([^"\']*)["\']')

        cards = re.findall(r'class=["\']card-item\s+complaints["\'][^>]*>', html)
        for card_html in cards:
            eid = id_pattern.search(card_html)
            oid = old_pattern.search(card_html)
            dt = date_pattern.search(card_html)
            svc = svc_pattern.search(card_html)
            fac = fac_pattern.search(card_html)
            if eid:
                episodes.append({
                    "episodeId": eid.group(1),
                    "oldComplaintId": oid.group(1) if oid else "0",
                    "serviceId": "",
                    "date": dt.group(1) if dt else "",
                    "doctorCode": "",
                    "serviceText": svc.group(1) if svc else "",
                    "facilityText": fac.group(1) if fac else "",
                })

    log(f"Found {len(episodes)} episodes")
    return episodes


def select_episode(session, patient_id, episode_id):
    """Set server-side episode context."""
    post(session, "/Cm/Ehr/Inpatient", {
        "patientId": patient_id,
        "episodeId": episode_id,
    })


# ── Endpoint Definitions ────────────────────────────────────────────────────
# Each endpoint: (key, label, url_path, param_builder_function)
# param_builder receives (patient_id, episode_id, old_complaint_id, start_date, end_date)

def _params_hekim(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": eid, "startDate": sd, "endDate": ed}

def _params_hemsire(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": oid, "startDate": sd, "endDate": ed}

def _params_vital(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": oid, "startDate": sd, "endDate": ed}

def _params_bloodgas(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": oid, "startDate": sd, "endDate": ed}

def _params_medicene(pid, eid, oid, sd, ed):
    return {"patientId": pid, "orderDate": sd, "episodeId": eid}

def _params_lab(pid, eid, oid, sd, ed):
    return {"patientId": pid, "orderDate": sd}

def _params_abortion_risk(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": eid}

def _params_assessment(pid, eid, oid, sd, ed):
    return {"patientId": pid, "startDate": sd, "endDate": ed, "complaintId": oid}

def _params_infection(formId):
    def builder(pid, eid, oid, sd, ed):
        return {"patientId": pid, "complaintId": oid, "startDate": sd, "endDate": ed, "formId": formId}
    return builder

def _params_old_complaint_dated(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": oid, "startDate": sd, "endDate": ed}

def _params_episode_dated(pid, eid, oid, sd, ed):
    return {"patientId": pid, "complaintId": eid, "startDate": sd, "endDate": ed}

def _params_cvvhdf(pid, eid, oid, sd, ed):
    return {"patientId": pid, "episodeId": eid, "startDate": sd, "endDate": ed}

def _params_ventilation(pid, eid, oid, sd, ed):
    return {"patientId": pid, "episodeId": eid, "startDate": sd, "endDate": ed}

def _params_prom(pid, eid, oid, sd, ed):
    return {"patientId": pid}


# All endpoints to fetch per episode
ENDPOINTS = [
    # Main tabs
    ("hekim_izlem_notlari", "Hekim İzlem Notları", "/Cm/Nurse/DoctorObservation", _params_hekim),
    ("hemsire_izlem_notlari", "Hemşire İzlem Notları", "/Cm/Nurse/NurseObservation", _params_hemsire),
    ("vital_bulgular", "Vital Bulgular", "/Cm/Nurse/VitalObservation", _params_vital),
    ("kangazi_izlem", "Kangazı İzlem", "/Cm/Nurse/BloodGas", _params_bloodgas),
    ("ilac_izlem", "İlaç İzlem", "/Cm/Nurse/MediceneObservation", _params_medicene),
    ("laboratuvar_izlem", "Laboratuvar İzlem", "/Cm/Nurse/LabObservation", _params_lab),

    # Diğer İzlemler
    ("dusme_riski", "Düşme Riski", "/Cm/Nurse/AbortionRisk", _params_abortion_risk),
    ("degerlendirme", "Değerlendirme", "/Cm/Nurse/AssesmentFormList", _params_assessment),

    # Enfeksiyon Önlem Paketi Kontrol Formu (5 sub-forms)
    ("enfeksiyon_kontrol_ventilator", "Enf. Kontrol - Ventilatör", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("899")),
    ("enfeksiyon_kontrol_santral_takma", "Enf. Kontrol - Santral Takma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("890")),
    ("enfeksiyon_kontrol_santral_korunma", "Enf. Kontrol - Santral Korunma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("892")),
    ("enfeksiyon_kontrol_uriner_takma", "Enf. Kontrol - Üriner Takma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("894")),
    ("enfeksiyon_kontrol_uriner_korunma", "Enf. Kontrol - Üriner Korunma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("896")),

    # Enfeksiyon Önlem Paketi İzlem Formu (5 sub-forms)
    ("enfeksiyon_izlem_ventilator", "Enf. İzlem - Ventilatör", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("891")),
    ("enfeksiyon_izlem_santral_takma", "Enf. İzlem - Santral Takma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("898")),
    ("enfeksiyon_izlem_santral_korunma", "Enf. İzlem - Santral Korunma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("893")),
    ("enfeksiyon_izlem_uriner_takma", "Enf. İzlem - Üriner Takma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("895")),
    ("enfeksiyon_izlem_uriner_korunma", "Enf. İzlem - Üriner Korunma", "/Cm/Nurse/InfectionPreventionPackageControlForm", _params_infection("897")),

    # Remaining Diğer İzlemler
    ("basinc_yaralanmasi_riski", "Basınç Yaralanması Riski İzlem", "/Cm/Nurse/PressureSore", _params_old_complaint_dated),
    ("aldigi_cikardigi", "Aldığı Çıkardığı İzlem", "/Cm/Nurse/FeedAndStool", _params_old_complaint_dated),
    ("basinc_yaralanmasi_izlem", "Basınç Yaralanması İzlem", "/Cm/Nurse/PresureSoreFollowUp", _params_old_complaint_dated),
    ("norolojik_izlem", "Nörolojik İzlem", "/Cm/Nurse/NeurologicObservation", _params_old_complaint_dated),
    ("hasta_girisim_izlem", "Hasta Girişim İzlem", "/Cm/Nurse/PatientCare", _params_old_complaint_dated),
    ("hka_izlem", "HKA İzlem", "/Cm/Nurse/PatientControlledAnalgesia", _params_old_complaint_dated),
    ("diyabet_izlem", "Diyabet İzlem", "/Cm/Nurse/MonitorDiabetForms", _params_episode_dated),
    ("cvvhdf_izlem", "CVVHDF İzlem", "/Cm/CriticalCare/CVVHDFList", _params_cvvhdf),
    ("solunum_ventilasyon", "Solunum/Ventilasyon", "/Cm/Nurse/VentilationList", _params_ventilation),
    ("prom", "PROM", "/Cm/Nurse/PROM", _params_prom),
    ("act", "ACT", "/Cm/Nurse/MonitorCoagulationTimeForms", _params_episode_dated),
]


# ── Logging ──────────────────────────────────────────────────────────────────
_verbose = True

def log(msg=""):
    if _verbose:
        print(msg, file=sys.stderr)


# ── Record Fingerprinting (for diff/merge) ──────────────────────────────────
def fingerprint_records(records):
    """Create a set of hashes for records to detect changes."""
    hashes = set()
    for r in records:
        raw = json.dumps(r, sort_keys=True, ensure_ascii=False)
        hashes.add(hashlib.md5(raw.encode()).hexdigest())
    return hashes


def merge_records(existing, new_records):
    """Merge new records into existing, avoiding exact duplicates. Returns merged list and count of new."""
    if not existing:
        return new_records, len(new_records)
    existing_fps = fingerprint_records(existing)
    added = 0
    merged = list(existing)
    for r in new_records:
        raw = json.dumps(r, sort_keys=True, ensure_ascii=False)
        fp = hashlib.md5(raw.encode()).hexdigest()
        if fp not in existing_fps:
            merged.append(r)
            existing_fps.add(fp)
            added += 1
    return merged, added


# ── Main Scraper ─────────────────────────────────────────────────────────────
def scrape_episode(session, patient_id, episode, start_date, end_date):
    """Scrape all endpoints for a single episode. Returns dict of key→records."""
    eid = episode["episodeId"]
    oid = episode["oldComplaintId"] or "0"

    # Set episode context on server
    select_episode(session, patient_id, eid)
    time.sleep(0.3)

    data = {}
    for key, label, path, param_fn in ENDPOINTS:
        params = param_fn(patient_id, eid, oid, start_date, end_date)
        records = fetch_and_parse(session, path, params, label)
        if records:
            data[key] = records
        # Small delay to be nice to the server
        time.sleep(0.15)

    return data


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 cerebral_izlem_export.py <protocol_number> [--output FILE]")
        sys.exit(1)

    patient_id = sys.argv[1]

    # Normalize protocol: strip spaces/dashes, ensure 8-digit
    patient_id = re.sub(r"[\s\-]+", "", patient_id.strip())
    if not re.match(r"^\d{7,9}$", patient_id):
        print(f"ERROR: Invalid protocol number '{patient_id}'. Must be 7-9 digits.", file=sys.stderr)
        sys.exit(1)

    output_file = f"izlem_{patient_id}.json"

    # Parse --output flag
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            output_file = sys.argv[idx + 1]

    # Date range: "Hepsi"
    now = datetime.now()
    start_date = DATE_ALL_START
    end_date = now.strftime("%d.%m.%Y") + " 23:59"

    # Load cookies
    if not os.path.exists(COOKIE_FILE):
        sys.exit(f"ERROR: Cookie file not found: {COOKIE_FILE}")
    cookie_jar = load_cookies(COOKIE_FILE)
    log(f"Loaded {len(cookie_jar)} cookies")

    # Build session
    session = build_session(cookie_jar)

    # Load existing data for incremental mode
    existing_data = {}
    if os.path.exists(output_file):
        log(f"Loading existing data from {output_file} for incremental merge...")
        try:
            with open(output_file, "r", encoding="utf-8") as f:
                existing_data = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            log(f"Warning: Could not read existing file ({e}), starting fresh")
            existing_data = {}

    # Build lookup of existing episodes by ID
    existing_episodes = {}
    if "episodes" in existing_data:
        for ep in existing_data["episodes"]:
            existing_episodes[ep["episode_info"]["episodeId"]] = ep

    # Fetch episodes
    episodes = load_episodes(session, patient_id)
    if not episodes:
        sys.exit("ERROR: No episodes found for this patient.")

    # Process each episode
    result_episodes = []
    total_new_records = 0
    total_existing_records = 0
    skipped_unchanged = 0

    for i, ep in enumerate(episodes):
        eid = ep["episodeId"]
        oid = ep["oldComplaintId"] or "0"
        log(f"\n── Episode {i+1}/{len(episodes)}: {eid} | {ep['date']} | "
            f"{ep['facilityText']} {ep['serviceText']} ──")

        # Scrape fresh data
        fresh_data = scrape_episode(session, patient_id, ep, start_date, end_date)

        # Merge with existing data
        episode_result = {
            "episode_info": {
                "episodeId": eid,
                "oldComplaintId": oid,
                "date": ep["date"],
                "serviceText": ep["serviceText"],
                "facilityText": ep["facilityText"],
                "doctorCode": ep["doctorCode"],
                "serviceId": ep["serviceId"],
            },
            "data": {},
        }

        existing_ep = existing_episodes.get(eid, {})
        existing_ep_data = existing_ep.get("data", {}) if existing_ep else {}

        ep_new = 0
        for key in set(list(fresh_data.keys()) + list(existing_ep_data.keys())):
            fresh = fresh_data.get(key, [])
            existing = existing_ep_data.get(key, [])
            merged, added = merge_records(existing, fresh)
            if merged:
                episode_result["data"][key] = merged
                ep_new += added
                total_existing_records += len(existing)

        total_new_records += ep_new
        if ep_new > 0:
            log(f"  → {ep_new} new records merged")
        else:
            log(f"  → No new records")

        result_episodes.append(episode_result)

    # Build final output
    output = {
        "meta": {
            "patient_id": patient_id,
            "export_date": now.isoformat(),
            "start_date": start_date,
            "end_date": end_date,
            "total_episodes": len(result_episodes),
            "incremental": bool(existing_data),
            "new_records_this_run": total_new_records,
        },
        "episodes": result_episodes,
    }

    # Compute summary stats
    summary = {}
    for ep in result_episodes:
        for key, records in ep["data"].items():
            summary[key] = summary.get(key, 0) + len(records)
    output["meta"]["record_counts"] = summary
    output["meta"]["total_records"] = sum(summary.values())

    # Write output
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f"\n{'='*60}")
    log(f"Done! Output: {output_file}")
    log(f"Total episodes: {len(result_episodes)}")
    log(f"Total records: {output['meta']['total_records']}")
    log(f"New records this run: {total_new_records}")
    log(f"{'='*60}")

    # Also print summary to stderr
    log("\nRecord counts by type:")
    for k, v in sorted(summary.items()):
        log(f"  {k}: {v}")


if __name__ == "__main__":
    main()