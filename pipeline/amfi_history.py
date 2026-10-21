"""Official AMFI NAV history for specific date windows.

mfapi.in skips some weekend/holiday NAVs of Liquid and Overnight funds (they
publish a NAV every calendar day). Returns depend on the exact start date and
risk figures on exact month-end NAVs, so the build downloads AMFI's own
history for those windows and merges it in. AMFI is treated as the authority:
missing days are added, and any disagreeing value is replaced by AMFI's.

Past windows never change, so each downloaded window is cached on disk.
"""
import calendar
import os
import time
import urllib.request
from datetime import date, datetime, timedelta

URL = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt={a}&todt={b}"


def years_before(d, n):
    try:
        return d.replace(year=d.year - n)
    except ValueError:
        return d.replace(year=d.year - n, day=28)


def windows(as_of: date, months=40):
    """Date windows needed: around each 1/3/5/10-year start date, and the last
    5 days of each of the last `months` months (month-end NAVs)."""
    out = []
    for yrs in (1, 3, 5, 10):
        t = years_before(as_of, yrs)
        out.append((t - timedelta(days=9), t))
    y, m = as_of.year, as_of.month
    for _ in range(months):
        m -= 1
        if m == 0:
            m, y = 12, y - 1
        last = date(y, m, calendar.monthrange(y, m)[1])
        out.append((last - timedelta(days=4), last))
    return out


def _download(a: date, b: date, cache_dir: str, today: date):
    os.makedirs(cache_dir, exist_ok=True)
    fn = os.path.join(cache_dir, f"amfi_{a.isoformat()}_{b.isoformat()}.txt")
    # a window ending within the last 7 days may still get late NAVs: refresh it
    if os.path.exists(fn) and os.path.getsize(fn) > 20000 and (today - b).days > 7:
        return fn
    url = URL.format(a=a.strftime("%d-%b-%Y"), b=b.strftime("%d-%b-%Y"))
    last = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Analyx-data-builder/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            if len(body) > 20000:
                with open(fn, "wb") as f:
                    f.write(body)
                return fn
            last = "empty response"
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"AMFI history {a}..{b}: {last}")


def _parse(fn, wanted):
    out = {}
    with open(fn, encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.strip().split(";")
            if len(p) < 8 or p[0] not in wanted:
                continue
            try:
                v = float(p[6])
                d = datetime.strptime(p[7].strip(), "%d-%b-%Y").date()
            except ValueError:
                continue
            if v > 0:
                out.setdefault(p[0], {})[d] = v
    return out


def official_points(as_of: date, wanted_codes, cache_dir: str, today: date, log=print):
    """{code: {date: nav}} from AMFI for all needed windows. Raises if a window fails."""
    wanted = set(wanted_codes)
    merged, failed = {}, []
    wins = windows(as_of)
    for i, (a, b) in enumerate(wins, 1):
        try:
            fn = _download(a, b, cache_dir, today)
        except RuntimeError as e:
            failed.append(str(e))
            continue
        for code, pts in _parse(fn, wanted).items():
            merged.setdefault(code, {}).update(pts)
        if i % 10 == 0:
            log(f"  AMFI history windows {i}/{len(wins)}")
        time.sleep(1.0)  # be gentle with AMFI's server
    return merged, failed


def merge(series, official, upto: date):
    """Add AMFI points to a (date, nav) series; AMFI wins on disagreement.
    Returns (series, added, replaced)."""
    d = dict(series)
    added = replaced = 0
    for day, v in official.items():
        if day > upto:
            continue
        if day not in d:
            d[day] = v
            added += 1
        elif abs(d[day] - v) > 1e-4 * v:
            d[day] = v
            replaced += 1
    return sorted(d.items()), added, replaced
