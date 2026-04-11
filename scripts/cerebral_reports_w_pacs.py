#!/usr/bin/env python3
"""
Cerebral Plus Report Downloader
Downloads all medical reports for a patient by protocol number.
Generates PACS viewer links for radiology reports.

Usage:
    python cerebral_reports.py <protocol_no>
    python cerebral_reports.py --refresh-pacs reports_70214897

Requirements:
    pip install requests pymupdf

PACS Link Refresh Guide (for LLM or manual use):
    PACS URLs expire because they contain a signed timestamp.
    To regenerate all PACS links without re-downloading reports:

        python cerebral_reports.py --refresh-pacs <output_dir>

    This reads manifest.json from <output_dir>, regenerates every PACS URL
    with a fresh timestamp, and overwrites pacs_links.json + manifest.json.

    To regenerate a SINGLE study link programmatically:

        import hashlib, math, time
        from urllib.parse import quote

        def pacs_url(patient_id, acc_no):
            ts = str(math.floor(time.time()))
            data = (patient_id + ts + "sectra" + "URL"
                    + "show_study" + "0" + acc_no + "Sectra2020*")
            key = hashlib.sha1(data.encode("utf-8")).hexdigest()
            return (f"https://pacskad.acibadem.com.tr/uniview/"
                    f"#/apiLaunch?pat_id={quote(patient_id)}"
                    f"&time={ts}&user_id=sectra&mrn_group=URL"
                    f"&uniview_cmd=show_study&allow_pat_change=0"
                    f"&acc_no={quote(acc_no)}&key={key}")

    For all-studies link (no specific study):
        Replace "show_study" with "show_images", remove acc_no from
        both the data string and the URL parameters.
"""

import argparse
import base64
import hashlib
import json
import math
import os
import re
import sys
import time
import zipfile
import io
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from urllib.parse import quote

import requests

try:
    import fitz  # PyMuPDF
    HAS_PYMUPDF = True
except ImportError:
    HAS_PYMUPDF = False
    print("[WARN] PyMuPDF not installed. Text extraction disabled. Run: pip install pymupdf")

BASE_URL = "https://cerebralplustr.acibadem.com.tr"
PACS_BASE = "https://pacskad.acibadem.com.tr/uniview/"
PACS_USER = "sectra"
PACS_MRN_GROUP = "URL"
PACS_SECRET = "Sectra2020*"
COOKIES_FILE = os.environ.get("COOKIES_FILE") or next(
    (p for p in [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cookies", "cookies.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.json"),
    ] if os.path.isfile(p)),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.json"),
)

REPORT_OPEN_TYPES = {"M", "0", "G", "X", "K", "O", "D", "F"}
MM_REPORT_TYPES = {"H"}
LAB_REPORT_TYPES = {"L"}
ZIP_ONLY_TYPES = {"P"}

REPORT_COLUMNS = [
    "ReportId", "ReportType", "ReportNote", "ReportDateStr",
    "ReportId", "Facility", "ReportId", "ReportId"
]


# ── PACS URL generation ─────────────────────────────────────────────
def generate_pacs_url(patient_id, uniview_cmd="show_images", acc_no=None):
    """Generate a signed Sectra UniView PACS URL with fresh timestamp."""
    timestamp = str(math.floor(time.time()))
    parts = [patient_id, timestamp, PACS_USER, PACS_MRN_GROUP, uniview_cmd, "0"]
    if acc_no:
        parts.append(acc_no)
    parts.append(PACS_SECRET)
    key = hashlib.sha1("".join(parts).encode("utf-8")).hexdigest()

    url = (
        f"{PACS_BASE}#/apiLaunch?"
        f"pat_id={quote(patient_id)}&time={timestamp}"
        f"&user_id={PACS_USER}&mrn_group={PACS_MRN_GROUP}"
        f"&uniview_cmd={quote(uniview_cmd)}&allow_pat_change=0"
    )
    if acc_no:
        url += f"&acc_no={quote(acc_no)}"
    url += f"&key={key}"
    return url


