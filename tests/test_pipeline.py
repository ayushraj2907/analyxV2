"""Unit tests for the data pipeline. Run:  python -m pytest -q"""
import json
import math
import os
import re
import statistics
import sys
from datetime import date, timedelta

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipeline"))

from amfi import parse_navall  # noqa: E402
from categories import classify_header  # noqa: E402
import metrics as M  # noqa: E402
from ranking import percentile, rank_category  # noqa: E402


def daily_series(start, end, annual_rate, start_nav=100.0):
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append((d, start_nav * (1 + annual_rate) ** ((d - start).days / 365.0)))
        d += timedelta(days=1)
    return out


# ---------------- returns ----------------

def test_cagr_exact_12_percent():
    s = daily_series(date(2019, 1, 1), date(2026, 10, 16), 0.12)  # Friday end
    # 3 years back = 2023-10-16 (Monday) exists -> exactly 12.00%
    assert M.period_return(s, 3) == pytest.approx(12.0, abs=1e-9)
    assert M.period_return(s, 5) == pytest.approx(12.0, abs=1e-9)
    # 1Y is absolute return over 366 days here (2025-10-16 is Thursday)
    assert M.period_return(s, 1) == pytest.approx((1.12 ** (365 / 365.0) - 1) * 100, abs=1e-9)


def test_cagr_uses_dates_not_rows():
    s = daily_series(date(2020, 1, 1), date(2026, 10, 16), 0.10)
    # delete half the rows: a row-count method would break, a date method doesn't
    thinned = s[::2] + [s[-1]]
    thinned = sorted(set(thinned))
    assert M.period_return(thinned, 3) == pytest.approx(10.0, abs=0.01)


def test_cagr_unavailable_when_gap_over_7_days():
    s = daily_series(date(2023, 11, 1), date(2026, 10, 16), 0.10)  # starts after the 3Y target
    assert M.period_return(s, 3) is None
    # gap: remove the 20 days before the 3Y target
    full = daily_series(date(2022, 1, 1), date(2026, 10, 16), 0.10)
    target = date(2023, 10, 16)
    gapped = [p for p in full if not (target - timedelta(days=20) < p[0] <= target)]
    assert M.period_return(gapped, 3) is None


# ---------------- risk metrics ----------------

def month_end_series(returns, start=(2023, 1)):
    """Build a NAV series with one point at the 28th of each month + a point in the following month."""
    y, m = start
    nav = 100.0
    out = [(date(y, m, 28), nav)]
    for r in returns:
        m += 1
        if m > 12:
            m, y = 1, y + 1
        nav *= 1 + r
        out.append((date(y, m, 28), nav))
    # a point in the next month so the last one counts as a complete month
    m += 1
    if m > 12:
        m, y = 1, y + 1
    out.append((date(y, m, 5), nav))
    return out


RETS = [0.03, -0.02, 0.015, 0.04, -0.035, 0.01] * 6  # 36 months


def test_std_sharpe_sortino_match_hand_formula():
    s = month_end_series(RETS)
    rf = 6.0
    out = M.risk_metrics(s, rf)
    rf_m = 1.06 ** (1 / 12) - 1
    sd = statistics.stdev(RETS)
    mean = statistics.mean(RETS)
    assert out["std_dev"] == pytest.approx(sd * math.sqrt(12) * 100)
    assert out["sharpe"] == pytest.approx((mean - rf_m) / sd * math.sqrt(12))
    dd = math.sqrt(sum(min(0, r - rf_m) ** 2 for r in RETS) / len(RETS))
    assert out["sortino"] == pytest.approx((mean - rf_m) / dd * math.sqrt(12))


def test_beta_and_alpha_from_regression():
    bench_r = RETS
    fund_r = [2 * r + 0.001 for r in bench_r]  # beta exactly 2
    s, b = month_end_series(fund_r), month_end_series(bench_r)
    out = M.risk_metrics(s, 6.0, b)
    rf_m = 1.06 ** (1 / 12) - 1
    assert out["beta"] == pytest.approx(2.0)
    exp_alpha = ((statistics.mean(fund_r) - rf_m) - 2 * (statistics.mean(bench_r) - rf_m)) * 12 * 100
    assert out["alpha"] == pytest.approx(exp_alpha)


def test_risk_metrics_none_when_months_missing():
    s = month_end_series(RETS[:20])
    out = M.risk_metrics(s, 6.0)
    assert all(v is None for v in out.values())


