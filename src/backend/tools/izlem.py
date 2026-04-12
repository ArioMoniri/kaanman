"""Izlem (Follow-up Monitoring) integration -- ingest izlem data from cerebral_izlem_export.py.

Wraps cerebral_izlem_export.py as a subprocess. Provides functions to:
- Fetch izlem data for a patient (with incremental refresh support)
- Load izlem JSON from disk
- Check if izlem data exists for a protocol ID
- Cross-reference izlem data with episodes by episode_id
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

log = logging.getLogger("cerebralink.izlem")


def _normalize_protocol_id(pid: str) -> str:
    """Strip spaces/dashes from protocol IDs."""
    return re.sub(r"[\s\-]+", "", pid.strip())


def _izlem_dir(protocol_id: str) -> Path:
    """Return the output directory for a patient's izlem data."""
    return DATA_DIR / f"izlem_{protocol_id}"


def izlem_exists(protocol_id: str) -> bool:
    """Check if izlem data already exists on disk."""
    protocol_id = _normalize_protocol_id(protocol_id)
    return (DATA_DIR / f"izlem_{protocol_id}.json").exists()


def get_izlem_dir(protocol_id: str) -> Path:
    """Return the izlem directory path."""
    return _izlem_dir(_normalize_protocol_id(protocol_id))


def get_izlem_data(protocol_id: str) -> dict | None:
    """Load the full izlem JSON from disk. Returns parsed dict or None."""
    protocol_id = _normalize_protocol_id(protocol_id)
    izlem_path = DATA_DIR / f"izlem_{protocol_id}.json"
    if not izlem_path.exists():
        return None
    try:
        with open(izlem_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log.warning("Failed to load izlem data for %s: %s", protocol_id, e)
        return None


async def auto_fetch_izlem(
    protocol_id: str, refresh: bool = False
) -> dict[str, Any]:
    """Fetch izlem data for a patient using cookies.json.

    Calls cerebral_izlem_export.py as a subprocess. If refresh=True, always
    re-run (the script supports incremental merging). If data exists and
    refresh=False, return from cache.

    Returns:
        {"izlem_data": {...}, "total_episodes": N, "record_counts": {...},
         "from_cache": bool}
    """
    protocol_id = _normalize_protocol_id(protocol_id)

    # If already on disk and not refreshing, just load from there
    if izlem_exists(protocol_id) and not refresh:
        data = get_izlem_data(protocol_id)
        if data is not None:
            meta = data.get("meta", {})
            return {
                "izlem_data": data,
                "total_episodes": meta.get("total_episodes", 0),
                "record_counts": meta.get("record_counts", {}),
                "from_cache": True,
            }

    fetch_script = SCRIPTS_DIR / "cerebral_izlem_export.py"
    if not fetch_script.exists():
        raise FileNotFoundError(f"Izlem export script not found: {fetch_script}")

    cookies_file = COOKIES_DIR / "cookies.json"
    if not cookies_file.exists():
        raise FileNotFoundError(
            f"No cookies.json found in {COOKIES_DIR}. "
            "Export cookies from your browser and place them in the cookies/ folder."
        )

    # Pass COOKIES_FILE env var so the script finds cookies even on read-only mounts.
    # CWD must be DATA_DIR because the script creates izlem_{pid}.json relative to CWD.
    import os as _os

    env = {**_os.environ, "COOKIES_FILE": str(cookies_file)}

    try:
        proc = subprocess.run(
            [sys.executable, str(fetch_script), protocol_id],
            capture_output=True,
            text=True,
            timeout=600,  # izlem can be large; allow up to 10 minutes
            cwd=str(DATA_DIR),
            env=env,
        )
        if proc.returncode != 0:
            stderr_lines = proc.stderr.strip().split("\n")
            raise RuntimeError(
                f"Izlem fetch failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}"
            )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Izlem fetch timed out for {protocol_id}. Too many episodes or slow network."
        )

    # Load the generated JSON
    data = get_izlem_data(protocol_id)
    if data is None:
        raise RuntimeError(
            f"Izlem fetch completed but no output file found for {protocol_id}"
        )

    meta = data.get("meta", {})
    log.info(
        "Izlem fetched for %s: %d episodes, record counts: %s",
        protocol_id,
        meta.get("total_episodes", 0),
        meta.get("record_counts", {}),
    )

    return {
        "izlem_data": data,
        "total_episodes": meta.get("total_episodes", 0),
        "record_counts": meta.get("record_counts", {}),
        "from_cache": False,
    }


def cross_reference_with_episodes(
    izlem_data: dict,
    episodes_manifest: list[dict],
) -> list[dict]:
    """Cross-reference izlem episodes with episode manifest by episodeId.

    Returns a list of matched pairs:
    [{"izlem_episode": {...}, "episode": {...} | None, "match_type": "episode_id" | "unmatched"}, ...]
    """
    # Build episode lookup by episode_id
    episodes_by_id: dict[str, dict] = {}
    for ep in episodes_manifest:
        ep_id = str(ep.get("episode_id", ""))
        cross = ep.get("cross_match", {})
        alt_id = str(cross.get("episode_id", ""))
        if ep_id:
            episodes_by_id[ep_id] = ep
        if alt_id and alt_id != ep_id:
            episodes_by_id[alt_id] = ep

    matches: list[dict] = []
    izlem_episodes = izlem_data.get("episodes", [])

    for izlem_ep in izlem_episodes:
        ep_info = izlem_ep.get("episode_info", {})
        izlem_episode_id = str(ep_info.get("episodeId", ""))

        matched_episode = episodes_by_id.get(izlem_episode_id)

        matches.append({
            "izlem_episode": izlem_ep,
            "episode": matched_episode,
            "match_type": "episode_id" if matched_episode else "unmatched",
            "episode_id": izlem_episode_id,
            "date": ep_info.get("date", ""),
            "service_text": ep_info.get("serviceText", ""),
            "data_types": list(izlem_ep.get("data", {}).keys()),
        })

    return matches