def extract_accession_number(text):
    """Extract accession number (Erişim Numarası) from report text."""
    if not text:
        return None
    for pattern in [
        r'Eri[sş]im\s+Numaras[ıi]\s*:\s*(\d+)',
        r'Accession\s*(?:No|Number|#)?\s*:\s*(\d+)',
        r'Eri[sş]im\s+No\s*:\s*(\d+)',
    ]:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


# ── File naming ──────────────────────────────────────────────────────
def safe_filename(s, max_len=80):
    s = s.replace("/", "-").replace("\\", "-")
    s = re.sub(r'[<>:"|?*\x00-\x1f]', '', s)
    s = re.sub(r'\s+', '_', s.strip())
    s = re.sub(r'_+', '_', s)
    return s[:max_len].rstrip('_.')


def build_report_filename(report):
    parts = [
        safe_filename(report.get("ReportType", "Unknown"), 30),
        safe_filename(report.get("ReportNote", "NoName"), 50),
        safe_filename(report.get("ReportDateStr", "").replace(":", ".").replace(" ", "_"), 20),
        str(report.get("ReportId", "0")),
    ]
    return "_".join(p for p in parts if p)


class LinkExtractor(HTMLParser):
    def __init__(self, pattern):
        super().__init__()
        self.pattern = pattern
        self.result = None

    def handle_starttag(self, tag, attrs):
        if tag == "a" and self.result is None:
            for name, val in attrs:
                if name == "href" and val and self.pattern in val:
                    self.result = val.replace("&amp;", "&")


def load_cookies_json(filepath):
    with open(filepath, "r", encoding="utf-8") as f:
        cookies = json.load(f)
    target_domain = "cerebralplustr.acibadem.com.tr"
    pairs = []
    for c in cookies:
        domain = c.get("domain", "")
        name = c.get("name", "")
        value = c.get("value", "")
        if not name:
            continue
        if domain == target_domain or (domain.startswith(".") and target_domain.endswith(domain)):
            pairs.append(f"{name}={value}")
    if not pairs:
        raise RuntimeError(f"No cookies found for {target_domain} in {filepath}")
    return "; ".join(pairs)


