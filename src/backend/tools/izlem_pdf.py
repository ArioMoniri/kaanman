"""Izlem PDF Brief Generator -- creates structured PDF summaries of patient monitoring data.

Uses PyMuPDF (fitz) to generate professional PDF briefs with:
- Page 1: Last 24h focus with alerts, vitals chart, hekim/hemşire notes, reports
- Pages 2+: Last 3 izlem episodes detail
- Past history: falls, allergies, important recurring issues
- Full Turkish character support via Story API + insert_htmlbox
- Proper markdown → HTML rendering
"""

from __future__ import annotations

import html as html_mod
import logging
import os
import re
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import fitz  # pymupdf

log = logging.getLogger("cerebralink.izlem_pdf")

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = Path(os.environ.get("PATIENT_DATA_DIR", str(PROJECT_ROOT)))

# Layout constants (A4)
_PW, _PH = 595, 842
_ML, _MR, _MT, _MB = 50, 545, 60, 790
_CONTENT_W = _MR - _ML

# Fonts directory — Inter font family bundled in project
_FONTS_DIR = PROJECT_ROOT / "fonts" / "inter"

# CSS for HTML rendering — warm earth-tone medical report (Canva-quality)
_CSS = """
body { font-family: "Inter", "InterBold", "InterItalic", sans-serif;
       font-size: 9.5px; color: #2D2926; line-height: 1.55; }
h1 { font-family: "InterBold"; font-size: 22px; color: #2D2926; margin: 0 0 2px 0;
     font-weight: 700; letter-spacing: -0.03em; }
h2 { font-family: "InterBold"; font-size: 13px; color: #ffffff; margin: 16px 0 8px 0;
     font-weight: 700; padding: 8px 16px;
     background: linear-gradient(90deg, #C4704B 0%, #B86040 100%);
     border-radius: 6px; letter-spacing: 0.02em; }
h3 { font-family: "InterBold"; font-size: 11px; color: #2A6F6F; margin: 10px 0 4px 0;
     font-weight: 700; padding-left: 10px; border-left: 3px solid #C4704B; }
h4 { font-family: "InterMedium"; font-size: 10px; color: #9C9590; margin: 6px 0 2px 0;
     font-weight: 500; font-style: italic; }
p  { margin: 3px 0; }
ul, ol { margin: 4px 0; padding-left: 18px; }
li { margin: 2px 0; line-height: 1.45; }
b, strong { font-family: "InterBold"; font-weight: 700; }
i, em { font-family: "InterItalic"; font-style: italic; }

/* Tables — warm earth-tone medical data table */
table { border-collapse: collapse; width: 100%; margin: 8px 0;
        border: 1px solid #DDD5CA; }
th { background: #F0EBE3; color: #2D2926; font-family: "InterBold"; font-weight: 600;
     font-size: 8px; padding: 6px 10px; text-align: left;
     text-transform: uppercase; letter-spacing: 0.5px;
     border-bottom: 2px solid #DDD5CA; }
td { padding: 5px 10px; font-size: 8.5px; border-bottom: 1px solid #EDE8E0; color: #2D2926; }
tr:nth-child(even) td { background: #FAF7F2; }
tr:nth-child(odd) td  { background: #ffffff; }

/* Alert boxes — high-visibility with warm coral/amber accents */
.alert-critical {
  background: rgba(212,83,75,0.06); border-left: 4px solid #D4534B;
  border: 1px solid rgba(212,83,75,0.2); border-left-width: 4px;
  padding: 8px 14px; margin: 8px 0; color: #2D2926;
  font-size: 9.5px; border-radius: 0 6px 6px 0;
}
.alert-critical b, .alert-critical strong { color: #D4534B; }
.alert-warning {
  background: rgba(212,160,60,0.06); border-left: 4px solid #D4A03C;
  border: 1px solid rgba(212,160,60,0.2); border-left-width: 4px;
  padding: 8px 14px; margin: 8px 0; color: #2D2926;
  font-size: 9.5px; border-radius: 0 6px 6px 0;
}
.alert-info {
  background: rgba(42,111,111,0.05); border-left: 4px solid #2A6F6F;
  border: 1px solid rgba(42,111,111,0.15); border-left-width: 4px;
  padding: 8px 14px; margin: 8px 0; color: #2D2926;
  font-size: 9px; border-radius: 0 6px 6px 0;
}

/* Note blocks — clinical notes with earth-tone borders */
.note-block {
  background: #ffffff; border-left: 3px solid #C4704B; border: 1px solid #DDD5CA;
  border-left-width: 3px; padding: 6px 12px;
  margin: 4px 0; font-size: 8.5px; border-radius: 0 4px 4px 0;
}
.note-block-doctor {
  background: #ffffff; border-left: 4px solid #2A6F6F; border: 1px solid #DDD5CA;
  border-left-width: 4px; padding: 6px 12px;
  margin: 4px 0; font-size: 9px; border-radius: 0 5px 5px 0;
}
.note-block-nurse {
  background: #ffffff; border-left: 4px solid #6B8F71; border: 1px solid #DDD5CA;
  border-left-width: 4px; padding: 6px 12px;
  margin: 4px 0; font-size: 9px; border-radius: 0 5px 5px 0;
}

/* Highlight box — key findings with warm accents */
.highlight-box {
  background: rgba(196,112,75,0.06); border: 1.5px solid rgba(196,112,75,0.25);
  padding: 8px 12px; margin: 6px 0; border-radius: 6px; font-size: 9px;
}
.highlight-green {
  background: rgba(107,143,113,0.06); border: 1.5px solid rgba(107,143,113,0.25);
  padding: 8px 12px; margin: 6px 0; border-radius: 6px; font-size: 9px;
}

/* Section header banner — terracotta section divider */
.section-banner {
  background: linear-gradient(90deg, #C4704B, #B86040); color: #ffffff;
  padding: 8px 16px; margin: 14px 0 8px 0;
  font-family: "InterBold"; font-weight: 700; font-size: 12px;
  border-radius: 6px; letter-spacing: 0.02em;
}
.section-banner-accent {
  background: linear-gradient(90deg, #2A6F6F, #236060); color: #ffffff;
  padding: 8px 16px; margin: 14px 0 8px 0;
  font-family: "InterBold"; font-weight: 700; font-size: 12px;
  border-radius: 6px; letter-spacing: 0.02em;
}
.section-banner-alert {
  background: linear-gradient(90deg, #D4534B, #C4443C); color: #ffffff;
  padding: 8px 16px; margin: 14px 0 8px 0;
  font-family: "InterBold"; font-weight: 700; font-size: 12px;
  border-radius: 6px; letter-spacing: 0.02em;
}

/* Patient identity card */
.patient-card {
  background: #F0EBE3; border-left: 5px solid #C4704B;
  border: 1px solid #DDD5CA; border-left-width: 5px;
  border-radius: 8px; padding: 12px 16px; margin: 10px 0 14px 0;
}

/* Misc */
code { background: #F0EBE3; padding: 1px 4px; border-radius: 3px; font-size: 8px;
       font-family: monospace; color: #2A6F6F; }
.muted { color: #9C9590; font-size: 8.5px; font-style: italic; }
.small { font-size: 7.5px; color: #9C9590; }
.sep { border-top: 1.5px solid #DDD5CA; margin: 12px 0; }
.sep-heavy { border-top: 2.5px solid #C4704B; margin: 14px 0; }
.page-break { break-before: page; }
.badge { display: inline; background: #F0EBE3; color: #2A6F6F; padding: 1px 8px;
         border-radius: 10px; font-size: 7.5px; font-family: "InterBold";
         font-weight: 700; border: 1px solid #DDD5CA; }
.badge-red { display: inline; background: rgba(212,83,75,0.1); color: #D4534B;
             padding: 1px 8px; border-radius: 10px; font-size: 7.5px;
             font-family: "InterBold"; font-weight: 700; border: 1px solid rgba(212,83,75,0.3); }
.badge-green { display: inline; background: rgba(107,143,113,0.1); color: #6B8F71;
               padding: 1px 8px; border-radius: 10px; font-size: 7.5px;
               font-family: "InterBold"; font-weight: 700; border: 1px solid rgba(107,143,113,0.3); }
"""


