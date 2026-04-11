"""Lab report parser — extracts structured lab values from Cerebral Plus TXT exports.

Parses the columnar format produced by cerebral_reports_w_pacs.py text extraction.
Builds time-series data grouped by test name for trend analysis.

Lab report TXT structure (Turkish hospital format):
    HEMATOLOJİ
    Sonuç    Referans Değer    Birim    03.01.23    03.05.22
    Test Adı
         Lökosit    5.16    4.3 - 11.3    x10^3/uL    4.49    7.30
         Nötrofil (%)    59.1    39.0 - 72.5    %    52.3    86.5

Sections include: HEMATOLOJİ, BİYOKİMYA, HORMON, İMMUNOLOJİ, MARKER,
SEROLOJİ, İDRAR TAHLİLİ, KAN GRUBU, KOAGÜlASYON.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

log = logging.getLogger("cerebralink.lab_parser")

# Known section headers in Turkish lab reports
SECTION_HEADERS = {
    "HEMATOLOJİ", "BİYOKİMYA", "HORMON", "İMMUNOLOJİ", "MARKER",
    "SEROLOJİ", "İDRAR TAHLİLİ", "KAN GRUBU", "KOAGÜLASYON",
    "KOAGÜlASYON", "MİKROBİYOLOJİ", "GAZ", "SEDİMENTASYON",
    "PATOLOJI", "NÜKLEOTİD",
}

# Date patterns: DD.MM.YY or DD.MM.YYYY
_DATE_PATTERN = re.compile(r"\d{2}\.\d{2}\.\d{2,4}")

# Reference range: "4.3 - 11.3" or "< 5.0" or "> 1.0" or "4.3-11.3"
_REF_RANGE_PATTERN = re.compile(
    r"^([<>]?\s*\d+\.?\d*)\s*[-–]\s*(\d+\.?\d*)$"
)
_REF_LESS_THAN = re.compile(r"^[<]\s*(\d+\.?\d*)$")
_REF_GREATER_THAN = re.compile(r"^[>]\s*(\d+\.?\d*)$")


@dataclass
class LabValue:
    """A single lab test result at a specific point in time."""
    test_name: str
    value: float | None
    unit: str
    ref_min: float | None
    ref_max: float | None
    date: str
    section: str
    is_abnormal: bool = False
    raw_value: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _parse_float(s: str) -> float | None:
    """Try to parse a float from a string, handling Turkish/European formats."""
    if not s:
        return None
    s = s.strip().replace(",", ".")
    # Remove comparison operators
    s = re.sub(r"^[<>≤≥]=?\s*", "", s)
    try:
        return float(s)
    except ValueError:
        return None


def _parse_ref_range(ref_str: str) -> tuple[float | None, float | None]:
    """Parse a reference range string into (min, max).

    Handles: "4.3 - 11.3", "< 5.0", "> 1.0", "4.3-11.3", "0 - 35"
    """
    ref_str = ref_str.strip()
    if not ref_str or ref_str == "-":
        return None, None

    # Range: "4.3 - 11.3"
    match = _REF_RANGE_PATTERN.match(ref_str)
    if match:
        return _parse_float(match.group(1)), _parse_float(match.group(2))

    # Less than: "< 5.0"
    match = _REF_LESS_THAN.match(ref_str)
    if match:
        return None, _parse_float(match.group(1))

    # Greater than: "> 1.0"
    match = _REF_GREATER_THAN.match(ref_str)
    if match:
        return _parse_float(match.group(1)), None

    # Try splitting on common separators
    for sep in [" - ", " – ", "-", "–"]:
        if sep in ref_str:
            parts = ref_str.split(sep, 1)
            return _parse_float(parts[0]), _parse_float(parts[1])

    return None, None


def _is_section_header(line: str) -> str | None:
    """Check if a line is a section header, return the section name or None."""
    stripped = line.strip().upper()
    for header in SECTION_HEADERS:
        if stripped == header or stripped.startswith(header):
            return header
    return None


def _extract_historical_dates(header_line: str) -> list[str]:
    """Extract dates from the column header line.

    Example: "Sonuç    Referans Değer    Birim    03.01.23    03.05.22"
    Returns: ["03.01.23", "03.05.22"]
    """
    return _DATE_PATTERN.findall(header_line)


def _is_test_name_line(line: str, raw_line: str) -> bool:
    """Check if a line is an indented test name (6+ spaces or tab indent)."""
    if not line:
        return False
    indent = len(raw_line) - len(raw_line.lstrip())
    has_letters = bool(re.search(r"[a-zA-ZçÇğĞıİöÖşŞüÜ]", line))
    is_numeric = _parse_float(line) is not None
    # Indented lines containing letters that aren't pure numbers
    return indent >= 4 and has_letters and not is_numeric


def _is_ref_range_line(line: str) -> bool:
    """Check if a line looks like a reference range (e.g. '4.40 - 9.70')."""
    return bool(re.match(r"^\s*<?[>]?\s*\d+[.,]?\d*\s*[-–]\s*\d+[.,]?\d*\s*$", line))


def _is_unit_line(line: str) -> bool:
    """Check if a line looks like a unit (%, x10^3/uL, g/dL, etc.)."""
    unit_patterns = [
        r"^%$", r"^[a-zA-Z/\^]+$", r"x10\^", r"/[umd]?[Ll]$",
        r"g/[dm]?L", r"fL$", r"pg$", r"^m[gm]/", r"^U/[Ll]$",
        r"mIU", r"ng/", r"µ?g/", r"sec$", r"sn$", r"mm/", r"mL$",
        r"mmol", r"µmol", r"pmol", r"^IU/", r"MEq", r"^Oran$",
    ]
    stripped = line.strip()
    if not stripped:
        return False
    for pat in unit_patterns:
        if re.search(pat, stripped, re.IGNORECASE):
            return True
    return False


# Lines to skip: noise, method names, sub-section titles
_SKIP_LINES = {
    ".", "..", "ODS", "Otomatize Kan Sayım Sistemi",
    "Tam Kan Sayımı", "Tam İdrar Tetkiki", "Biyokimyasal Testler",
    "Hormon Testleri", "İmmunolojik Testler", "Koagülasyon Testleri",
    "Serolojik Testler", "İdrar Biyokimya", "Fonksiyon Testleri",
    "Kemilüminesans", "İmmüno Nefelometri", "Elektrokemiluminesans",
    "Türbidimetrik", "Kolorimetrik", "Enzimatik",
}


def parse_lab_report(text: str, report_date: str) -> list[LabValue]:
    """Parse a single lab report TXT file into structured LabValue entries.

    Handles two formats:
    1. Horizontal (tab/space-separated columns on one line)
    2. Vertical (Acıbadem format where each field is on its own line)

    Args:
        text: Raw text content of the lab report.
        report_date: The date of this report (from manifest metadata).

    Returns:
        List of LabValue objects for each test result found.
    """
    if not text or not text.strip():
        return []

    lines = text.split("\n")
    results: list[LabValue] = []
    current_section = "UNKNOWN"
    historical_dates: list[str] = []

    # First try: horizontal parsing (original logic)
    horizontal_results = _parse_horizontal(lines, report_date)
    if horizontal_results:
        return horizontal_results

    # Fallback: vertical parsing for Acıbadem format
    return _parse_vertical(lines, report_date)


def _parse_horizontal(lines: list[str], report_date: str) -> list[LabValue]:
    """Try parsing as horizontal tab-separated format."""
    results: list[LabValue] = []
    current_section = "UNKNOWN"
    historical_dates: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        section = _is_section_header(stripped)
        if section:
            current_section = section
            continue

        if "Sonuç" in stripped or "Referans" in stripped or "Birim" in stripped:
            historical_dates = _extract_historical_dates(stripped)
            continue

        if stripped in ("Test Adı", "Test Ad"):
            continue

        parts = re.split(r"\s{2,}|\t", stripped)
        parts = [p.strip() for p in parts if p.strip()]

        if len(parts) < 3:
            continue

        test_name = parts[0]
        if _parse_float(test_name) is not None and len(parts) > 4:
            continue

        raw_value = parts[1] if len(parts) > 1 else ""
        value = _parse_float(raw_value)
        ref_str = parts[2] if len(parts) > 2 else ""
        unit = parts[3] if len(parts) > 3 else ""

        ref_min, ref_max = _parse_ref_range(ref_str)

        if ref_min is None and ref_max is None and "-" in unit:
            ref_min, ref_max = _parse_ref_range(unit)
            unit = ref_str if not ref_str.replace(".", "").replace("-", "").replace(" ", "").isdigit() else ""

        is_abnormal = False
        if value is not None:
            if ref_min is not None and value < ref_min:
                is_abnormal = True
            if ref_max is not None and value > ref_max:
                is_abnormal = True

        if value is not None or raw_value:
            results.append(LabValue(
                test_name=test_name, value=value, unit=unit,
                ref_min=ref_min, ref_max=ref_max, date=report_date,
                section=current_section, is_abnormal=is_abnormal,
                raw_value=raw_value,
            ))

        hist_values = parts[4:] if len(parts) > 4 else []
        for i, hist_raw in enumerate(hist_values):
            hist_val = _parse_float(hist_raw)
            if hist_val is None:
                continue
            hist_date = historical_dates[i] if i < len(historical_dates) else f"hist_{i}"
            hist_abnormal = False
            if ref_min is not None and hist_val < ref_min:
                hist_abnormal = True
            if ref_max is not None and hist_val > ref_max:
                hist_abnormal = True
            results.append(LabValue(
                test_name=test_name, value=hist_val, unit=unit,
                ref_min=ref_min, ref_max=ref_max, date=hist_date,
                section=current_section, is_abnormal=hist_abnormal,
                raw_value=hist_raw,
            ))

    log.debug("Horizontal parse: %d values from report dated %s", len(results), report_date)
    return results


def _parse_vertical(lines: list[str], report_date: str) -> list[LabValue]:
    """Parse vertical format where each field is on its own line.

    Acıbadem lab format:
          TestName      (indented with 4-6+ spaces)
    10.34               (value — numeric)
    4.40 - 9.70         (ref range — X - Y pattern)
    x10^3/uL            (unit)
    9.61                (historical values — numeric)
    """
    results: list[LabValue] = []
    current_section = "UNKNOWN"
    historical_dates: list[str] = []
    in_header_block = True

    # Collect all lines after header, grouping by test entries
    i = 0
    while i < len(lines):
        raw_line = lines[i]
        stripped = raw_line.strip()
        i += 1

        if not stripped:
            continue

        if stripped.startswith("#") or stripped.startswith("="):
            continue

        # Detect section headers
        section = _is_section_header(stripped)
        if section:
            current_section = section
            in_header_block = False
            continue

        # Collect historical dates from header lines
        if "Sonuç" in stripped or "Referans" in stripped or "Birim" in stripped:
            continue

        if stripped in ("Test Adı", "Test Ad"):
            in_header_block = False
            continue

        # Collect dates that appear alone on a line in header area
        date_match = _DATE_PATTERN.match(stripped)
        if date_match and len(stripped) <= 12:
            historical_dates.append(stripped)
            continue

        # Skip noise lines
        if stripped in _SKIP_LINES or stripped.upper() in _SKIP_LINES:
            continue

        # Skip hospital header noise (first ~30 lines before first section)
        if in_header_block and current_section == "UNKNOWN":
            continue

        # Look for test name (indented line with letters)
        if _is_test_name_line(stripped, raw_line):
            test_name = stripped
            value = None
            raw_value = ""
            ref_min = None
            ref_max = None
            unit = ""
            hist_values: list[str] = []

            # Consume subsequent lines for this test entry
            while i < len(lines):
                next_raw = lines[i]
                next_stripped = next_raw.strip()

                if not next_stripped:
                    i += 1
                    continue

                # If we hit the next test name, section header, or skip-line, stop
                if _is_test_name_line(next_stripped, next_raw):
                    break
                next_section = _is_section_header(next_stripped)
                if next_section:
                    break
                if next_stripped in _SKIP_LINES or next_stripped.upper() in _SKIP_LINES:
                    i += 1
                    continue
                if next_stripped.startswith("#"):
                    i += 1
                    continue

                # Try to classify this line
                if _is_ref_range_line(next_stripped):
                    ref_min, ref_max = _parse_ref_range(next_stripped)
                    i += 1
                elif _is_unit_line(next_stripped) and not unit:
                    unit = next_stripped
                    i += 1
                elif _parse_float(next_stripped) is not None:
                    num = _parse_float(next_stripped)
                    if value is None:
                        value = num
                        raw_value = next_stripped
                    else:
                        hist_values.append(next_stripped)
                    i += 1
                else:
                    # Unknown line — might be method name or noise, skip
                    i += 1
                    # But if it looks like a new test name starting, break
                    if re.search(r"[a-zA-ZçÇğĞıİöÖşŞüÜ]{3,}", next_stripped):
                        indent = len(next_raw) - len(next_raw.lstrip())
                        if indent >= 4:
                            break

            # Save the parsed test entry
            if value is not None:
                is_abnormal = False
                if ref_min is not None and value < ref_min:
                    is_abnormal = True
                if ref_max is not None and value > ref_max:
                    is_abnormal = True

                results.append(LabValue(
                    test_name=test_name, value=value, unit=unit,
                    ref_min=ref_min, ref_max=ref_max, date=report_date,
                    section=current_section, is_abnormal=is_abnormal,
                    raw_value=raw_value,
                ))

                # Historical values
                for hi, hist_raw in enumerate(hist_values):
                    hist_val = _parse_float(hist_raw)
                    if hist_val is None:
                        continue
                    hist_date = historical_dates[hi] if hi < len(historical_dates) else f"hist_{hi}"
                    hist_abnormal = False
                    if ref_min is not None and hist_val < ref_min:
                        hist_abnormal = True
                    if ref_max is not None and hist_val > ref_max:
                        hist_abnormal = True
                    results.append(LabValue(
                        test_name=test_name, value=hist_val, unit=unit,
                        ref_min=ref_min, ref_max=ref_max, date=hist_date,
                        section=current_section, is_abnormal=hist_abnormal,
                        raw_value=hist_raw,
                    ))

    log.debug("Vertical parse: %d values from report dated %s", len(results), report_date)
    return results


def aggregate_trends(
    manifest: list[dict], reports_dir: str
) -> dict[str, list[dict[str, Any]]]:
    """Parse ALL lab reports from a patient and aggregate by test name.

    Args:
        manifest: The report manifest (list of entry dicts from manifest.json).
        reports_dir: Path to the reports directory.

    Returns:
        Dict mapping test_name -> list of LabValue dicts, sorted by date.
        Also includes an "_abnormal_summary" key with currently abnormal tests.
    """
    reports_path = Path(reports_dir)
    all_values: dict[str, list[LabValue]] = {}
    lab_count = 0

    for entry in manifest:
        # Only process lab reports (Laboratuvar type)
        report_type = entry.get("report_type", "")
        report_type_swc = entry.get("report_type_swc", "")
        if report_type_swc != "L" and "Laboratuvar" not in report_type:
            continue

        text_file = entry.get("text_file")
        if not text_file:
            continue

        txt_path = reports_path / text_file
        if not txt_path.exists():
            continue

        try:
            with open(txt_path, "r", encoding="utf-8") as f:
                text = f.read()
        except Exception as e:
            log.warning("Failed to read lab report %s: %s", txt_path, e)
            continue

        report_date = entry.get("date", "")
        values = parse_lab_report(text, report_date)
        lab_count += 1

        for v in values:
            key = v.test_name.strip()
            if key not in all_values:
                all_values[key] = []
            all_values[key].append(v)

    # Sort each test's values by date and convert to dicts
    result: dict[str, list[dict[str, Any]]] = {}
    for test_name, values in sorted(all_values.items()):
        sorted_vals = sorted(values, key=lambda v: v.date)
        result[test_name] = [v.to_dict() for v in sorted_vals]

    # Build abnormal summary: tests where the most recent value is abnormal
    abnormal_summary: list[dict[str, Any]] = []
    for test_name, values in result.items():
        if values and values[-1].get("is_abnormal"):
            latest = values[-1]
            abnormal_summary.append({
                "test_name": test_name,
                "value": latest.get("value"),
                "unit": latest.get("unit", ""),
                "ref_min": latest.get("ref_min"),
                "ref_max": latest.get("ref_max"),
                "date": latest.get("date", ""),
                "section": latest.get("section", ""),
            })

    result["_abnormal_summary"] = abnormal_summary
    result["_lab_reports_parsed"] = [{"count": lab_count}]

    log.info(
        "Aggregated trends: %d unique tests from %d lab reports, %d currently abnormal",
        len(all_values), lab_count, len(abnormal_summary),
    )

    return result
