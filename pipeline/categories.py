"""Map AMFI category headers to one SEBI peer group.

AMFI's NAVAll.txt is mid-way through SEBI's category renaming, so the same
peer group appears under old and new names (e.g. "Debt Scheme - Low Duration
Fund" and "Income/Debt Oriented Schemes - Ultra Short to Short Term Fund").
Both map to one canonical group so funds are ranked against all their peers.
Anything not recognised is returned as None and excluded (and counted in the
build warnings) - it is never dumped into an "Other" bucket.
"""
import re

# (family regex, name regex, canonical group, asset type)
# Checked in order; the first match wins.
RULES = [
    # ---- Equity ----
    (r"^equity schemes?", r"large\s*&\s*mid\s*cap", "Large & Mid Cap", "equity"),
    (r"^equity schemes?", r"large\s*cap", "Large Cap", "equity"),
    (r"^equity schemes?", r"mid\s*cap", "Mid Cap", "equity"),
    (r"^equity schemes?", r"small\s*cap", "Small Cap", "equity"),
    (r"^equity schemes?", r"multi\s*cap", "Multi Cap", "equity"),
    (r"^equity schemes?", r"flexi\s*cap", "Flexi Cap", "equity"),
    (r"^equity schemes?", r"focused", "Focused", "equity"),
    (r"^equity schemes?", r"value", "Value", "equity"),
    (r"^equity schemes?", r"contra", "Contra", "equity"),
    (r"^equity schemes?", r"dividend\s*yield", "Dividend Yield", "equity"),
    (r"^equity schemes?", r"elss", "ELSS", "equity"),
    (r"^equity schemes?", r"sectoral|thematic", "Sectoral/Thematic", "equity"),
    # ---- Hybrid ----
    (r"^hybrid schemes?", r"aggressive", "Aggressive Hybrid", "hybrid"),
    (r"^hybrid schemes?", r"conservative", "Conservative Hybrid", "hybrid"),
    (r"^hybrid schemes?", r"balanced\s*advantage|dynamic\s*asset", "Balanced Advantage", "hybrid"),
    (r"^hybrid schemes?", r"balanced\s*hybrid", "Balanced Hybrid", "hybrid"),
    (r"^hybrid schemes?", r"multi\s*asset", "Multi Asset", "hybrid"),
    (r"^hybrid schemes?", r"equity\s*savings", "Equity Savings", "hybrid"),
    (r"^hybrid schemes?", r"arbitrage", "Arbitrage", "hybrid"),
    # ---- Debt: old SEBI names ("Debt Scheme - ...") and new names ("Income/Debt Oriented Schemes - ...") ----
    (r"^(debt|income/debt oriented) schemes?", r"overnight", "Overnight", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"liquid", "Liquid", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"money\s*market", "Money Market", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"ultra\s*short\s*to\s*short|low\s*duration", "Low Duration", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"ultra\s*short", "Ultra Short Duration", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"medium\s*to\s*long", "Medium to Long Duration", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"short\s*(duration|term)", "Short Duration", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"medium\s*(duration|term)", "Medium Duration", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"long\s*(duration|term)", "Long Duration", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"dynamic\s*(bond|term)", "Dynamic Bond", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"corporate\s*bond", "Corporate Bond", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"credit\s*risk", "Credit Risk", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"banking\s*(and|&)\s*psu", "Banking and PSU", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"10[\s-]*year|constant\s*(duration|maturity)", "Gilt 10Y Constant", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"gilt", "Gilt", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"floater|floating", "Floater", "debt"),
    (r"^(debt|income/debt oriented) schemes?", r"sectoral", "Debt Sectoral", "debt"),
    # ---- Solution oriented ----
    (r"^solution oriented schemes?", r"retirement", "Retirement", "solution"),
    (r"^solution oriented schemes?", r"children", "Children's", "solution"),
    (r"^children", r"children", "Children's", "solution"),
    (r"^life cycle", r".*", "Life Cycle", "solution"),
    # ---- Passive / FoF ----
    (r"^index funds?", r"equity", "Index Fund (Equity)", "passive"),
    (r"^index funds?", r"debt", "Index Fund (Debt)", "passive"),
    (r"^index funds?", r"hybrid", "Index Fund (Hybrid)", "passive"),
    (r"^other schemes?", r"index", "Index Fund", "passive"),
    (r"^other schemes?", r"gold\s*etf", "ETF", "passive"),
    (r"^other schemes?", r"etf", "ETF", "passive"),
    (r"^exchange traded", r".*", "ETF", "passive"),
    (r"^other schemes?", r"fof\s*overseas", "FoF Overseas", "fof"),
    (r"^other schemes?", r"fof\s*domestic", "FoF Domestic", "fof"),
    (r"^overseas fund of funds", r".*", "FoF Overseas", "fof"),
    (r"^fund of funds", r".*", "FoF Domestic", "fof"),
]

_COMPILED = [(re.compile(f), re.compile(n), c, t) for f, n, c, t in RULES]


def _norm(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'")
    s = re.sub(r"\*+", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def classify_header(header: str):
    """Return (canonical_group, asset_type, open_ended) or (None, None, open_ended).

    header looks like 'Open Ended Schemes(Equity Scheme - Large Cap Fund)'.
    Close-ended and interval schemes are reported as not open-ended.
    """
    h = _norm(header)
    open_ended = h.startswith("open ended")
    m = re.match(r"^[^(]*\((.*)\)\s*$", h)
    if not m:
        return None, None, open_ended
    inner = m.group(1)
    if " - " in inner:
        family, name = inner.split(" - ", 1)
    else:
        family, name = inner, ""
    family, name = family.strip(), name.strip()
    for fre, nre, canon, typ in _COMPILED:
        if fre.search(family) and nre.search(name):
            return canon, typ, open_ended
    return None, None, open_ended
