"""NAV history from mfapi.in with an on-disk cache and incremental updates.

mfapi.in is a free, community-run mirror of AMFI data (no API key, no SLA).
Every history is cross-checked against today's official AMFI NAV.
"""
import json
import os
import time
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta

BASES = ["https://api.mfapi.in/mf", "https://cdn.mfapi.in/mf"]
UA = "Analyx-data-builder/1.0 (+https://github.com)"
TIMEOUT = 40
RETRIES = 3


def _get_json(url):
    last_err = None
    for attempt in range(RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError, ConnectionError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last_err}")


def _parse(payload):
    if not isinstance(payload, dict) or payload.get("status") != "SUCCESS":
        raise RuntimeError("mfapi returned no data")
    pts = {}
    for item in payload.get("data", []):
        try:
            d = datetime.strptime(item["date"], "%d-%m-%Y").date()
            v = float(item["nav"])
        except (KeyError, ValueError, TypeError):
            continue
        if v > 0:
            pts[d] = v
    return sorted(pts.items())


def _fetch(code, start: date = None, end: date = None):
    q = ""
    if start:
        q = f"?startDate={start.isoformat()}&endDate={(end or date.today()).isoformat()}"
    err = None
    for base in BASES:
        try:
            return _parse(_get_json(f"{base}/{code}{q}"))
        except RuntimeError as e:
            err = e
    raise RuntimeError(str(err))


def _load(path):
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        return [(date.fromisoformat(d), v) for d, v in raw["data"]]
    except (OSError, ValueError, KeyError):
        return None


def _save(path, code, series):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"code": code, "saved": datetime.utcnow().isoformat() + "Z",
                   "data": [[d.isoformat(), v] for d, v in series]}, f, separators=(",", ":"))
    os.replace(tmp, path)


def _close(a, b, tol=1e-4):
    return abs(a - b) <= tol * max(abs(a), abs(b))


def get_history(code, cache_dir, today: date, full_refresh=False):
    """Return (series, info). Raises RuntimeError on failure (never caches failures)."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{code}.json")
    cached = None if full_refresh else _load(path)
    info = {"mode": "full"}
    series = None
    if cached and cached[-1][0] >= today - timedelta(days=45):
        start = cached[-1][0] - timedelta(days=10)
        try:
            recent = _fetch(code, start, today + timedelta(days=1))
            old = dict(cached)
            overlap_ok = all(_close(old[d], v) for d, v in recent if d in old)
            if overlap_ok:
                merged = dict(cached)
                merged.update(recent)
                series = sorted(merged.items())
                info["mode"] = "incremental"
            else:
                info["mode"] = "full (cache disagreed with source)"
        except RuntimeError:
            series = None
    if series is None:
        series = _fetch(code)
    if not series:
        raise RuntimeError("empty history")
    _save(path, code, series)
    return series, info


def reconcile_with_amfi(series, amfi_date, amfi_nav):
    """Make sure the official AMFI NAV is the last point. Returns (series, note)."""
    d = dict(series)
    note = None
    if amfi_date in d:
        if not _close(d[amfi_date], amfi_nav):
            note = f"mfapi {d[amfi_date]} != AMFI {amfi_nav} on {amfi_date}; used AMFI"
            d[amfi_date] = amfi_nav
    elif amfi_date > series[-1][0]:
        d[amfi_date] = amfi_nav
        note = "appended today's AMFI NAV"
    out = sorted(d.items())
    # drop anything after the official date (should not happen)
    return [p for p in out if p[0] <= amfi_date], note
