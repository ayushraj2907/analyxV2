"""Build the whole static site: app files + config + fresh data.

Usage (what the GitHub Action runs):
    python pipeline/build_site.py --out _site

Exit code 1 = data looked wrong; the workflow then does NOT publish, so the
live site keeps yesterday's data.
"""
import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from amfi import parse_navall  # noqa: E402
from metrics import compute_all, remove_bad_ticks, downsample, history_years, period_return  # noqa: E402
from mfapi import get_history, reconcile_with_amfi  # noqa: E402
from ranking import rank_category  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IST = timezone(timedelta(hours=5, minutes=30))
AMFI_URLS = ["https://portal.amfiindia.com/spages/NAVAll.txt", "https://www.amfiindia.com/spages/NAVAll.txt"]
ACTIVE_WINDOW_DAYS = 7          # ~5 business days
STALE_LIMIT_DAYS = 5            # build fails if AMFI's latest NAV is older than this
MAX_FAIL_RATIO = 0.02
MIN_RANKED = 100
SOURCES = [
    {"name": "AMFI NAVAll.txt", "url": "https://www.amfiindia.com/spages/NAVAll.txt",
     "used_for": "Scheme list, SEBI category, fund house, latest official NAV and date"},
    {"name": "mfapi.in", "url": "https://www.mfapi.in/",
     "used_for": "NAV history (free mirror of AMFI data; cross-checked against AMFI's latest NAV)"},
]


def log(*a):
    print(*a, flush=True)


def load_json(name):
    with open(os.path.join(ROOT, "config", name), encoding="utf-8") as f:
        return json.load(f)


def r4(x):
    return None if x is None else round(x, 4)


def fetch_amfi():
    last = None
    for url in AMFI_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Analyx-data-builder/1.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                text = r.read().decode("utf-8", errors="replace")
            if len(text) > 100000:
                return text
        except Exception as e:  # noqa: BLE001
            last = e
    raise SystemExit(f"Could not download AMFI NAVAll.txt: {last}")


