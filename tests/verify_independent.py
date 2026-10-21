"""Independent check of every number the app publishes.

Shares NO code with pipeline/. It:
 1. Downloads AMFI's own official NAV history for the exact dates each return
    uses, recomputes 1Y/3Y/5Y/10Y returns for EVERY ranked fund and benchmark,
    and compares them with the published data/funds.json.
 2. Recomputes volatility, Sharpe, Sortino, beta, alpha, drawdowns and
    consistency with pandas (a different implementation) from the NAV history.
 3. Recomputes every category percentile and score from the metrics.

Usage:  python tests/verify_independent.py _site [--history .cache/history] [--amfi-dir DIR]
Exit code 1 if anything disagrees. Writes _site/data/verification.json.
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

TOL_RET = 0.005     # percentage points (data is stored with 4 decimals)
TOL_REL = 1e-3


def years_back(d, n):
    try:
        return d.replace(year=d.year - n)
    except ValueError:
        return d.replace(year=d.year - n, day=28)


def fetch_amfi_range(d0, d1, folder):
    os.makedirs(folder, exist_ok=True)
    fn = os.path.join(folder, f"amfi_{d0.isoformat()}_{d1.isoformat()}.txt")
    # past windows never change; a window ending in the last 7 days may get late NAVs
    if os.path.exists(fn) and os.path.getsize(fn) > 100000 and (date.today() - d1).days > 7:
        return fn
    url = ("https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?"
           f"frmdt={d0.strftime('%d-%b-%Y')}&todt={d1.strftime('%d-%b-%Y')}")
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Analyx-verifier/1.0"})
            with urllib.request.urlopen(req, timeout=240) as r:
                body = r.read()
            if len(body) > 100000:
                open(fn, "wb").write(body)
                return fn
        except Exception as e:  # noqa: BLE001
            print("  AMFI download retry:", e)
        time.sleep(3 * (attempt + 1))
    raise SystemExit(f"Could not download AMFI history {d0}..{d1}")


def read_amfi(files):
    navs = {}
    for fn in files:
        for line in open(fn, encoding="utf-8", errors="replace"):
            p = line.strip().split(";")
            if len(p) < 8 or not p[0].isdigit():
                continue
            try:
                v = float(p[6]); d = datetime.strptime(p[7].strip(), "%d-%b-%Y").date()
            except ValueError:
                continue
            if v > 0:
                navs.setdefault(p[0], {})[d] = v
    return navs


def amfi_return(nav_by_date, end_d, end_v, years):
    target = years_back(end_d, years)
    cands = [d for d in nav_by_date if d <= target]
    if not cands:
        return None, None
    sd = max(cands)
    if (target - sd).days > 7:
        return None, sd
    r = end_v / nav_by_date[sd]
    if years == 1:
        return (r - 1) * 100, sd
    return (r ** (365.0 / (end_d - sd).days) - 1) * 100, sd


def load_history(folder, code, asset_type="equity"):
    raw = json.load(open(os.path.join(folder, f"{code}.json")))["data"]
    s = pd.Series({pd.Timestamp(d): v for d, v in raw}).sort_index()
    # documented data-error rule (README): drop a one-day jump beyond the threshold
    # that fully reverses the next day
    thr = {"equity": 0.25, "hybrid": 0.15, "debt": 0.05}.get(asset_type, 0.25)
    vals = s.values
    keep = np.ones(len(vals), dtype=bool)
    prev = vals[0]
    for i in range(1, len(vals) - 1):
        if abs(vals[i] / prev - 1) > thr and abs(vals[i + 1] / prev - 1) < thr / 5:
            keep[i] = False
            continue
        prev = vals[i]
    return s[keep]


def pandas_metrics(s, rf_pct, b=None):
    out = {}
    last = s.index[-1]
    me = s.groupby([s.index.year, s.index.month]).last()
    me.index = [pd.Period(year=y, month=m, freq="M") for y, m in me.index]
    cur = pd.Period(last, freq="M")
    window = [cur - k for k in range(37, 0, -1)]
    rf_m = (1 + rf_pct / 100) ** (1 / 12) - 1
    if all(p in me.index for p in window):
        r = me.loc[window].pct_change().dropna()
        out["std_dev"] = r.std(ddof=1) * math.sqrt(12) * 100
        out["sharpe"] = (r.mean() - rf_m) / r.std(ddof=1) * math.sqrt(12)
        dd = math.sqrt(((r - rf_m).clip(upper=0) ** 2).mean())
        out["sortino"] = (r.mean() - rf_m) / dd * math.sqrt(12) if dd > 0 else None
        if b is not None:
            bme = b.groupby([b.index.year, b.index.month]).last()
            bme.index = [pd.Period(year=y, month=m, freq="M") for y, m in bme.index]
            if all(p in bme.index for p in window):
                br = bme.loc[window].pct_change().dropna()
                beta = np.cov(r.values, br.values, ddof=1)[0, 1] / np.var(br.values, ddof=1)
                out["beta"] = beta
                out["alpha"] = ((r.mean() - rf_m) - beta * (br.mean() - rf_m)) * 1200
    else:
        out.update(std_dev=None, sharpe=None, sortino=None)
    out.setdefault("beta", None); out.setdefault("alpha", None)
    start3 = pd.Timestamp(years_back(last.date(), 3))
    if (last - s.index[0]).days / 365.25 >= 3:
        w = s[s.index >= start3]
        out["max_drawdown_3y"] = float(((w.cummax() - w) / w.cummax()).max() * 100)
    else:
        out["max_drawdown_3y"] = None
    out["max_drawdown_all"] = float(((s.cummax() - s) / s.cummax()).max() * 100)
    if b is not None:
        common = me.index.intersection(bme.index) if 'bme' in dir() else None
        bme2 = b.groupby([b.index.year, b.index.month]).last()
        bme2.index = [pd.Period(year=y, month=m, freq="M") for y, m in bme2.index]
        common = me.index.intersection(bme2.index)
        common = common[common <= cur - 1]
        cs = set(common)
        wins = tot = 0
        for p in common:
            q = p - 36
            if q in cs:
                tot += 1
                if (me[p] / me[q]) ** (1 / 3) > (bme2[p] / bme2[q]) ** (1 / 3):
                    wins += 1
        out["consistency"] = wins / tot * 100 if tot >= 12 else None
    else:
        out["consistency"] = None
    return out


def close(a, b, tol_abs):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= max(tol_abs, TOL_REL * abs(b))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("--history", default=".cache/history_final")
    ap.add_argument("--amfi-dir", default=".cache/amfi")
    args = ap.parse_args()
    data = os.path.join(args.site, "data")
    funds = json.load(open(os.path.join(data, "funds.json")))["funds"]
    meta = json.load(open(os.path.join(data, "meta.json")))
    rf = meta["macro"]["risk_free_rate"]["value"]
    scoring = json.load(open(os.path.join(args.site, "config", "scoring.json")))
    as_of = date.fromisoformat(meta["nav_as_of"])

    # ---- 1. official AMFI history around each return's start date ----
    files = []
    for yrs in (0, 1, 3, 5, 10):
        c = years_back(as_of, yrs)
        files.append(fetch_amfi_range(c - timedelta(days=16), c, args.amfi_dir))
    amfi = read_amfi(files)
    # today's official file (the history report can lag by a day)
    req = urllib.request.Request("https://www.amfiindia.com/spages/NAVAll.txt", headers={"User-Agent": "Analyx-verifier/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        for line in r.read().decode("utf-8", errors="replace").splitlines():
            p = line.strip().split(";")
            if len(p) >= 8 and p[0].isdigit():
                try:
                    amfi.setdefault(p[0], {})[datetime.strptime(p[7].strip(), "%d-%b-%Y").date()] = float(p[6])
                except ValueError:
                    pass
    problems, checked = [], 0
    for f in funds:
        code = f["code"]
        a = amfi.get(code, {})
        end_d = date.fromisoformat(f["nav_date"])
        if end_d not in a:
            problems.append(f"{code} {f['name']}: latest NAV date {end_d} not in AMFI history")
            continue
        if abs(a[end_d] - f["nav"]) > 1e-6 * f["nav"]:
            problems.append(f"{code} {f['name']}: NAV {f['nav']} != AMFI {a[end_d]} on {end_d}")
        for yrs, key in ((1, "return_1y"), (3, "return_3y"), (5, "return_5y"), (10, "return_10y")):
            mine, sd = amfi_return(a, end_d, a[end_d], yrs)
            pub = f["metrics"][key]
            checked += 1
            if mine is None and pub is not None:
                # AMFI file lacks that date (scheme not listed then) - acceptable only if history says the same
                if sd is None:
                    problems.append(f"{code} {f['name']}: {key}={pub:.2f} published but AMFI has no NAV near the start date")
                else:
                    problems.append(f"{code} {f['name']}: {key} start-date gap differs (AMFI {sd})")
            elif mine is not None and pub is None:
                problems.append(f"{code} {f['name']}: {key} not published but AMFI gives {mine:.2f}")
            elif mine is not None and abs(mine - pub) > TOL_RET:
                problems.append(f"{code} {f['name']}: {key} published {pub:.4f} vs AMFI {mine:.4f}")
    ret_problems = len(problems)
    print(f"[1] Returns vs AMFI official history: {checked} values checked for {len(funds)} funds, {ret_problems} problems")

    # ---- 2. risk metrics with pandas ----
    bench_cache = {}
    risk_checked = 0
    for f in funds:
        s = load_history(args.history, f["code"], f["asset_type"])
        s = s[s.index <= pd.Timestamp(f["nav_date"])]
        b = None
        if f["benchmark"]:
            bc = meta["benchmarks"][f["benchmark"]]["scheme_code"]
            if bc not in bench_cache:
                bench_cache[bc] = load_history(args.history, bc)
            b = bench_cache[bc]
        mine = pandas_metrics(s, rf, b)
        for k, v in mine.items():
            risk_checked += 1
            pub = f["metrics"][k]
            tol = 0.01 if k in ("std_dev", "max_drawdown_3y", "max_drawdown_all", "consistency", "alpha") else 0.001
            if not close(None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v), pub, tol):
                problems.append(f"{f['code']} {f['name']}: {k} published {pub} vs independent {v}")
    print(f"[2] Risk metrics recomputed with pandas: {risk_checked} values, {len(problems) - ret_problems} problems")

    # ---- 3. percentiles and scores ----
    before = len(problems)
    lower = set(scoring["lower_is_better"])
    by_cat = {}
    for f in funds:
        by_cat.setdefault(f["category"], []).append(f)
    pc_checked = 0
    for cat, lst in by_cat.items():
        for k in scoring["weights"]:
            vals = [x["metrics"][k] for x in lst if x["metrics"][k] is not None]
            for x in lst:
                v = x["metrics"][k]
                pub = x["percentiles"][k]
                if v is None:
                    if pub is not None:
                        problems.append(f"{x['code']}: percentile for missing {k}")
                    continue
                n = len(vals)
                pc_checked += 1
                if n == 1:
                    if abs(pub - 50) > 0.01:
                        problems.append(f"{x['code']}: {k} percentile {pub} vs 50")
                    continue
                # published metrics are rounded to 4 decimals, so values within 1e-4 may be
                # a tie or not: accept anything between the two extremes
                eps = 1.5e-4
                strictly = sum(1 for y in vals if (y > v + eps if k in lower else y < v - eps))
                near = sum(1 for y in vals if abs(y - v) <= eps) - 1
                lo = strictly / (n - 1) * 100
                hi = (strictly + near) / (n - 1) * 100
                if not (lo - 0.01 <= pub <= hi + 0.01):
                    problems.append(f"{x['code']}: {k} percentile {pub} outside {lo:.2f}-{hi:.2f}")
        for x in lst:
            num = sum(w * x["percentiles"][k] for k, w in scoring["weights"].items() if x["percentiles"][k] is not None)
            den = sum(w for k, w in scoring["weights"].items() if x["percentiles"][k] is not None)
            if abs(num / den - x["score"]) > 0.01:
                problems.append(f"{x['code']}: score {x['score']} vs {num / den}")
    print(f"[3] Category percentiles and scores: {pc_checked} percentiles, {len(problems) - before} problems")

    # ---- 4. benchmarks vs AMFI ----
    before = len(problems)
    for k, bm in meta["benchmarks"].items():
        a = amfi.get(bm["scheme_code"], {})
        end_d = date.fromisoformat(bm["as_of"])
        if end_d not in a:
            problems.append(f"benchmark {k}: {end_d} not in AMFI")
            continue
        for yrs, key in ((1, "return_1y"), (3, "return_3y"), (5, "return_5y")):
            mine, _ = amfi_return(a, end_d, a[end_d], yrs)
            pub = bm[key]
            if (mine is None) != (pub is None) or (mine is not None and abs(mine - pub) > TOL_RET):
                problems.append(f"benchmark {k} {key}: published {pub} vs AMFI {mine}")
    print(f"[4] Benchmarks vs AMFI official history: {len(meta['benchmarks'])} indices, {len(problems) - before} problems")

    report = {"checked_at": datetime.now().isoformat(timespec="seconds"), "nav_as_of": meta["nav_as_of"],
              "funds": len(funds), "return_values": checked, "risk_values": risk_checked,
              "percentiles": pc_checked, "problems": problems[:200], "ok": not problems}
    json.dump(report, open(os.path.join(data, "verification.json"), "w"), indent=1)
    if problems:
        print("\nPROBLEMS:")
        for p in problems[:60]:
            print(" -", p)
        sys.exit(1)
    print("\nAll published numbers match the independent recomputation.")


if __name__ == "__main__":
    main()
