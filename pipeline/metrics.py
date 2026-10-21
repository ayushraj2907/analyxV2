"""The one and only metrics engine. Every number the app shows comes from here.

Input series: list of (datetime.date, nav) sorted by date, oldest first.
All returns/ratios are returned as plain floats (percent values are in %).
A metric that cannot be computed honestly returns None - never a guess.

Definitions
- Point-to-point return over N years: start NAV = last NAV on or before
  (end date - N years). If that NAV is more than 7 days before the target date
  the value is None. 1Y is the absolute return; longer periods are CAGR using
  actual days / 365.
- Monthly returns use calendar month-end NAVs (last NAV in each month) for the
  36 complete months before the month of the latest NAV.
- Std dev = sample std of monthly returns x sqrt(12).
- Sharpe = (mean monthly return - rf_m) / std x sqrt(12); rf_m = (1+rf)^(1/12)-1.
- Sortino = (mean - rf_m) / downside deviation x sqrt(12), where downside
  deviation = sqrt(mean(min(0, r - rf_m)^2)) over ALL months.
- Beta = cov(fund, benchmark) / var(benchmark) on the same 36 months.
- Alpha (Jensen) = [(mean_f - rf_m) - beta (mean_b - rf_m)] x 12, in %.
- Max drawdown = worst peak-to-trough fall on daily NAVs (last 3Y and since inception).
- Consistency = % of rolling 3-year windows (monthly steps) where the fund's
  CAGR beat the benchmark's. Needs at least 12 windows.
"""
import math
from datetime import date, timedelta

MAX_GAP_DAYS = 7
MONTHS = 36


def years_before(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year - years)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year - years, day=28)


