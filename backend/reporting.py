import json
import math
import re
from datetime import date, datetime, timedelta
from io import BytesIO
from typing import Any
from zoneinfo import ZoneInfo

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

_TUNIS_TZ = ZoneInfo("Africa/Tunis")
_TZ_SUFFIX_RE = re.compile(r"(?:Z|[+-]\d{2}:\d{2})$")

_MODE_META = {
    "barcode": {"label": "Code-barres", "color": "#0d9488"},
    "date": {"label": "Date", "color": "#2563eb"},
    "anomaly": {"label": "Anomalie", "color": "#dc2626"},
}
_MODE_ORDER = ("barcode", "date", "anomaly")

_ANOMALY_META = [
    ("nok_no_barcode", "Sans code-barres", "#84cc16"),
    ("nok_no_date", "Date non visible", "#06b6d4"),
    ("nok_anomaly", "Anomalie détectée", "#f97316"),
]


def _parse_iso_date(raw: str) -> date:
    return date.fromisoformat((raw or "").strip())


def _parse_backend_timestamp(raw: str | None) -> datetime | None:
    if not raw:
        return None
    normalized = raw
    if normalized.startswith("interrupted:"):
        normalized = normalized[len("interrupted:"):]
    elif normalized.startswith("preempted:"):
        normalized = normalized[len("preempted:"):]
    try:
        dt = datetime.fromisoformat(
            normalized if _TZ_SUFFIX_RE.search(normalized) else f"{normalized}+01:00"
        )
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_TUNIS_TZ)
    return dt.astimezone(_TUNIS_TZ)


def _coerce_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _safe_round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def _pct(numerator: int | float, denominator: int | float) -> float:
    if not denominator:
        return 0.0
    return _safe_round((float(numerator) / float(denominator)) * 100.0, 2)


def _format_french_date(day: date, with_weekday: bool = True) -> str:
    weekdays = [
        "lundi",
        "mardi",
        "mercredi",
        "jeudi",
        "vendredi",
        "samedi",
        "dimanche",
    ]
    months = [
        "janvier",
        "fevrier",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "aout",
        "septembre",
        "octobre",
        "novembre",
        "decembre",
    ]
    prefix = f"{weekdays[day.weekday()]} " if with_weekday else ""
    return f"{prefix}{day.day:02d} {months[day.month - 1]} {day.year}"


def _format_short_date(day: date) -> str:
    return f"{day.day:02d}/{day.month:02d}/{day.year}"


def _format_time(value: datetime | None) -> str:
    if value is None:
        return "—"
    return value.strftime("%H:%M")


def _format_duration(minutes: int) -> str:
    if minutes <= 0:
        return "0 min"
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f"{hours}h {mins:02d}m"
    if hours:
        return f"{hours}h"
    return f"{mins} min"


def _format_hours(minutes: int) -> str:
    return f"{minutes / 60.0:.2f} h"


def _normalize_enabled_checks(session: dict[str, Any]) -> dict[str, bool]:
    raw = session.get("enabled_checks")
    parsed: Any = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = None
    if isinstance(parsed, dict):
        return {
            "barcode": bool(parsed.get("barcode", False)),
            "date": bool(parsed.get("date", False)),
            "anomaly": bool(parsed.get("anomaly", False)),
        }

    checkpoint_ids = session.get("checkpoint_ids") or []
    if not checkpoint_ids and session.get("checkpoint_id"):
        checkpoint_ids = [session.get("checkpoint_id")]
    checkpoint_ids = [str(cp or "") for cp in checkpoint_ids]
    return {
        "barcode": any("barcode" in cp or "tracking" in cp for cp in checkpoint_ids),
        "date": any("barcode" in cp or "tracking" in cp for cp in checkpoint_ids),
        "anomaly": any("anomaly" in cp for cp in checkpoint_ids),
    }


def _normalize_check_payload(raw: Any, fallback: dict[str, bool]) -> dict[str, bool]:
    parsed = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = None
    if not isinstance(parsed, dict):
        parsed = {}
    return {
        "barcode": bool(parsed["barcode"]) if "barcode" in parsed else fallback["barcode"],
        "date": bool(parsed["date"]) if "date" in parsed else fallback["date"],
        "anomaly": bool(parsed["anomaly"]) if "anomaly" in parsed else fallback["anomaly"],
    }