class CerebralSession:
    def __init__(self, cookie_header):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE_URL,
            "Referer": BASE_URL + "/CM/ehr/medicalcard",
            "Cookie": cookie_header,
        })

    def init_patient(self, patient_id):
        url = f"{BASE_URL}/CM/ehr/medicalcard?patientId={patient_id}"
        resp = self.session.get(url, timeout=30, allow_redirects=True)
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to load medical card: HTTP {resp.status_code}")
        if "/ehr/medicalcard" not in resp.url:
            raise RuntimeError("Session expired – redirected away. Export fresh cookies.")
        if len(resp.content) < 5000:
            raise RuntimeError("Session expired – got empty page. Export fresh cookies.")
        return True

    def get_all_reports(self, patient_id):
            url = f"{BASE_URL}/Cm/Ehr/GetReports"
            data = {
                "draw": "1", "start": "0", "length": "500",
                "search[value]": "", "search[regex]": "false",
                "order[0][column]": "0", "order[0][dir]": "desc",
                "PatientId": patient_id, "complaintId": "0",
                "ReportType": "", "FacilityId": "DoctorLoginFacility", "StartDate": "",
            }
            for i, col in enumerate(REPORT_COLUMNS):
                data[f"columns[{i}][data]"] = col
                data[f"columns[{i}][name]"] = ""
                data[f"columns[{i}][searchable]"] = "true"
                data[f"columns[{i}][orderable]"] = "false"
                data[f"columns[{i}][search][value]"] = ""
                data[f"columns[{i}][search][regex]"] = "false"
            resp = self.session.post(url, data=data, timeout=30)
            resp.raise_for_status()
            ct = resp.headers.get("content-type", "")
            if "json" not in ct and "javascript" not in ct:
                if len(resp.text) < 100 or "<html" in resp.text[:500].lower():
                    raise RuntimeError("GetReports returned non-JSON. Session likely expired.")
            result = resp.json()
            reports = result.get("data", [])
            total = result.get("recordsTotal", 0)

            # Deduplicate by ReportId (server may ignore pagination start param)
            seen = set()
            unique = []
            for r in reports:
                rid = r.get("ReportId")
                if rid not in seen:
                    seen.add(rid)
                    unique.append(r)

            return unique, total

    def download_report_open(self, report_id, report_type_swc):
            resp = self.session.get(f"{BASE_URL}/Cm/Ehr/_ReportOpen",
                                    params={"reportid": report_id, "reportType": report_type_swc}, timeout=60)
            if resp.status_code == 200 and len(resp.content) > 100:
                # Accept PDF, RTF, or any non-HTML content with real data
                ct = resp.headers.get("content-type", "")
                if "html" not in ct or resp.content[:5] == b"%PDF-":
                    return resp.content
                # Even HTML might be valid if it's large enough (some reports render as HTML)
                if len(resp.content) > 1000:
                    return resp.content
            return None

    def download_mm_report(self, report_id):
        resp = self.session.get(f"{BASE_URL}/Cm/report/MMReportOpen",
                                params={"reportid": report_id}, timeout=60)
        if resp.status_code == 200 and len(resp.content) > 100:
            ct = resp.headers.get("content-type", "")
            if "html" not in ct or resp.content[:5] == b"%PDF-":
                return resp.content
            if len(resp.content) > 1000:
                return resp.content
        return None

    def get_report_menu_url(self, patient_id, report, link_pattern):
        url = f"{BASE_URL}/Cm/Ehr/GetReportMenuForOneReport?patientId={patient_id}"
        form = {k: str(report.get(v) or "") for k, v in {
            "reportid": "ReportId", "reporttypeswc": "ReportTypeSwc",
            "reporttype": "ReportType", "reportnote": "ReportNote",
            "approveswc": "ApproveSwc", "fileok": "FileOk",
            "iscerebralplusreport": "IsCerebralPlusReport",
            "haveesignreportdata": "HaveESignReportData",
            "formid": "FormId", "reportswc": "ReportSwc", "risswc": "RisSwc",
            "rapswc": "RapSwc", "havepdffile": "HavePdfFile",
            "reporttypeid": "ReportTypeId", "episodeid": "EpisodeId",
            "orderno": "OrderNo", "formname": "FormName",
            "reportlinc": "ReportLinc", "masterreportno": "MasterReportNo",
            "radiologyswc": "RadiologySwc", "hasversioning": "HasVersioning",
            "username": "UserName", "refid": "RefId", "isusg": "IsUSG",
            "reportidencrypted": "ReportIdEncrypted", "magicserver": "MagicServer",
            "hizmet_swc": "HIZMET_SWC", "reportdate": "ReportDateStr",
            "medulaid": "MedulaId", "swc_1": "SWC_1",
        }.items()}
        resp = self.session.post(url, data=form, timeout=15)
        if resp.status_code != 200:
            return None
        try:
            html = json.loads(resp.text)
        except json.JSONDecodeError:
            html = resp.text
        ext = LinkExtractor(link_pattern)
        ext.feed(html)
        return ext.result

    def download_lab_report(self, patient_id, report):
        menu_url = self.get_report_menu_url(patient_id, report, "_LabReportOpen")
        if not menu_url:
            return None
        full_url = BASE_URL + menu_url if menu_url.startswith("/") else menu_url
        try:
            resp = self.session.get(full_url, timeout=120)
            if resp.status_code == 200 and len(resp.content) > 100:
                ct = resp.headers.get("content-type", "")
                if "pdf" in ct or resp.content[:5] == b"%PDF-" or "html" in ct:
                    return resp.content
        except requests.Timeout:
            pass
        return None

    def download_xsig(self, report_id, patient_id):
        resp = self.session.get(f"{BASE_URL}/Cm/Report/XadesSignFile",
                                params={"reportId": report_id, "patientId": patient_id}, timeout=30)
        if resp.status_code != 200 or len(resp.content) < 100:
            return None
        try:
            text = resp.content.decode("utf-8", errors="ignore")
            m = re.search(r'<ds:Object[^>]*MimeType="application/pdf"[^>]*Encoding="base64"[^>]*>(.*?)</ds:Object>', text, re.DOTALL)
            if m:
                return base64.b64decode(m.group(1).strip())
        except Exception:
            pass
        return None

    def download_via_zip(self, report_ids):
        if not report_ids:
            return {}
        resp = self.session.post(f"{BASE_URL}/Cm/Ehr/DownloadAllMedicalReports",
                                 json={"reportid": list(report_ids)}, timeout=60)
        if resp.status_code != 200 or "true" not in resp.text.lower():
            return {}
        resp = self.session.get(f"{BASE_URL}/Cm/ehr/GetMedicalReportsZipFile", timeout=120)
        if resp.status_code != 200 or len(resp.content) < 100:
            return {}
        results = {}
        try:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                for name in zf.namelist():
                    data = zf.read(name)
                    if data:
                        for rid in report_ids:
                            if str(rid) in name:
                                results[str(rid)] = data
                                break
                        else:
                            results[name] = data
        except zipfile.BadZipFile:
            pass
        return results