def test_max_drawdown():
    s = [(date(2024, 1, i), v) for i, v in enumerate([100, 120, 90, 130, 100], start=1)]
    assert M.max_drawdown(s) == pytest.approx(25.0)


def test_rolling_consistency():
    # fund always 1%/month better than benchmark -> wins every window
    b = month_end_series([0.01] * 60, start=(2020, 1))
    f = month_end_series([0.02] * 60, start=(2020, 1))
    assert M.rolling_consistency(f, b) == pytest.approx(100.0)
    assert M.rolling_consistency(b, f) == pytest.approx(0.0)
    short = month_end_series([0.02] * 40, start=(2020, 1))
    assert M.rolling_consistency(short, b) is None  # fewer than 12 windows


def test_bad_tick_removed_but_real_crash_kept():
    base = [(date(2024, 1, i), 100.0) for i in range(1, 10)]
    spike = base[:4] + [(date(2024, 1, 5), 1000.0)] + base[5:]
    clean, n = M.remove_bad_ticks(spike, "equity")
    assert n == 1 and all(v == 100.0 for _, v in clean)
    crash = base[:4] + [(date(2024, 1, 5), 70.0), (date(2024, 1, 6), 69.0), (date(2024, 1, 7), 71.0)]
    clean, n = M.remove_bad_ticks(crash, "equity")
    assert n == 0 and len(clean) == len(crash)


# ---------------- ranking ----------------

def test_percentile():
    vals = [1, 2, 3, 4, 5]
    assert percentile(vals, 5) == 100
    assert percentile(vals, 1) == 0
    assert percentile(vals, 1, lower_is_better=True) == 100
    assert percentile([7], 7) == 50


def test_rank_skips_missing_and_renormalises():
    scoring = {"weights": {"return_3y": 50, "alpha": 50}, "lower_is_better": []}
    funds = [{"metrics": {"return_3y": 10, "alpha": None}}, {"metrics": {"return_3y": 5, "alpha": None}}]
    rank_category(funds, scoring)
    assert funds[0]["score"] == 100 and funds[1]["score"] == 0  # alpha ignored, not filled in
    assert funds[0]["rank"] == 1


# ---------------- AMFI parsing & categories ----------------

AMFI_SAMPLE = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Large Cap Fund)

Axis Mutual Fund

120465;INF846K01DP8;-;Axis Large Cap Fund;Direct Plan;Growth;65.12;19-Oct-2026
120466;INF846K01DQ6;INF846K01DR4;Axis Large Cap Fund;Direct Plan;IDCW;20.5;19-Oct-2026
112277;INF846K01131;-;Axis Large Cap Fund;Regular Plan;Growth;55.0;19-Oct-2026

Open Ended Schemes(Income/Debt Oriented Schemes - Ultra Short to Short Term Fund)

Bandhan Mutual Fund

118000;X;-;Bandhan Ultra Short to Short Term Fund - Direct Plan - Growth;;;40.1;19-Oct-2026

Close Ended Schemes(Income)

UTI Mutual Fund