def _session_mode_seconds(db_writer, session: dict[str, Any], started_dt: datetime, ended_dt: datetime) -> tuple[dict[str, bool], dict[str, float]]:
    fallback = _normalize_enabled_checks(session)
    changes = []
    group_id = session.get("id") or session.get("group_id")
    if group_id and hasattr(db_writer, "get_check_changes_for_group"):
        try:
            changes = db_writer.get_check_changes_for_group(group_id) or []
        except Exception:
            changes = []

    changes = sorted(changes, key=lambda row: row.get("changed_at") or "")
    initial_checks = (
        _normalize_check_payload(changes[0].get("old_checks"), fallback)
        if changes
        else fallback
    )

    points: list[tuple[datetime, dict[str, bool]]] = [(started_dt, initial_checks)]
    last_checks = initial_checks
    for change in changes:
        changed_dt = _parse_backend_timestamp(change.get("changed_at"))
        if changed_dt is None or changed_dt < started_dt or changed_dt > ended_dt:
            continue
        last_checks = _normalize_check_payload(change.get("new_checks"), last_checks)
        points.append((changed_dt, last_checks))

    points.sort(key=lambda item: item[0])
    points.append((ended_dt, points[-1][1]))

    active_seconds = {key: 0.0 for key in _MODE_ORDER}
    for index in range(len(points) - 1):
        current_dt, checks = points[index]
        next_dt = points[index + 1][0]
        seg_seconds = max(0.0, (next_dt - current_dt).total_seconds())
        for mode_key in _MODE_ORDER:
            if checks.get(mode_key):
                active_seconds[mode_key] += seg_seconds

    active_checks = {key: active_seconds[key] > 0 for key in _MODE_ORDER}
    return active_checks, active_seconds


def _mode_abbrev(checks: dict[str, bool]) -> str:
    """Return compact abbreviation string: CAB / D / A."""
    parts = []
    if checks.get("barcode"):
        parts.append("CAB")
    if checks.get("date"):
        parts.append("D")
    if checks.get("anomaly"):
        parts.append("A")
    return ", ".join(parts) if parts else "—"


def _mode_labels(checks: dict[str, bool]) -> list[str]:
    return [_MODE_META[key]["label"] for key in _MODE_ORDER if checks.get(key)]


def _daily_modes_abbrev(modes_active: list[str]) -> str:
    """Convert full mode labels list to abbreviations."""
    mapping = {"Code-barres": "CAB", "Date": "D", "Anomalie": "A"}
    parts = [mapping.get(m, m) for m in modes_active]
    return ", ".join(parts) if parts else "—"


def _iter_period_days(start_day: date, end_day: date):
    current = start_day
    while current <= end_day:
        yield current
        current += timedelta(days=1)


def _chunk_rows(rows: list[list[str]], chunk_size: int):
    for index in range(0, len(rows), chunk_size):
        yield rows[index:index + chunk_size]


