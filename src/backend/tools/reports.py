"""Report downloader wrapper — fetches all patient reports from Cerebral Plus.

Wraps scripts/cerebral_reports_w_pacs.py as a subprocess, returning manifest data
with report metadata and PACS links. Also provides PACS URL generation for on-demand
link refresh (signed URLs expire because they embed a timestamp).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
COOKIES_DIR = Path(__file__).resolve().parents[3] / "cookies"
PROJECT_ROOT = Path(__file__).resolve().parents[3]

log = logging.getLogger("cerebralink.reports")

# ── PACS URL configuration ──
PACS_BASE = "https://pacskad.acibadem.com.tr/uniview/"
PACS_USER = "sectra"
PACS_MRN_GROUP = "URL"
PACS_SECRET = "Sectra2020*"


def _normalize_protocol_id(pid: str) -> str:
    """Strip spaces/dashes from protocol IDs: '7021 4897' -> '70214897'."""
    return re.sub(r"[\s\-]+", "", pid.strip())


def _reports_dir(protocol_id: str) -> Path:
    """Return the output directory for a patient's reports."""
    return PROJECT_ROOT / f"reports_{protocol_id}"


# ── PACS URL generation (inline, no subprocess needed) ──

def generate_pacs_url(
    patient_id: str,
    uniview_cmd: str = "show_images",
    acc_no: str | None = None,
) -> str:
    """Generate a signed Sectra UniView PACS URL with fresh timestamp.

    For all-studies: cmd="show_images", no acc_no
    For per-study:   cmd="show_study", acc_no=<accession number>

    Hash: SHA1(patient_id + timestamp + "sectra" + "URL" + cmd + "0" [+ acc_no] + secret)
    """
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


def get_fresh_pacs_link(patient_id: str, accession_number: str | None = None) -> dict:
    """Generate a fresh PACS link for a patient or specific study.

    Returns dict with url, patient_id, accession_number, generated_at.
    """
    patient_id = _normalize_protocol_id(patient_id)

    if accession_number:
        url = generate_pacs_url(patient_id, "show_study", accession_number)
    else:
        url = generate_pacs_url(patient_id, "show_images")

    return {
        "url": url,
        "patient_id": patient_id,
        "accession_number": accession_number,
        "uniview_cmd": "show_study" if accession_number else "show_images",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def refresh_all_pacs_links(protocol_id: str) -> dict:
    """Refresh all PACS links for a patient from the manifest on disk.

    Re-generates every signed URL with a fresh timestamp. Updates both
    manifest.json and pacs_links.json on disk.

    Returns summary dict.
    """
    protocol_id = _normalize_protocol_id(protocol_id)
    output_dir = _reports_dir(protocol_id)
    manifest_path = output_dir / "manifest.json"

    if not manifest_path.exists():
        raise FileNotFoundError(f"No manifest found for protocol {protocol_id}")

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    # Handle both old (flat array) and new (object) format
    if isinstance(manifest_data, list):
        # Old format — no patient_id embedded, use protocol_id
        patient_id = protocol_id
        reports = manifest_data
    else:
        patient_id = manifest_data.get("patient_id", protocol_id)
        reports = manifest_data.get("reports", [])

    # Refresh all-studies link
    pacs_all = generate_pacs_url(patient_id, "show_images")

    study_links = []
    for entry in reports:
        acc_no = entry.get("accession_number")
        if acc_no:
            entry["pacs_url"] = generate_pacs_url(patient_id, "show_study", acc_no)
            study_links.append({
                "report_id": entry.get("report_id", ""),
                "report_name": entry.get("report_name", ""),
                "accession_number": acc_no,
                "pacs_url": entry["pacs_url"],
            })

    # Update manifest on disk
    if isinstance(manifest_data, list):
        # Old format — convert to new format
        manifest_data = {
            "patient_id": patient_id,
            "pacs_all_studies": pacs_all,
            "reports": reports,
        }
    else:
        manifest_data["pacs_all_studies"] = pacs_all

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, ensure_ascii=False, indent=2)

    # Update pacs_links.json
    pacs_data = {
        "patient_id": patient_id,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "pacs_all_studies": pacs_all,
        "studies": study_links,
    }
    with open(output_dir / "pacs_links.json", "w", encoding="utf-8") as f:
        json.dump(pacs_data, f, ensure_ascii=False, indent=2)

    log.info(
        "PACS links refreshed for %s: %d study links",
        protocol_id, len(study_links),
    )

    return {
        "patient_id": patient_id,
        "pacs_all_studies": pacs_all,
        "study_links_refreshed": len(study_links),
        "studies": study_links,
    }


# ── Report downloading ──

