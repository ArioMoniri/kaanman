"""Episode (Yatış + Poliklinik) integration — ingest episode data from cerebral_yatis.py.

Wraps cerebral_yatis.py as a subprocess. Provides functions to:
- Fetch episodes for a patient
- Load manifest/summary from disk
- Check if episodes exist for a protocol ID
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import os as _os_module

SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
COOKIES_DIR = Path(__file__).resolve().parents[3] / "cookies"
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = Path(_os_module.environ.get("PATIENT_DATA_DIR", str(PROJECT_ROOT)))

log = logging.getLogger("cerebralink.episodes")


def _normalize_protocol_id(pid: str) -> str:
    """Strip spaces/dashes from protocol IDs."""
    return re.sub(r"[\s\-]+", "", pid.strip())


def _episodes_dir(protocol_id: str) -> Path:
    """Return the output directory for a patient's episodes."""
    return DATA_DIR / f"episodes_{protocol_id}"


def episodes_exist(protocol_id: str) -> bool:
    """Check if episode data already exists on disk."""
    protocol_id = _normalize_protocol_id(protocol_id)
    d = _episodes_dir(protocol_id)
    return (d / "manifest.json").exists()


def get_episodes_dir(protocol_id: str) -> Path:
    """Return the episodes directory path."""
    return _episodes_dir(_normalize_protocol_id(protocol_id))


def get_manifest(protocol_id: str) -> list[dict] | None:
    """Load the episode manifest from disk. Returns list of episodes or None."""
    protocol_id = _normalize_protocol_id(protocol_id)
    manifest_path = _episodes_dir(protocol_id) / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("episodes", [])
    except Exception as e:
        log.warning("Failed to load episode manifest for %s: %s", protocol_id, e)
        return None


def get_yatis_summary(protocol_id: str) -> dict | None:
    """Load the yatış summary from disk (hospitalization episodes only)."""
    protocol_id = _normalize_protocol_id(protocol_id)
    summary_path = _episodes_dir(protocol_id) / "yatis_summary.json"
    if not summary_path.exists():
        return None
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log.warning("Failed to load yatis summary for %s: %s", protocol_id, e)
        return None


def get_full_manifest_data(protocol_id: str) -> dict | None:
    """Load the full manifest.json including patient_id and metadata."""
    protocol_id = _normalize_protocol_id(protocol_id)
    manifest_path = _episodes_dir(protocol_id) / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log.warning("Failed to load full manifest for %s: %s", protocol_id, e)
        return None


async def auto_fetch_episodes(protocol_id: str) -> dict[str, Any]:
    """Fetch all episodes for a patient using cookies.json.

    Calls cerebral_yatis.py as a subprocess. Returns:
        {"manifest": [...], "episodes_dir": "...", "total": N, "yatis_count": N, "poli_count": N}
    """
    protocol_id = _normalize_protocol_id(protocol_id)

    # If already on disk, just load from there
    if episodes_exist(protocol_id):
        manifest = get_manifest(protocol_id)
        if manifest is not None:
            yatis_count = sum(1 for ep in manifest if ep.get("is_hospitalization"))
            poli_count = len(manifest) - yatis_count
            return {
                "manifest": manifest,
                "episodes_dir": str(_episodes_dir(protocol_id)),
                "total": len(manifest),
                "yatis_count": yatis_count,
                "poli_count": poli_count,
                "from_cache": True,
            }

    fetch_script = SCRIPTS_DIR / "cerebral_yatis.py"
    if not fetch_script.exists():
        raise FileNotFoundError(f"Episode scraper not found: {fetch_script}")

    cookies_file = COOKIES_DIR / "cookies.json"
    if not cookies_file.exists():
        raise FileNotFoundError(
            f"No cookies.json found in {COOKIES_DIR}. "
            "Export cookies from your browser and place them in the cookies/ folder."
        )

    # Pass COOKIES_FILE env var so the script finds cookies even on read-only mounts
    # CWD must be PROJECT_ROOT (not SCRIPTS_DIR) because Docker mounts scripts/ read-only
    # and the script creates episodes_{pid}/ relative to CWD.
    import os as _os
    env = {**_os.environ, "COOKIES_FILE": str(cookies_file)}

    try:
        proc = subprocess.run(
            [sys.executable, str(fetch_script), protocol_id],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(DATA_DIR),
            env=env,
        )
        if proc.returncode != 0:
            stderr_lines = proc.stderr.strip().split("\n")
            raise RuntimeError(
                f"Episode fetch failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}"
            )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Episode fetch timed out for {protocol_id}. Too many episodes."
        )

    # Load the generated manifest
    manifest = get_manifest(protocol_id)
    if manifest is None:
        raise RuntimeError(f"Episode fetch completed but no manifest found for {protocol_id}")

    yatis_count = sum(1 for ep in manifest if ep.get("is_hospitalization"))
    poli_count = len(manifest) - yatis_count

    log.info(
        "Episodes fetched for %s: %d total (%d yatış, %d poliklinik)",
        protocol_id, len(manifest), yatis_count, poli_count,
    )

    return {
        "manifest": manifest,
        "episodes_dir": str(_episodes_dir(protocol_id)),
        "total": len(manifest),
        "yatis_count": yatis_count,
        "poli_count": poli_count,
        "from_cache": False,
    }


def cross_match_reports(
    episodes_manifest: list[dict],
    reports_manifest: list[dict],
) -> list[dict]:
    """Cross-match episodes with reports by date + facility.

    Returns a list of matched pairs:
    [{"episode": {...}, "reports": [{...}, ...], "match_type": "date+facility"}, ...]
    """
    matches: list[dict] = []

    # Build report lookup by date
    reports_by_date: dict[str, list[dict]] = {}
    for report in reports_manifest:
        date = report.get("date", "")
        if date:
            if date not in reports_by_date:
                reports_by_date[date] = []
            reports_by_date[date].append(report)

    for episode in episodes_manifest:
        ep_date = episode.get("date", "")
        ep_facility = episode.get("facility_text", "").lower()
        cross = episode.get("cross_match", {})
        ep_episode_id = cross.get("episode_id", episode.get("episode_id", ""))

        matched_reports: list[dict] = []
        match_type = ""

        # Match by episode_id in reports (strongest match)
        for report in reports_manifest:
            rep_ep_id = str(report.get("episode_id", ""))
            if rep_ep_id and rep_ep_id == str(ep_episode_id):
                matched_reports.append(report)
                match_type = "episode_id"

        # If no episode_id match, try date + facility
        if not matched_reports and ep_date in reports_by_date:
            for report in reports_by_date[ep_date]:
                rep_facility = report.get("facility", "").lower()
                if ep_facility and rep_facility and (
                    ep_facility in rep_facility or rep_facility in ep_facility
                ):
                    matched_reports.append(report)
                    match_type = "date+facility"

            # If still no match, match by date only
            if not matched_reports:
                matched_reports = reports_by_date[ep_date]
                match_type = "date_only"

        if matched_reports:
            matches.append({
                "episode": episode,
                "reports": matched_reports,
                "match_type": match_type,
            })

    return matches
