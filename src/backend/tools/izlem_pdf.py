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

# CSS for HTML rendering -- professional medical report style
# Inter is installed in Docker image; DejaVu Sans as fallback; TurkFont from pymupdf built-in
_CSS = """
body { font-family: "Inter", "DejaVu Sans", "TurkFont", sans-serif;
       font-size: 9px; color: #1a1a1a; line-height: 1.5; }
h1 { font-size: 18px; color: #1e1b4b; margin: 12px 0 6px 0; font-weight: 800;
     letter-spacing: -0.02em; }
h2 { font-size: 14px; color: #1e3a5f; margin: 10px 0 4px 0; font-weight: 700;
     border-bottom: 2px solid #a5b4fc; padding-bottom: 3px; letter-spacing: -0.01em; }
h3 { font-size: 11px; color: #2563eb; margin: 8px 0 3px 0; font-weight: 700; }
h4 { font-size: 10px; color: #374151; margin: 5px 0 2px 0; font-weight: 600;
     font-style: italic; }
p { margin: 3px 0; }
ul, ol { margin: 3px 0; padding-left: 18px; }
li { margin: 1px 0; }
b, strong { font-weight: 700; }
i, em { font-style: italic; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; }
th { background: #dbeafe; color: #1e3a5f; font-weight: 700; font-size: 8px;
     padding: 4px 6px; text-align: left; border: 1px solid #93c5fd; }
td { padding: 3px 6px; font-size: 8px; border: 1px solid #e5e7eb; }
tr:nth-child(even) td { background: #f8fafc; }
.alert-critical { background: #fef2f2; border-left: 4px solid #dc2626; padding: 5px 10px;
                   margin: 4px 0; color: #991b1b; font-weight: 700; font-size: 9px;
                   border-radius: 0 4px 4px 0; }
.alert-warning { background: #fffbeb; border-left: 4px solid #d97706; padding: 5px 10px;
                 margin: 4px 0; color: #92400e; font-weight: 600; font-size: 9px;
                 border-radius: 0 4px 4px 0; }
.note-block { background: #f8fafc; border-left: 3px solid #6366f1; padding: 4px 10px;
              margin: 3px 0; font-size: 8px; border-radius: 0 4px 4px 0; }
.muted { color: #6b7280; font-size: 8px; font-style: italic; }
.small { font-size: 7px; }
.sep { border-top: 2px solid #e0e7ff; margin: 8px 0; }
.page-break { break-before: page; }
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
        parts.append("<h3>⚠ Kritik Uyarılar</h3>")
        for a in crits[:8]:
            parts.append(f'<div class="alert-critical">[{_esc(a["cat"])}] {_esc(a["msg"])}</div>')
    if warns:
        parts.append("<h3>⚡ Uyarılar</h3>")
        for a in warns[:6]:
            parts.append(f'<div class="alert-warning">[{_esc(a["cat"])}] {_esc(a["msg"])}</div>')
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
    parts = [f"<h3>{_esc(title)}</h3>"]
    for note in notes[:10]:
        date_str = _get(note, "col_0", "Tarih")
        author = _get(note, "col_1", "Hekim" if is_hekim else "Hemşire")
        text = _get(note, "col_2", "Not", "col_3")
        header = f"<b>{_esc(date_str)}</b>"
        if author:
            header += f" — {_esc(author)}"
        parts.append(f'<div class="note-block">{header}<br/>{_esc(text[:500])}</div>')
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


def _md_to_html(md_text: str) -> str:
    """Convert markdown text to HTML for PDF rendering."""
    lines = md_text.split("\n")
    html_parts: list[str] = []
    in_list = False

    for line in lines:
        s = line.strip()
        if not s:
            if in_list:
                html_parts.append("</ul>"); in_list = False
            continue

        if s.startswith("#### "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h4>{_esc(s[5:])}</h4>")
        elif s.startswith("### "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h3>{_esc(s[4:])}</h3>")
        elif s.startswith("## "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h2>{_esc(s[3:])}</h2>")
        elif s.startswith("# "):
            if in_list: html_parts.append("</ul>"); in_list = False
            html_parts.append(f"<h1>{_esc(s[2:])}</h1>")
        elif s.startswith(("- ", "* ", "• ")):
            if not in_list: html_parts.append("<ul>"); in_list = True
            content = _esc(s[2:])
            content = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', content)
            html_parts.append(f"<li>{content}</li>")
        elif re.match(r'^\d+\.\s', s):
            if not in_list: html_parts.append("<ul>"); in_list = True
            content = _esc(re.sub(r'^\d+\.\s*', '', s))
            content = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', content)
            html_parts.append(f"<li>{content}</li>")
        else:
            if in_list: html_parts.append("</ul>"); in_list = False
            escaped = _esc(s)
            escaped = re.sub(r'\*\*\*([^*]+)\*\*\*', r'<b><i>\1</i></b>', escaped)
            escaped = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', escaped)
            escaped = re.sub(r'\*([^*]+)\*', r'<i>\1</i>', escaped)
            escaped = re.sub(r'\[\d+\]', '', escaped)
            escaped = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', escaped)
            html_parts.append(f"<p>{escaped}</p>")

    if in_list:
        html_parts.append("</ul>")
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
    """Create an archive with built-in helv font for Turkish character fallback."""
    try:
        tmpdir = tempfile.mkdtemp(prefix="izlem_fonts_")
        font = fitz.Font("helv")
        font_path = os.path.join(tmpdir, "helv.ttf")
        with open(font_path, "wb") as f:
            f.write(font.buffer)
        return fitz.Archive(tmpdir)
    except Exception:
        return None


def _render_story_to_doc(html: str, output_path: str) -> int:
    """Render styled HTML to a PDF file using Story API. Returns page count."""
    arch = _make_font_archive()
    font_face = '@font-face { font-family: "TurkFont"; src: url("helv.ttf"); }\n'
    styled = f'<style>{font_face}{_CSS}</style>{html}'
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
    alerts = _detect_alerts(izlem_data, now)
    vitals_24h = _extract_vitals_24h(izlem_data, now)
    hekim_notes = _extract_notes_24h(izlem_data, now, "hekim_izlem_notlari")
    hemsire_notes = _extract_notes_24h(izlem_data, now, "hemsire_izlem_notlari")
    labs_24h = _extract_labs_24h(izlem_data, now)
    meds = _extract_meds_recent(izlem_data)
    past_items = _extract_past_important(izlem_data)
    episodes = sorted(
        izlem_data.get("episodes", []),
        key=lambda e: e.get("episode_info", {}).get("date", "0"), reverse=True)

    # ── Build full HTML document ──
    html_sections: list[str] = []

    # Page 1 header
    title = "Hasta İzlem Raporu — Son 24 Saat" if is_tr else "Patient Monitoring Report — Last 24 Hours"
    html_sections.append(f"""<h1>{_esc(title)}</h1>