100001;X;-;UTI FTIF Series XX - Direct Plan - Growth;Direct Plan;Growth;12;02-Jul-2018
"""


def test_parse_navall():
    r = parse_navall(AMFI_SAMPLE)
    s = {x["code"]: x for x in r["schemes"]}
    assert s["120465"]["plan"] == "Direct" and s["120465"]["growth"]
    assert not s["120466"]["growth"]  # IDCW filtered
    assert s["112277"]["plan"] == "Regular"
    assert s["118000"]["category"] == "Low Duration" and s["118000"]["plan"] == "Direct" and s["118000"]["growth"]
    assert s["120465"]["amc"] == "Axis Mutual Fund" and s["120465"]["date"] == date(2026, 10, 19)
    assert not s["100001"]["open_ended"]


@pytest.mark.parametrize("header,expected", [
    ("Open Ended Schemes(Equity Scheme - Large & Mid Cap Fund)", "Large & Mid Cap"),
    ("Open Ended Schemes(Equity Schemes - ELSS- Tax Saver Fund)", "ELSS"),
    ("Open Ended Schemes(Equity Schemes - Thematic Fund)", "Sectoral/Thematic"),
    ("Open Ended Schemes(Hybrid Schemes - Balanced Advantage Fund/ Dynamic Asset Allocation)", "Balanced Advantage"),
    ("Open Ended Schemes(Hybrid Scheme - Dynamic Asset Allocation or Balanced Advantage)", "Balanced Advantage"),
    ("Open Ended Schemes(Debt Scheme - Ultra Short Duration Fund)", "Ultra Short Duration"),
    ("Open Ended Schemes(Income/Debt Oriented Schemes - Ultra Short Term Fund)", "Ultra Short Duration"),
    ("Open Ended Schemes(Income/Debt Oriented Schemes - Short Term Fund)", "Short Duration"),
    ("Open Ended Schemes(Income/Debt Oriented Schemes - Medium to Long Term Fund)", "Medium to Long Duration"),
    ("Open Ended Schemes(Income/Debt Oriented Schemes - 10-year Constant Maturity Gilt Fund)", "Gilt 10Y Constant"),
    ("Open Ended Schemes(Income/Debt Oriented Schemes - Sectoral Fund)", "Debt Sectoral"),
    ("Open Ended Schemes(Children’s Fund - Childrens' Fund)", "Children's"),
    ("Open Ended Schemes(Solution Oriented Schemes ** - Retirement Fund)", "Retirement"),
    ("Open Ended Schemes(Other Scheme - Index Funds)", "Index Fund"),
    ("Open Ended Schemes(Income)", None),
])
def test_categories(header, expected):
    assert classify_header(header)[0] == expected


def test_profile_categories_all_exist():
    """Every category named in profile_rules.json must be a real canonical group."""
    from categories import RULES
    canon = {r[2] for r in RULES}
    rules = json.load(open(os.path.join(ROOT, "config", "profile_rules.json")))
    used = set()
    for risks in rules["goals"].values():
        for lst in risks.values():
            used.update(lst)
    assert used <= canon, used - canon


# ---------------- no hardcoded market numbers ----------------

ALLOWED = {
    # pipeline thresholds / unit conversions, not market data
    "365.25", "1.5", "1e-4",
}


def test_no_hardcoded_market_numbers():
    """Decimal literals between 2 and 40 look like returns/inflation/rates. They must live in config/."""
    pat = re.compile(r"(?<![\w.])(\d{1,2}\.\d+)(?![\w.])")
    offenders = []
    for folder in ("pipeline", os.path.join("app", "js")):
        for dirpath, _, files in os.walk(os.path.join(ROOT, folder)):
            for fn in files:
                if not fn.endswith((".py", ".js")):
                    continue
                path = os.path.join(dirpath, fn)
                for i, line in enumerate(open(path, encoding="utf-8"), 1):
                    if "allow-number" in line:
                        continue  # explicitly reviewed (language constants, not market data)
                    if fn.endswith(".py"):
                        code = line.split("#")[0]
                    else:
                        if line.lstrip().startswith(("*", "/*")):
                            continue  # JS block comment line
                        code = re.sub(r"/\*.*?\*/", "", line).split("//")[0]
                    for m in pat.finditer(code):
                        v = m.group(1)
                        if v in ALLOWED:
                            continue
                        if 2 <= float(v) <= 40:
                            offenders.append(f"{os.path.relpath(path, ROOT)}:{i}: {v}")
    assert not offenders, "Hardcoded market-looking numbers:\n" + "\n".join(offenders)


# ---------------- built data: list == detail ----------------

SITE = os.environ.get("SITE_DIR", os.path.join(ROOT, "_site"))


@pytest.mark.skipif(not os.path.exists(os.path.join(SITE, "data", "funds.json")), reason="site not built")
def test_list_and_detail_identical():
    funds = json.load(open(os.path.join(SITE, "data", "funds.json")))["funds"]
    assert funds
    for f in funds:
        d = json.load(open(os.path.join(SITE, "data", "funds", f"{f['code']}.json")))
        assert d["fund"] == f, f["code"]
        assert d["series"][-1][0] == f["nav_date"]
        assert d["series"][-1][1] == f["nav"]


@pytest.mark.skipif(not os.path.exists(os.path.join(SITE, "data", "meta.json")), reason="site not built")
def test_every_number_has_source_and_date():
    meta = json.load(open(os.path.join(SITE, "data", "meta.json")))
    assert meta["sources"] and meta["nav_as_of"] and meta["built_at"]
    for key in ("inflation", "risk_free_rate"):
        assert meta["macro"][key]["source_url"].startswith("https://")
        assert meta["macro"][key]["period"]
    for c in json.load(open(os.path.join(SITE, "data", "benchmarks.json")))["cards"]:
        assert c["as_of"] and c["fund_name"]
