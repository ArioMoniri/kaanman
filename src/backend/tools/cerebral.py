"""Cerebral Plus integration — ingest patient data from cookies.json.

Wraps cerebral_cookie_from_json.py and cerebral_fetch.py as Python calls.
"""

from __future__ import annotations

import json
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


async def fetch_patient(patient_id: str, cookie_string: str) -> dict[str, Any]:
    """Fetch a patient record from Cerebral Plus using the cookie string."""
    fetch_script = SCRIPTS_DIR / "cerebral_fetch.py"
    if not fetch_script.exists():
        raise FileNotFoundError(f"Fetch script not found: {fetch_script}")

    proc = subprocess.run(
        [sys.executable, str(fetch_script), patient_id, "--stdout", "--cookie", cookie_string],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        stderr_lines = proc.stderr.strip().split("\n")
        raise RuntimeError(f"Patient fetch failed: {stderr_lines[-1] if stderr_lines else 'unknown error'}")

    return json.loads(proc.stdout)


async def auto_fetch_patient(protocol_id: str) -> dict[str, Any]:
    """Auto-fetch patient data using cookies.json from the cookies/ folder.

    This is the main entry point when a doctor types a protocol number
    in the chat (e.g., "73524705 bu hastaya atenolol baslayabilir miyim").
    """
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