async def fetch_reports(protocol_id: str, cookie_string: str) -> dict[str, Any]:
    """Run cerebral_reports_w_pacs.py for a patient, return manifest data.

    Args:
        protocol_id: Patient protocol number (spaces/dashes stripped).
        cookie_string: Cookie header string for authentication.

    Returns:
        Dict with keys: manifest (list), reports_dir (str), total (int),
        downloaded (int), failed (int), patient_id (str).
    """
    protocol_id = _normalize_protocol_id(protocol_id)
    report_script = SCRIPTS_DIR / "cerebral_reports_w_pacs.py"
    if not report_script.exists():
        raise FileNotFoundError(f"Report script not found: {report_script}")

    output_dir = _reports_dir(protocol_id)

    # Find cookies for env var passthrough (read-only Docker mount safe)
    _cookies = COOKIES_DIR / "cookies.json"
    if not _cookies.exists():
        _cookies = SCRIPTS_DIR / "cookies.json"
    env = {**__import__("os").environ, "COOKIES_FILE": str(_cookies)} if _cookies.exists() else None

    try:
        proc = subprocess.run(
            [
                sys.executable, str(report_script),
                protocol_id,
                "--output", str(output_dir),
            ],
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
        if proc.returncode != 0:
            stderr_lines = proc.stderr.strip().split("\n")
            raise RuntimeError(
                f"Report fetch failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}"
            )
    except subprocess.TimeoutExpired:
        log.warning("Report fetch timed out for %s after 600s", protocol_id)
        raise RuntimeError(
            f"Report fetch timed out for {protocol_id}. "
            "The patient may have too many reports."
        )

    return _load_manifest_from_disk(protocol_id, output_dir)


async def auto_fetch_reports(protocol_id: str) -> dict[str, Any]:
    """Fetch reports using cookies.json from the cookies/ folder.

    Args:
        protocol_id: Patient protocol number (accepts '7352 4705' format).

    Returns:
        Same dict as fetch_reports().
    """
    protocol_id = _normalize_protocol_id(protocol_id)

    # Find cookies.json — prefer cookies/ dir (Docker mount), fall back to scripts/
    cookies_file = COOKIES_DIR / "cookies.json"
    if not cookies_file.exists():
        cookies_file = SCRIPTS_DIR / "cookies.json"
    if not cookies_file.exists():
        raise FileNotFoundError(
            f"No cookies.json found in {COOKIES_DIR} or {SCRIPTS_DIR}. "
            "Export cookies from your browser and place them in the cookies/ folder."
        )

    report_script = SCRIPTS_DIR / "cerebral_reports_w_pacs.py"
    if not report_script.exists():
        raise FileNotFoundError(f"Report script not found: {report_script}")

    output_dir = _reports_dir(protocol_id)

    # Pass COOKIES_FILE env var so the script finds cookies even on read-only mounts
    env = {**__import__("os").environ, "COOKIES_FILE": str(cookies_file)}

    try:
        proc = subprocess.run(
            [
                sys.executable, str(report_script),
                protocol_id,
                "--output", str(output_dir),
            ],
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
        if proc.returncode != 0:
            stderr_lines = proc.stderr.strip().split("\n")
            raise RuntimeError(
                f"Report fetch failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}"
            )
    except subprocess.TimeoutExpired:
        log.warning("Report fetch timed out for %s after 600s", protocol_id)
        raise RuntimeError(
            f"Report fetch timed out for {protocol_id}. "
            "The patient may have too many reports."
        )

    return _load_manifest_from_disk(protocol_id, output_dir)


def _load_manifest_from_disk(protocol_id: str, output_dir: Path) -> dict[str, Any]:
    """Load and normalize manifest from disk (handles both old and new formats)."""
    manifest_path = output_dir / "manifest.json"
    if not manifest_path.exists():
        raise RuntimeError(
            f"Report fetch completed but no manifest found at {manifest_path}"
        )

    with open(manifest_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # Normalize: new format is {"patient_id": ..., "reports": [...]}
    # Old format is a flat array [...]
    if isinstance(raw, list):
        manifest = raw
        patient_id = protocol_id
    else:
        manifest = raw.get("reports", [])
        patient_id = raw.get("patient_id", protocol_id)

    downloaded = sum(1 for e in manifest if e.get("file"))
    failed = sum(1 for e in manifest if not e.get("file"))

    log.info(
        "Reports loaded for %s: %d downloaded, %d failed, dir=%s",
        protocol_id, downloaded, failed, output_dir,
    )

    return {
        "manifest": manifest,
        "reports_dir": str(output_dir),
        "total": len(manifest),
        "downloaded": downloaded,
        "failed": failed,
        "patient_id": patient_id,
    }


def get_manifest(protocol_id: str) -> list[dict] | None:
    """Load an already-downloaded manifest from disk, or None if missing.

    Always returns the reports array (handles both old flat-array and new object format).
    """
    protocol_id = _normalize_protocol_id(protocol_id)
    manifest_path = _reports_dir(protocol_id) / "manifest.json"
    if not manifest_path.exists():
        return None
    with open(manifest_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, list):
        return raw
    return raw.get("reports", [])


def get_manifest_with_pacs(protocol_id: str) -> dict | None:
    """Load manifest with PACS metadata (patient_id, pacs_all_studies).

    Returns the full manifest object, or None if missing.
    """
    protocol_id = _normalize_protocol_id(protocol_id)
    manifest_path = _reports_dir(protocol_id) / "manifest.json"
    if not manifest_path.exists():
        return None
    with open(manifest_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, list):
        # Old format — wrap it
        return {
            "patient_id": protocol_id,
            "pacs_all_studies": None,
            "reports": raw,
        }
    return raw


def get_pacs_links(protocol_id: str) -> dict | None:
    """Load pacs_links.json from disk, or None if not available."""
    protocol_id = _normalize_protocol_id(protocol_id)
    pacs_path = _reports_dir(protocol_id) / "pacs_links.json"
    if not pacs_path.exists():
        return None
    with open(pacs_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_reports_dir(protocol_id: str) -> Path:
    """Return the reports directory path for a protocol ID."""
    return _reports_dir(_normalize_protocol_id(protocol_id))


def reports_exist(protocol_id: str) -> bool:
    """Check if reports have already been fetched for this patient."""
    protocol_id = _normalize_protocol_id(protocol_id)
    manifest_path = _reports_dir(protocol_id) / "manifest.json"
    return manifest_path.exists()