def build_report_summary(db_writer, start_date: str, end_date: str) -> dict[str, Any]:
    start_day = _parse_iso_date(start_date)
    end_day = _parse_iso_date(end_date)
    if end_day < start_day:
        raise ValueError("La date de fin doit etre apres la date de debut.")

    start_ts = f"{start_day.isoformat()}T00:00:00"
    end_ts = f"{end_day.isoformat()}T23:59:59"
    grouped_sessions = db_writer.list_grouped_sessions_between(start_ts, end_ts) or []

    total_days = (end_day - start_day).days + 1
    now_tn = datetime.now(_TUNIS_TZ)

    daily_map: dict[str, dict[str, Any]] = {}
    for day in _iter_period_days(start_day, end_day):
        daily_map[day.isoformat()] = {
            "date": day.isoformat(),
            "date_label": _format_french_date(day),
            "session_count": 0,
            "total_packets": 0,
            "ok_count": 0,
            "total_anomalies": 0,
            "duration_minutes": 0,
            "nok_no_barcode": 0,
            "nok_no_date": 0,
            "nok_anomaly": 0,
            "modes_active": set(),
        }

    totals = {
        "session_count": 0,
        "total_packets": 0,
        "ok_count": 0,
        "total_anomalies": 0,
        "duration_minutes": 0,
        "nok_no_barcode": 0,
        "nok_no_date": 0,
        "nok_anomaly": 0,
    }
    mode_session_counts = {key: 0 for key in _MODE_ORDER}
    mode_duration_minutes = {key: 0 for key in _MODE_ORDER}
    combo_counts: dict[str, int] = {}
    active_modes_seen: set[str] = set()
    session_rows: list[dict[str, Any]] = []

    sorted_sessions = sorted(
        grouped_sessions,
        key=lambda row: row.get("started_at") or "",
    )

    for session in sorted_sessions:
        started_dt = _parse_backend_timestamp(session.get("started_at"))
        if started_dt is None:
            continue
        ended_dt = _parse_backend_timestamp(session.get("ended_at")) or now_tn
        if ended_dt < started_dt:
            ended_dt = started_dt

        session_day_iso = started_dt.date().isoformat()
        if session_day_iso not in daily_map:
            continue

        checks, mode_active_seconds = _session_mode_seconds(db_writer, session, started_dt, ended_dt)
        mode_abbrev = _mode_abbrev(checks)
        mode_labels = _mode_labels(checks)
        duration_minutes = max(
            0,
            int(round((ended_dt - started_dt).total_seconds() / 60.0)),
        )
        total_packets = _coerce_int(session.get("total"))
        ok_count = _coerce_int(session.get("ok_count"))
        nobarcode = _coerce_int(session.get("nok_no_barcode"))
        nodate = _coerce_int(session.get("nok_no_date"))
        anomaly = _coerce_int(session.get("nok_anomaly"))
        total_anomalies = nobarcode + nodate + anomaly

        daily = daily_map[session_day_iso]
        daily["session_count"] += 1
        daily["total_packets"] += total_packets
        daily["ok_count"] += ok_count
        daily["total_anomalies"] += total_anomalies
        daily["duration_minutes"] += duration_minutes
        daily["nok_no_barcode"] += nobarcode
        daily["nok_no_date"] += nodate
        daily["nok_anomaly"] += anomaly
        daily["modes_active"].update(mode_labels)

        totals["session_count"] += 1
        totals["total_packets"] += total_packets
        totals["ok_count"] += ok_count
        totals["total_anomalies"] += total_anomalies
        totals["duration_minutes"] += duration_minutes
        totals["nok_no_barcode"] += nobarcode
        totals["nok_no_date"] += nodate
        totals["nok_anomaly"] += anomaly

        for mode_key in _MODE_ORDER:
            if checks.get(mode_key):
                active_modes_seen.add(mode_key)
                mode_session_counts[mode_key] += 1
                mode_duration_minutes[mode_key] += int(round(mode_active_seconds[mode_key] / 60.0))

        combo_counts[mode_abbrev] = combo_counts.get(mode_abbrev, 0) + 1
        session_rows.append({
            "id": session.get("id"),
            "date": session_day_iso,
            "date_label": _format_french_date(started_dt.date()),
            "start_time": _format_time(started_dt),
            "end_time": _format_time(ended_dt),
            "started_at": session.get("started_at"),
            "ended_at": session.get("ended_at"),
            "duration_minutes": duration_minutes,
            "duration_label": _format_duration(duration_minutes),
            "total_packets": total_packets,
            "ok_count": ok_count,
            "total_anomalies": total_anomalies,
            "nok_no_barcode": nobarcode,
            "nok_no_date": nodate,
            "nok_anomaly": anomaly,
            "conformity_rate_pct": _pct(ok_count, total_packets),
            "anomaly_rate_pct": _pct(total_anomalies, total_packets),
            "enabled_checks": checks,
            "mode_labels": mode_labels,
            "mode_abbrev": mode_abbrev,
            "end_reason": session.get("end_reason"),
        })

    daily_rows: list[dict[str, Any]] = []
    for day in _iter_period_days(start_day, end_day):
        daily = daily_map[day.isoformat()]
        daily_rows.append({
            "date": daily["date"],
            "date_label": daily["date_label"],
            "session_count": daily["session_count"],
            "total_packets": daily["total_packets"],
            "ok_count": daily["ok_count"],
            "total_anomalies": daily["total_anomalies"],
            "duration_minutes": daily["duration_minutes"],
            "worked_hours": _safe_round(daily["duration_minutes"] / 60.0),
            "worked_hours_label": _format_hours(daily["duration_minutes"]),
            "conformity_rate_pct": _pct(daily["ok_count"], daily["total_packets"]),
            "anomaly_rate_pct": _pct(daily["total_anomalies"], daily["total_packets"]),
            "nok_no_barcode": daily["nok_no_barcode"],
            "nok_no_date": daily["nok_no_date"],
            "nok_anomaly": daily["nok_anomaly"],
            "modes_active": sorted(daily["modes_active"]),
        })

    anomaly_rows = []
    for key, label, color in _ANOMALY_META:
        count = totals[key]
        anomaly_rows.append({
            "key": key,
            "label": label,
            "color": color,
            "count": count,
            "rate_pct": _pct(count, totals["total_packets"]),
            "share_pct": _pct(count, totals["total_anomalies"]),
        })

    active_mode_rows = []
    for mode_key in _MODE_ORDER:
        active_mode_rows.append({
            "key": mode_key,
            "label": _MODE_META[mode_key]["label"],
            "color": _MODE_META[mode_key]["color"],
            "session_count": mode_session_counts[mode_key],
            "session_share_pct": _pct(mode_session_counts[mode_key], totals["session_count"]),
            "duration_minutes": mode_duration_minutes[mode_key],
            "hours": _safe_round(mode_duration_minutes[mode_key] / 60.0),
            "hours_share_pct": _pct(mode_duration_minutes[mode_key], totals["duration_minutes"]),
            "active": mode_key in active_modes_seen,
        })

    combinations = [
        {"label": label, "count": count, "share_pct": _pct(count, totals["session_count"])}
        for label, count in combo_counts.items()
    ]
    combinations.sort(key=lambda row: (-row["count"], row["label"]))

    return {
        "start_date": start_day.isoformat(),
        "end_date": end_day.isoformat(),
        "period_label": (
            _format_french_date(start_day, with_weekday=False)
            if start_day == end_day
            else f"{_format_short_date(start_day)} au {_format_short_date(end_day)}"
        ),
        "report_kind": "daily" if start_day == end_day else "range",
        "generated_at": now_tn.isoformat(timespec="seconds"),
        "total_days": total_days,
        "session_count": totals["session_count"],
        "average_sessions_per_day": _safe_round(totals["session_count"] / total_days),
        "duration_minutes": totals["duration_minutes"],
        "total_hours": _safe_round(totals["duration_minutes"] / 60.0),
        "total_hours_label": _format_hours(totals["duration_minutes"]),
        "average_hours_per_day": _safe_round((totals["duration_minutes"] / 60.0) / total_days),
        "total_packets": totals["total_packets"],
        "total_conformes": totals["ok_count"],
        "total_anomalies": totals["total_anomalies"],
        "conformity_rate_pct": _pct(totals["ok_count"], totals["total_packets"]),
        "anomaly_rate_pct": _pct(totals["total_anomalies"], totals["total_packets"]),
        "active_modes": active_mode_rows,
        "active_mode_labels": [_MODE_META[key]["label"] for key in _MODE_ORDER if key in active_modes_seen],
        "mode_combinations": combinations,
        "anomalies_by_type": anomaly_rows,
        "days": daily_rows,
        "sessions": session_rows,
    }


