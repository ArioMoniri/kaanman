#!/usr/bin/env python3
"""
cerebral_fetch.py — Acıbadem Cerebral Plus EHR full patient export.

Scrapes a patient's full medical record from cerebralplustr.acibadem.com.tr
and emits a single LLM-friendly JSON file.

USAGE (stdin cookie, recommended):
    echo "$COOKIE" | python3 cerebral_fetch.py 30256609

USAGE (cookie from file):
    python3 cerebral_fetch.py 30256609 --cookie-file cookies.txt

USAGE (cookie from env var):
    export CEREBRAL_COOKIE='ASP.NET_SessionId=...; access_token=...; ...'
    python3 cerebral_fetch.py 30256609

USAGE (cookie as inline arg — least safe, appears in shell history):
    python3 cerebral_fetch.py 30256609 --cookie 'ASP.NET_SessionId=...'

OUTPUT:
    Writes patient_<id>_<timestamp>.json to the current working directory.
    Exit code 0 on success, non-zero with a clear error message on failure
    (expired token, not on VPN, unauthorized, etc.)

REQUIREMENTS:
    Python 3.8+, stdlib only. No pip install needed.

MUST BE ON THE ACIBADEM HOSPITAL VPN. The host is not reachable from the
public internet. If you see "Could not resolve host" or a connection
timeout, your VPN is not routing this domain.

This script is pure stdlib (urllib + html.parser) so it works on any Mac
without additional dependencies. It is designed to be safe to call from
an LLM tool harness — all errors go to stderr, only JSON to stdout if
--stdout is passed.
"""

from __future__ import annotations

import argparse
import base64
import html as html_lib
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any

BASE_URL = "https://cerebralplustr.acibadem.com.tr"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_TIMEOUT = 30

# ANSI color helpers for stderr logging (auto-disabled when not a tty)
_USE_COLOR = sys.stderr.isatty()
def _c(code: str, msg: str) -> str:
    return f"\033[{code}m{msg}\033[0m" if _USE_COLOR else msg
def log(msg: str) -> None:  print(_c("1;34", "[*]")  + " " + msg, file=sys.stderr, flush=True)
def ok(msg: str) -> None:   print(_c("1;32", "[OK]") + " " + msg, file=sys.stderr, flush=True)
def warn(msg: str) -> None: print(_c("1;33", "[!]")  + " " + msg, file=sys.stderr, flush=True)
def err(msg: str) -> None:  print(_c("1;31", "[x]")  + " " + msg, file=sys.stderr, flush=True)


# ============================================================================
# Error class surfaced to the LLM caller
# ============================================================================
class FetchError(Exception):
    """Raised on any terminal failure. LLM callers should show .message to the user."""
    def __init__(self, code: str, message: str, hint: str = ""):
        self.code = code
        self.message = message
        self.hint = hint
        super().__init__(f"[{code}] {message}")


# ============================================================================
# JWT expiry check
# ============================================================================
def check_jwt_expiry(cookie_string: str) -> dict[str, Any]:
    m = re.search(r"access_token=([^;]+)", cookie_string)
    if not m:
        raise FetchError(
            "NO_TOKEN",
            "access_token cookie missing from cookie string",
            "Re-export cookies from your browser — the access_token cookie is required.",
        )
    token = m.group(1)
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception as e:
        raise FetchError("BAD_TOKEN", f"Cannot decode JWT: {e}", "Cookie looks malformed — re-export it.")
    exp = int(payload.get("exp", 0))
    now = int(time.time())
    remaining = exp - now
    if remaining <= 0:
        raise FetchError(
            "TOKEN_EXPIRED",
            f"access_token expired {-remaining // 60} minutes ago (exp={datetime.fromtimestamp(exp)})",
            "Log back into Cerebral Plus in your browser, export the cookies again, and retry.",
        )
    return {
        "user_id": payload.get("UserId"),
        "user_name": payload.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"),
        "organization_code": payload.get("OrganizationCode"),
        "facility_id": payload.get("FacilityId"),
        "expires_at": datetime.fromtimestamp(exp).isoformat(),
        "expires_in_minutes": remaining // 60,
    }


# ============================================================================
# HTTP helpers (urllib, no external deps)
# ============================================================================
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE  # hospital intranet may have self-signed certs