def base_name(name):
    n = name.lower()
    n = re.sub(r"\b(direct|regular|plan|growth|option|gr|dir)\b", " ", n)
    n = re.sub(r"[^a-z0-9]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def amc_short(amc):
    return re.sub(r"\s+mutual\s+fund\s*$", "", amc.strip(), flags=re.I).strip() or amc


def recommendable_categories(rules):
    cats = set()
    for risks in rules["goals"].values():
        for lst in risks.values():
            cats.update(lst)
    a = rules["age_55_plus"]
    cats.update(a["add_if_conservative"]); cats.update(a["fallback"])
    cats.update(rules["horizon"]["max_1_year"]); cats.update(rules["horizon"]["max_3_years"])
    return cats


def copy_app(out):
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(os.path.join(ROOT, "app"), out)
    os.makedirs(os.path.join(out, "config"), exist_ok=True)
    for fn in os.listdir(os.path.join(ROOT, "config")):
        if fn.endswith(".json"):
            shutil.copy(os.path.join(ROOT, "config", fn), os.path.join(out, "config", fn))
    # .nojekyll so GitHub Pages serves every file as-is
    open(os.path.join(out, ".nojekyll"), "w").close()


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "_site"))
    ap.add_argument("--cache", default=os.path.join(ROOT, ".cache", "history"))
    ap.add_argument("--amfi-file", help="use a saved NAVAll.txt instead of downloading")
    ap.add_argument("--full-refresh", action="store_true", help="ignore the cache, re-download every history")
    ap.add_argument("--limit", type=int, default=0, help="only process N funds (for quick local tests)")
    ap.add_argument("--workers", type=int, default=10)
    args = ap.parse_args()

    now = datetime.now(IST)
    today = now.date()
    rules = load_json("profile_rules.json")
    scoring = load_json("scoring.json")
    macro = load_json("macro.json")
    bcfg = load_json("benchmarks.json")
    rf = float(macro["risk_free_rate"]["value"])
    warnings = []

    copy_app(args.out)
    data_dir = os.path.join(args.out, "data")

    # ---- 1. AMFI ----
    text = open(args.amfi_file, encoding="utf-8").read() if args.amfi_file else fetch_amfi()
    parsed = parse_navall(text)
    schemes = parsed["schemes"]
    open_schemes = [s for s in schemes if s["open_ended"]]
    latest = max(s["date"] for s in open_schemes)
    active = [s for s in open_schemes if (latest - s["date"]).days <= ACTIVE_WINDOW_DAYS]
    unmapped_active = {}
    for s in active:
        if s["category"] is None:
            unmapped_active[s["name"][:60]] = s["date"].isoformat()
    if unmapped_active:
        warnings.append(f"{len(unmapped_active)} active schemes had an unrecognised AMFI category and were excluded")
    log(f"AMFI: {len(schemes)} rows, latest NAV date {latest}, {len(active)} active open-ended schemes")

    wanted = recommendable_categories(rules)
    universe = [s for s in active if s["plan"] == "Direct" and s["growth"] and s["category"] in wanted]
    universe.sort(key=lambda s: int(s["code"]))
    if args.limit:
        # keep a spread across categories for quick tests
        by_cat = {}
        for s in universe:
            by_cat.setdefault(s["category"], []).append(s)
        per = max(1, args.limit // max(1, len(by_cat)))
        universe = [s for lst in by_cat.values() for s in lst[:per]]

    # ---- 2. benchmark candidates ----
    bench_candidates = {}
    for key, ix in bcfg["indices"].items():
        m, ex = re.compile(ix["match"], re.I), re.compile(ix["exclude"], re.I)
        c = [s for s in active if s["plan"] == "Direct" and s["growth"]
             and m.search(s["name"]) and not ex.search(s["name"])]
        c.sort(key=lambda s: int(s["code"]))
        bench_candidates[key] = c[:4]

    to_fetch = {s["code"]: s for s in universe}
    for c in bench_candidates.values():
        for s in c:
            to_fetch.setdefault(s["code"], s)
    log(f"Fetching NAV history for {len(to_fetch)} schemes ({len(universe)} funds + benchmark candidates)")

    histories, failures, notes = {}, {}, {}
    modes = {}

    def work(s):
        series, info = get_history(s["code"], args.cache, today, args.full_refresh)
        series, note = reconcile_with_amfi(series, s["date"], s["nav"])
        return series, info, note

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, s): code for code, s in to_fetch.items()}
        done = 0
        for fut in as_completed(futs):
            code = futs[fut]
            done += 1
            try:
                series, info, note = fut.result()
                histories[code] = series
                modes[info["mode"]] = modes.get(info["mode"], 0) + 1
                if note and "used AMFI" in note:
                    notes[code] = note
            except Exception as e:  # noqa: BLE001
                failures[code] = str(e)[:200]
            if done % 100 == 0:
                log(f"  {done}/{len(futs)}")
    log(f"Histories: {len(histories)} ok, {len(failures)} failed, modes {modes}")
    if notes:
        warnings.append(f"{len(notes)} schemes: mfapi NAV differed from AMFI on the latest date; AMFI value used")

    # ---- 3. resolve benchmarks (longest-running matching index fund) ----
    bench = {}
    for key, cands in bench_candidates.items():
        ok = [s for s in cands if s["code"] in histories]
        if not ok:
            warnings.append(f"No benchmark fund found for {bcfg['indices'][key]['name']}")
            continue
        best = min(ok, key=lambda s: (histories[s["code"]][0][0], int(s["code"])))
        ser = histories[best["code"]]
        bench[key] = {
            "key": key, "index": bcfg["indices"][key]["name"], "scheme_code": best["code"],
            "fund_name": best["name"], "since": ser[0][0].isoformat(), "as_of": ser[-1][0].isoformat(),
            "return_1y": r4(period_return(ser, 1)), "return_3y": r4(period_return(ser, 3)),
            "return_5y": r4(period_return(ser, 5)), "series": ser,
        }
        log(f"Benchmark {key}: {best['name']} ({best['code']}) since {ser[0][0]}")

    # ---- 4. metrics ----
    min_years = scoring["min_history_years"]
    funds, new_funds = [], 0
    bad_ticks = 0
    for s in universe:
        ser = histories.get(s["code"])
        if not ser:
            continue
        ser, removed = remove_bad_ticks(ser, s["asset_type"])
        bad_ticks += removed
        histories[s["code"]] = ser
        if history_years(ser) < min_years:
            new_funds += 1
            continue
        bkey = bcfg["category_benchmark"].get(s["category"])
        bser = bench[bkey]["series"] if bkey in bench else None
        m = compute_all(ser, rf, bser)
        funds.append({
            "code": s["code"], "name": s["name"], "amc": amc_short(s["amc"]), "category": s["category"],
            "asset_type": s["asset_type"], "plan": "Direct", "option": "Growth",
            "nav": ser[-1][1], "nav_date": ser[-1][0].isoformat(), "inception": ser[0][0].isoformat(),
            "history_years": round(history_years(ser), 2),
            "benchmark": bkey if bkey in bench else None,
            "metrics": m, "_base": base_name(s["name"]),
        })
    if bad_ticks:
        warnings.append(f"Removed {bad_ticks} one-day NAV spikes that fully reversed next day (data errors)")

    # de-duplicate the same fund listed under two codes (keep the longest history)
    seen = {}
    for f in funds:
        k = (f["amc"].lower(), f["_base"])
        if k not in seen or f["history_years"] > seen[k]["history_years"]:
            seen[k] = f
    dupes = len(funds) - len(seen)
    funds = list(seen.values())

    # ---- 5. rank within category ----
    by_cat = {}
    for f in funds:
        by_cat.setdefault(f["category"], []).append(f)
    for lst in by_cat.values():
        rank_category(lst, scoring)

    # ---- 6. write data ----
    def public(f):
        return {
            "code": f["code"], "name": f["name"], "amc": f["amc"], "category": f["category"],
            "asset_type": f["asset_type"], "plan": f["plan"], "option": f["option"],
            "nav": f["nav"], "nav_date": f["nav_date"], "inception": f["inception"],
            "history_years": f["history_years"], "benchmark": f["benchmark"],
            "metrics": {k: r4(v) for k, v in f["metrics"].items()},
            "percentiles": {k: r4(v) for k, v in f["percentiles"].items()},
            "score": r4(f["score"]), "rank": f.get("rank"), "peers": f.get("peers"),
        }

    pub = [public(f) for f in sorted(funds, key=lambda f: (f["category"], f.get("rank") or 9999))]
    write_json(os.path.join(data_dir, "funds.json"), {"nav_as_of": latest.isoformat(), "funds": pub})
    for p in pub:
        ser = histories[p["code"]]
        write_json(os.path.join(data_dir, "funds", f"{p['code']}.json"),
                   {"fund": p, "series": [[d.isoformat(), v] for d, v in downsample(ser)]})

    cards = []
    for key, b in bench.items():
        write_json(os.path.join(data_dir, "benchmarks", f"{key}.json"),
                   {"key": key, "series": [[d.isoformat(), v] for d, v in downsample(b["series"])]})
    for key in bcfg["cards"]:
        if key not in bench:
            continue
        b = bench[key]
        cards.append({"key": key, "index": b["index"], "fund_name": b["fund_name"], "scheme_code": b["scheme_code"],
                      "as_of": b["series"][-1][0].isoformat(),
                      "return_1y": r4(period_return(b["series"], 1)),
                      "return_3y": r4(period_return(b["series"], 3)),
                      "return_5y": r4(period_return(b["series"], 5))})
    write_json(os.path.join(data_dir, "benchmarks.json"), {"cards": cards})

    fail_ratio = len(failures) / max(1, len(to_fetch))
    ranked = len(pub)
    meta = {
        "built_at": now.isoformat(timespec="seconds"),
        "nav_as_of": latest.isoformat(),
        "sample": False,
        "sources": SOURCES,
        "macro": macro,
        "counts": {
            "amfi_rows": len(schemes), "active_open_ended": len(active), "universe": len(universe),
            "fetched": len(histories), "failed": len(failures), "ranked": ranked,
            "too_new_to_rank": new_funds, "duplicates_merged": dupes,
            "per_category": {c: len(v) for c, v in sorted(by_cat.items())},
        },
        "benchmarks": {k: {kk: vv for kk, vv in b.items() if kk != "series"} for k, b in bench.items()},
        "warnings": warnings,
        "failed_codes": dict(list(failures.items())[:50]),
    }
    write_json(os.path.join(data_dir, "meta.json"), meta)
    sw = os.path.join(args.out, "sw.js")
    if os.path.exists(sw):
        stamp = re.sub(r"[^0-9A-Za-z]", "", meta["built_at"])
        with open(sw, encoding="utf-8") as f:
            body = f.read().replace("__BUILD__", stamp)
        with open(sw, "w", encoding="utf-8") as f:
            f.write(body)
    log(f"Wrote {ranked} ranked funds, {len(cards)} benchmark cards -> {data_dir}")
    for w in warnings:
        log("WARNING:", w)

    # ---- 7. quality gates ----
    problems = []
    if fail_ratio > MAX_FAIL_RATIO:
        problems.append(f"{len(failures)} of {len(to_fetch)} histories failed ({fail_ratio:.1%} > 2%)")
    if (today - latest).days > STALE_LIMIT_DAYS:
        problems.append(f"AMFI latest NAV date {latest} is more than {STALE_LIMIT_DAYS} days old")
    if not args.limit and ranked < MIN_RANKED:
        problems.append(f"only {ranked} funds ranked (expected at least {MIN_RANKED})")
    if problems:
        for p in problems:
            log("ERROR:", p)
        log("Build FAILED - the site will not be updated (yesterday's data stays live).")
        sys.exit(1)
    log("Build OK")


if __name__ == "__main__":
    main()