# ── Abbreviation legend shown at the bottom of tables ──
_ABBREV_LEGEND = "CAB = Code-barres  |  D = Date  |  A = Anomalie"


def _render_table_pages(
    pdf: PdfPages,
    title: str,
    subtitle: str,
    headers: list[str],
    rows: list[list[str]],
    col_widths: list[float],
    chunk_size: int = 22,
    legend: str | None = None,
):
    if not rows:
        rows = [["—" for _ in headers]]

    total_pages = max(1, math.ceil(len(rows) / chunk_size))
    for page_index, page_rows in enumerate(_chunk_rows(rows, chunk_size), start=1):
        fig = plt.figure(figsize=(8.27, 11.69))
        fig.patch.set_facecolor("white")

        # Header
        fig.text(0.08, 0.955, title, fontsize=18, weight="bold", color="black")
        fig.text(0.08, 0.935, subtitle, fontsize=10, color="#333333")
        if total_pages > 1:
            fig.text(0.92, 0.955, f"{page_index}/{total_pages}", ha="right",
                     fontsize=9, color="#555555")

        # Table
        ax = fig.add_axes([0.04, 0.08, 0.92, 0.84])
        ax.axis("off")
        table = ax.table(
            cellText=page_rows,
            colLabels=headers,
            colWidths=col_widths,
            loc="upper left",
            cellLoc="center",
        )
        table.auto_set_font_size(False)
        table.set_fontsize(8.5)
        table.scale(1, 1.4)

        for (row_idx, col_idx), cell in table.get_celld().items():
            cell.set_edgecolor("#999999")
            cell.set_linewidth(0.5)
            if row_idx == 0:
                cell.set_facecolor("#222222")
                cell.set_text_props(weight="bold", color="white", fontsize=8.5)
            else:
                cell.set_facecolor("white" if row_idx % 2 else "#f5f5f5")
                cell.set_text_props(color="black", fontsize=8.5)

        # Legend at bottom
        if legend and page_index == total_pages:
            fig.text(0.08, 0.04, legend, fontsize=8, color="#555555", style="italic")

        pdf.savefig(fig)
        plt.close(fig)