def _request(
    method: str,
    path: str,
    cookie: str,
    patient_id: str,
    body: dict[str, str] | None = None,
    accept: str = "application/json, text/javascript, */*; q=0.01",
) -> tuple[int, bytes, dict[str, str]]:
    url = f"{BASE_URL}{path}" if path.startswith("/") else f"{BASE_URL}/{path}"
    data = urllib.parse.urlencode(body).encode() if body else None
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": accept,
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": cookie,
        "Referer": f"{BASE_URL}/Cm/ehr/medicalcard?patientId={patient_id}",
    }
    if body:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        headers["Origin"] = BASE_URL
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT, context=_SSL_CTX) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})
    except urllib.error.URLError as e:
        reason = str(e.reason)
        if "timed out" in reason.lower() or "timeout" in reason.lower():
            raise FetchError(
                "TIMEOUT",
                f"Request to {url} timed out after {DEFAULT_TIMEOUT}s",
                "Are you on the Acıbadem hospital VPN? This host is not reachable from the public internet.",
            )
        if "nodename" in reason.lower() or "name resolution" in reason.lower() or "getaddrinfo" in reason.lower():
            raise FetchError(
                "DNS_FAIL",
                f"Cannot resolve {BASE_URL}: {reason}",
                "Your VPN is not routing cerebralplustr.acibadem.com.tr. Check VPN config / split-tunnel settings.",
            )
        raise FetchError("NETWORK_ERROR", f"{url}: {reason}", "Check VPN / network connection.")


def get(path: str, cookie: str, patient_id: str, accept: str = "text/html,*/*") -> tuple[int, bytes]:
    code, body, _ = _request("GET", path, cookie, patient_id, accept=accept)
    return code, body


def post(path: str, cookie: str, patient_id: str, data: dict[str, str]) -> tuple[int, bytes]:
    code, body, _ = _request("POST", path, cookie, patient_id, body=data)
    return code, body


def post_json(path: str, cookie: str, patient_id: str, data: dict[str, str]) -> Any:
    """POST + parse JSON. Returns None on non-JSON response or non-200 status."""
    code, body = post(path, cookie, patient_id, data)
    if code != 200:
        warn(f"  {path} → HTTP {code}")
        return None
    txt = body.decode("utf-8", errors="replace").strip()
    if not txt:
        return None
    # Detect HTML error page
    if txt.startswith("<!DOCTYPE") or txt.startswith("<html") or "<title>" in txt[:300].lower():
        m = re.search(r"<title>(.*?)</title>", txt, re.S)
        warn(f"  {path} returned HTML: {(m.group(1).strip()[:150] if m else txt[:150])}")
        return {"_error": "html_response", "_title": m.group(1).strip() if m else None}
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        return {"_raw": txt[:2000], "_parse_error": True}


# ============================================================================
# Episode list scraper
# ============================================================================
_EP_TAG_RE = re.compile(
    r'<div\s+class="card-item complaints"\s+id="(\d+)"([^>]*)>',
    re.I,
)
_DATA_ATTR_RE = re.compile(r'data-([a-z][a-z0-9-]*)="([^"]*)"', re.I)
_CARD_TEXT_RE = re.compile(
    r'card-item-date">([^<]*)<.*?card-item-facility">([^<]*)<.*?'
    r'card-item-doctor">([^<]*)<.*?card-item-service">([^<]*)<',
    re.S,
)


