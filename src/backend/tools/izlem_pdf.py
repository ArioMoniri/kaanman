"""Izlem PDF Brief Generator -- creates structured PDF summaries of patient monitoring data.

Uses PyMuPDF (fitz) to generate clean, professional PDF briefs with:
- Last 24h emphasis on page 1
- Vitals trends table
- Medication list
- Doctor/nurse notes summary
- Alert sections highlighted in red/amber
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from pathlib import Path

import fitz  # pymupdf

log = logging.getLogger("cerebralink.izlem_pdf")

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = Path(os.environ.get("PATIENT_DATA_DIR", str(PROJECT_ROOT)))

# Layout constants (A4)
_PW, _PH = 595, 842
_ML, _MR, _MT, _MB = 50, 545, 60, 780

# Colors
_BLACK = (0, 0, 0)
_DGRAY = (0.2, 0.2, 0.2)
_GRAY = (0.5, 0.5, 0.5)
_LGRAY = (0.85, 0.85, 0.85)
_RED = (0.8, 0.1, 0.1)
_RED_F = (1.0, 0.92, 0.92)
_AMBER = (0.85, 0.55, 0.0)
_AMBER_F = (1.0, 0.96, 0.88)
_BLUE = (0.1, 0.3, 0.7)

# Vitals table config (reused across sections)
_VITALS_COLS = [100.0, 60.0, 80.0, 60.0, 60.0, 70.0]
_VITALS_HDRS = ["Date/Time", "Pulse", "BP", "SpO2", "Temp", "Resp"]
_VITALS_KEYS = [
    ("Tarih", "col_0"), ("Nabız", "Nabiz"), ("Tansiyon", "TA"),
    ("SpO2",), ("Ateş", "Ates", "Sicaklik"), ("Solunum", "SS"),
]


def _parse_date(s: str) -> datetime | None:
    for fmt in ("%d.%m.%Y %H:%M", "%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except (ValueError, AttributeError):
            continue
    return None


def _get(row: dict, *keys: str) -> str:
    """Get the first non-empty value from a row using multiple candidate keys."""
    for k in keys:
        v = row.get(k, "")
        if v and str(v).strip():
            return str(v)
    return ""


def _vitals_row_values(row: dict) -> list[str]:
    """Extract a vitals row into the standard column order."""
    return [_get(row, *keys) for keys in _VITALS_KEYS]


def _safe_float(s: str, strip_chars: str = "%,°C") -> float | None:
    cleaned = s
    for c in strip_chars:
        cleaned = cleaned.replace(c, "")
    cleaned = cleaned.replace(",", ".").split("/")[0].strip()
    try:
        return float(cleaned)
    except (ValueError, IndexError):
        return None


def _extract_vitals_24h(izlem_data: dict, now: datetime) -> list[dict]:
    vitals: list[dict] = []
    for ep in izlem_data.get("episodes", []):
        for row in ep.get("data", {}).get("vital_bulgular", []):
            dt = _parse_date(_get(row, "Tarih", "col_0"))
            if dt and (now - dt) < timedelta(hours=24):
                vitals.append(row)
    return vitals


def _extract_meds(izlem_data: dict, n: int = 3) -> list[dict]:
    meds: list[dict] = []
    for ep in izlem_data.get("episodes", [])[:n]:
        meds.extend(ep.get("data", {}).get("ilac_izlem", []))
    return meds


def _detect_alerts(izlem_data: dict) -> list[dict]:
    alerts: list[dict] = []
    for ep in izlem_data.get("episodes", []):
        ep_date = ep.get("episode_info", {}).get("date", "")
        for row in ep.get("data", {}).get("vital_bulgular", []):
            ds = _get(row, "Tarih", "col_0")
            hr = _safe_float(_get(row, "Nabız", "Nabiz"))
            if hr is not None:
                if hr > 120:
                    alerts.append({"type": "critical", "category": "Vitals",
                                   "message": f"Tachycardia HR={hr:.0f} ({ds})", "date": ds})
                elif hr < 50:
                    alerts.append({"type": "critical", "category": "Vitals",
                                   "message": f"Bradycardia HR={hr:.0f} ({ds})", "date": ds})
            spo2 = _safe_float(_get(row, "SpO2"))
            if spo2 is not None and spo2 < 92:
                alerts.append({"type": "critical", "category": "Vitals",
                               "message": f"Low SpO2={spo2:.0f}% ({ds})", "date": ds})
            temp = _safe_float(_get(row, "Ateş", "Ates", "Sicaklik"))
            if temp is not None and temp > 38.5:
                alerts.append({"type": "warning", "category": "Vitals",
                               "message": f"Fever T={temp:.1f} ({ds})", "date": ds})
        for row in ep.get("data", {}).get("enfeksiyon_kontrol_izlem", []):
            vals = " ".join(str(v) for v in row.values() if v).strip()
            if vals:
                alerts.append({"type": "warning", "category": "Infection Control",
                               "message": f"({ep_date}): {vals[:120]}", "date": ep_date})
    return alerts


class _W:
    """PDF page writer with auto-pagination."""

    def __init__(self, doc: fitz.Document):
        self.doc, self.page, self.y = doc, None, _MT

    def new_page(self):
        self.page = self.doc.new_page(width=_PW, height=_PH)
        self.y = _MT
        return self.page

    def _chk(self, n: float = 40):
        if self.y + n > _MB:
            self.new_page()

    def text(self, t: str, fs: float = 10, bold: bool = False,
             color: tuple = _BLACK, x: float = _ML):
        self._chk(fs + 4)
        self.page.insert_text(fitz.Point(x, self.y), t,
                              fontsize=fs, fontname="hebo" if bold else "helv", color=color)
        self.y += fs + 4

    def wrapped(self, t: str, fs: float = 10, color: tuple = _DGRAY, x: float = _ML):
        cpl = max(20, int((_MR - x) / (fs * 0.5)))
        line = ""
        for word in t.split():
            test = f"{line} {word}".strip()
            if len(test) > cpl:
                if line:
                    self.text(line, fs=fs, color=color, x=x)
                line = word
            else:
                line = test
        if line:
            self.text(line, fs=fs, color=color, x=x)

    def sep(self):
        self._chk(10)
        self.page.draw_line(fitz.Point(_ML, self.y), fitz.Point(_MR, self.y),
                            color=_LGRAY, width=0.5)
        self.y += 8

    def alert_box(self, t: str, critical: bool = True):
        self._chk(30)
        bc, fc, tc = (_RED, _RED_F, _RED) if critical else (_AMBER, _AMBER_F, _AMBER)
        r = fitz.Rect(_ML, self.y - 2, _MR, self.y + 16)
        self.page.draw_rect(r, color=bc, fill=fc, width=0.8)
        self.page.insert_text(fitz.Point(_ML + 8, self.y + 11), t[:100],
                              fontsize=9, fontname="hebo", color=tc)
        self.y += 22

    def table_row(self, cols: list[str], widths: list[float],
                  fs: float = 9, bold: bool = False, color: tuple = _BLACK):
        self._chk(fs + 6)
        fn = "hebo" if bold else "helv"
        x = _ML
        for txt, w in zip(cols, widths):
            self.page.insert_text(fitz.Point(x, self.y),
                                  txt[:int(w / (fs * 0.45))],
                                  fontsize=fs, fontname=fn, color=color)
            x += w
        self.y += fs + 4

    def vitals_table(self, rows: list[dict], title: str, fs: float = 8, max_rows: int = 15):
        if not rows:
            return
        self.text(title, fs=11, bold=True, color=_BLUE)
        self.y += 2
        self.table_row(_VITALS_HDRS, _VITALS_COLS, fs=9, bold=True, color=_DGRAY)
        self.page.draw_line(fitz.Point(_ML, self.y - 4),
                            fitz.Point(_ML + sum(_VITALS_COLS), self.y - 4),
                            color=_LGRAY, width=0.5)
        for row in rows[:max_rows]:
            self.table_row(_vitals_row_values(row), _VITALS_COLS, fs=fs, color=_DGRAY)
        self.y += 4


def _write_brief_text(w: _W, brief_text: str):
    for line in brief_text.split("\n"):
        s = line.strip()
        if not s:
            w.y += 6
        elif s.startswith("### "):
            w.y += 6; w._chk(30); w.text(s[4:], fs=11, bold=True, color=_BLUE); w.y += 2
        elif s.startswith("## "):
            w.y += 8; w._chk(30); w.text(s[3:], fs=12, bold=True, color=_BLUE); w.y += 4
        elif s.startswith("# "):
            w.y += 10; w._chk(30); w.text(s[2:], fs=14, bold=True, color=_BLUE); w.y += 4
        elif s.startswith("**") and s.endswith("**"):
            w.text(s.strip("*"), fs=10, bold=True, color=_DGRAY)
        elif s.startswith(("- ", "* ")):
            w.wrapped(f"  {s}", fs=9, color=_DGRAY, x=_ML + 10)
        else:
            w.wrapped(s, fs=9, color=_DGRAY)


def _write_episode_page(w: _W, ep: dict, idx: int):
    w.new_page()
    info = ep.get("episode_info", {})
    label = "Most Recent Episode" if idx == 0 else f"Episode {idx + 1}"
    w.text(label, fs=14, bold=True, color=_BLUE)
    w.text(f"Date: {info.get('date', 'N/A')}  |  Service: {info.get('serviceText', 'N/A')}"
           f"  |  Facility: {info.get('facilityText', 'N/A')}", fs=9, color=_DGRAY)
    w.sep()
    data = ep.get("data", {})

    # Doctor notes
    for note in data.get("hekim_izlem_notlari", [])[:10]:
        d, dr, txt = _get(note, "col_0", "Tarih"), _get(note, "col_1", "Hekim"), _get(note, "col_2", "Not")
        if d:
            w.text(f"{d} -- {dr}", fs=8, bold=True, color=_DGRAY)
        if txt:
            w.wrapped(txt[:500], fs=8, color=_DGRAY, x=_ML + 10)
        w.y += 2

    # Vitals
    w.vitals_table(data.get("vital_bulgular", []), "Vital Signs", fs=7, max_rows=20)

    # Meds
    ep_meds = data.get("ilac_izlem", [])
    if ep_meds:
        w.text("Medications", fs=11, bold=True, color=_BLUE)
        for row in ep_meds[:20]:
            name = _get(row, "İlaç Adı", "Ilac Adi", "col_0")
            if name.strip():
                w.text(f"  {name} -- {_get(row, 'Doz', 'col_1')}", fs=8, color=_DGRAY)
        w.y += 4

    # Labs
    ep_labs = data.get("laboratuvar_izlem", [])
    if ep_labs:
        w.text("Laboratory Results", fs=11, bold=True, color=_BLUE)
        for row in ep_labs[:15]:
            parts = [f"{k}: {v}" for k, v in row.items() if v and str(v).strip()]
            if parts:
                w.wrapped("  " + " | ".join(parts), fs=7, color=_DGRAY, x=_ML + 10)
        w.y += 4

    # Nurse notes
    for note in data.get("hemsire_izlem_notlari", [])[:5]:
        parts = [f"{k}: {v}" for k, v in note.items() if v and str(v).strip()]
        if parts:
            w.wrapped(" | ".join(parts)[:300], fs=7, color=_DGRAY, x=_ML + 10)


async def create_izlem_pdf(
    protocol_id: str,
    brief_text: str,
    izlem_data: dict,
    language: str = "en",
    output_dir: str | None = None,
) -> str:
    """Create a structured PDF brief of patient monitoring data.

    Returns the absolute path to the generated PDF file.
    """
    now = datetime.now()
    ts = now.strftime("%Y%m%d_%H%M%S")
    out = Path(output_dir) if output_dir else DATA_DIR / f"izlem_{protocol_id}"
    out.mkdir(parents=True, exist_ok=True)
    pdf_path = out / f"izlem_brief_{protocol_id}_{ts}.pdf"

    doc = fitz.open()
    w = _W(doc)

    # --- Page 1: Last 24 Hours Summary ---
    w.new_page()
    w.text("Patient Monitoring Brief", fs=16, bold=True, color=_BLUE)
    w.y += 4
    w.text(f"Protocol: {protocol_id}", fs=12, bold=True, color=_DGRAY)
    w.text(f"Generated: {now.strftime('%Y-%m-%d %H:%M')}", fs=9, color=_GRAY)
    w.y += 6
    w.sep()

    alerts = _detect_alerts(izlem_data)
    crit = [a for a in alerts if a["type"] == "critical"]
    warn = [a for a in alerts if a["type"] == "warning"]
    if crit:
        w.text("CRITICAL ALERTS", fs=11, bold=True, color=_RED)
        for a in crit[:8]:
            w.alert_box(a["message"], critical=True)
    if warn:
        w.text("WARNINGS", fs=11, bold=True, color=_AMBER)
        for a in warn[:6]:
            w.alert_box(a["message"], critical=False)
    if alerts:
        w.y += 4

    w.vitals_table(_extract_vitals_24h(izlem_data, now), "Last 24h Vital Signs")

    # Medications summary
    meds = _extract_meds(izlem_data)
    if meds:
        w.text("Current Medications", fs=11, bold=True, color=_BLUE)
        w.y += 2
        mcols = [180.0, 60.0, 80.0, 80.0, 80.0]
        w.table_row(["Medication", "Dose", "Route", "Frequency", "Date"],
                     mcols, fs=9, bold=True, color=_DGRAY)
        seen: set[str] = set()
        for row in meds:
            name = _get(row, "İlaç Adı", "Ilac Adi", "col_0")
            if not name.strip() or name in seen:
                continue
            seen.add(name)
            w.table_row([name, _get(row, "Doz", "col_1"),
                         _get(row, "Yol", "Uygulama Yolu", "col_2"),
                         _get(row, "Frekans", "Sıklık", "col_3"),
                         _get(row, "Tarih", "col_4")], mcols, fs=8, color=_DGRAY)
            if len(seen) >= 30:
                break
        w.y += 6

    # --- Page 2: LLM Brief ---
    w.new_page()
    w.text("Clinical Monitoring Summary", fs=14, bold=True, color=_BLUE)
    w.y += 6
    _write_brief_text(w, brief_text)

    # --- Pages 3+: Episode details ---
    episodes = sorted(izlem_data.get("episodes", []),
                      key=lambda e: e.get("episode_info", {}).get("date", "0"), reverse=True)
    for idx, ep in enumerate(episodes[:3]):
        _write_episode_page(w, ep, idx)

    # --- Alerts summary page ---
    if alerts:
        w.new_page()
        w.text("Alerts & Flags Summary", fs=14, bold=True, color=_BLUE)
        w.y += 6
        if crit:
            w.text(f"Critical Alerts ({len(crit)})", fs=11, bold=True, color=_RED)
            for a in crit:
                w.alert_box(f"[{a['category']}] {a['message']}", critical=True)
        if warn:
            w.y += 4
            w.text(f"Warnings ({len(warn)})", fs=11, bold=True, color=_AMBER)
            for a in warn:
                w.alert_box(f"[{a['category']}] {a['message']}", critical=False)

    # Footer on every page
    for i in range(len(doc)):
        doc[i].insert_text(
            fitz.Point(_ML, _PH - 20),
            f"CerebraLink Izlem Brief -- Protocol {protocol_id} -- "
            f"Page {i + 1}/{len(doc)} -- {now.strftime('%Y-%m-%d %H:%M')}",
            fontsize=7, fontname="helv", color=_GRAY)

    doc.save(str(pdf_path))
    doc.close()
    log.info("Created izlem PDF: %s", pdf_path)
    return str(pdf_path)
