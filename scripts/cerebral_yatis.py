#!/usr/bin/env python3
"""
cerebral_yatis.py — Acıbadem Cerebral Plus Yatış (Hospitalization) + Episode Scraper

Scrapes ALL episodes (Poliklinik + Yatış) from a patient's medical card.
For Yatış episodes: extracts hospitalization details (admission/discharge dates,
    reason, diagnosis, complaints, Poliklinik exam notes).
For Poliklinik episodes: extracts complaints, diagnoses, exam notes.

Cross-matching with report scraper (cerebral_reports.py):
    - Output files include episode_id in filenames
    - manifest.json maps episodes to dates/departments for report matching
    - Reports can be matched by date + facility + department

Usage:
    python cerebral_yatis.py <patient_id>
    python cerebral_yatis.py <patient_id> --yatis-only     # Only Yatış episodes
    python cerebral_yatis.py <patient_id> --all-episodes    # All episodes (default)

Requires: cookies.json (EditThisCookie format) in the same directory.

LLM Integration Guide:
    To cross-match with cerebral_reports.py output:
    1. Load this script's manifest.json → get episode list with dates/departments
    2. Load report scraper's manifest.json → get report list with dates/types
    3. Match on date + facility: episode.date == report.date AND
       episode.facility_text appears in report filename
    4. Episode ID links Yatış info to its Poliklinik exam notes
"""

import json
import os
import re
import sys
import time
import hashlib
from datetime import datetime
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ─── Configuration ───────────────────────────────────────────────────
BASE_URL = "https://cerebralplustr.acibadem.com.tr"
COOKIES_FILE = os.environ.get("COOKIES_FILE") or next(
    (p for p in [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cookies", "cookies.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.json"),
    ] if os.path.isfile(p)),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.json"),
)
MAX_WORKERS = 4  # concurrent fetches for episode details