def _render_summary_page(pdf: PdfPages, summary: dict[str, Any]):
    """First page: header + key metrics + production synthesis (text only, black)."""
    fig = plt.figure(figsize=(8.27, 11.69))
    fig.patch.set_facecolor("white")

    # ── Title block ──
    fig.text(0.08, 0.95, "Rapport GMCB", fontsize=26, weight="bold", color="black")
    subtitle = (
        f"Rapport journalier — {summary['period_label']}"
        if summary["report_kind"] == "daily"
        else f"Periode du {summary['period_label']}"
    )
    fig.text(0.08, 0.925, subtitle, fontsize=12, color="#333333")
    fig.text(0.08, 0.908, f"Genere le {summary['generated_at'][:16].replace('T', ' ')}",
             fontsize=9, color="#666666")

    # ── Separator ──
    from matplotlib.lines import Line2D
    line = Line2D([0.08, 0.92], [0.895, 0.895], transform=fig.transFigure,
                  color="black", linewidth=0.8)
    fig.add_artist(line)

    # ── Key metrics section ──
    y = 0.865
    fig.text(0.08, y, "Indicateurs cles", fontsize=16, weight="bold", color="black")
    y -= 0.035

    metrics = [
        ("Sessions", str(summary["session_count"])),
        ("Moyenne sessions / jour", f"{summary['average_sessions_per_day']:.2f}"),
        ("Heures travaillees", summary["total_hours_label"]),
        ("Moyenne heures / jour", f"{summary['average_hours_per_day']:.2f} h"),
        ("Taux de conformite", f"{summary['conformity_rate_pct']:.2f} %"),
        ("Taux d'anomalies", f"{summary['anomaly_rate_pct']:.2f} %"),
    ]
    for label, value in metrics:
        fig.text(0.10, y, f"{label} :", fontsize=11, color="black")
        fig.text(0.55, y, value, fontsize=11, weight="bold", color="black")
        y -= 0.028

    # ── Separator ──
    y -= 0.01
    line2 = Line2D([0.08, 0.92], [y, y], transform=fig.transFigure,
                   color="#cccccc", linewidth=0.5)
    fig.add_artist(line2)
    y -= 0.025

    # ── Synthese de production ──
    fig.text(0.08, y, "Synthese de production", fontsize=16, weight="bold", color="black")
    y -= 0.035

    prod_lines = [
        ("Paquets analyses", f"{summary['total_packets']:,}".replace(",", " ")),
        ("Paquets conformes", f"{summary['total_conformes']:,}".replace(",", " ")),
        ("Anomalies totales", f"{summary['total_anomalies']:,}".replace(",", " ")),
    ]
    for label, value in prod_lines:
        fig.text(0.10, y, f"{label} :", fontsize=11, color="black")
        fig.text(0.55, y, value, fontsize=11, weight="bold", color="black")
        y -= 0.028

    y -= 0.008
    fig.text(0.10, y, "Detail par type d'anomalie :", fontsize=11, color="black",
             weight="bold")
    y -= 0.028
    anomaly_details = [
        ("Sans code-barres (CAB)", summary.get("anomalies_by_type", [{}])[0].get("count", 0)
         if len(summary.get("anomalies_by_type", [])) > 0 else 0),
        ("Date non visible (D)", summary.get("anomalies_by_type", [{}])[1].get("count", 0)
         if len(summary.get("anomalies_by_type", [])) > 1 else 0),
        ("Anomalie detectee (A)", summary.get("anomalies_by_type", [{}])[2].get("count", 0)
         if len(summary.get("anomalies_by_type", [])) > 2 else 0),
    ]
    for label, count in anomaly_details:
        fig.text(0.12, y, f"• {label} :", fontsize=10.5, color="black")
        fig.text(0.55, y, str(count), fontsize=10.5, weight="bold", color="black")
        y -= 0.025

    # ── Separator ──
    y -= 0.01
    line3 = Line2D([0.08, 0.92], [y, y], transform=fig.transFigure,
                   color="#cccccc", linewidth=0.5)
    fig.add_artist(line3)
    y -= 0.025

    # ── Modes actifs ──
    fig.text(0.08, y, "Modes actifs", fontsize=16, weight="bold", color="black")
    y -= 0.035

    for mode in summary["active_modes"]:
        status = "Actif" if mode["active"] else "Inactif"
        fig.text(0.10, y, f"• {mode['label']} : {status}", fontsize=10.5, color="black")
        fig.text(0.45, y, f"{mode['session_count']} session(s)", fontsize=10.5, color="black")
        fig.text(0.65, y, f"{mode['hours']:.2f} h", fontsize=10.5, color="black")
        y -= 0.025

    # ── Footer legend ──
    fig.text(0.08, 0.04, _ABBREV_LEGEND, fontsize=8, color="#555555", style="italic")

    pdf.savefig(fig)
    plt.close(fig)


