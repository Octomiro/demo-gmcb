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
from matplotlib.patches import FancyBboxPatch

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


def _mode_labels(checks: dict[str, bool]) -> list[str]:
    return [_MODE_META[key]["label"] for key in _MODE_ORDER if checks.get(key)]


def _mode_combo_label(checks: dict[str, bool]) -> str:
    labels = _mode_labels(checks)
    return " + ".join(labels) if labels else "Aucun mode"


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

        checks = _normalize_enabled_checks(session)
        mode_labels = _mode_labels(checks)
        combo_label = _mode_combo_label(checks)
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
                mode_duration_minutes[mode_key] += duration_minutes

        combo_counts[combo_label] = combo_counts.get(combo_label, 0) + 1
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
            "mode_combo_label": combo_label,
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


def _metric_box(fig, x: float, y: float, w: float, h: float, title: str, value: str, color: str):
    box = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle="round,pad=0.012,rounding_size=0.02",
        linewidth=1,
        edgecolor="#e5e7eb",
        facecolor="#ffffff",
        transform=fig.transFigure,
        zorder=2,
    )
    fig.add_artist(box)
    fig.text(x + 0.02, y + h - 0.03, title, fontsize=10, color="#6b7280", zorder=3)
    fig.text(x + 0.02, y + 0.03, value, fontsize=18, weight="bold", color=color, zorder=3)