def extract_text_from_pdf(pdf_data):
    if not HAS_PYMUPDF or not pdf_data:
        return ""
    try:
        doc = fitz.open(stream=pdf_data, filetype="pdf")
        texts = [page.get_text() for page in doc]
        doc.close()
        return "\n".join(texts).strip()
    except Exception as e:
        return f"[TEXT EXTRACTION ERROR: {e}]"

def extract_text_from_rtf(rtf_data):
    """Extract plain text from RTF content.

    Handles:
    - \\'XX hex escapes → cp1254 decoded characters (Turkish: ç, ğ, ı, ö, ş, ü)
    - \\uN? Unicode escapes
    - \\par, \\line → newlines
    - \\tab → tab
    - Escaped literals: \\\\, \\{, \\}
    - Nested RTF groups (multi-pass removal)
    """
    if isinstance(rtf_data, bytes):
        rtf_data = rtf_data.decode("cp1254", errors="ignore")

    text = rtf_data

    # 0. Strip outer {\rtf1...} envelope — keep the inner content
    m_outer = re.match(r'^\s*\{\\rtf\d?\s*', text)
    if m_outer:
        text = text[m_outer.end():]
        # Remove the matching closing brace at the very end
        if text.rstrip().endswith('}'):
            text = text.rstrip()[:-1]

    # 1. Remove header groups iteratively (fonttbl, colortbl, stylesheet, etc.)
    #    These are deeply nested, so run multiple passes
    for _ in range(5):
        reduced = re.sub(r'\{\\(?:fonttbl|colortbl|stylesheet|info|header|footer|pict|object|datafield|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|listtable|listoverridetable|pgdsctbl|rsidtbl)\b[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', '', text)
        if reduced == text:
            break
        text = reduced

    # 2. Remove remaining nested groups that don't contain readable text
    #    (field instructions, bookmarks, etc.) — innermost first, multi-pass
    for _ in range(10):
        # Only strip groups that start with a control word (not plain text groups)
        reduced = re.sub(r'\{\\[a-z*][^{}]*\}', '', text)
        if reduced == text:
            break
        text = reduced

    # 2b. Flatten remaining plain text groups (just remove braces, keep content)
    for _ in range(5):
        reduced = re.sub(r'\{([^{}]*)\}', r'\1', text)
        if reduced == text:
            break
        text = reduced

    # 3. Decode \'XX hex escapes → cp1254 characters (critical for Turkish)
    def _decode_hex(m):
        try:
            return bytes([int(m.group(1), 16)]).decode("cp1254", errors="replace")
        except (ValueError, UnicodeDecodeError):
            return ""
    text = re.sub(r"\\'([0-9a-fA-F]{2})", _decode_hex, text)

    # 4. Decode \uN? Unicode escapes
    def _decode_unicode(m):
        try:
            cp = int(m.group(1))
            if cp < 0:
                cp += 65536
            return chr(cp)
        except (ValueError, OverflowError):
            return ""
    text = re.sub(r'\\u(-?\d+)\s?\??', _decode_unicode, text)

    # 5. Convert structural control words to whitespace
    text = re.sub(r'\\par\b\s?', '\n', text)
    text = re.sub(r'\\line\b\s?', '\n', text)
    text = re.sub(r'\\tab\b\s?', '\t', text)
    text = re.sub(r'\\page\b\s?', '\n\n', text)
    # RTF table cell/row boundaries → tab/newline for tabular layout
    text = re.sub(r'\\cell\b\s?', '\t', text)
    text = re.sub(r'\\row\b\s?', '\n', text)
    text = re.sub(r'\\trowd\b[^\\]*', '', text)    # remove row definitions
    text = re.sub(r'\\cellx\d+\s?', '', text)      # remove cell width defs

    # 6. Handle escaped literals
    text = text.replace('\\\\', '\x00BACKSLASH\x00')
    text = text.replace('\\{', '{')
    text = text.replace('\\}', '}')

    # 7. Remove remaining control words (\keyword123 )
    text = re.sub(r'\\[a-z*]+\d*\s?', '', text)

    # 8. Restore escaped backslashes and clean up
    text = text.replace('\x00BACKSLASH\x00', '\\')
    text = re.sub(r'[{}]', '', text)               # remove leftover braces
    text = re.sub(r'\r\n|\r', '\n', text)           # normalize newlines
    text = re.sub(r'[ \t]+\n', '\n', text)          # trailing whitespace on lines
    text = re.sub(r'\n{3,}', '\n\n', text)          # collapse blank lines
    return text.strip()

