"""Read-only pilot evidence collector for sibling DomainManager/DomainAnalyzer data.

This script never changes a database, provider, registrar, or DNS record. It emits
sanitized JSON to stdout so the selected rows can be reviewed and imported into
DomainMonetizer separately.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any


VERTICAL_RULES: dict[str, tuple[str, ...]] = {
    "appliance repair": ("appliance", "refrigerator", "washer", "dryer", "oven repair"),
    "plumbing": ("plumb", "sewer", "drain", "water heater"),
    "hvac": ("hvac", "heating", "air conditioning", "air service"),
    "electrical": ("electric", "electrician"),
    "roofing": ("roof", "roofer"),
    "water damage": ("water damage", "restoration", "waterproof"),
    "pest control": ("pest", "termite", "wildlife removal"),
    "tree removal": ("tree service", "tree removal", "arborist"),
    "garage doors": ("garage door",),
    "windows": ("window replacement", "windows"),
    "solar": ("solar",),
    "bathroom remodeling": ("bathroom remodel", "walk-in tub"),
    "kitchen remodeling": ("kitchen remodel", "countertop"),
    "flooring": ("flooring", "floor service"),
    "mold remediation": ("mold",),
}

HARD_RISK_TERMS = (
    " law ",
    " law firm",
    "attorney",
    "dentist",
    "dentistry",
    "chiropractic",
    "hospital",
    "clinic",
    "union",
    "nonprofit",
    "church",
    "funeral",
    "insurance agency",
    "real estate agency",
)

BUSINESS_NAME_HINTS = (" llc", " inc", " corporation", " company profile", "family-owned business")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain-manager-root", type=Path, required=True)
    parser.add_argument("--domains", nargs="*", default=[], help="Optional exact domain allowlist")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--parklogic-checks", type=int, default=20)
    return parser.parse_args()


def text_blob(row: dict[str, Any]) -> str:
    fields = (
        row.get("domain_name"),
        row.get("ai_description"),
        row.get("ai_keywords"),
        row.get("ai_category"),
        row.get("ai_category_2"),
    )
    return " " + " ".join(str(value or "").lower() for value in fields) + " "


def infer_vertical(blob: str) -> str | None:
    for vertical, terms in VERTICAL_RULES.items():
        if any(term in blob for term in terms):
            return vertical
    return None


def normalize_country(value: Any) -> str | None:
    normalized = str(value or "").strip().upper()
    return "US" if normalized in {"US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"} else normalized or None


def risk_flags(blob: str, domain: str) -> list[str]:
    flags: list[str] = []
    if any(term in blob for term in HARD_RISK_TERMS):
        flags.append("regulated_or_identity_sensitive")
    if any(term in blob for term in BUSINESS_NAME_HINTS) or "llc" in domain:
        flags.append("former_business_identity")
    if domain.endswith(".org"):
        flags.append("organization_domain")
    if re.search(r"(?:^|[^a-z])(dr|doctor)[a-z]", domain):
        flags.append("person_or_clinic_name")
    return flags


def main() -> int:
    args = parse_args()
    dm_root = args.domain_manager_root.resolve()
    if not (dm_root / "utils.py").is_file():
        raise SystemExit("DomainManager root is invalid")
    sys.path.insert(0, str(dm_root))

    import mysql.connector  # type: ignore
    from config import DOMAIN_ANALYZER_DB_CONFIG  # type: ignore
    from parklogic_api import ParkLogicAPIClient  # type: ignore
    from utils import get_db_connection  # type: ignore

    dm_connection = get_db_connection()
    dm_cursor = dm_connection.cursor(dictionary=True)
    try:
        exact_domains = sorted({str(domain).strip().lower() for domain in args.domains if str(domain).strip()})
        exact_clause = ""
        exact_values: tuple[Any, ...] = ()
        if exact_domains:
            exact_clause = f" AND LOWER(d.domain_name) IN ({','.join(['%s'] * len(exact_domains))})"
            exact_values = tuple(exact_domains)
        eligibility_sql = """
            WHERE LOWER(TRIM(d.type))='parking'
              AND LOWER(TRIM(d.status))='available'
              AND NOT EXISTS (
                  SELECT 1 FROM domain_labels blocked
                   WHERE LOWER(blocked.domain_name)=LOWER(d.domain_name)
                     AND LOWER(TRIM(blocked.label_key))='traffic2'
              )
        """
        dm_cursor.execute(f"SELECT COUNT(*) AS count FROM domains d {eligibility_sql}")
        source_eligibility_count = int(dm_cursor.fetchone()["count"])
        dm_cursor.execute(
            f"""
            SELECT d.domain_name, d.registrar, d.nameservers, d.nameserver_sync_state,
                   COALESCE(parked_stats.visitors_30d, 0) AS parking_last_30d_visitors,
                   COALESCE(parked_stats.revenue_30d, 0) AS parking_last_30d_revenue,
                   d.parking_data_start_date, d.parking_data_end_date, d.parking_data_updated_at,
                   (SELECT GROUP_CONCAT(dl.label ORDER BY dl.label SEPARATOR '|')
                      FROM domain_labels dl WHERE LOWER(dl.domain_name)=LOWER(d.domain_name)) AS labels
              FROM domains d
              LEFT JOIN (
                    SELECT domain_name,
                           SUM(CASE WHEN stat_date BETWEEN CURRENT_DATE - INTERVAL 30 DAY
                                    AND CURRENT_DATE - INTERVAL 1 DAY
                                    THEN COALESCE(visitors, 0) ELSE 0 END) AS visitors_30d,
                           SUM(CASE WHEN stat_date BETWEEN CURRENT_DATE - INTERVAL 30 DAY
                                    AND CURRENT_DATE - INTERVAL 1 DAY
                                    THEN COALESCE(revenue, 0) ELSE 0 END) AS revenue_30d
                      FROM parking_provider_daily_stats
                     WHERE provider IN ('parklogic', 'giantpanda')
                     GROUP BY domain_name
              ) parked_stats ON parked_stats.domain_name = d.domain_name
              {eligibility_sql}
              {exact_clause}
             ORDER BY COALESCE(parked_stats.visitors_30d, 0) DESC,
                      COALESCE(parked_stats.revenue_30d, 0) DESC,
                      d.domain_name ASC
             LIMIT %s
            """,
            (*exact_values, max(1, min(args.limit, 2000))),
        )
        rows = list(dm_cursor.fetchall())
    finally:
        dm_cursor.close()
        dm_connection.close()

    analyzer = mysql.connector.connect(**dict(DOMAIN_ANALYZER_DB_CONFIG))
    analyzer_cursor = analyzer.cursor(dictionary=True)
    try:
        domains = [str(row["domain_name"]).lower() for row in rows]
        analysis: dict[str, dict[str, Any]] = {}
        for start in range(0, len(domains), 200):
            chunk = domains[start : start + 200]
            placeholders = ",".join(["%s"] * len(chunk))
            analyzer_cursor.execute(
                f"SELECT domain, ai_description, ai_keywords, ai_category, ai_category_2, ai_country, analyzed_datetime FROM analyzed_domains WHERE LOWER(domain) IN ({placeholders})",
                tuple(chunk),
            )
            for item in analyzer_cursor.fetchall():
                analysis[str(item["domain"]).lower()] = item
    finally:
        analyzer_cursor.close()
        analyzer.close()

    candidates: list[dict[str, Any]] = []
    for row in rows:
        domain = str(row["domain_name"]).lower()
        enriched = {**row, **analysis.get(domain, {})}
        blob = text_blob(enriched)
        vertical = infer_vertical(blob)
        country = normalize_country(enriched.get("ai_country"))
        flags = risk_flags(blob, domain)
        visitors = int(enriched.get("parking_last_30d_visitors") or 0)
        revenue = float(enriched.get("parking_last_30d_revenue") or 0)
        score = round(50 * bool(vertical) + 25 * (country == "US") + 14 * math.log1p(visitors) + min(revenue, 10) - 100 * bool(flags), 2)
        candidates.append(
            {
                "domain": domain,
                "registrar": enriched.get("registrar"),
                "nameservers": enriched.get("nameservers"),
                "nameserver_sync_state": enriched.get("nameserver_sync_state"),
                "labels": [label for label in str(enriched.get("labels") or "").split("|") if label],
                "vertical": vertical,
                "country_signal": country,
                "country_signal_source": "DomainAnalyzer content classification, not visitor geo",
                "ai_summary": enriched.get("ai_description"),
                "ai_keywords": enriched.get("ai_keywords"),
                "ai_category": enriched.get("ai_category"),
                "ai_category_2": enriched.get("ai_category_2"),
                "visitors_30d": visitors,
                "parking_revenue_30d_usd": revenue,
                "parking_period_start": str(enriched.get("parking_data_start_date") or "") or None,
                "parking_period_end": str(enriched.get("parking_data_end_date") or "") or None,
                "parking_updated_at": str(enriched.get("parking_data_updated_at") or "") or None,
                "risk_flags": flags,
                "score": score,
            }
        )

    candidates.sort(key=lambda item: (-item["score"], -item["visitors_30d"], item["domain"]))
    eligible = [item for item in candidates if item["vertical"] and not item["risk_flags"]]

    end_date = date.today() - timedelta(days=1)
    start_date = end_date - timedelta(days=29)
    client = ParkLogicAPIClient()
    parklogic_checks: dict[str, Any] = {}
    parklogic_targets = candidates if exact_domains else eligible
    for candidate in parklogic_targets[: max(0, min(args.parklogic_checks, 50))]:
        result = client.domain_daily(candidate["domain"], start_date.isoformat(), end_date.isoformat())
        rows_result = result.get("results") if result.get("success") else []
        daily_rows = [item for item in (rows_result or []) if isinstance(item, dict)]
        parklogic_checks[candidate["domain"]] = {
            "success": bool(result.get("success")),
            "row_count": len(daily_rows),
            "totals": {
                "requests": int(sum(float(item.get("urls") or 0) for item in daily_rows)),
                "views": int(sum(float(item.get("views") or 0) for item in daily_rows)),
                "clicks": int(sum(float(item.get("clicks") or 0) for item in daily_rows)),
                "revenue_usd": round(sum(float(item.get("revenue") or 0) for item in daily_rows), 4),
                "nonzero_view_days": sum(1 for item in daily_rows if float(item.get("views") or 0) > 0),
            },
            "period_start": start_date.isoformat(),
            "period_end": end_date.isoformat(),
            "message": result.get("message"),
        }

    print(
        json.dumps(
            {
                "collected_at": date.today().isoformat(),
                "source_eligibility_count": source_eligibility_count,
                "selected_eligibility_count": len(rows),
                "scored_candidates": candidates[:100],
                "recommended_pool": eligible[:30],
                "parklogic_daily": parklogic_checks,
                "visitor_geo_available": False,
                "visitor_geo_note": "The configured ParkLogic client exposes domain totals/daily rows but no country report. Validate country mix after cutover with Cloudflare telemetry.",
            },
            default=str,
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
