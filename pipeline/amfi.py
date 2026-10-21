"""Parse AMFI NAVAll.txt (official daily NAV file for all schemes).

Current format (8 columns, semicolon separated):
Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Older files had 6 columns (no Plan/Option); both are handled.
"""
import re
from datetime import datetime

from categories import classify_header

BAD_OPTION_WORDS = ("idcw", "dividend", "bonus", "payout", "reinvest", "income distribution", "withdrawal")


def _plan(plan_col: str, name: str) -> str:
    p = (plan_col or "").lower()
    if "direct" in p:
        return "Direct"
    if "regular" in p:
        return "Regular"
    n = name.lower()
    if "direct" in n:
        return "Direct"
    if "regular" in n:
        return "Regular"
    return "Unknown"


def _is_growth(option_col: str, name: str) -> bool:
    o = (option_col or "").strip().lower()
    n = name.lower()
    if any(w in n for w in ("segregated", "unclaimed")):
        return False
    if o:
        return "growth" in o and not any(w in o for w in BAD_OPTION_WORDS)
    return "growth" in n and not any(w in n for w in BAD_OPTION_WORDS)


def _is_header(line: str) -> bool:
    return bool(re.match(r"^(open ended|close ended|interval)", line.strip(), re.I))


def parse_navall(text: str) -> dict:
    """Return {'schemes': [...], 'unmapped_headers': {header: count}}."""
    schemes = []
    unmapped = {}
    header = None
    cat = typ = None
    open_ended = False
    amc = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if ";" not in line:
            if _is_header(line):
                header = line
                cat, typ, open_ended = classify_header(line)
            else:
                amc = line
            continue
        parts = [p.strip() for p in line.split(";")]
        if not parts[0].isdigit():
            continue
        if len(parts) >= 8:
            code, name, plan_col, opt_col, nav_s, date_s = parts[0], parts[3], parts[4], parts[5], parts[6], parts[7]
        elif len(parts) >= 6:
            code, name, plan_col, opt_col, nav_s, date_s = parts[0], parts[3], "", "", parts[4], parts[5]
        else:
            continue
        try:
            nav = float(nav_s.replace(",", ""))
            d = datetime.strptime(date_s, "%d-%b-%Y").date()
        except ValueError:
            continue
        if nav <= 0:
            continue
        if cat is None and open_ended:
            unmapped[header] = unmapped.get(header, 0) + 1
        schemes.append({
            "code": code,
            "name": re.sub(r"\s+", " ", name),
            "amc": amc,
            "category": cat,
            "asset_type": typ,
            "open_ended": open_ended,
            "plan": _plan(plan_col, name),
            "growth": _is_growth(opt_col, name),
            "nav": nav,
            "date": d,
        })
    return {"schemes": schemes, "unmapped_headers": unmapped}
