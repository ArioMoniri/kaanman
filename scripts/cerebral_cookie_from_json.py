#!/usr/bin/env python3
"""
cerebral_cookie_from_json.py — convert a Chrome cookie-editor JSON export
into the raw cookie string that cerebral_fetch.py needs.

The browser extension "Cookie Editor" (and similar) exports cookies as a JSON
array of objects with fields like:
    [ {"name": "access_token", "value": "...", "domain": "...", ...}, ... ]

This script takes that JSON and emits the `name=value; name=value; ...` string
that HTTP clients (curl, Postman, cerebral_fetch.py) need.

USAGE:
    # From a file (normal case)
    python3 cerebral_cookie_from_json.py cookies.json

    # From stdin
    cat cookies.json | python3 cerebral_cookie_from_json.py -

    # Emit a ready-to-paste shell export (zsh/bash)
    python3 cerebral_cookie_from_json.py cookies.json --export

    # Pipe directly into cerebral_fetch.py (one-liner)
    python3 cerebral_cookie_from_json.py cookies.json | python3 cerebral_fetch.py 30256609

    # Pretty summary of what was found (token expiry, user, cookie count)
    python3 cerebral_cookie_from_json.py cookies.json --info

    # Write cookie string to a file
    python3 cerebral_cookie_from_json.py cookies.json -o ~/.cerebral_cookie

OUTPUT (default):
    The cookie string goes to STDOUT, diagnostics go to STDERR.
    Exit 0 on success, non-zero on bad JSON / missing required cookies / expired token.

CALLING FROM AN LLM TOOL HARNESS:
    import subprocess, json
    raw_json = open("cookies.json").read()
    r = subprocess.run(
        ["python3", "cerebral_cookie_from_json.py", "-"],
        input=raw_json, capture_output=True, text=True
    )
    if r.returncode != 0:
        err = json.loads(r.stderr.strip().split("\\n")[-1])  # last stderr line is JSON
        return {"ok": False, **err}
    cookie_string = r.stdout.strip()
    # Now feed cookie_string into cerebral_fetch.py
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
from datetime import datetime
from typing import Any

TARGET_HOSTS = ("cerebralplustr.acibadem.com.tr", ".acibadem.com.tr", "acibadem.com.tr")

# Cookies that are required for Cerebral Plus auth to work
REQUIRED_COOKIES = ("access_token", "ASP.NET_SessionId")

# Tracking / analytics cookies that we strip to keep the cookie string tidy
# (The server ignores them, but they bloat the header.)
STRIP_COOKIES = {
    "_ttp", "_tt_enable_cookie", "ttcsid", "_hjSessionUser_596076",
    "VL_CM_0", "OfferMiner_ID",
    "windowWidth", "windowHeight", "windowName",
}

_USE_COLOR = sys.stderr.isatty()
def _c(code, msg): return f"\033[{code}m{msg}\033[0m" if _USE_COLOR else msg
def log(m):  print(_c("1;34", "[*]")  + " " + m, file=sys.stderr, flush=True)
def ok(m):   print(_c("1;32", "[OK]") + " " + m, file=sys.stderr, flush=True)
def warn(m): print(_c("1;33", "[!]")  + " " + m, file=sys.stderr, flush=True)
def err(m):  print(_c("1;31", "[x]")  + " " + m, file=sys.stderr, flush=True)


class CookieError(Exception):
    def __init__(self, code: str, message: str, hint: str = ""):
        self.code = code
        self.message = message
        self.hint = hint
        super().__init__(f"[{code}] {message}")


def domain_matches(cookie_domain: str, target: str = "cerebralplustr.acibadem.com.tr") -> bool:
    """Loose host-match check. A cookie with domain ".acibadem.com.tr" applies
    to any *.acibadem.com.tr host; a cookie with domain "cerebralplustr..." only
    applies to exactly that host.
    """
    cd = cookie_domain.lstrip(".").lower()
    t = target.lower()
    return t == cd or t.endswith("." + cd)


def load_cookies_json(source: str) -> list[dict]:
    """Load and parse the cookie JSON file, or '-' for stdin."""
    if source == "-":
        data = sys.stdin.read()
    else:
        try:
            with open(source, "r", encoding="utf-8") as f:
                data = f.read()
        except FileNotFoundError:
            raise CookieError("FILE_NOT_FOUND", f"No such file: {source}", "Check the path.")
    data = data.strip()
    if not data:
        raise CookieError("EMPTY_INPUT", "Cookie JSON is empty", "Did you pipe the right file?")
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as e:
        raise CookieError(
            "BAD_JSON",
            f"Cannot parse JSON: {e}",
            "Make sure the input is a valid JSON array exported by a cookie-editor extension.",
        )
    if not isinstance(parsed, list):
        # Sometimes exports wrap the array in {"cookies": [...]} — unwrap it
        if isinstance(parsed, dict) and "cookies" in parsed and isinstance(parsed["cookies"], list):
            parsed = parsed["cookies"]
        else:
            raise CookieError(
                "BAD_SHAPE",
                f"Expected a JSON array, got {type(parsed).__name__}",
                "Re-export cookies — the file should be an array of cookie objects.",
            )
    if not parsed:
        raise CookieError("EMPTY_ARRAY", "Cookie JSON is an empty array", "No cookies in the export.")
    return parsed


def filter_and_build(
    cookies: list[dict],
    target_host: str = "cerebralplustr.acibadem.com.tr",
    strip_tracking: bool = True,
) -> tuple[str, dict[str, Any]]:
    """Filter cookies for the target host and build a `k=v; k=v` string.

    Returns (cookie_string, info_dict).
    """
    kept: list[tuple[str, str]] = []
    skipped_wrong_domain: list[str] = []
    skipped_tracking: list[str] = []
    seen: set[str] = set()

    for c in cookies:
        if not isinstance(c, dict):
            continue
        name = c.get("name")
        value = c.get("value", "")
        domain = c.get("domain", "")
        if not name:
            continue
        if not domain_matches(domain, target_host):
            skipped_wrong_domain.append(name)
            continue
        if strip_tracking and name in STRIP_COOKIES:
            skipped_tracking.append(name)
            continue
        # De-dupe: last occurrence wins (matches browser behaviour)
        if name in seen:
            kept = [(n, v) for n, v in kept if n != name]
        seen.add(name)
        # Ensure value is a string (some exports coerce numbers)
        kept.append((name, str(value if value is not None else "")))

    missing = [r for r in REQUIRED_COOKIES if r not in seen]
    if missing:
        raise CookieError(
            "MISSING_REQUIRED",
            f"Required cookie(s) not found: {', '.join(missing)}",
            "Log into Cerebral Plus in your browser, then re-export ALL cookies — the session cookies are mandatory.",
        )

    cookie_string = "; ".join(f"{n}={v}" for n, v in kept)

    info: dict[str, Any] = {
        "target_host": target_host,
        "total_input_cookies": len(cookies),
        "kept": len(kept),
        "kept_names": [n for n, _ in kept],
        "skipped_wrong_domain": len(skipped_wrong_domain),
        "skipped_tracking": skipped_tracking,
        "cookie_string_length": len(cookie_string),
    }

    # Decode JWT inside access_token for expiry info
    access_token = next((v for n, v in kept if n == "access_token"), None)
    if access_token:
        info["access_token"] = decode_jwt(access_token)

    return cookie_string, info


def decode_jwt(token: str) -> dict[str, Any]:
    try:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception as e:
        return {"decode_error": str(e)}
    exp = int(payload.get("nbf", 0)), int(payload.get("exp", 0))
    now = int(time.time())
    nbf, exp = exp
    info = {
        "user_id": payload.get("UserId"),
        "user_name": payload.get("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"),
        "organization_code": payload.get("OrganizationCode"),
        "facility_id": payload.get("FacilityId"),
        "not_before": datetime.fromtimestamp(nbf).isoformat() if nbf else None,
        "expires_at": datetime.fromtimestamp(exp).isoformat() if exp else None,
        "expires_in_minutes": (exp - now) // 60 if exp else None,
        "is_expired": exp > 0 and exp < now,
        "is_valid_now": (nbf <= now < exp) if nbf and exp else None,
    }
    return info


def format_info_human(info: dict[str, Any]) -> str:
    lines = []
    lines.append(f"Target host:           {info['target_host']}")
    lines.append(f"Input cookies:         {info['total_input_cookies']}")
    lines.append(f"Kept for this host:    {info['kept']}")
    lines.append(f"Dropped (wrong host):  {info['skipped_wrong_domain']}")
    lines.append(f"Dropped (tracking):    {len(info['skipped_tracking'])}  -> {', '.join(info['skipped_tracking']) or '(none)'}")
    lines.append(f"Cookie string length:  {info['cookie_string_length']} chars")
    lines.append(f"Cookies kept:          {', '.join(info['kept_names'])}")
    jwt = info.get("access_token")
    if jwt:
        if "decode_error" in jwt:
            lines.append("")
            lines.append(f"JWT decode error: {jwt['decode_error']}")
        else:
            lines.append("")
            lines.append("--- access_token JWT ---")
            lines.append(f"  user:            {jwt.get('user_name')} (id {jwt.get('user_id')})")
            lines.append(f"  organization:    {jwt.get('organization_code')} / facility {jwt.get('facility_id')}")
            lines.append(f"  not_before:      {jwt.get('not_before')}")
            lines.append(f"  expires_at:      {jwt.get('expires_at')}")
            if jwt.get("is_expired"):
                lines.append(f"  status:          EXPIRED {-jwt['expires_in_minutes']} min ago — re-export cookies!")
            else:
                lines.append(f"  status:          valid, expires in {jwt['expires_in_minutes']} minutes")
    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("source", help="Path to cookie JSON file, or '-' for stdin")
    p.add_argument("--target-host", default="cerebralplustr.acibadem.com.tr",
                   help="Only keep cookies whose domain matches this host (default: cerebralplustr.acibadem.com.tr)")
    p.add_argument("--keep-tracking", action="store_true",
                   help="Don't strip tracking/analytics cookies (_ttp, ttcsid, etc.)")
    p.add_argument("--export", action="store_true",
                   help="Emit a shell `export CEREBRAL_COOKIE='...'` line instead of the raw string")
    p.add_argument("--info", action="store_true",
                   help="Print a human-readable summary to stderr and nothing to stdout")
    p.add_argument("--json-info", action="store_true",
                   help="Print the info dict as JSON to stdout (no cookie string)")
    p.add_argument("--output", "-o", help="Write the cookie string to this file instead of stdout")
    p.add_argument("--fail-if-expired", action="store_true",
                   help="Exit with code 2 if the access_token is expired")
    args = p.parse_args()

    try:
        cookies = load_cookies_json(args.source)
        cookie_string, info = filter_and_build(
            cookies,
            target_host=args.target_host,
            strip_tracking=not args.keep_tracking,
        )
    except CookieError as e:
        err(f"{e.code}: {e.message}")
        if e.hint:
            err(f"HINT: {e.hint}")
        print(json.dumps({"error": {"code": e.code, "message": e.message, "hint": e.hint}}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as e:
        err(f"UNEXPECTED: {type(e).__name__}: {e}")
        return 1

    # Always surface a short summary on stderr so humans see what's going on
    jwt = info.get("access_token") or {}
    if jwt.get("is_expired"):
        warn(f"JWT EXPIRED {-jwt.get('expires_in_minutes', 0)} min ago — re-export cookies!")
        if args.fail_if_expired:
            err("Aborting due to --fail-if-expired")
            print(json.dumps({"error": {"code": "TOKEN_EXPIRED", "message": "access_token expired", "hint": "Log back into Cerebral Plus and re-export cookies."}}, ensure_ascii=False), file=sys.stderr)
            return 2
    elif "is_expired" in jwt:
        ok(f"JWT valid — user={jwt.get('user_name')} exp_in={jwt.get('expires_in_minutes')}min")
    ok(f"Built cookie string: {info['kept']} cookies, {info['cookie_string_length']} chars")

    # Output mode
    if args.info:
        # Human summary to stderr, nothing to stdout
        print(format_info_human(info), file=sys.stderr)
        return 0

    if args.json_info:
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    out_text = cookie_string
    if args.export:
        # Single-quote-safe shell export
        safe = cookie_string.replace("'", "'\"'\"'")
        out_text = f"export CEREBRAL_COOKIE='{safe}'"

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out_text + "\n")
        ok(f"written to {args.output}")
    else:
        print(out_text)

    return 0


if __name__ == "__main__":
    sys.exit(main())