def parse_episodes_from_medical_card(html: str) -> list[dict[str, Any]]:
    """Extract the visit list from /Cm/ehr/medicalcard HTML.

    The medical card page embeds every visit as a <div class="card-item complaints">
    with id="<episodeId>" and a rich set of data-* attributes (service-id, date,
    doctor-code, etc.) plus four inner child divs with visible text (date,
    facility, doctor name, service name).
    """
    episodes = []
    for m in _EP_TAG_RE.finditer(html):
        eid = m.group(1)
        attrs = dict(_DATA_ATTR_RE.findall(m.group(2)))
        # Inner text
        tail = html[m.end() : m.end() + 2000]
        tm = _CARD_TEXT_RE.search(tail)
        inner = {
            "date_text":     html_lib.unescape(tm.group(1).strip()) if tm else None,
            "facility_text": html_lib.unescape(tm.group(2).strip()) if tm else None,
            "doctor_text":   html_lib.unescape(tm.group(3).strip()) if tm else None,
            "service_text":  html_lib.unescape(tm.group(4).strip()) if tm else None,
        }
        episodes.append({
            "episode_id": eid,
            "date":         attrs.get("date"),
            "service_id":   attrs.get("service-id"),
            "service_name": html_lib.unescape(attrs.get("service-text", "")),
            "doctor_code":  attrs.get("doctor-code"),
            "doctor_name":  inner["doctor_text"],
            "facility_id":  attrs.get("facility-id"),
            "facility_name": html_lib.unescape(attrs.get("longfacility-text", attrs.get("facility-text", ""))),
            "old_complaint_id": attrs.get("oldcomplaint-id"),
            "is_hospitalization": bool(attrs.get("hospitalization")),
            "_raw_attrs": attrs,
            "_inner_text": inner,
        })
    # Sort chronologically (newest first). date is "dd.mm.yyyy"
    def _dkey(ep):
        d = ep.get("date") or ""
        try:
            return datetime.strptime(d, "%d.%m.%Y")
        except Exception:
            return datetime.min
    episodes.sort(key=_dkey, reverse=True)
    return episodes


# ============================================================================
# Examination HTML scraper — strips tags and extracts visible labeled text
# ============================================================================
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_MULTI_NL_RE = re.compile(r"\n\s*\n+")