def extract_text_from_html(html_data):
    class TE(HTMLParser):
        def __init__(self):
            super().__init__()
            self.t, self.s = [], False
        def handle_starttag(self, tag, a):
            if tag in ("script", "style"): self.s = True
        def handle_endtag(self, tag):
            if tag in ("script", "style"): self.s = False
        def handle_data(self, d):
            if not self.s and d.strip(): self.t.append(d.strip())
    try:
        e = TE()
        e.feed(html_data.decode("utf-8", errors="ignore") if isinstance(html_data, bytes) else html_data)
        return "\n".join(e.t).strip()
    except Exception:
        return ""


# ── Refresh PACS links from existing manifest ────────────────────────
def refresh_pacs_links(output_dir):
    """Regenerate all PACS links with fresh timestamps from existing manifest."""
    manifest_path = os.path.join(output_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        raise RuntimeError(f"manifest.json not found in {output_dir}")

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    patient_id = manifest_data.get("patient_id", "")
    reports = manifest_data.get("reports", [])

    if not patient_id:
        raise RuntimeError("No patient_id in manifest.json")

    # Regenerate all PACS URLs with fresh timestamp
    pacs_all = generate_pacs_url(patient_id, "show_images")
    manifest_data["pacs_all_studies"] = pacs_all

    study_links = []
    for entry in reports:
        acc_no = entry.get("accession_number")
        if acc_no:
            fresh_url = generate_pacs_url(patient_id, "show_study", acc_no)
            entry["pacs_url"] = fresh_url
            study_links.append({
                "report_id": entry["report_id"],
                "report_name": entry.get("report_name", ""),
                "accession_number": acc_no,
                "pacs_url": fresh_url,
            })

    # Save updated manifest
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, ensure_ascii=False, indent=2)

    # Save updated pacs_links
    pacs_data = {
        "patient_id": patient_id,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "pacs_all_studies": pacs_all,
        "studies": study_links,
    }
    with open(os.path.join(output_dir, "pacs_links.json"), "w", encoding="utf-8") as f:
        json.dump(pacs_data, f, ensure_ascii=False, indent=2)

    print(f"PACS links refreshed for patient {patient_id}")
    print(f"  All studies: {pacs_all[:90]}...")
    print(f"  {len(study_links)} study-specific links updated")
    for s in study_links:
        print(f"    {s['report_name']:<40} acc={s['accession_number']:<12}")
    print(f"\nFiles updated:")
    print(f"  {manifest_path}")
    print(f"  {os.path.join(output_dir, 'pacs_links.json')}")


