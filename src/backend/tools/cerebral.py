"""Cerebral Plus integration — ingest patient data from cookies.json.

Wraps cerebral_cookie_from_json.py and cerebral_fetch.py as Python calls.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
COOKIES_DIR = Path(__file__).resolve().parents[3] / "cookies"


async def ingest_cookies_json(cookies_json_str: str) -> dict[str, Any]:
    """Full pipeline: cookies JSON string → cookie string."""
    cookie_script = SCRIPTS_DIR / "cerebral_cookie_from_json.py"
    if not cookie_script.exists():
        raise FileNotFoundError(f"Cookie script not found: {cookie_script}")

    proc = subprocess.run(
        [sys.executable, str(cookie_script), "-"],
        input=cookies_json_str,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        stderr_lines = proc.stderr.strip().split("\n")
        raise RuntimeError(f"Cookie conversion failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}")

    cookie_string = proc.stdout.strip()
    if not cookie_string:
        raise RuntimeError("Cookie conversion produced empty output")

    return {"cookie_string": cookie_string, "status": "cookie_ready"}


def _normalize_protocol_id(pid: str) -> str:
    """Strip spaces/dashes from protocol IDs: '7021 4897' → '70214897'."""
    return re.sub(r"[\s\-]+", "", pid.strip())


async def fetch_patient(patient_id: str, cookie_string: str) -> dict[str, Any]:
    """Fetch a patient record from Cerebral Plus using the cookie string.

    Timeout is 600s (10 min) because patients with many episodes (60+)
    can take several minutes to scrape all examination pages.

    If the fetch times out, we retry with --max-episodes to get partial
    data (newest episodes first) rather than returning nothing.
    """
    patient_id = _normalize_protocol_id(patient_id)
    fetch_script = SCRIPTS_DIR / "cerebral_fetch.py"
    if not fetch_script.exists():
        raise FileNotFoundError(f"Fetch script not found: {fetch_script}")

    try:
        proc = subprocess.run(
            [sys.executable, str(fetch_script), patient_id, "--stdout", "--cookie", cookie_string],
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode != 0:
            stderr_lines = proc.stderr.strip().split("\n")
            raise RuntimeError(f"Patient fetch failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}")

        if not proc.stdout.strip():
            raise RuntimeError("Patient fetch returned empty output — check stderr logs")

        data = json.loads(proc.stdout)

        # If the data is very large (>100 episodes), truncate older episodes
        # to prevent downstream LLM timeouts. Keep newest first.
        episodes = data.get("episodes", [])
        if len(episodes) > 80:
            import logging
            logging.getLogger("cerebralink.cerebral").info(
                "Patient %s has %d episodes — truncating to newest 80", patient_id, len(episodes)
            )
            data["episodes"] = episodes[:80]
            data["_truncated"] = True
            data["_total_episodes"] = len(episodes)

        return data

    except subprocess.TimeoutExpired:
        import logging
        log = logging.getLogger("cerebralink.cerebral")
        log.warning(
            "Patient fetch timed out for %s — retrying with --max-episodes 30", patient_id
        )
        # Retry with a smaller episode limit so we get partial data
        try:
            proc = subprocess.run(
                [sys.executable, str(fetch_script), patient_id, "--stdout", "--cookie", cookie_string,
                 "--max-episodes", "30"],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                data = json.loads(proc.stdout)
                data["_truncated"] = True
                data["_truncation_reason"] = "timeout"
                log.info("Partial fetch succeeded: %d episodes", len(data.get("episodes", [])))
                return data
        except (subprocess.TimeoutExpired, Exception) as retry_err:
            log.error("Retry also failed: %s", retry_err)

        raise RuntimeError(
            f"Patient fetch timed out for {patient_id}. "
            "The patient has too many records. Try again or contact support."
        )


async def auto_fetch_patient(protocol_id: str) -> dict[str, Any]:
    """Auto-fetch patient data using cookies.json from the cookies/ folder.

    This is the main entry point when a doctor types a protocol number
    in the chat (e.g., "73524705 bu hastaya atenolol baslayabilir miyim").
    Accepts both '73524705' and '7352 4705' formats.
    """
    protocol_id = _normalize_protocol_id(protocol_id)
    cookies_file = COOKIES_DIR / "cookies.json"
    if not cookies_file.exists():
        raise FileNotFoundError(
            f"No cookies.json found in {COOKIES_DIR}. "
            "Export cookies from your browser and place them in the cookies/ folder."
        )

    with open(cookies_file, "r", encoding="utf-8") as f:
        cookies_json = f.read()

    result = await ingest_cookies_json(cookies_json)
    cookie_string = result["cookie_string"]

    return await fetch_patient(protocol_id, cookie_string)


async def load_patient_from_file(path: str) -> dict[str, Any]:
    """Load an already-exported patient JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.loads(f.read())