def nav_on_or_before(series, target: date):
    """Binary search: last (date, nav) with date <= target, or None."""
    lo, hi = 0, len(series) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= target:
            best = series[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def period_return(series, years: int):
    """Percent. 1Y absolute; >1Y CAGR. None if history doesn't reach."""
    if not series:
        return None
    end_d, end_v = series[-1]
    target = years_before(end_d, years)
    start = nav_on_or_before(series, target)
    if start is None or (target - start[0]).days > MAX_GAP_DAYS:
        return None
    start_d, start_v = start
    if start_v <= 0 or end_v <= 0:
        return None
    ratio = end_v / start_v
    if years == 1:
        return (ratio - 1) * 100
    days = (end_d - start_d).days
    return (ratio ** (365.0 / days) - 1) * 100


def month_ends(series):
    """{(year, month): nav} using the last NAV of each calendar month."""
    out = {}
    for d, v in series:
        out[(d.year, d.month)] = v
    return out


def _prev_month(ym, k=1):
    y, m = ym
    m -= k
    while m <= 0:
        m += 12
        y -= 1
    return (y, m)


def monthly_returns(series, months=MONTHS):
    """Ordered list of ((y, m), return) for the `months` complete months before
    the month of the latest NAV. None if any month-end is missing."""
    if not series:
        return None
    me = month_ends(series)
    last_complete = _prev_month((series[-1][0].year, series[-1][0].month))
    keys = [_prev_month(last_complete, k) for k in range(months, -1, -1)]  # months+1 points
    if any(k not in me for k in keys):
        return None
    out = []
    for i in range(1, len(keys)):
        p, c = me[keys[i - 1]], me[keys[i]]
        out.append((keys[i], c / p - 1))
    return out


def _mean(xs):
    return sum(xs) / len(xs)


def _stdev(xs):
    if len(xs) < 2:
        return None
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def risk_metrics(series, rf_annual_pct, bench_series=None):
    """Std dev, Sharpe, Sortino, beta, alpha over the last 36 complete months."""
    out = {"std_dev": None, "sharpe": None, "sortino": None, "beta": None, "alpha": None}
    mr = monthly_returns(series)
    if mr is None:
        return out
    r = [x for _, x in mr]
    rf_m = (1 + rf_annual_pct / 100) ** (1 / 12) - 1
    sd = _stdev(r)
    mean = _mean(r)
    if sd and sd > 0:
        out["std_dev"] = sd * math.sqrt(12) * 100
        out["sharpe"] = (mean - rf_m) / sd * math.sqrt(12)
    dd = math.sqrt(_mean([min(0.0, x - rf_m) ** 2 for x in r]))
    if dd > 0:
        out["sortino"] = (mean - rf_m) / dd * math.sqrt(12)
    if bench_series:
        br = monthly_returns(bench_series)
        if br is not None:
            bmap = dict(br)
            pairs = [(x, bmap[k]) for k, x in mr if k in bmap]
            if len(pairs) == MONTHS:
                f = [a for a, _ in pairs]
                b = [c for _, c in pairs]
                mf, mb = _mean(f), _mean(b)
                cov = sum((x - mf) * (y - mb) for x, y in pairs) / (len(pairs) - 1)
                var = sum((y - mb) ** 2 for y in b) / (len(b) - 1)
                if var > 0:
                    beta = cov / var
                    out["beta"] = beta
                    out["alpha"] = ((mf - rf_m) - beta * (mb - rf_m)) * 12 * 100
    return out


def max_drawdown(series, since: date = None):
    """Worst peak-to-trough fall in %, as a positive number. None if < 2 points."""
    pts = [v for d, v in series if since is None or d >= since]
    if len(pts) < 2:
        return None
    peak = pts[0]
    worst = 0.0
    for v in pts:
        if v > peak:
            peak = v
        dd = (peak - v) / peak
        if dd > worst:
            worst = dd
    return worst * 100


def rolling_consistency(series, bench_series, window_years=3, min_windows=12):
    """% of rolling windows (monthly steps) where fund CAGR > benchmark CAGR."""
    if not series or not bench_series:
        return None
    fm, bm = month_ends(series), month_ends(bench_series)
    common = sorted(set(fm) & set(bm))
    common_set = set(common)
    n = window_years * 12
    last_complete = _prev_month((series[-1][0].year, series[-1][0].month))
    wins = total = 0
    for k in common:
        if k > last_complete:
            continue
        s = _prev_month(k, n)
        if s not in common_set:
            continue
        f = (fm[k] / fm[s]) ** (1 / window_years)
        b = (bm[k] / bm[s]) ** (1 / window_years)
        total += 1
        if f > b:
            wins += 1
    if total < min_windows:
        return None
    return wins / total * 100


def history_years(series):
    if len(series) < 2:
        return 0.0
    return (series[-1][0] - series[0][0]).days / 365.25


def compute_all(series, rf_annual_pct, bench_series=None):
    """Full metric set for one fund. Same function for list and detail views."""
    end = series[-1][0]
    m = {
        "return_1y": period_return(series, 1),
        "return_3y": period_return(series, 3),
        "return_5y": period_return(series, 5),
        "return_10y": period_return(series, 10),
        "max_drawdown_3y": max_drawdown(series, years_before(end, 3)) if history_years(series) >= 3 else None,
        "max_drawdown_all": max_drawdown(series),
        "consistency": rolling_consistency(series, bench_series) if bench_series else None,
    }
    m.update(risk_metrics(series, rf_annual_pct, bench_series))
    return m


# ---------------- data cleaning ----------------

BAD_TICK = {"equity": 0.25, "hybrid": 0.15, "debt": 0.05}


def remove_bad_ticks(series, asset_type):
    """Drop single-day spikes that fully reverse the next day (data errors).
    Real moves are kept. Returns (clean_series, removed_count)."""
    thr = BAD_TICK.get(asset_type, 0.25)
    if len(series) < 3:
        return series, 0
    keep = [series[0]]
    removed = 0
    for i in range(1, len(series) - 1):
        prev_v = keep[-1][1]
        v = series[i][1]
        nxt = series[i + 1][1]
        jump = abs(v / prev_v - 1)
        back = abs(nxt / prev_v - 1)
        if jump > thr and back < thr / 5:
            removed += 1
            continue
        keep.append(series[i])
    keep.append(series[-1])
    return keep, removed


def downsample(series, recent_days=400, step=5):
    """Every point for the last ~13 months, every `step`-th point before that.
    The first and last points are always kept."""
    if not series:
        return []
    cutoff = series[-1][0] - timedelta(days=recent_days)
    old = [p for p in series if p[0] < cutoff]
    new = [p for p in series if p[0] >= cutoff]
    sampled = old[::step]
    if old and sampled[-1] != old[-1]:
        sampled.append(old[-1])
    return sampled + new