def _parse_date(s: str) -> datetime | None:
    for fmt in ("%d.%m.%Y %H:%M", "%d.%m.%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except (ValueError, AttributeError):
            continue
    return None


def _get(row: dict, *keys: str) -> str:
    for k in keys:
        v = row.get(k, "")
        if v and str(v).strip():
            return str(v).strip()
    return ""


def _esc(s: str) -> str:
    return html_mod.escape(str(s))


def _safe_float(s: str) -> float | None:
    cleaned = s.replace("%", "").replace("°C", "").replace(",", ".").split("/")[0].strip()
    try:
        return float(cleaned)
    except (ValueError, IndexError):
        return None


# ── Data extraction helpers ──

def _find_most_recent_timestamp(izlem_data: dict) -> datetime | None:
    """Find the most recent timestamp in the izlem data.

    Scans episode dates, vital signs dates, and note dates to find the latest
    data point. This is used as the reference time for "last 24h" extraction
    instead of system clock, so the section isn't empty when data is older.
    """
    latest: datetime | None = None
    for ep in izlem_data.get("episodes", []):
        # Episode-level date
        ep_date_str = ep.get("episode_info", {}).get("date", "")
        dt = _parse_date(ep_date_str)
        if dt and (latest is None or dt > latest):
            latest = dt
        # Scan individual data rows for timestamps
        data = ep.get("data", {})
        for key in ["vital_bulgular", "hekim_izlem_notlari", "hemsire_izlem_notlari",
                     "laboratuvar_izlem", "ilac_izlem"]:
            for row in data.get(key, []):
                dt = _parse_date(_get(row, "Tarih", "col_0"))
                if dt and (latest is None or dt > latest):
                    latest = dt
    return latest


def _extract_vitals_24h(izlem_data: dict, now: datetime) -> list[dict]:
    vitals: list[dict] = []
    for ep in izlem_data.get("episodes", []):
        for row in ep.get("data", {}).get("vital_bulgular", []):
            dt = _parse_date(_get(row, "Tarih", "col_0"))
            if dt and (now - dt) < timedelta(hours=24):
                vitals.append(row)
    vitals.sort(key=lambda r: _get(r, "Tarih", "col_0"), reverse=True)
    return vitals


def _extract_notes_24h(izlem_data: dict, now: datetime, key: str) -> list[dict]:
    notes: list[dict] = []
    for ep in izlem_data.get("episodes", []):
        for row in ep.get("data", {}).get(key, []):
            dt = _parse_date(_get(row, "col_0", "Tarih"))
            if dt and (now - dt) < timedelta(hours=24):
                notes.append(row)
            elif not dt:
                notes.append(row)
    return notes[:15]


def _extract_meds_recent(izlem_data: dict, n_eps: int = 3) -> list[dict]:
    meds: list[dict] = []
    seen: set[str] = set()
    for ep in izlem_data.get("episodes", [])[:n_eps]:
        for row in ep.get("data", {}).get("ilac_izlem", []):
            name = _get(row, "İlaç Adı", "Ilac Adi", "col_0")
            if name and name not in seen:
                seen.add(name)
                meds.append(row)
    return meds


def _detect_alerts(izlem_data: dict, now: datetime | None = None) -> list[dict]:
    alerts: list[dict] = []
    for ep in izlem_data.get("episodes", []):
        ep_date = ep.get("episode_info", {}).get("date", "")
        for row in ep.get("data", {}).get("vital_bulgular", []):
            ds = _get(row, "Tarih", "col_0")
            dt = _parse_date(ds)
            is_24h = dt and now and (now - dt) < timedelta(hours=24)
            hr = _safe_float(_get(row, "Nabız", "Nabiz"))
            if hr is not None:
                if hr > 120:
                    alerts.append({"type": "critical", "cat": "Vital", "recent": is_24h,
                                   "msg": f"Taşikardi HR={hr:.0f} ({ds})"})
                elif hr < 50:
                    alerts.append({"type": "critical", "cat": "Vital", "recent": is_24h,
                                   "msg": f"Bradikardi HR={hr:.0f} ({ds})"})
            spo2 = _safe_float(_get(row, "SpO2"))
            if spo2 is not None and spo2 < 92:
                alerts.append({"type": "critical", "cat": "Vital", "recent": is_24h,
                               "msg": f"Düşük SpO2={spo2:.0f}% ({ds})"})
            temp = _safe_float(_get(row, "Ateş", "Ates", "Sicaklik"))
            if temp is not None and temp > 38.5:
                alerts.append({"type": "warning", "cat": "Vital", "recent": is_24h,
                               "msg": f"Ateş T={temp:.1f}°C ({ds})"})
        for row in ep.get("data", {}).get("enfeksiyon_kontrol_izlem", []):
            vals = " ".join(str(v) for v in row.values() if v).strip()
            if vals:
                alerts.append({"type": "warning", "cat": "Enfeksiyon",
                               "msg": f"({ep_date}): {vals[:120]}", "recent": False})
        for row in ep.get("data", {}).get("basinc_yarasi_izlem", []):
            vals = " ".join(str(v) for v in row.values() if v).strip()
            if vals:
                alerts.append({"type": "warning", "cat": "Basınç Yarası",
                               "msg": f"({ep_date}): {vals[:120]}", "recent": False})
    return alerts


def _extract_labs_24h(izlem_data: dict, now: datetime) -> list[dict]:
    labs: list[dict] = []
    for ep in izlem_data.get("episodes", []):
        for row in ep.get("data", {}).get("laboratuvar_izlem", []):
            dt = _parse_date(_get(row, "Tarih", "col_0"))
            if dt and (now - dt) < timedelta(hours=24):
                labs.append(row)
            elif not dt:
                labs.append(row)
    return labs[:20]


def _extract_past_important(izlem_data: dict) -> list[str]:
    items: list[str] = []
    seen: set[str] = set()
    for ep in izlem_data.get("episodes", []):
        data = ep.get("data", {})
        ep_date = ep.get("episode_info", {}).get("date", "")
        for key in ["hekim_izlem_notlari", "hemsire_izlem_notlari"]:
            for note in data.get(key, []):
                txt = " ".join(str(v) for v in note.values() if v).lower()
                for keyword, label in [
                    ("düşme", "Düşme riski/olay"), ("düştü", "Düşme olay"),
                    ("fall", "Fall risk/event"), ("alerji", "Alerji"),
                    ("allergy", "Allergy"), ("anafilak", "Anafilaksi riski"),
                    ("kanama", "Kanama"), ("transfüzyon", "Transfüzyon"),
                    ("dekübit", "Dekübit ülser"), ("basınç yarası", "Basınç yarası"),
                    ("izolasyon", "İzolasyon"), ("mrsa", "MRSA"), ("vre", "VRE"),
                    ("cpap", "CPAP/Solunum desteği"), ("entüb", "Entübasyon"),
                    ("resüsitasyon", "Resüsitasyon"),
                ]:
                    if keyword in txt and label not in seen:
                        seen.add(label)
                        items.append(f"{label} ({ep_date})")
    return items


# ── HTML builders ──

def _build_alerts_html(alerts: list[dict], recent_only: bool = False) -> str:
    filtered = [a for a in alerts if a.get("recent")] if recent_only else alerts
    if not filtered:
        return ""
    parts = []
    crits = [a for a in filtered if a["type"] == "critical"]
    warns = [a for a in filtered if a["type"] == "warning"]
    if crits:
        parts.append('<div class="section-banner-alert">KRITIK UYARILAR</div>')
        for a in crits[:8]:
            parts.append(
                f'<div class="alert-critical">'
                f'<span class="badge-red">{_esc(a["cat"])}</span> '
                f'{_esc(a["msg"])}</div>'
            )
    if warns:
        parts.append("<h3>Uyarilar</h3>")
        for a in warns[:6]:
            parts.append(
                f'<div class="alert-warning">'
                f'<span class="badge">{_esc(a["cat"])}</span> '
                f'{_esc(a["msg"])}</div>'
            )
    return "\n".join(parts)


def _build_vitals_table_html(vitals: list[dict], title: str) -> str:
    if not vitals:
        return ""
    rows_html = []
    for row in vitals[:15]:
        rows_html.append("<tr>" + "".join(
            f"<td>{_esc(_get(row, *keys))}</td>"
            for keys in [
                ("Tarih", "col_0"), ("Nabız", "Nabiz"), ("Tansiyon", "TA"),
                ("SpO2",), ("Ateş", "Ates", "Sicaklik"), ("Solunum", "SS"),
            ]
        ) + "</tr>")
    return f"""<h3>{_esc(title)}</h3>
<table>
<tr><th>Tarih/Saat</th><th>Nabız</th><th>TA</th><th>SpO2</th><th>Ateş</th><th>Solunum</th></tr>
{"".join(rows_html)}
</table>"""


def _build_meds_html(meds: list[dict], title: str) -> str:
    if not meds:
        return ""
    rows = []
    for row in meds[:25]:
        name = _get(row, "İlaç Adı", "Ilac Adi", "col_0")
        if not name:
            continue
        rows.append("<tr>" + "".join(f"<td>{_esc(v)}</td>" for v in [
            name, _get(row, "Doz", "col_1"), _get(row, "Yol", "Uygulama Yolu", "col_2"),
            _get(row, "Frekans", "Sıklık", "col_3"), _get(row, "Tarih", "col_4"),
        ]) + "</tr>")
    if not rows:
        return ""
    return f"""<h3>{_esc(title)}</h3>
<table>
<tr><th>İlaç</th><th>Doz</th><th>Yol</th><th>Sıklık</th><th>Tarih</th></tr>
{"".join(rows)}
</table>"""


def _build_notes_html(notes: list[dict], title: str, is_hekim: bool = True) -> str:
    if not notes:
        return ""
    block_cls = "note-block-doctor" if is_hekim else "note-block-nurse"
    role_badge = '<span class="badge">Hekim</span>' if is_hekim else '<span class="badge-green">Hemsire</span>'
    parts = [f"<h3>{_esc(title)}</h3>"]
    for note in notes[:10]:
        date_str = _get(note, "col_0", "Tarih")
        author = _get(note, "col_1", "Hekim" if is_hekim else "Hemşire")
        text = _get(note, "col_2", "Not", "col_3")
        header = f"{role_badge} <b>{_esc(date_str)}</b>"
        if author:
            header += f" — <i>{_esc(author)}</i>"
        parts.append(f'<div class="{block_cls}">{header}<br/>{_esc(text[:500])}</div>')
    return "\n".join(parts)


def _build_labs_html(labs: list[dict], title: str) -> str:
    if not labs:
        return ""
    parts = [f"<h3>{_esc(title)}</h3>"]
    for row in labs[:15]:
        items = [f"<b>{_esc(k)}</b>: {_esc(str(v))}" for k, v in row.items()
                 if v and str(v).strip()]
        if items:
            parts.append(f'<div class="note-block" style="font-size:7px">{" | ".join(items)}</div>')
    return "\n".join(parts)


def _build_episode_html(ep: dict, idx: int, language: str) -> str:
    info = ep.get("episode_info", {})
    data = ep.get("data", {})
    is_tr = language == "tr"
    label = ("En Son Epizod" if idx == 0 else f"Epizod {idx + 1}") if is_tr else \
            ("Most Recent Episode" if idx == 0 else f"Episode {idx + 1}")

    parts = [
        f'<div class="page-break"></div>',
        f"<h2>{_esc(label)}</h2>",
        f'<p class="muted">Tarih: {_esc(info.get("date", "N/A"))} | '
        f'Servis: {_esc(info.get("serviceText", "N/A"))} | '
        f'Kurum: {_esc(info.get("facilityText", "N/A"))}</p>',
        '<div class="sep"></div>',
    ]

    parts.append(_build_notes_html(
        data.get("hekim_izlem_notlari", [])[:10],
        "Hekim İzlem Notları" if is_tr else "Doctor Notes", is_hekim=True))
    parts.append(_build_notes_html(
        data.get("hemsire_izlem_notlari", [])[:8],
        "Hemşire İzlem Notları" if is_tr else "Nurse Notes", is_hekim=False))
    parts.append(_build_vitals_table_html(
        data.get("vital_bulgular", []),
        "Vital Bulgular" if is_tr else "Vital Signs"))
    parts.append(_build_meds_html(
        data.get("ilac_izlem", []),
        "İlaçlar" if is_tr else "Medications"))
    parts.append(_build_labs_html(
        data.get("laboratuvar_izlem", []),
        "Laboratuvar" if is_tr else "Laboratory"))
    blood_gas = data.get("kangazi_izlem", [])
    if blood_gas:
        parts.append(_build_labs_html(blood_gas, "Kan Gazı" if is_tr else "Blood Gas"))
    for cat_key, tr, en in [
        ("enfeksiyon_kontrol_izlem", "Enfeksiyon Kontrol", "Infection Control"),
        ("norolojik_izlem", "Nörolojik", "Neurological"),
        ("diyabet_izlem", "Diyabet", "Diabetes"),
        ("ventilasyon_izlem", "Ventilasyon", "Ventilation"),
        ("nutrisyon_izlem", "Nütrisyon", "Nutrition"),
        ("agri_izlem", "Ağrı", "Pain"),
        ("rehabilitasyon_izlem", "Rehabilitasyon", "Rehabilitation"),
        ("basinc_yarasi_izlem", "Basınç Yarası", "Pressure Sore"),
        ("yara_bakimi_izlem", "Yara Bakımı", "Wound Care"),
    ]:
        cat_data = data.get(cat_key, [])
        if cat_data:
            parts.append(_build_labs_html(cat_data[:8], tr if is_tr else en))

    return "\n".join(p for p in parts if p)


def _inline_format(text: str) -> str:
    """Apply inline markdown formatting (bold, italic, links, refs)."""
    text = re.sub(r'\*\*\*([^*]+)\*\*\*', r'<b><i>\1</i></b>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'\*([^*]+)\*', r'<i>\1</i>', text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\[\d+\]', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text


def _md_to_html(md_text: str) -> str:
    """Convert markdown text to HTML for PDF rendering."""
    lines = md_text.split("\n")
    html_parts: list[str] = []
    in_list = False
    in_table = False

    for line in lines:
        s = line.strip()
        if not s:
            if in_list:
                html_parts.append("</ul>"); in_list = False
            if in_table:
                html_parts.append("</table>"); in_table = False
            continue

        # Horizontal rules: ---, ***, ___
        if re.match(r'^[-*_]{3,}\s*$', s):
            if in_list: html_parts.append("</ul>"); in_list = False
            if in_table: html_parts.append("</table>"); in_table = False
            html_parts.append('<div class="sep"></div>')
            continue

        # Table separator rows (|---|---|)
        if re.match(r'^\|?\s*[-:]+[-|\s:]+\s*\|?$', s):
            continue  # skip markdown table alignment rows

        # Table rows (| col | col |)
        if '|' in s and re.match(r'^\|.*\|$', s.strip()):
            cells = [c.strip() for c in s.strip('|').split('|')]
            if not in_table:
                html_parts.append("<table>")
                in_table = True
                html_parts.append("<tr>" + "".join(
                    f"<th>{_inline_format(_esc(c))}</th>" for c in cells) + "</tr>")
            else:
                html_parts.append("<tr>" + "".join(
                    f"<td>{_inline_format(_esc(c))}</td>" for c in cells) + "</tr>")
            continue

        if in_table:
            html_parts.append("</table>"); in_table = False

        if s.startswith("#### "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h4>{_inline_format(_esc(s[5:]))}</h4>")
        elif s.startswith("### "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h3>{_inline_format(_esc(s[4:]))}</h3>")
        elif s.startswith("## "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h2>{_inline_format(_esc(s[3:]))}</h2>")
        elif s.startswith("# "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h1>{_inline_format(_esc(s[2:]))}</h1>")
        elif s.startswith(("- ", "* ", "• ")):
            if not in_list: html_parts.append("<ul>"); in_list = True
            content = _inline_format(_esc(s[2:]))
            html_parts.append(f"<li>{content}</li>")
        elif re.match(r'^\d+\.\s', s):
            if not in_list: html_parts.append("<ul>"); in_list = True
            content = _inline_format(_esc(re.sub(r'^\d+\.\s*', '', s)))
            html_parts.append(f"<li>{content}</li>")
        else:
            if in_list: html_parts.append("</ul>"); in_list = False
            escaped = _inline_format(_esc(s))
            html_parts.append(f"<p>{escaped}</p>")

    if in_list:
        html_parts.append("</ul>")
    if in_table:
        html_parts.append("</table>")
    return "\n".join(html_parts)


# ── Vitals chart overlay (direct pymupdf drawing on existing page) ──

def _draw_vitals_chart(page: fitz.Page, vitals: list[dict], y_start: float) -> float:
    """Draw a simple vitals trend chart. Returns y after chart."""
    if not vitals or len(vitals) < 2:
        return y_start

    chart_h, chart_w = 75, _CONTENT_W - 40
    x0, y0 = _ML + 20, y_start + 5
    x1, y1 = x0 + chart_w, y0 + chart_h

    page.draw_rect(fitz.Rect(x0, y0, x1, y1),
                   color=(0.85, 0.85, 0.85), fill=(0.97, 0.97, 0.99), width=0.5)

    hr_pts: list[tuple[int, float]] = []
    spo2_pts: list[tuple[int, float]] = []
    temp_pts: list[tuple[int, float]] = []

    vs = list(reversed(vitals[:20]))
    for i, row in enumerate(vs):
        hr = _safe_float(_get(row, "Nabız", "Nabiz"))
        if hr is not None: hr_pts.append((i, hr))
        sp = _safe_float(_get(row, "SpO2"))
        if sp is not None: spo2_pts.append((i, sp))
        t = _safe_float(_get(row, "Ateş", "Ates", "Sicaklik"))
        if t is not None: temp_pts.append((i, t))

    n = len(vs)
    if n < 2:
        return y_start

    def _draw_series(pts: list[tuple[int, float]], vmin: float, vmax: float,
                     color: tuple, label: str):
        if len(pts) < 2:
            return
        rng = max(vmax - vmin, 1)
        prev = None
        for idx, val in pts:
            px = x0 + 5 + (idx / max(n - 1, 1)) * (chart_w - 10)
            py = y1 - 5 - ((val - vmin) / rng) * (chart_h - 15)
            py = max(y0 + 5, min(y1 - 5, py))
            if prev:
                page.draw_line(fitz.Point(*prev), fitz.Point(px, py), color=color, width=1.2)
            page.draw_circle(fitz.Point(px, py), 2, color=color, fill=color)
            prev = (px, py)
        # Legend label
        if pts:
            font = fitz.Font("helv")
            tw = fitz.TextWriter(page.rect)
            tw.append(fitz.Point(x1 + 3, y1 - 5 - ((pts[-1][1] - vmin) / rng) * (chart_h - 15)),
                      label, font=font, fontsize=6)
            tw.write_text(page, color=color)

    if hr_pts:
        _draw_series(hr_pts, 40, 160, (0.8, 0.1, 0.1), "HR")
    if spo2_pts:
        _draw_series(spo2_pts, 80, 100, (0.1, 0.3, 0.8), "SpO2")
    if temp_pts:
        _draw_series(temp_pts, 36, 40, (0.85, 0.55, 0.0), "T")

    # Time axis
    font = fitz.Font("helv")
    tw = fitz.TextWriter(page.rect)
    if vs:
        tw.append(fitz.Point(x0, y1 + 8), _get(vs[0], "Tarih", "col_0")[:11], font=font, fontsize=6)
        tw.append(fitz.Point(x1 - 40, y1 + 8), _get(vs[-1], "Tarih", "col_0")[:11], font=font, fontsize=6)
    tw.write_text(page, color=(0.5, 0.5, 0.5))
    return y1 + 14


# ── Story-based multi-page rendering ──

def _make_font_archive() -> fitz.Archive | None:
    """Create an archive with Inter font family for professional typography.

    Falls back to built-in helv if Inter files are unavailable.
    Inter provides excellent Turkish character support (2900+ glyphs).
    """
    import shutil

    try:
        tmpdir = tempfile.mkdtemp(prefix="izlem_fonts_")
        inter_dir = _FONTS_DIR

        # Check multiple possible font locations (Docker may mount differently)
        possible_dirs = [
            inter_dir,
            Path("/app/fonts/inter"),
            Path("/app/src/backend/fonts/inter"),
            PROJECT_ROOT / "src" / "backend" / "fonts" / "inter",
        ]

        font_map = {
            "Inter.ttf": "Inter-Regular.ttf",
            "InterBold.ttf": "Inter-Bold.ttf",
            "InterItalic.ttf": "Inter-Italic.ttf",
            "InterMedium.ttf": "Inter-Medium.ttf",
            "InterSemiBold.ttf": "Inter-SemiBold.ttf",
            "InterBoldItalic.ttf": "Inter-BoldItalic.ttf",
            "InterMediumItalic.ttf": "Inter-MediumItalic.ttf",
        }

        fonts_loaded = 0
        used_dir = None
        for candidate_dir in possible_dirs:
            if not candidate_dir.exists():
                continue
            count = 0
            for target_name, source_name in font_map.items():
                source_path = candidate_dir / source_name
                if source_path.exists():
                    shutil.copy2(source_path, os.path.join(tmpdir, target_name))
                    count += 1
            if count > fonts_loaded:
                fonts_loaded = count
                used_dir = candidate_dir
            if fonts_loaded >= 7:
                break

        if fonts_loaded == 0:
            # Fallback: use built-in helv (no Turkish ı, ş, ö, ü, ç, ğ support!)
            log.warning(
                "Inter fonts not found in any of %s — falling back to helv. "
                "Turkish characters may not render correctly.",
                [str(d) for d in possible_dirs],
            )
            font = fitz.Font("helv")
            with open(os.path.join(tmpdir, "Inter.ttf"), "wb") as f:
                f.write(font.buffer)
            bold = fitz.Font("hebo")
            with open(os.path.join(tmpdir, "InterBold.ttf"), "wb") as f:
                f.write(bold.buffer)
            italic = fitz.Font("heit")
            with open(os.path.join(tmpdir, "InterItalic.ttf"), "wb") as f:
                f.write(italic.buffer)
        else:
            log.info("Loaded %d Inter font variants from %s", fonts_loaded, used_dir)
        return fitz.Archive(tmpdir)
    except Exception as e:
        log.warning("Font archive creation failed: %s", e, exc_info=True)
        return None


def _render_story_to_doc(html: str, output_path: str) -> int:
    """Render styled HTML to a PDF file using Story API. Returns page count."""
    arch = _make_font_archive()
    # Register Inter font family with all weight/style variants
    font_faces = """
@font-face { font-family: "Inter"; src: url("Inter.ttf"); }
@font-face { font-family: "InterBold"; src: url("InterBold.ttf"); font-weight: bold; }
@font-face { font-family: "InterItalic"; src: url("InterItalic.ttf"); font-style: italic; }
@font-face { font-family: "InterMedium"; src: url("InterMedium.ttf"); }
@font-face { font-family: "InterSemiBold"; src: url("InterSemiBold.ttf"); }
@font-face { font-family: "InterBoldItalic"; src: url("InterBoldItalic.ttf"); font-weight: bold; font-style: italic; }
@font-face { font-family: "InterMediumItalic"; src: url("InterMediumItalic.ttf"); font-style: italic; }
"""
    styled = f'<style>{font_faces}{_CSS}</style>{html}'
    story = fitz.Story(html=styled, archive=arch) if arch else fitz.Story(html=styled)
    writer = fitz.DocumentWriter(output_path)
    rect = fitz.Rect(_ML, _MT, _MR, _MB)
    pno = 0
    while True:
        dev = writer.begin_page(fitz.paper_rect("a4"))
        more, _ = story.place(rect)
        story.draw(dev)
        writer.end_page()
        pno += 1
        if not more:
            break
    writer.close()
    return pno


# ── Main PDF creation ──

async def create_izlem_pdf(
    protocol_id: str,
    brief_text: str,
    izlem_data: dict,
    language: str = "en",
    output_dir: str | None = None,
) -> str:
    """Create a comprehensive daily monitoring PDF brief.

    Page 1: Last 24h dashboard — alerts, vitals chart + table, hekim/hemşire notes, labs, meds
    Page 2+: LLM clinical summary (properly rendered markdown)
    Episode pages: Last 3 episodes with all izlem categories
    Final: Past important events (falls, allergies, recurring issues)
    """
    now = datetime.now()
    ts = now.strftime("%Y%m%d_%H%M%S")
    out = Path(output_dir) if output_dir else DATA_DIR / f"izlem_{protocol_id}"
    out.mkdir(parents=True, exist_ok=True)
    pdf_path = out / f"izlem_brief_{protocol_id}_{ts}.pdf"

    is_tr = language == "tr"

    # Use the most recent data timestamp as reference instead of system clock.
    # This prevents the "last 24h" section from being empty when data is older.
    ref_time = _find_most_recent_timestamp(izlem_data) or now
    log.info(
        "Izlem PDF ref_time: %s (now=%s, delta=%s)",
        ref_time.isoformat(), now.isoformat(),
        str(now - ref_time) if ref_time else "N/A",
    )

    alerts = _detect_alerts(izlem_data, ref_time)
    vitals_24h = _extract_vitals_24h(izlem_data, ref_time)
    hekim_notes = _extract_notes_24h(izlem_data, ref_time, "hekim_izlem_notlari")
    hemsire_notes = _extract_notes_24h(izlem_data, ref_time, "hemsire_izlem_notlari")
    labs_24h = _extract_labs_24h(izlem_data, ref_time)
    meds = _extract_meds_recent(izlem_data)
    past_items = _extract_past_important(izlem_data)
    episodes = sorted(
        izlem_data.get("episodes", []),
        key=lambda e: e.get("episode_info", {}).get("date", "0"), reverse=True)

    # ── Build full HTML document ──
    html_sections: list[str] = []

    # Page 1 header — warm earth-tone branded header
    title = "Hasta İzlem Raporu" if is_tr else "Patient Monitoring Report"
    subtitle = "Günlük Klinik İzlem Özeti" if is_tr else "Daily Clinical Monitoring Summary"
    html_sections.append(f"""<div style="text-align:center;margin-bottom:6px">
<h1 style="margin-bottom:2px;font-size:22px;color:#2D2926">{_esc(title)}</h1>
<p style="font-family:InterMedium;font-size:11px;color:#C4704B;margin:0">
{_esc(subtitle)}</p>
</div>
<p style="font-size:9px;color:#9C9590;margin:4px 0;text-align:center">
Protokol No: {_esc(protocol_id)} &nbsp;|&nbsp;
Rapor Tarihi: {now.strftime('%d.%m.%Y %H:%M')}</p>
<div class="sep-heavy"></div>""")

    # ── SON 24 SAAT section — explicit banner ──
    html_sections.append(
        '<div class="section-banner-accent">'
        f'{"SON 24 SAAT — KLİNİK ÖZET" if is_tr else "LAST 24 HOURS — CLINICAL SUMMARY"}'
        '</div>'
    )

    # Alerts (24h) — most critical first
    alerts_html = _build_alerts_html(alerts, recent_only=True)
    if alerts_html:
        html_sections.append(alerts_html)
    else:
        html_sections.append(
            '<div class="highlight-green"><b>'
            f'{"Son 24 saatte kritik uyari saptanmadi." if is_tr else "No critical alerts in last 24 hours."}'
            '</b></div>'
        )

    # Reserve space for vitals chart (will be drawn directly later)
    if vitals_24h and len(vitals_24h) >= 2:
        chart_label = "Vital Bulgular Trendi" if is_tr else "Vital Signs Trend"
        html_sections.append(f'<h3>{_esc(chart_label)}</h3>')
        html_sections.append('<div style="height:90px"></div>')

    # Vitals table
    html_sections.append(_build_vitals_table_html(
        vitals_24h[:10], "Son 24s Vital Degerler" if is_tr else "Last 24h Vitals"))

    # Doctor notes — with specific styling
    html_sections.append(_build_notes_html(
        hekim_notes, "Hekim Izlem Notlari (Son 24s)" if is_tr else "Doctor Notes (24h)", is_hekim=True))

    # Nurse notes — with specific styling
    html_sections.append(_build_notes_html(
        hemsire_notes, "Hemsire Notlari (Son 24s)" if is_tr else "Nurse Notes (24h)", is_hekim=False))

    # Labs
    html_sections.append(_build_labs_html(
        labs_24h, "Laboratuvar (Son 24s)" if is_tr else "Lab Results (24h)"))

    # Separator before general sections
    html_sections.append('<div class="sep-heavy"></div>')

    # Meds with section banner
    html_sections.append(
        '<div class="section-banner">'
        f'{"GÜNCEL İLAÇ TEDAVİSİ" if is_tr else "CURRENT MEDICATIONS"}'
        '</div>'
    )
    html_sections.append(_build_meds_html(
        meds, "Ilac Listesi" if is_tr else "Medication List"))

    # LLM Brief (page break)
    if brief_text:
        summary_title = "Klinik İzlem Özeti" if is_tr else "Clinical Monitoring Summary"
        html_sections.append(f'<div class="page-break"></div><h2>{_esc(summary_title)}</h2>')
        html_sections.append(_md_to_html(brief_text))

    # Episodes (each on new page)
    for idx, ep in enumerate(episodes[:3]):
        html_sections.append(_build_episode_html(ep, idx, language))

    # Past important events
    if past_items or [a for a in alerts if not a.get("recent")]:
        title_past = "Dikkat Gerektiren Geçmiş Olaylar" if is_tr else "Important Past Events"
        final_parts = [f'<div class="page-break"></div><h2>{_esc(title_past)}</h2>']
        if past_items:
            final_parts.append("<ul>")
            for item in past_items:
                final_parts.append(f"<li>{_esc(item)}</li>")
            final_parts.append("</ul>")
        old_alerts = [a for a in alerts if not a.get("recent")]
        if old_alerts:
            final_parts.append(_build_alerts_html(old_alerts))
        html_sections.append("\n".join(final_parts))

    # ── Render to PDF using Story API ──
    full_html = "\n".join(s for s in html_sections if s)
    tmp_pdf = tempfile.mktemp(suffix=".pdf")
    try:
        _render_story_to_doc(full_html, tmp_pdf)

        # Open the rendered PDF and add overlays
        doc = fitz.open(tmp_pdf)

        # Remove trailing near-empty pages (Story API sometimes creates blank overflow pages)
        while len(doc) > 1:
            last_page = doc[-1]
            text = last_page.get_text().strip()
            # If last page has very little text, it's likely an artifact
            if len(text) < 30:
                doc.delete_page(-1)
                log.info("Removed empty trailing page (had %d chars)", len(text))
            else:
                break

        # Draw vitals chart on page 1 if we have data
        if vitals_24h and len(vitals_24h) >= 2 and len(doc) > 0:
            # Find where the chart placeholder is (after alerts, before vitals table)
            # Estimate position based on alert count
            alert_count = len([a for a in alerts if a.get("recent")])
            chart_y = _MT + 50 + alert_count * 22 + 16  # title + alerts + heading
            _draw_vitals_chart(doc[0], vitals_24h, chart_y)

        # Add footers with Inter font
        inter_footer_path = _FONTS_DIR / "Inter-Regular.ttf"
        footer_font = (fitz.Font(fontfile=str(inter_footer_path))
                       if inter_footer_path.exists() else fitz.Font("helv"))
        for i in range(len(doc)):
            page = doc[i]
            # Header accent line
            page.draw_line(
                fitz.Point(_ML, _MT - 8), fitz.Point(_MR, _MT - 8),
                color=(0.77, 0.44, 0.29), width=1.2,
            )
            # Footer line
            page.draw_line(
                fitz.Point(_ML, _PH - 28), fitz.Point(_MR, _PH - 28),
                color=(0.87, 0.84, 0.79), width=0.6,
            )
            # Footer text
            tw = fitz.TextWriter(page.rect)
            footer_left = f"CerebraLink Izlem Raporu — Protokol {protocol_id}"
            footer_right = f"Sayfa {i + 1}/{len(doc)} — {now.strftime('%d.%m.%Y %H:%M')}"
            tw.append(fitz.Point(_ML, _PH - 18), footer_left, font=footer_font, fontsize=7)
            tw.append(fitz.Point(_MR - 130, _PH - 18), footer_right, font=footer_font, fontsize=7)
            tw.write_text(page, color=(0.5, 0.5, 0.5))

        doc.save(str(pdf_path))
        page_count = len(doc)
        doc.close()
    finally:
        try:
            os.unlink(tmp_pdf)
        except OSError:
            pass

    log.info("Created izlem PDF: %s (%d pages)", pdf_path, page_count)
    return str(pdf_path)


def _detect_section_type(heading: str) -> str | None:
    """Detect clinical section type from heading text for icon/styling.

    Handles both proper Turkish (ş, ı, ö, ü, ç, ğ) and ASCII equivalents
    (s, i, o, u, c, g) since LLM output may use either.
    """
    h = heading.lower()
    if any(k in h for k in ["uyarı", "uyari", "alert", "kritik", "critical", "acil"]):
        return "alert"
    if any(k in h for k in ["vital", "nabız", "nabiz", "tansiyon", "spo2", "ateş", "ates"]):
        return "vitals"
    if any(k in h for k in ["ilaç", "ilac", "medik", "medicat", "tedavi", "prescrip", "reçete", "recete"]):
        return "meds"
    if any(k in h for k in ["lab", "laboratuvar", "hemogram", "biyokimya"]):
        return "labs"
    if any(k in h for k in ["hekim", "doktor", "doctor", "muayene", "değerlendirme", "degerlendirme", "assessment"]):
        return "doctor"
    if any(k in h for k in ["hemşire", "hemsire", "nurse", "bakım", "bakim"]):
        return "nurse"
    if any(k in h for k in ["özet", "ozet", "summary", "24 saat", "24h", "son 24", "izlem"]):
        return "summary"
    if any(k in h for k in ["geçmiş", "gecmis", "past", "history", "önceki", "onceki", "kronoloji"]):
        return "history"
    if any(k in h for k in ["enfeksiyon", "infection", "izolasyon"]):
        return "infection"
    if any(k in h for k in ["epizod", "episode"]):
        return "episode"
    if any(k in h for k in ["konsültasyon", "konsultasyon", "öneri", "oneri", "consultation", "recommend"]):
        return "summary"
    if any(k in h for k in ["kronik", "chronic", "tanı", "tani", "diagnosis"]):
        return "history"
    if any(k in h for k in ["ziyaret", "visit", "kaynak", "referans", "reference"]):
        return "history"
    if any(k in h for k in ["parametre", "parameter", "monitoring", "monitör", "monitor"]):
        return "labs"
    return None


def _section_icon(section_type: str | None) -> str:
    """Return an HTML icon prefix for a clinical section."""
    icons = {
        "alert": '<span style="color:#dc2626;font-size:11px">&#9888;</span> ',
        "vitals": '<span style="color:#2A6F6F;font-size:10px">&#9829;</span> ',
        "meds": '<span style="color:#059669;font-size:10px">&#9736;</span> ',
        "labs": '<span style="color:#7c3aed;font-size:10px">&#9878;</span> ',
        "doctor": '<span style="color:#2A6F6F;font-size:10px">&#9737;</span> ',
        "nurse": '<span style="color:#0891b2;font-size:10px">&#9737;</span> ',
        "summary": '<span style="color:#1e1b4b;font-size:10px">&#9670;</span> ',
        "history": '<span style="color:#6b7280;font-size:10px">&#9201;</span> ',
        "infection": '<span style="color:#dc2626;font-size:10px">&#9763;</span> ',
        "episode": '<span style="color:#C4704B;font-size:10px">&#9679;</span> ',
    }
    return icons.get(section_type, "")


def _enhance_answer_html(md_text: str, language: str) -> str:
    """Convert LLM answer markdown to enhanced HTML with section detection and styling.

    Detects clinical sections, applies appropriate alert/note styles,
    and structures the content professionally.
    """
    base_html = _md_to_html(md_text)
    lines = base_html.split("\n")
    enhanced: list[str] = []
    in_alert_section = False

    for line in lines:
        # Detect h2/h3 headings and add section icons + styling
        h2_match = re.match(r'<h2>(.*?)</h2>', line)
        h3_match = re.match(r'<h3>(.*?)</h3>', line)

        if h2_match:
            heading_text = h2_match.group(1)
            plain = re.sub(r'<[^>]+>', '', heading_text)
            sec_type = _detect_section_type(plain)
            icon = _section_icon(sec_type)
            in_alert_section = sec_type == "alert"
            if sec_type == "episode":
                enhanced.append('<div class="page-break"></div>')
            # Use section-banner for major sections
            if sec_type == "alert":
                enhanced.append(f'<div class="section-banner-alert">{icon}{heading_text}</div>')
            elif sec_type in ("summary", "meds"):
                enhanced.append(f'<div class="section-banner-accent">{icon}{heading_text}</div>')
            elif sec_type in ("vitals", "labs", "doctor", "nurse", "episode"):
                enhanced.append(f'<div class="section-banner">{icon}{heading_text}</div>')
            else:
                enhanced.append(f'<h2>{icon}{heading_text}</h2>')
            continue

        if h3_match:
            heading_text = h3_match.group(1)
            plain = re.sub(r'<[^>]+>', '', heading_text)
            sec_type = _detect_section_type(plain)
            icon = _section_icon(sec_type)
            in_alert_section = sec_type == "alert"
            enhanced.append(f'<h3>{icon}{heading_text}</h3>')
            continue

        # Style list items in alert sections OR items containing alert markers
        is_alert_item = in_alert_section and line.startswith("<li>")
        is_inline_alert = line.startswith("<li>") and any(
            k in line.lower() for k in ["alert:", "alert :", "uyari:", "uyarı:"]
        )
        if is_alert_item or is_inline_alert:
            content = line.replace("<li>", "").replace("</li>", "")
            is_critical = any(k in content.lower() for k in [
                "kritik", "critical", "acil", "dusuk spo2", "tasikardi", "bradikardi",
                "hr>120", "hr<50", "spo2<92", "kontrendike", "alert", "kesilmeli",
                "kacinilmali", "hipotansiyon", "coombs",
            ])
            cls = "alert-critical" if is_critical else "alert-warning"
            enhanced.append(f'<div class="{cls}">{content}</div>')
            continue

        # Highlight important standalone paragraphs
        if line.startswith("<p>") and any(k in line.lower() for k in [
            "onemli", "dikkat", "important", "critical", "kontrendike", "kontrol",
        ]):
            enhanced.append(line.replace('<p>', '<p><b>').replace('</p>', '</b></p>'))
            continue

        enhanced.append(line)

    return "\n".join(enhanced)


async def create_izlem_pdf_from_answer(
    protocol_id: str,
    answer_text: str,
    language: str = "en",
    output_dir: str | None = None,
) -> str:
    """Create a PDF from LLM izlem answer text (fallback when raw data unavailable).

    Renders markdown as styled HTML with full Turkish character support,
    section detection, clinical alert styling, and professional formatting.
    """
    now = datetime.now()
    ts = now.strftime("%Y%m%d_%H%M%S")
    out = Path(output_dir) if output_dir else DATA_DIR / f"izlem_{protocol_id}"
    out.mkdir(parents=True, exist_ok=True)
    pdf_path = out / f"izlem_brief_{protocol_id}_{ts}.pdf"

    is_tr = language == "tr"
    title = "Hasta İzlem Raporu" if is_tr else "Patient Monitoring Report"
    subtitle = "Günlük Klinik İzlem Özeti" if is_tr else "Daily Clinical Monitoring Summary"
    note = ("Bu rapor, mevcut hasta verileri ve klinik geçmişten otomatik olarak oluşturulmuştur."
            if is_tr else "This report was automatically generated from available patient data and clinical history.")

    # Enhanced HTML with header block, section detection, and styling
    body_html = _enhance_answer_html(answer_text, language)

    html = f"""<div style="text-align:center;margin-bottom:8px">
<h1 style="margin-bottom:2px;font-size:22px">{_esc(title)}</h1>
<p style="font-family:InterMedium;font-size:12px;color:#C4704B;margin:0">{_esc(subtitle)}</p>
</div>
<p style="font-size:9px;color:#374151;margin:4px 0;text-align:center">
<b>Protokol No:</b> {_esc(protocol_id)} &nbsp; | &nbsp;
<b>Rapor Tarihi:</b> {now.strftime('%d.%m.%Y %H:%M')}</p>
<div class="sep-heavy"></div>
<p class="small muted" style="text-align:center">{_esc(note)}</p>
<div class="sep"></div>
{body_html}
<div class="sep-heavy"></div>
<p class="small muted" style="text-align:center;margin-top:14px">
{'Bu rapor CerebraLink klinik karar destek sistemi tarafindan olusturulmustur. Klinik kararlar icin hekim degerlendirmesi gereklidir.'
 if is_tr else
 'This report was generated by the CerebraLink clinical decision support system. Clinical decisions require physician evaluation.'}
</p>"""

    tmp_pdf = tempfile.mktemp(suffix=".pdf")
    try:
        _render_story_to_doc(html, tmp_pdf)
        doc = fitz.open(tmp_pdf)

        # Add header line and footers to every page with Inter font
        inter_footer_path = _FONTS_DIR / "Inter-Regular.ttf"
        footer_font = (fitz.Font(fontfile=str(inter_footer_path))
                       if inter_footer_path.exists() else fitz.Font("helv"))
        for i in range(len(doc)):
            page = doc[i]
            # Header accent line
            page.draw_line(
                fitz.Point(_ML, _MT - 8), fitz.Point(_MR, _MT - 8),
                color=(0.77, 0.44, 0.29), width=1.2,
            )
            # Footer line
            page.draw_line(
                fitz.Point(_ML, _PH - 28), fitz.Point(_MR, _PH - 28),
                color=(0.87, 0.84, 0.79), width=0.6,
            )
            # Footer text
            tw = fitz.TextWriter(page.rect)
            footer_left = f"CerebraLink Izlem Raporu — Protokol {protocol_id}"
            footer_right = f"Sayfa {i + 1}/{len(doc)} — {now.strftime('%d.%m.%Y %H:%M')}"
            tw.append(fitz.Point(_ML, _PH - 18), footer_left, font=footer_font, fontsize=7)
            tw.append(fitz.Point(_MR - 130, _PH - 18), footer_right, font=footer_font, fontsize=7)
            tw.write_text(page, color=(0.5, 0.5, 0.5))

        doc.save(str(pdf_path))
        page_count = len(doc)
        doc.close()
    finally:
        try:
            os.unlink(tmp_pdf)
        except OSError:
            pass

    log.info("Created izlem PDF from answer: %s (%d pages)", pdf_path, page_count)
    return str(pdf_path)