<p class="muted">Protokol: {_esc(protocol_id)} | Tarih: {now.strftime('%Y-%m-%d %H:%M')}</p>
<div class="sep"></div>""")

    # Alerts (24h)
    html_sections.append(_build_alerts_html(alerts, recent_only=True))

    # Reserve space for vitals chart (will be drawn directly later)
    if vitals_24h and len(vitals_24h) >= 2:
        chart_label = "Vital Bulgular Trendi" if is_tr else "Vital Signs Trend"
        # Insert placeholder text + extra spacing for chart area
        html_sections.append(f'<h3>{_esc(chart_label)}</h3>')
        html_sections.append('<div style="height:90px"></div>')

    # Vitals table
    html_sections.append(_build_vitals_table_html(
        vitals_24h[:10], "Son 24s Vital Değerler" if is_tr else "Last 24h Vitals"))

    # Notes
    html_sections.append(_build_notes_html(
        hekim_notes, "Hekim İzlem Notları (24s)" if is_tr else "Doctor Notes (24h)", is_hekim=True))
    html_sections.append(_build_notes_html(
        hemsire_notes, "Hemşire Notları (24s)" if is_tr else "Nurse Notes (24h)", is_hekim=False))

    # Labs
    html_sections.append(_build_labs_html(
        labs_24h, "Laboratuvar (24s)" if is_tr else "Lab Results (24h)"))

    # Meds
    html_sections.append(_build_meds_html(
        meds, "Güncel İlaçlar" if is_tr else "Current Medications"))

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

        # Draw vitals chart on page 1 if we have data
        if vitals_24h and len(vitals_24h) >= 2 and len(doc) > 0:
            # Find where the chart placeholder is (after alerts, before vitals table)
            # Estimate position based on alert count
            alert_count = len([a for a in alerts if a.get("recent")])
            chart_y = _MT + 50 + alert_count * 22 + 16  # title + alerts + heading
            _draw_vitals_chart(doc[0], vitals_24h, chart_y)

        # Add footers
        footer_font = fitz.Font("helv")
        for i in range(len(doc)):
            tw = fitz.TextWriter(doc[i].rect)
            footer = (f"CerebraLink İzlem Raporu — Protokol {protocol_id} — "
                      f"Sayfa {i + 1}/{len(doc)} — {now.strftime('%Y-%m-%d %H:%M')}")
            tw.append(fitz.Point(_ML, _PH - 20), footer, font=footer_font, fontsize=7)
            tw.write_text(doc[i], color=(0.5, 0.5, 0.5))

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


async def create_izlem_pdf_from_answer(
    protocol_id: str,
    answer_text: str,
    language: str = "en",
    output_dir: str | None = None,
) -> str:
    """Create a PDF from LLM izlem answer text (fallback when raw data unavailable).

    Renders markdown as styled HTML with full Turkish character support.
    """
    now = datetime.now()
    ts = now.strftime("%Y%m%d_%H%M%S")
    out = Path(output_dir) if output_dir else DATA_DIR / f"izlem_{protocol_id}"
    out.mkdir(parents=True, exist_ok=True)
    pdf_path = out / f"izlem_brief_{protocol_id}_{ts}.pdf"

    is_tr = language == "tr"
    title = "Hasta İzlem Özeti" if is_tr else "Patient Monitoring Brief"
    note = ("Not: Bu özet, mevcut hasta verileri ve klinik geçmişten oluşturulmuştur."
            if is_tr else "Note: Generated from available patient data and clinical history.")

    html = f"""<h1>{_esc(title)}</h1>
<p class="muted">Protokol: {_esc(protocol_id)} | Tarih: {now.strftime('%Y-%m-%d %H:%M')}</p>
<p class="small muted">{_esc(note)}</p>
<div class="sep"></div>
{_md_to_html(answer_text)}"""

    tmp_pdf = tempfile.mktemp(suffix=".pdf")
    try:
        _render_story_to_doc(html, tmp_pdf)
        doc = fitz.open(tmp_pdf)

        # Add footers
        footer_font = fitz.Font("helv")
        for i in range(len(doc)):
            tw = fitz.TextWriter(doc[i].rect)
            footer = (f"CerebraLink İzlem Raporu — Protokol {protocol_id} — "
                      f"Sayfa {i + 1}/{len(doc)} — {now.strftime('%Y-%m-%d %H:%M')}")
            tw.append(fitz.Point(_ML, _PH - 20), footer, font=footer_font, fontsize=7)
            tw.write_text(doc[i], color=(0.5, 0.5, 0.5))

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
