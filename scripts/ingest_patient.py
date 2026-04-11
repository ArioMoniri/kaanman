#!/usr/bin/env python3
"""
ingest_patient.py — CLI tool for doctors to ingest patient data.

Reads cookies.json from the cookies/ directory, converts to cookie string,
fetches patient record from Cerebral Plus, and sends to the backend for
PHI masking and session setup.

USAGE:
    # Interactive — prompts for patient ID
    python3 scripts/ingest_patient.py

    # With patient ID
    python3 scripts/ingest_patient.py --patient-id 30256609

    # From a pre-exported patient JSON file
    python3 scripts/ingest_patient.py --from-file patient_30256609_*.json

    # Point to a specific cookies file
    python3 scripts/ingest_patient.py --cookies cookies/cookies.json
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS_DIR.parent
COOKIES_DIR = PROJECT_ROOT / "cookies"
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")


def find_cookies_file() -> Path | None:
    """Find the most recent cookies.json in the cookies/ directory."""
    candidates = sorted(COOKIES_DIR.glob("*.json"), key=os.path.getmtime, reverse=True)
    return candidates[0] if candidates else None


def convert_cookies(cookies_path: Path) -> str:
    """Run cerebral_cookie_from_json.py to get a cookie string."""
    script = SCRIPTS_DIR / "cerebral_cookie_from_json.py"
    proc = subprocess.run(
        [sys.executable, str(script), str(cookies_path)],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        print(f"Cookie conversion failed:\n{proc.stderr}", file=sys.stderr)
        sys.exit(1)
    return proc.stdout.strip()


def fetch_patient(patient_id: str, cookie_string: str) -> dict:
    """Run cerebral_fetch.py to get the patient record."""
    # Normalise: "7021 4897" → "70214897"
    patient_id = re.sub(r"[\s\-]+", "", patient_id.strip())
    script = SCRIPTS_DIR / "cerebral_fetch.py"
    proc = subprocess.run(
        [sys.executable, str(script), patient_id, "--stdout", "--cookie", cookie_string],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        print(f"Patient fetch failed:\n{proc.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(proc.stdout)


def send_to_backend(cookies_json_str: str) -> dict:
    """Send cookies JSON to the backend for ingestion."""
    import urllib.request
    import urllib.error

    payload = json.dumps({"cookies_json": cookies_json_str}).encode()
    req = urllib.request.Request(
        f"{BACKEND_URL}/api/patient/ingest",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        return {"success": False, "error": f"Backend not reachable: {e}"}


def main():
    p = argparse.ArgumentParser(description="Ingest patient data into CerebraLink")
    p.add_argument("--patient-id", help="Patient ID to fetch")
    p.add_argument("--cookies", help="Path to cookies.json file")
    p.add_argument("--from-file", help="Load from pre-exported patient JSON file")
    p.add_argument("--backend", default=BACKEND_URL, help=f"Backend URL (default: {BACKEND_URL})")
    args = p.parse_args()

    global BACKEND_URL
    BACKEND_URL = args.backend

    if args.from_file:
        # Load from existing file
        path = Path(args.from_file)
        if not path.exists():
            matches = glob.glob(args.from_file)
            if matches:
                path = Path(matches[0])
            else:
                print(f"File not found: {args.from_file}", file=sys.stderr)
                sys.exit(1)

        print(f"Loading patient data from: {path}")
        with open(path) as f:
            data = json.load(f)
        print(f"Patient: {data.get('patient', {}).get('full_name', 'Unknown')}")
        print(f"Episodes: {len(data.get('episodes', []))}")
        print("(Note: To send to backend, use the API directly with this file)")
        return

    # Find cookies
    cookies_path = Path(args.cookies) if args.cookies else find_cookies_file()
    if not cookies_path or not cookies_path.exists():
        print("No cookies.json found.", file=sys.stderr)
        print(f"Place your cookies.json in: {COOKIES_DIR}/", file=sys.stderr)
        sys.exit(1)

    print(f"Using cookies: {cookies_path}")

    # Read cookies JSON and send to backend
    cookies_json_str = cookies_path.read_text()
    print("Sending to backend for ingestion...")
    result = send_to_backend(cookies_json_str)

    if result.get("success"):
        print(f"Session ID: {result['session_id']}")
        print(f"Patient summary: {result.get('patient_summary', 'N/A')}")
        print("\nPatient context is now active. Open the UI to start asking questions.")
    else:
        print(f"Ingestion failed: {result.get('error', 'Unknown error')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