# ── Main download orchestrator ───────────────────────────────────────
def download_all_reports(protocol_no, output_dir=None, max_workers=10):
    patient_id = str(protocol_no)
    if output_dir is None:
        output_dir = f"reports_{patient_id}"
    os.makedirs(output_dir, exist_ok=True)

    if not os.path.exists(COOKIES_FILE):
        raise RuntimeError(f"cookies.json not found at {COOKIES_FILE}")

    print(f"[1/6] Loading cookies...")
    cookie_header = load_cookies_json(COOKIES_FILE)
    sess = CerebralSession(cookie_header)
    print(f"      Initializing session for patient {patient_id}...")
    sess.init_patient(patient_id)
    print("      Session established.")

    print("[2/6] Fetching report list...")
    reports, total = sess.get_all_reports(patient_id)
    print(f"      Found {len(reports)} accessible reports (of {total} total).")
    if not reports:
        print("[!] No reports found.")
        return

    direct_reports, mm_reports, lab_reports, zip_reports, esign_reports = [], [], [], [], []
    for r in reports:
        t = r.get("ReportTypeSwc", "")
        if t in REPORT_OPEN_TYPES: direct_reports.append(r)
        elif t in MM_REPORT_TYPES: mm_reports.append(r)
        elif t in LAB_REPORT_TYPES: lab_reports.append(r)
        elif t in ZIP_ONLY_TYPES: zip_reports.append(r)
        else: direct_reports.append(r)
        if r.get("HaveESignReportData") == "T": esign_reports.append(r)

    type_counts = {}
    for r in reports:
        t = r.get("ReportTypeSwc") or "?"
        type_counts[t] = type_counts.get(t, 0) + 1
    print(f"      Types: {dict(sorted(type_counts.items(), key=lambda x: -x[1]))}")

    print("[3/6] Downloading reports...")
    results = {}
    failed_ids = []
    t_start = time.time()

    def download_one(report):
            rid = str(report.get("ReportId", ""))
            t = report.get("ReportTypeSwc", "")
            fname = build_report_filename(report)
            pdf = None
            # Try up to 2 times
            for attempt in range(2):
                try:
                    pdf = sess.download_mm_report(rid) if t in MM_REPORT_TYPES else sess.download_report_open(rid, t)
                    if pdf:
                        break
                except Exception:
                    if attempt == 0:
                        time.sleep(1)
            return rid, fname, pdf, report

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(download_one, r): r for r in direct_reports + mm_reports}
        for future in as_completed(futures):
            try:
                rid, fname, pdf, meta = future.result()
                if pdf: results[rid] = (pdf, fname, meta)
                else: failed_ids.append(rid); results[rid] = (None, fname, meta)
            except Exception as e:
                r = futures[future]
                rid = str(r.get("ReportId", ""))
                failed_ids.append(rid)
                results[rid] = (None, build_report_filename(r), r)

    for r in lab_reports:
        rid = str(r.get("ReportId", ""))
        fname = build_report_filename(r)
        try:
            pdf = sess.download_lab_report(patient_id, r)
            if pdf: results[rid] = (pdf, fname, r)
            else: failed_ids.append(rid); results[rid] = (None, fname, r)
        except Exception:
            failed_ids.append(rid); results[rid] = (None, fname, r)

    for r in zip_reports:
        rid = str(r.get("ReportId", ""))
        failed_ids.append(rid); results[rid] = (None, build_report_filename(r), r)

    t_direct = time.time() - t_start
    ok_count = sum(1 for v in results.values() if v[0] is not None)
    print(f"      Direct: {ok_count}/{len(reports)} in {t_direct:.1f}s")

    if failed_ids:
        print(f"      ZIP fallback for {len(failed_ids)}...")
        try:
            zr = sess.download_via_zip(failed_ids)
            zm = 0
            for rid in list(failed_ids):
                if str(rid) in zr:
                    _, fname, meta = results[rid]
                    results[rid] = (zr[str(rid)], fname, meta)
                    failed_ids.remove(rid); zm += 1
            for zname, zdata in zr.items():
                for rid in list(failed_ids):
                    if str(rid) in zname:
                        _, fname, meta = results.get(rid, (None, str(rid), {}))
                        results[rid] = (zdata, fname, meta)
                        failed_ids.remove(rid); zm += 1; break
            print(f"      ZIP recovered: {zm}")
        except Exception as e:
            print(f"      [ERR] ZIP: {e}")

    if esign_reports:
        for r in esign_reports:
            rid = str(r.get("ReportId", ""))
            try:
                xsig_pdf = sess.download_xsig(rid, patient_id)
                if xsig_pdf and rid in results and results[rid][0] is None:
                    _, fname, meta = results[rid]
                    results[rid] = (xsig_pdf, fname, meta)
            except Exception: pass

    t_total = time.time() - t_start
    final_ok = sum(1 for v in results.values() if v[0] is not None)
    print(f"      Total: {final_ok}/{len(reports)} in {t_total:.1f}s")

    # ── Save files + extract text (NO PACS links in files) ───────────
    print("[4/6] Saving files and extracting text...")
    manifest = []

    for rid, (pdf_data, fname, meta) in sorted(results.items(), key=lambda x: x[1][1]):
        entry = {
            "report_id": rid,
            "report_type": meta.get("ReportType", ""),
            "report_type_swc": meta.get("ReportTypeSwc", ""),
            "report_name": meta.get("ReportNote", ""),
            "date": meta.get("ReportDateStr", ""),
            "facility": meta.get("Facility", ""),
            "approver": meta.get("ApproverName", ""),
            "form_name": meta.get("FormName", ""),
            "episode_id": str(meta.get("EpisodeId", "")),
            "e_signed": meta.get("HaveESignReportData", "F") == "T",
        }

        if pdf_data:
            is_pdf = pdf_data[:5] == b"%PDF-"
            is_html = b"<html" in pdf_data[:500].lower() or b"<!doctype" in pdf_data[:500].lower()
            is_rtf = pdf_data[:5] == b"{\\rtf"
            ext = ".pdf" if is_pdf else ".rtf" if is_rtf else ".html" if is_html else ".bin"

            with open(os.path.join(output_dir, fname + ext), "wb") as f:
                f.write(pdf_data)
            entry["file"] = fname + ext
            entry["file_size"] = len(pdf_data)

            if is_pdf:
                text = extract_text_from_pdf(pdf_data)
            elif is_html:
                text = extract_text_from_html(pdf_data)
            elif is_rtf:
                text = extract_text_from_rtf(pdf_data)
            else:
                text = ""

            # Extract accession number for radiology (stored in manifest, NOT in file)
            if meta.get("ReportTypeSwc") == "X" and text:
                acc_no = extract_accession_number(text)
                if acc_no:
                    entry["accession_number"] = acc_no

            if text:
                header_lines = [
                    f"# Report: {meta.get('ReportNote', '')}",
                    f"# Type: {meta.get('ReportType', '')}",
                    f"# Date: {meta.get('ReportDateStr', '')}",
                    f"# ID: {rid}",
                    f"# Facility: {meta.get('Facility', '')}",
                    f"# Approver: {meta.get('ApproverName', '')}",
                    f"# Form: {meta.get('FormName', '')}",
                    "# " + "=" * 60,
                ]
                with open(os.path.join(output_dir, fname + "-txt.txt"), "w", encoding="utf-8") as f:
                    f.write("\n".join(header_lines) + "\n\n" + text)
                entry["text_file"] = fname + "-txt.txt"
                entry["text_length"] = len(text)
            else:
                entry["text_file"] = None
                entry["text_length"] = 0
        else:
            entry.update({"file": None, "file_size": 0, "text_file": None,
                          "text_length": 0, "error": "download_failed"})

        manifest.append(entry)

    # ── Generate ALL PACS links fresh NOW (after downloads complete) ──
    print("[5/6] Generating fresh PACS links...")
    pacs_all = generate_pacs_url(patient_id, "show_images")
    study_links = []
    for entry in manifest:
        acc_no = entry.get("accession_number")
        if acc_no:
            entry["pacs_url"] = generate_pacs_url(patient_id, "show_study", acc_no)
            study_links.append({
                "report_id": entry["report_id"],
                "report_name": entry.get("report_name", ""),
                "accession_number": acc_no,
                "pacs_url": entry["pacs_url"],
            })

    pacs_data = {
        "patient_id": patient_id,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": "PACS URLs are time-signed and expire. Refresh with: python cerebral_reports.py --refresh-pacs " + output_dir,
        "pacs_all_studies": pacs_all,
        "studies": study_links,
    }
    with open(os.path.join(output_dir, "pacs_links.json"), "w", encoding="utf-8") as f:
        json.dump(pacs_data, f, ensure_ascii=False, indent=2)

    # ── Save manifest ────────────────────────────────────────────────
    print("[6/6] Saving manifest...")
    manifest_data = {"patient_id": patient_id, "pacs_all_studies": pacs_all, "reports": manifest}
    with open(os.path.join(output_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, ensure_ascii=False, indent=2)

    # ── Terminal summary ─────────────────────────────────────────────
    print("\n" + "=" * 80)
    print(f"  REPORT DOWNLOAD SUMMARY – Patient {patient_id}")
    print("=" * 80)
    print(f"  Total: {total} on server, {len(reports)} accessible, {final_ok} downloaded")
    print(f"  Time: {t_total:.1f}s  |  E-signed: {len(esign_reports)}  |  PACS links: {len(study_links)}")
    print(f"  Output: {os.path.abspath(output_dir)}")
    print("-" * 80)
    print(f"  {'Type':<25} {'#':>3} {'DL':>3} {'Txt':>3}")
    print("-" * 80)
    type_stats = {}
    for e in manifest:
        t = e.get("report_type") or e.get("report_type_swc") or "?"
        if t not in type_stats: type_stats[t] = [0, 0, 0]
        type_stats[t][0] += 1
        if e.get("file"): type_stats[t][1] += 1
        if e.get("text_length", 0) > 0: type_stats[t][2] += 1
    for t, (tot, ok, txt) in sorted(type_stats.items(), key=lambda x: -x[1][0]):
        print(f"  {t:<25} {tot:>3} {ok:>3} {txt:>3}")

    if study_links:
        print("-" * 80)
        print(f"  PACS ALL STUDIES: {pacs_all[:80]}...")
        print(f"  PACS PER-STUDY ({len(study_links)}):")
        for s in study_links:
            print(f"    {s['report_name']:<40} acc={s['accession_number']}")

    print("-" * 80)
    print(f"  To refresh expired PACS links:")
    print(f"    python cerebral_reports.py --refresh-pacs {output_dir}")
    print("=" * 80 + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(
        description="Download all medical reports from Cerebral Plus",
        epilog="To refresh expired PACS links: %(prog)s --refresh-pacs <output_dir>")
    parser.add_argument("protocol_no", nargs="?", help="Patient protocol number (Hasta No)")
    parser.add_argument("--output", "-o", help="Output directory")
    parser.add_argument("--workers", "-w", type=int, default=10, help="Concurrent workers (default: 10)")
    parser.add_argument("--refresh-pacs", metavar="DIR",
                        help="Regenerate PACS links from existing manifest (no download)")
    args = parser.parse_args()

    if args.refresh_pacs:
        try:
            refresh_pacs_links(args.refresh_pacs)
        except RuntimeError as e:
            print(f"[FATAL] {e}")
            sys.exit(1)
        return

    if not args.protocol_no:
        parser.error("protocol_no is required (or use --refresh-pacs)")

    try:
        download_all_reports(args.protocol_no, args.output, args.workers)
    except RuntimeError as e:
        print(f"\n[FATAL] {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[INTERRUPTED]")
        sys.exit(130)


if __name__ == "__main__":
    main()