def _render_summary_page(pdf: PdfPages, summary: dict[str, Any]):
    fig = plt.figure(figsize=(8.27, 11.69))
    fig.patch.set_facecolor("white")

    fig.text(0.08, 0.95, "Rapport PDF GMCB", fontsize=24, weight="bold", color="#0f172a")
    subtitle = (
        f"Rapport journalier du {summary['period_label']}"
        if summary["report_kind"] == "daily"
        else f"Periode du {summary['period_label']}"
    )
    fig.text(0.08, 0.922, subtitle, fontsize=12, color="#475569")
    fig.text(0.08, 0.903, f"Genere le {summary['generated_at'][:16].replace('T', ' ')}", fontsize=10, color="#94a3b8")

    metrics = [
        ("Sessions", str(summary["session_count"]), "#4f46e5"),
        ("Moyenne / jour", f"{summary['average_sessions_per_day']:.2f}", "#0d9488"),
        ("Heures travaillees", summary["total_hours_label"], "#2563eb"),
        ("Moyenne h / jour", f"{summary['average_hours_per_day']:.2f} h", "#7c3aed"),
        ("Conformite", f"{summary['conformity_rate_pct']:.2f}%", "#16a34a"),
        ("Taux anomalies", f"{summary['anomaly_rate_pct']:.2f}%", "#dc2626"),
    ]
    card_positions = [
        (0.08, 0.79),
        (0.39, 0.79),
        (0.70, 0.79),
        (0.08, 0.69),
        (0.39, 0.69),
        (0.70, 0.69),
    ]
    for (title, value, color), (x, y) in zip(metrics, card_positions):
        _metric_box(fig, x, y, 0.22, 0.08, title, value, color)

    fig.text(0.08, 0.64, "Synthese de production", fontsize=14, weight="bold", color="#0f172a")
    summary_lines = [
        f"Paquets analyses : {summary['total_packets']:,}".replace(",", " "),
        f"Paquets conformes : {summary['total_conformes']:,}".replace(",", " "),
        f"Anomalies totales : {summary['total_anomalies']:,}".replace(",", " "),
    ]
    for index, line in enumerate(summary_lines):
        fig.text(0.10, 0.615 - (index * 0.025), f"• {line}", fontsize=11, color="#334155")

    fig.text(0.08, 0.53, "Modes actifs observes", fontsize=14, weight="bold", color="#0f172a")
    y_cursor = 0.505
    for mode in summary["active_modes"]:
        status = "Actif" if mode["active"] else "Absent"
        line = (
            f"{mode['label']} : {status} | {mode['session_count']} session(s) | "
            f"{mode['hours']:.2f} h approx."
        )
        fig.text(0.10, y_cursor, f"• {line}", fontsize=10.5, color="#334155")
        y_cursor -= 0.023

    fig.text(0.52, 0.53, "Combinaisons de modes", fontsize=14, weight="bold", color="#0f172a")
    combo_rows = summary["mode_combinations"][:6] or [{"label": "Aucune donnee", "count": 0, "share_pct": 0.0}]
    y_cursor = 0.505
    for row in combo_rows:
        fig.text(
            0.54,
            y_cursor,
            f"• {row['label']} : {row['count']} session(s) ({row['share_pct']:.1f}%)",
            fontsize=10.5,
            color="#334155",
        )
        y_cursor -= 0.023

    ax = fig.add_axes([0.08, 0.12, 0.84, 0.25])
    labels = [row["label"] for row in summary["anomalies_by_type"]]
    values = [row["count"] for row in summary["anomalies_by_type"]]
    colors = [row["color"] for row in summary["anomalies_by_type"]]
    y_pos = list(range(len(labels)))
    ax.barh(y_pos, values, color=colors, edgecolor="none", height=0.45)
    ax.set_yticks(y_pos)
    ax.set_yticklabels(labels, fontsize=10)
    ax.invert_yaxis()
    ax.set_xlabel("Nombre d'anomalies", fontsize=10, color="#475569")
    ax.set_title("Repartition des anomalies par type", loc="left", fontsize=14, weight="bold", color="#0f172a", pad=12)
    ax.grid(axis="x", color="#e2e8f0", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_color("#cbd5e1")
    ax.tick_params(axis="x", colors="#64748b", labelsize=9)
    for idx, value in enumerate(values):
        ax.text(value + max(max(values, default=0) * 0.02, 0.25), idx, str(value), va="center", fontsize=10, color="#334155")

    pdf.savefig(fig)
    plt.close(fig)


def _render_table_pages(
    pdf: PdfPages,
    title: str,
    subtitle: str,
    headers: list[str],
    rows: list[list[str]],
    col_widths: list[float],
    chunk_size: int = 18,
):
    if not rows:
        rows = [["Aucune donnee disponible" for _ in headers]]

    total_pages = max(1, math.ceil(len(rows) / chunk_size))
    for page_index, page_rows in enumerate(_chunk_rows(rows, chunk_size), start=1):
        fig = plt.figure(figsize=(8.27, 11.69))
        fig.patch.set_facecolor("white")
        fig.text(0.08, 0.95, title, fontsize=20, weight="bold", color="#0f172a")
        fig.text(0.08, 0.922, subtitle, fontsize=11, color="#64748b")
        fig.text(0.92, 0.95, f"Page {page_index}/{total_pages}", ha="right", fontsize=10, color="#94a3b8")

        ax = fig.add_axes([0.05, 0.06, 0.90, 0.82])
        ax.axis("off")
        table = ax.table(
            cellText=page_rows,
            colLabels=headers,
            colWidths=col_widths,
            loc="upper left",
            cellLoc="left",
        )
        table.auto_set_font_size(False)
        table.set_fontsize(9)
        table.scale(1, 1.45)

        for (row_idx, col_idx), cell in table.get_celld().items():
            cell.set_edgecolor("#e5e7eb")
            cell.set_linewidth(0.8)
            if row_idx == 0:
                cell.set_facecolor("#f8fafc")
                cell.set_text_props(weight="bold", color="#0f172a")
            else:
                cell.set_facecolor("#ffffff" if row_idx % 2 else "#fcfcfd")
                cell.set_text_props(color="#334155")

        pdf.savefig(fig)
        plt.close(fig)


def generate_report_pdf(summary: dict[str, Any]) -> bytes:
    buffer = BytesIO()
    with PdfPages(buffer) as pdf:
        _render_summary_page(pdf, summary)

        daily_rows = [
            [
                day["date"],
                str(day["session_count"]),
                day["worked_hours_label"],
                f"{day['total_packets']:,}".replace(",", " "),
                f"{day['conformity_rate_pct']:.2f}%",
                str(day["total_anomalies"]),
                ", ".join(day["modes_active"]) if day["modes_active"] else "—",
            ]
            for day in summary["days"]
        ]
        _render_table_pages(
            pdf,
            "Details par jour",
            "Sessions, heures, paquets, conformite, anomalies et modes actifs",
            ["Date", "Sessions", "Heures", "Paquets", "Conformite", "Anomalies", "Modes"],
            daily_rows,
            [0.15, 0.10, 0.12, 0.13, 0.13, 0.12, 0.25],
            chunk_size=20,
        )

        session_rows = [
            [
                row["date"],
                row["start_time"],
                row["end_time"],
                row["duration_label"],
                f"{row['total_packets']:,}".replace(",", " "),
                f"{row['conformity_rate_pct']:.2f}%",
                str(row["total_anomalies"]),
                ", ".join(row["mode_labels"]) if row["mode_labels"] else "—",
            ]
            for row in summary["sessions"]
        ]
        _render_table_pages(
            pdf,
            "Details par session",
            "Chaque session demarree dans la periode selectionnee",
            ["Date", "Debut", "Fin", "Duree", "Paquets", "Conformite", "Anomalies", "Modes"],
            session_rows,
            [0.12, 0.09, 0.09, 0.12, 0.12, 0.13, 0.11, 0.22],
            chunk_size=22,
        )

    buffer.seek(0)
    return buffer.getvalue()