def generate_report_pdf(summary: dict[str, Any]) -> bytes:
    buffer = BytesIO()
    with PdfPages(buffer) as pdf:
        _render_summary_page(pdf, summary)

        if summary["report_kind"] == "daily":
            # ── Single day: session detail table ──
            session_rows = [
                [
                    row["start_time"],
                    row["end_time"],
                    row["duration_label"],
                    f"{row['total_packets']:,}".replace(",", " "),
                    str(row["ok_count"]),
                    str(row["nok_no_barcode"]),
                    str(row["nok_no_date"]),
                    str(row["nok_anomaly"]),
                    f"{row['conformity_rate_pct']:.1f}%",
                    row.get("mode_abbrev", "—"),
                ]
                for row in summary["sessions"]
            ]
            _render_table_pages(
                pdf,
                "Details des sessions",
                f"Sessions du {summary['period_label']}",
                ["Debut", "Fin", "Duree", "Paquets", "OK", "CAB", "D", "A", "Conf.", "Modes"],
                session_rows,
                [0.08, 0.08, 0.09, 0.10, 0.08, 0.08, 0.08, 0.08, 0.09, 0.10],
                chunk_size=24,
                legend=_ABBREV_LEGEND,
            )
        else:
            # ── Multi-day: daily summary table only ──
            daily_rows = [
                [
                    _format_short_date(_parse_iso_date(day["date"])),
                    str(day["session_count"]),
                    day["worked_hours_label"],
                    f"{day['total_packets']:,}".replace(",", " "),
                    str(day["ok_count"]),
                    str(day["nok_no_barcode"]),
                    str(day["nok_no_date"]),
                    str(day["nok_anomaly"]),
                    f"{day['conformity_rate_pct']:.1f}%",
                    _daily_modes_abbrev(day.get("modes_active", [])),
                ]
                for day in summary["days"]
            ]
            _render_table_pages(
                pdf,
                "Details par jour",
                f"Periode du {summary['period_label']}",
                ["Date", "Sess.", "Heures", "Paquets", "OK", "CAB", "D", "A", "Conf.", "Modes"],
                daily_rows,
                [0.10, 0.07, 0.09, 0.10, 0.08, 0.08, 0.08, 0.08, 0.09, 0.10],
                chunk_size=24,
                legend=_ABBREV_LEGEND,
            )

    buffer.seek(0)
    return buffer.getvalue()
