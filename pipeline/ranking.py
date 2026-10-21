"""Percentile ranking inside each SEBI category."""


def percentile(values, x, lower_is_better=False):
    """Share of peers this value beats (ties count half), 0-100."""
    n = len(values)
    if n == 0:
        return None
    if n == 1:
        return 50.0
    if lower_is_better:
        better = sum(1 for v in values if v > x)
    else:
        better = sum(1 for v in values if v < x)
    equal = sum(1 for v in values if v == x) - 1  # exclude itself
    return (better + 0.5 * equal) / (n - 1) * 100


def rank_category(funds, scoring):
    """funds: list of dicts with 'metrics'. Adds 'percentiles', 'score', 'rank', 'peers'."""
    weights = scoring["weights"]
    lower = set(scoring.get("lower_is_better", []))
    values = {k: [f["metrics"][k] for f in funds if f["metrics"].get(k) is not None] for k in weights}
    for f in funds:
        pct = {}
        num = den = 0.0
        for k, w in weights.items():
            v = f["metrics"].get(k)
            if v is None:
                pct[k] = None
                continue
            p = percentile(values[k], v, k in lower)
            pct[k] = p
            num += w * p
            den += w
        f["percentiles"] = pct
        f["score"] = num / den if den else None
        f["weights_used"] = den
    ordered = sorted([f for f in funds if f["score"] is not None],
                     key=lambda f: (-f["score"], -(f["metrics"].get("return_3y") or -1e9)))
    for i, f in enumerate(ordered, 1):
        f["rank"] = i
        f["peers"] = len(ordered)
    return funds