# ─── HTML Text Extractor ─────────────────────────────────────────────
class HTMLTextExtractor(HTMLParser):
    """Simple HTML-to-text converter."""
    def __init__(self):
        super().__init__()
        self._text = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self._skip = True
        elif tag == 'br':
            self._text.append('\n')
        elif tag in ('p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            self._text.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._skip = False
        elif tag in ('td', 'th'):
            self._text.append('\t')

    def handle_data(self, data):
        if not self._skip:
            self._text.append(data)

    def get_text(self):
        return re.sub(r'\n{3,}', '\n\n', ''.join(self._text)).strip()


def html_to_text(html_str):
    """Convert HTML string to plain text."""
    parser = HTMLTextExtractor()
    parser.feed(html_str)
    return parser.get_text()


# ─── Cookie Loading ──────────────────────────────────────────────────
def load_cookies():
    """Load cookies from EditThisCookie JSON format and build raw Cookie header."""
    with open(COOKIES_FILE, 'r', encoding='utf-8') as f:
        cookies_list = json.load(f)

    # Build raw Cookie header string (avoids RequestsCookieJar domain issues)
    pairs = []
    for c in cookies_list:
        name = c.get("name", "")
        value = c.get("value", "")
        if name and value:
            pairs.append(f"{name}={value}")

    cookie_header = "; ".join(pairs)
    if not cookie_header:
        print("[ERROR] No cookies found in cookies.json")
        sys.exit(1)

    return cookie_header


# ─── Session Setup ───────────────────────────────────────────────────
def create_session(cookie_header):
    """Create requests session with retry logic and cookie header."""
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    session.headers.update({
        "Cookie": cookie_header,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/json,*/*",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{BASE_URL}/Cm/Home",
    })

    return session


def verify_session(session, patient_id):
    """Verify the session is authenticated by loading the medical card page."""
    url = f"{BASE_URL}/CM/ehr/medicalcard?patientId={patient_id}"
    resp = session.get(url, allow_redirects=True, timeout=30)
    if "/ehr/medicalcard" not in resp.url:
        print(f"[ERROR] Session not authenticated. Redirected to: {resp.url}")
        print("        Please update cookies.json with fresh cookies.")
        sys.exit(1)
    return resp


# ─── Episode Extraction ─────────────────────────────────────────────
def parse_episodes_from_html(html_text):
    """
    Parse episode list from the medicalcard page HTML.
    Extracts .card-item.complaints divs with their data attributes.
    """
    episodes = []

    # Regex to find card-item complaints divs with all data attributes
    # Pattern: <div class="card-item complaints..." id="EPISODE_ID" data-xxx="yyy" ...>
    card_pattern = re.compile(
        r'<div\s+class="card-item\s+complaints[^"]*"\s+'
        r'((?:id|data-)[^>]+)>',
        re.DOTALL
    )

    # Extract individual attributes
    attr_pattern = re.compile(r'([\w-]+)="([^"]*)"')

    for match in card_pattern.finditer(html_text):
        attr_str = match.group(1)
        attrs = dict(attr_pattern.findall(attr_str))

        episode = {
            "episode_id": attrs.get("id", attrs.get("data-episode-id", "")),
            "date": attrs.get("data-date", ""),
            "service_id": attrs.get("data-service-id", ""),
            "service_text": attrs.get("data-service-text", ""),
            "facility_id": attrs.get("data-facility-id", ""),
            "facility_text": attrs.get("data-facility-text", ""),
            "long_facility_text": attrs.get("data-longfacility-text", ""),
            "doctor_code": attrs.get("data-doctor-code", ""),
            "is_hospitalization": attrs.get("data-episode-hospitalization-history", "F") == "T",
            "old_complaint_id": attrs.get("data-oldcomplaint-id", ""),
            "is_cplus_facility": attrs.get("data-is-cplus-facility", "0") == "1",
        }

        # Deduplicate by episode_id
        if episode["episode_id"] and not any(
            e["episode_id"] == episode["episode_id"] for e in episodes
        ):
            episodes.append(episode)

    return episodes


# ─── Doctor Name Extraction ──────────────────────────────────────────
def extract_doctor_names(html_text, episodes):
    """
    Extract doctor names from the sidebar HTML by matching episode card structure.
    The doctor name appears as a direct child div within each card-item.
    """
    # For each episode, find the doctor name in the HTML near the episode ID
    for ep in episodes:
        eid = ep["episode_id"]
        # Look for the card content after the id
        pattern = re.compile(
            rf'id="{eid}"[^>]*>.*?'  # card div opening
            r'(?:<div[^>]*>([^<]*)</div>\s*){2,5}',  # child divs
            re.DOTALL
        )
        match = pattern.search(html_text)
        if match:
            # Extract all div texts within this card
            div_texts = re.findall(r'<div[^>]*>([^<]+)</div>', match.group(0))
            for t in div_texts:
                t = t.strip()
                if re.match(r'^(Prof\.|Doç\.|Dr\.|Dt\.|Uzm\.|Yrd\.|Diyetisyen|V\d+)', t):
                    ep["doctor_name"] = t
                    break
            if "doctor_name" not in ep:
                ep["doctor_name"] = ""
        else:
            ep["doctor_name"] = ""


# ─── Inpatient Data Fetching ────────────────────────────────────────
def fetch_inpatient_data(session, patient_id, episode_id):
    """
    Fetch Yatış (hospitalization) tab data for an episode.
    Returns dict with admission/discharge dates and other info.
    """
    url = f"{BASE_URL}/Cm/Ehr/Inpatient"
    params = {"patientId": patient_id, "episodeId": episode_id}
    resp = session.post(url, params=params, timeout=30)

    if resp.status_code != 200:
        return {"error": f"HTTP {resp.status_code}"}

    html = resp.text
    text = html_to_text(html)

    # Extract dates
    date_matches = re.findall(r'(\d{2}\.\d{2}\.\d{4})', text)

    # Parse Yatış Tarihi and Taburcu Tarihi
    yatis_tarihi = ""
    taburcu_tarihi = ""

    yt_match = re.search(r'Yatış Tarihi:\s*(\d{2}\.\d{2}\.\d{4})', text)
    if yt_match:
        yatis_tarihi = yt_match.group(1)

    tt_match = re.search(r'Taburcu Tarihi:\s*(\d{2}\.\d{2}\.\d{4})', text)
    if tt_match:
        taburcu_tarihi = tt_match.group(1)

    # Parse Yatış Sebebi (between "Yatış Sebebi:" and "Yatış Tanısı:")
    sebep_match = re.search(r'Yatış Sebebi:\s*(.*?)(?=Yatış Tanısı:|$)', text, re.DOTALL)
    yatis_sebebi = sebep_match.group(1).strip() if sebep_match else ""

    # Parse Yatış Tanısı (between "Yatış Tanısı:" and "Yatış Tarihi:")
    tani_match = re.search(r'Yatış Tanısı:\s*(.*?)(?=Yatış Tarihi:|$)', text, re.DOTALL)
    yatis_tanisi = tani_match.group(1).strip() if tani_match else ""

    return {
        "yatis_tarihi": yatis_tarihi,
        "taburcu_tarihi": taburcu_tarihi,
        "yatis_sebebi": yatis_sebebi,
        "yatis_tanisi": yatis_tanisi,
    }


def fetch_inpatient_info(session, patient_id):
    """
    Fetch the InpatientInfo modal data (Yatış Sebebi + Tanısı textareas).
    This is a patient-level endpoint, not episode-level.
    """
    url = f"{BASE_URL}/Cm/Ehr/InpatientInfo"
    params = {"patientId": patient_id}
    resp = session.get(url, params=params, timeout=30)

    if resp.status_code != 200:
        return {"error": f"HTTP {resp.status_code}"}

    html = resp.text

    # Extract textarea values
    complaint_match = re.search(
        r'id="txtComplaint"[^>]*>(.*?)</textarea>', html, re.DOTALL
    )
    story_match = re.search(
        r'id="txtStory"[^>]*>(.*?)</textarea>', html, re.DOTALL
    )

    return {
        "yatis_sebebi_detail": complaint_match.group(1).strip() if complaint_match else "",
        "yatis_tanisi_detail": story_match.group(1).strip() if story_match else "",
    }


def fetch_diagnosis(session, patient_id, episode_id):
    """Fetch diagnoses for an episode. Returns list of diagnosis dicts."""
    url = f"{BASE_URL}/Cm/Ehr/GetPatientDiagnosisByEpisodeId"
    data = {"patientId": patient_id, "episodeId": episode_id}
    resp = session.post(url, data=data, timeout=30)

    if resp.status_code != 200:
        return []

    try:
        result = resp.json()
        if isinstance(result, list):
            return [
                {
                    "icd_code": d.get("Diagnosis_Id", ""),
                    "name": d.get("DiagnosisName", ""),
                    "type": d.get("DIAGNOSIS_TYPE", ""),
                    "side": d.get("DIAGNOSIS_SIDE", ""),
                    "order": d.get("SIRALAMA", 0),
                }
                for d in result
            ]
        return []
    except (json.JSONDecodeError, ValueError):
        return []


def fetch_complaint(session, patient_id, episode_id):
    """Fetch complaint/symptoms for an episode. Returns list of complaint dicts."""
    url = f"{BASE_URL}/Cm/Ehr/GetPatientComplaintByEpisodeId"
    data = {"patientId": patient_id, "episodeId": episode_id}
    resp = session.post(url, data=data, timeout=30)

    if resp.status_code != 200:
        return []

    try:
        result = resp.json()
        if isinstance(result, list):
            complaints = []
            seen = set()
            for c in result:
                title = c.get("COMPLAINTTITLE", "").strip()
                if title and title not in seen:
                    seen.add(title)
                    # Parse .NET date format /Date(milliseconds)/
                    date_str = ""
                    raw_date = c.get("CREATE_DATE", "")
                    date_ms = re.search(r'/Date\((\d+)\)/', str(raw_date))
                    if date_ms:
                        ts = int(date_ms.group(1)) / 1000
                        date_str = datetime.fromtimestamp(ts).strftime("%d.%m.%Y")

                    complaints.append({
                        "title": title,
                        "text": c.get("COMPLAINTTEXT", "").strip(),
                        "date": date_str,
                        "time_unit": c.get("TIMEUNIT", ""),
                    })
            return complaints
        return []
    except (json.JSONDecodeError, ValueError):
        return []


def fetch_policlinic_notes(session, patient_id, episode_id, service_id):
    """
    Fetch Poliklinik (examination) notes for an episode.
    Returns extracted text with exam notes, treatment, medications.
    """
    url = f"{BASE_URL}/Cm/Ehr/EmrPoliclinic"
    params = {
        "patientId": patient_id,
        "episodeId": episode_id,
        "lastComplaintId": episode_id,
        "medicalServiceId": service_id,
    }
    resp = session.post(url, params=params, timeout=30)

    if resp.status_code != 200:
        return ""

    html = resp.text
    text = html_to_text(html)

    # Clean up the text — remove CSS and JS artifacts
    text = re.sub(r'\.scroll\s*\{[^}]+\}', '', text)
    text = re.sub(r'\.[a-z-]+\s*\{[^}]+\}', '', text)
    text = re.sub(r'\s*\.scroll[^{]*\{[^}]*\}', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()

    return text


# ─── File Naming ─────────────────────────────────────────────────────
def safe_filename(text, max_len=50):
    """Sanitize text for use in filenames."""
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', text)
    text = re.sub(r'_+', '_', text).strip('_. ')
    return text[:max_len]


def episode_filename(episode, suffix=""):
    """
    Generate a filename for an episode.
    Format: {TYPE}_{DATE}_{DEPT}_{FACILITY}_{EPISODE_ID}{suffix}
    TYPE = YATIS or POLI
    """
    ep_type = "YATIS" if episode["is_hospitalization"] else "POLI"
    date = episode["date"].replace(".", "")
    dept = safe_filename(episode["service_text"], 30)
    facility = safe_filename(episode["facility_text"], 20)
    eid = episode["episode_id"]
    return f"{ep_type}_{date}_{dept}_{facility}_{eid}{suffix}"


# ─── Main Scraper ────────────────────────────────────────────────────
def scrape_patient(patient_id, yatis_only=False):
    """
    Main scraper function.
    1. Load medicalcard page to get episode list
    2. Parse episodes from HTML
    3. For each target episode, fetch details (diagnosis, complaints, notes)
    4. For Yatış episodes, also fetch hospitalization-specific data
    5. Save individual text files + manifest.json
    """
    print(f"\n{'='*60}")
    print(f"  Cerebral Plus Yatış & Episode Scraper")
    print(f"  Patient ID: {patient_id}")
    print(f"{'='*60}\n")

    # Step 1: Load cookies and create session
    print("[1/6] Loading cookies...")
    cookie_header = load_cookies()
    session = create_session(cookie_header)

    # Step 2: Verify session and load medicalcard page
    print("[2/6] Verifying session & loading medical card...")
    resp = verify_session(session, patient_id)
    page_html = resp.text
    print(f"       Page loaded ({len(page_html)} bytes)")

    # Step 3: Parse episodes
    print("[3/6] Parsing episodes from sidebar...")
    episodes = parse_episodes_from_html(page_html)
    extract_doctor_names(page_html, episodes)

    total = len(episodes)
    yatis_count = sum(1 for e in episodes if e["is_hospitalization"])
    poli_count = total - yatis_count
    print(f"       Found {total} episodes: {yatis_count} Yatış, {poli_count} Poliklinik")

    if yatis_only:
        target_episodes = [e for e in episodes if e["is_hospitalization"]]
        print(f"       Mode: Yatış-only → processing {len(target_episodes)} episodes")
    else:
        target_episodes = episodes
        print(f"       Mode: All episodes → processing {len(target_episodes)} episodes")

    if not target_episodes:
        print("[!] No target episodes found.")
        return

    # Step 4: Create output directory
    out_dir = f"episodes_{patient_id}"
    os.makedirs(out_dir, exist_ok=True)
    print(f"[4/6] Output directory: {out_dir}/")

    # Step 5: Fetch details for each episode
    print(f"[5/6] Fetching episode details...")
    manifest = {
        "patient_id": patient_id,
        "scrape_time": datetime.now().isoformat(),
        "total_episodes": total,
        "yatis_count": yatis_count,
        "poli_count": poli_count,
        "episodes": [],
    }

    def process_episode(ep):
        """Process a single episode: fetch all data and save files."""
        eid = ep["episode_id"]
        is_yatis = ep["is_hospitalization"]
        tag = "YATIŞ" if is_yatis else "POLİ"

        result = {
            **ep,
            "diagnoses": [],
            "complaints": [],
            "policlinic_notes": "",
        }

        # Fetch diagnosis
        try:
            result["diagnoses"] = fetch_diagnosis(session, patient_id, eid)
        except Exception as e:
            result["diagnoses_error"] = str(e)

        # Fetch complaints
        try:
            result["complaints"] = fetch_complaint(session, patient_id, eid)
        except Exception as e:
            result["complaints_error"] = str(e)

        # Fetch Yatış-specific data
        if is_yatis:
            try:
                inpatient_data = fetch_inpatient_data(session, patient_id, eid)
                result["yatis_bilgisi"] = inpatient_data
            except Exception as e:
                result["yatis_bilgisi_error"] = str(e)

        # Fetch Policlinic notes (exam notes, treatment, meds)
        try:
            notes = fetch_policlinic_notes(
                session, patient_id, eid, ep["service_id"]
            )
            result["policlinic_notes"] = notes
        except Exception as e:
            result["policlinic_notes_error"] = str(e)

        # Build text file content
        lines = []
        lines.append(f"{'='*60}")
        lines.append(f"  {tag} — Episode {eid}")
        lines.append(f"{'='*60}")
        lines.append(f"Tarih (Date):       {ep['date']}")
        lines.append(f"Bölüm (Department): {ep['service_text']} (ID: {ep['service_id']})")
        lines.append(f"Şube (Facility):    {ep['facility_text']} ({ep.get('long_facility_text', '')})")
        lines.append(f"Doktor (Doctor):    {ep.get('doctor_name', '')} (Code: {ep['doctor_code']})")
        lines.append(f"Episode ID:         {eid}")
        lines.append(f"Old Complaint ID:   {ep['old_complaint_id']}")
        lines.append(f"Yatış:              {'Evet (Yes)' if is_yatis else 'Hayır (No)'}")
        lines.append("")

        # Yatış details
        if is_yatis and "yatis_bilgisi" in result:
            yb = result["yatis_bilgisi"]
            lines.append("─── Yatış Bilgisi (Hospitalization Info) ───")
            lines.append(f"Yatış Tarihi (Admission):  {yb.get('yatis_tarihi', '')}")
            lines.append(f"Taburcu Tarihi (Discharge): {yb.get('taburcu_tarihi', '')}")
            lines.append(f"Yatış Sebebi (Reason):     {yb.get('yatis_sebebi', '')}")
            lines.append(f"Yatış Tanısı (Diagnosis):  {yb.get('yatis_tanisi', '')}")
            lines.append("")

        # Diagnoses
        if result["diagnoses"]:
            lines.append("─── Tanılar (Diagnoses) ───")
            for d in result["diagnoses"]:
                lines.append(f"  [{d['icd_code']}] {d['name']} — {d['type']}"
                             + (f" ({d['side']})" if d['side'] else ""))
            lines.append("")

        # Complaints
        if result["complaints"]:
            lines.append("─── Yakınma (Complaints) ───")
            for c in result["complaints"]:
                lines.append(f"  [{c['date']}] {c['title']}")
                if c["text"]:
                    lines.append(f"    {c['text']}")
            lines.append("")

        # Policlinic notes
        if result["policlinic_notes"]:
            lines.append("─── Poliklinik Notları (Examination Notes) ───")
            lines.append(result["policlinic_notes"])
            lines.append("")

        text_content = "\n".join(lines)

        # Save text file
        fname = episode_filename(ep, ".txt")
        fpath = os.path.join(out_dir, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(text_content)

        result["output_file"] = fname
        return result

    # Process episodes (sequential to avoid rate limiting)
    results = []
    for i, ep in enumerate(target_episodes):
        tag = "YATIŞ" if ep["is_hospitalization"] else "POLİ"
        print(f"       [{i+1}/{len(target_episodes)}] {tag} {ep['date']} — "
              f"{ep['service_text']} ({ep['facility_text']})")
        try:
            result = process_episode(ep)
            results.append(result)
        except Exception as e:
            print(f"         [ERROR] {e}")
            results.append({**ep, "error": str(e)})
        time.sleep(0.3)  # Be gentle on the server

    # Step 6: Save manifest
    print(f"[6/6] Saving manifest...")

    # Build manifest episodes list (without bulky text content)
    for r in results:
        manifest_ep = {
            "episode_id": r["episode_id"],
            "date": r["date"],
            "service_text": r["service_text"],
            "service_id": r["service_id"],
            "facility_text": r["facility_text"],
            "facility_id": r["facility_id"],
            "doctor_name": r.get("doctor_name", ""),
            "doctor_code": r["doctor_code"],
            "is_hospitalization": r["is_hospitalization"],
            "old_complaint_id": r["old_complaint_id"],
            "diagnoses": r.get("diagnoses", []),
            "complaints": r.get("complaints", []),
            "output_file": r.get("output_file", ""),
            # Cross-matching fields
            "cross_match": {
                "date": r["date"],
                "facility_id": r["facility_id"],
                "service_id": r["service_id"],
                "episode_id": r["episode_id"],
            },
        }
        if r["is_hospitalization"] and "yatis_bilgisi" in r:
            manifest_ep["yatis_bilgisi"] = r["yatis_bilgisi"]

        manifest["episodes"].append(manifest_ep)

    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # Also save a separate yatis_summary.json for quick access
    yatis_episodes = [e for e in manifest["episodes"] if e["is_hospitalization"]]
    if yatis_episodes:
        summary_path = os.path.join(out_dir, "yatis_summary.json")
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump({
                "patient_id": patient_id,
                "total_yatis": len(yatis_episodes),
                "yatis_episodes": yatis_episodes,
            }, f, ensure_ascii=False, indent=2)

    # Print summary
    yatis_ok = sum(1 for r in results if r["is_hospitalization"] and "error" not in r)
    poli_ok = sum(1 for r in results if not r["is_hospitalization"] and "error" not in r)
    errors = sum(1 for r in results if "error" in r)

    print(f"\n{'='*60}")
    print(f"  DONE — Results in: {out_dir}/")
    print(f"{'='*60}")
    print(f"  Yatış episodes:     {yatis_ok} scraped")
    print(f"  Poliklinik episodes: {poli_ok} scraped")
    print(f"  Errors:             {errors}")
    print(f"  Manifest:           {manifest_path}")
    if yatis_episodes:
        print(f"  Yatış Summary:      {os.path.join(out_dir, 'yatis_summary.json')}")
    print(f"\n  Cross-matching tip: Match episodes to reports by")
    print(f"  date + facility_id using manifest.json from both scrapers.")
    print(f"{'='*60}\n")


# ─── CLI ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python cerebral_yatis.py <patient_id> [--yatis-only | --all-episodes]")
        print("  --yatis-only    Only scrape Yatış (hospitalization) episodes")
        print("  --all-episodes  Scrape all episodes (default)")
        sys.exit(1)

    patient_id = sys.argv[1]
    yatis_only = "--yatis-only" in sys.argv

    scrape_patient(patient_id, yatis_only=yatis_only)