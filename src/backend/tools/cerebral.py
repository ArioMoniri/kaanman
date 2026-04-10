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


async def ingest_cookies_json(cookies_json_str: str) -> dict[str, Any]:
    """Full pipeline: cookies JSON string → patient record dict.

    1. Parse cookies JSON → cookie string (via cerebral_cookie_from_json.py)
    2. Extract patient ID from cookies or use default
    3. Fetch patient record (via cerebral_fetch.py)
    """
    # Step 1: Convert cookies JSON to cookie string
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


async def load_patient_from_file(path: str) -> dict[str, Any]:
    """Load an already-exported patient JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.loads(f.read())