def strip_html_to_text(html: str) -> str:
    """Convert HTML to readable plain text.

    - Remove <script>, <style>, <head>
    - Convert <br> <p> <tr> <li> <div> to newlines
    - Unescape entities
    - Collapse whitespace
    """
    # Kill non-content sections
    html = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.I | re.S)
    html = re.sub(r"<style[^>]*>.*?</style>", " ", html, flags=re.I | re.S)
    html = re.sub(r"<head[^>]*>.*?</head>", " ", html, flags=re.I | re.S)
    html = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    # Line breaks for block elements
    html = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    html = re.sub(r"</(p|div|tr|li|h[1-6]|table|thead|tbody|section|article)>", "\n", html, flags=re.I)
    # Strip all remaining tags
    text = _TAG_RE.sub("", html)
    text = html_lib.unescape(text)
    # Normalise whitespace per-line, then collapse blank lines
    lines = [_WS_RE.sub(" ", ln).strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    return _MULTI_NL_RE.sub("\n\n", "\n".join(lines)).strip()


def build_examination_url(ep: dict[str, Any], patient_id: str) -> str:
    """Build /Cm/examination/Index URL from an episode's metadata.

    The original working URL had these params:
        patientId, complaintId (=episodeId), serviceId, date, doctorcode,
        formtype=exaform, line=T, updatelink=t,
        exaorder, treaorder, anesorder, reportno

    The last four (exaorder, treaorder, anesorder, reportno) identify a
    specific examination form WITHIN the episode. We don't have them — the
    medical card HTML only gives us the top-level episode data. We rely on
    the server to default to the most recent / primary examination form when
    these are omitted, which is what the page does when you click "View".
    """
    params = {
        "patientId":   patient_id,
        "complaintId": ep["episode_id"],
        "serviceId":   ep.get("service_id") or "",
        "updatelink":  "t",
        "date":        ep.get("date") or "",
        "doctorcode":  ep.get("doctor_code") or "",
        "line":        "T",
        "formtype":    "exaform",
    }
    return "/Cm/examination/Index?" + urllib.parse.urlencode(params)


# ============================================================================
# Main orchestration
# ============================================================================
def fetch_patient_record(patient_id: str, cookie: str) -> dict[str, Any]:
    """Fetch the complete patient record and return it as a single dict."""
    # 1. JWT sanity check
    log("Checking JWT validity...")
    jwt_info = check_jwt_expiry(cookie)
    ok(f"JWT valid — user={jwt_info['user_name']} exp_in={jwt_info['expires_in_minutes']}min")

    # 2. Load medical card HTML (this also initialises the server session)
    log(f"Loading medical card for patient {patient_id}...")
    code, body = get(f"/Cm/ehr/medicalcard?patientId={patient_id}", cookie, patient_id, accept="text/html,*/*")
    if code != 200:
        raise FetchError(
            "MEDICALCARD_FAIL",
            f"Medical card returned HTTP {code}",
            "If 302/401 → token expired; if 500 → server session issue; if timeout → VPN issue.",
        )
    mc_html = body.decode("utf-8", errors="replace")
    if len(mc_html) < 5000:
        warn(f"medical card HTML suspiciously small ({len(mc_html)}B) — might be a redirect to login")
    # Detect login redirect
    if "login" in mc_html[:500].lower() and "cerebral" not in mc_html[:500].lower():
        raise FetchError(
            "AUTH_FAIL",
            "Medical card returned what looks like a login page",
            "Re-export cookies from your browser — access_token or session cookies are no longer accepted.",
        )
    ok(f"medical card: {len(mc_html)}B")

    # 3. Parse episodes from the HTML
    log("Parsing episodes from medical card HTML...")
    episodes = parse_episodes_from_medical_card(mc_html)
    if not episodes:
        raise FetchError(
            "NO_EPISODES",
            "No episodes (card-item.complaints) found in medical card HTML",
            "Either the patient has no visit history, or the page structure changed. Check /Users/.../debug_mc.html if available.",
        )
    ok(f"found {len(episodes)} episodes: {', '.join(e['episode_id'] for e in episodes)}")

    # 4. Extract patient header info from the medical card HTML
    log("Extracting patient header info...")
    patient_info = extract_patient_header(mc_html)

    # 5. Trigger GetAllEpisodes (returns {HasError:false} — just a server-side ping)
    post_json("/Cm/Ehr/GetAllEpisodes", cookie, patient_id, {"patientId": patient_id, "DataType": "0"})

    # 6. Patient-level endpoints (run once)
    log("Fetching patient-level data...")
    patient_level = {
        "allergy":          post_json("/Cm/Nurse/GetPatientAllergyInfo",  cookie, patient_id, {"patientId": patient_id}),
        "bmi_vya":          post_json("/Cm/Ehr/GetPatientBmiVya",         cookie, patient_id, {"patientId": patient_id}),
        "previous_recipes": post_json("/Cm/Ehr/GetPreviousRecipeList",    cookie, patient_id, {"patientId": patient_id}),
    }
    ok("patient-level endpoints done")

    # 7. Per-episode data
    for ep in episodes:
        eid = ep["episode_id"]
        log(f"Fetching episode {eid} ({ep.get('date')} {ep.get('service_name')})...")
        ep["diagnosis"]   = post_json("/Cm/Ehr/GetPatientDiagnosisByEpisodeId", cookie, patient_id, {"patientId": patient_id, "episodeId": eid})
        ep["complaint"]   = post_json("/Cm/Ehr/GetPatientComplaintByEpisodeId", cookie, patient_id, {"patientId": patient_id, "episodeId": eid})
        ep["resume"]      = post_json("/Cm/Ehr/GetPatientResume",              cookie, patient_id, {"patientId": patient_id, "episodeId": eid})
        ep["plan_type"]   = post_json("/Cm/Ehr/GetPlanTypeByEpisodeId",        cookie, patient_id, {"patientId": patient_id, "episodeId": eid})

        # Examination HTML → scraped text
        exa_url = build_examination_url(ep, patient_id)
        try:
            code, raw = get(exa_url, cookie, patient_id, accept="text/html,*/*")
            if code == 200:
                raw_html = raw.decode("utf-8", errors="replace")
                ep["examination_text"] = strip_html_to_text(raw_html)
                ep["examination_url"] = exa_url
                ok(f"  examination HTML: {len(raw_html)}B → {len(ep['examination_text'])} text chars")
            else:
                ep["examination_text"] = None
                ep["examination_error"] = f"HTTP {code}"
                warn(f"  examination HTML: HTTP {code}")
        except Exception as e:
            ep["examination_text"] = None
            ep["examination_error"] = str(e)
            warn(f"  examination HTML failed: {e}")

        # Drop the noisy raw debug attrs — they're just clutter in final JSON
        ep.pop("_raw_attrs", None)
        ep.pop("_inner_text", None)

    # 8. Build the final LLM-friendly structure
    return {
        "schema_version": "1.0",
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "source": BASE_URL,
        "exported_by": {
            "user_id": jwt_info["user_id"],
            "user_name": jwt_info["user_name"],
            "facility_id": jwt_info["facility_id"],
        },
        "patient": {
            "patient_id": patient_id,
            **patient_info,
            "allergy":          patient_level["allergy"],
            "bmi_vya":          patient_level["bmi_vya"],
            "previous_recipes": patient_level["previous_recipes"],
        },
        "episodes": episodes,  # already sorted newest→oldest
        "summary": {
            "episode_count": len(episodes),
            "date_range": {
                "earliest": episodes[-1].get("date") if episodes else None,
                "latest":   episodes[0].get("date") if episodes else None,
            },
            "departments": sorted({e.get("service_name", "") for e in episodes if e.get("service_name")}),
            "facilities":  sorted({e.get("facility_name", "") for e in episodes if e.get("facility_name")}),
            "doctors":     sorted({e.get("doctor_name", "") for e in episodes if e.get("doctor_name")}),
        },
    }


def extract_patient_header(html: str) -> dict[str, Any]:
    """Pull the patient name (and any other available header info) from the page.

    The medical card page does not expose the patient info as a structured
    DOM block with stable IDs — the only place the name reliably appears
    is the <title>, formatted like "NAME SURNAME <patientId>".
    """
    info: dict[str, Any] = {}
    t = re.search(r"<title>(.*?)</title>", html, re.S)
    if t:
        title = html_lib.unescape(t.group(1).strip())
        info["page_title"] = title
        # Split off trailing numeric ID if present
        m = re.match(r"^(.*?)\s+(\d{6,})\s*$", title)
        if m:
            info["full_name"] = re.sub(r"\s+", " ", m.group(1).strip())
    # Some installs expose the birth date via a data-birthDate attribute used
    # by the Nurse subsystem (seen in the probe: birthDate=26.04.2003)
    bd = re.search(r'birthDate=(\d{2}\.\d{2}\.\d{4})', html)
    if bd:
        info["birth_date"] = bd.group(1)
    return info


# ============================================================================
# CLI
# ============================================================================
def read_cookie_from_sources(args) -> str:
    if args.cookie:
        return args.cookie.strip()
    if args.cookie_file:
        with open(args.cookie_file) as f:
            return f.read().strip()
    env = os.environ.get("CEREBRAL_COOKIE")
    if env:
        return env.strip()
    if not sys.stdin.isatty():
        data = sys.stdin.read().strip()
        if data:
            return data
    raise FetchError(
        "NO_COOKIE",
        "No cookie provided",
        "Pass --cookie-file <path>, or set $CEREBRAL_COOKIE, or pipe the cookie to stdin.",
    )


def main() -> int:
    p = argparse.ArgumentParser(
        description="Acıbadem Cerebral Plus EHR full patient record exporter.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("patient_id", help="Patient ID (e.g. 30256609 or '7021 4897')")
    p.add_argument("--cookie-file", help="Read cookie string from file")
    p.add_argument("--cookie", help="Cookie string as inline arg (visible in shell history — avoid)")
    p.add_argument("--output", "-o", help="Output file path (default: patient_<id>_<timestamp>.json in cwd)")
    p.add_argument("--stdout", action="store_true", help="Print JSON to stdout instead of writing to file")
    p.add_argument("--pretty", action="store_true", default=True, help="Pretty-print JSON (default: true)")
    args = p.parse_args()

    # Normalise protocol ID: strip spaces/dashes so "7021 4897" → "70214897"
    args.patient_id = re.sub(r"[\s\-]+", "", args.patient_id)

    if not re.fullmatch(r"\d+", args.patient_id):
        err("patient_id must be numeric (e.g. 30256609 or '7021 4897')")
        return 2

    try:
        cookie = read_cookie_from_sources(args)
        record = fetch_patient_record(args.patient_id, cookie)
    except FetchError as e:
        err(f"{e.code}: {e.message}")
        if e.hint:
            err(f"HINT: {e.hint}")
        # Also emit a structured error JSON on stderr so LLM harness can parse it
        print(json.dumps({"error": {"code": e.code, "message": e.message, "hint": e.hint}}, ensure_ascii=False), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        err("interrupted")
        return 130
    except Exception as e:
        err(f"UNEXPECTED: {type(e).__name__}: {e}")
        return 1

    blob = json.dumps(record, ensure_ascii=False, indent=2 if args.pretty else None)

    if args.stdout:
        print(blob)
    else:
        out_path = args.output or f"patient_{args.patient_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(blob)
        ok(f"written: {out_path}  ({len(blob)} chars, {len(record['episodes'])} episodes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())