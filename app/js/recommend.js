// Turn a profile into eligible categories and pick the top funds.
// Pure functions: no DOM, so they can be unit-tested with node --test.

export function categoriesFor(profile, rules) {
  const { goal, risk, age_group: age, horizon_years: horizon } = profile;
  const notes = [];
  let cats = [...((rules.goals[goal] || rules.goals['Wealth Creation'])[risk] || [])];
  const drop = (list) => { cats = cats.filter((c) => !list.includes(c)); };
  const add = (list) => { for (const c of list) if (!cats.includes(c)) cats.push(c); };

  const a = rules.age_55_plus;
  if (age === '55+' && !a.exempt_goals.includes(goal)) {
    drop(a.remove_always);
    if (risk === 'Conservative') { drop(a.remove_if_conservative); add(a.add_if_conservative); }
    if (!cats.length) cats = [...a.fallback];
    notes.push('note55');
  }
  const a46 = rules.age_46_55;
  if (a46 && age === '46-55' && !a46.exempt_goals.includes(goal) && cats.some((c) => a46.remove.includes(c))) {
    drop(a46.remove);
    if (!cats.length) cats = [...a.fallback];
    notes.push('note46');
  }

  const h = rules.horizon;
  if (!h.exempt_goals.includes(goal)) {
    if (horizon <= 1) { cats = [...h.max_1_year]; notes.push('noteH1'); }
    else if (horizon <= 3) { cats = [...h.max_3_years]; notes.push('noteH3'); }
    else if (h.max_5_years && horizon <= 5 && cats.some((c) => h.max_5_years.remove.includes(c))) {
      drop(h.max_5_years.remove); add(h.max_5_years.add); notes.push('noteH5');
    }
  }
  if (goal === 'Tax Saving' && horizon < 3) notes.push('noteElssLock');
  return { categories: cats, notes };
}

/** Re-score a fund for a risk level from its category percentiles (no new data, no fill-ins). */
export function riskScore(f, weights) {
  let num = 0, den = 0;
  for (const [k, w] of Object.entries(weights)) {
    const p = f.percentiles?.[k];
    if (p == null) continue;
    num += w * p; den += w;
  }
  return den ? num / den : null;
}

/**
 * Pick the top funds for a profile.
 * opts: { risk, horizon, scoring } - scoring is config/scoring.json (optional: falls back to stored scores).
 */
export function pickTop(funds, categories, rules, opts = {}) {
  const n = rules.top_n || 10;
  const capAmc = rules.max_per_fund_house || 2;
  const capCat = Math.max(rules.max_per_category_min || 3, Math.ceil(n / Math.max(1, categories.length)));
  const weights = opts.scoring?.risk_weights?.[opts.risk];
  const minYears = rules.min_track_record_years?.equity_long_term;
  const longTerm = (opts.horizon ?? 0) >= 5;

  // score every fund in the chosen categories for this risk level, then rank within category
  const inCats = funds.filter((f) => categories.includes(f.category) && f.score != null)
    .map((f) => ({ ...f, score: weights ? riskScore(f, weights) : f.score }));
  const byCat = {};
  for (const f of inCats) (byCat[f.category] ||= []).push(f);
  for (const list of Object.values(byCat)) {
    list.sort((a, b) => (b.score - a.score) || ((b.metrics.return_3y ?? -1e9) - (a.metrics.return_3y ?? -1e9)));
    list.forEach((f, i) => { f.rank = i + 1; f.peers = list.length; });
  }
  const ordered = inCats.sort((a, b) => (b.score - a.score) || ((b.metrics.return_3y ?? -1e9) - (a.metrics.return_3y ?? -1e9)));

  const needsRecord = (f) => longTerm && minYears && (f.asset_type === 'equity' || f.asset_type === 'hybrid') && f.history_years < minYears;
  const take = (allowYoung) => {
    const out = [], perAmc = {}, perCat = {};
    for (const f of ordered) {
      if (out.length >= n) break;
      if (!allowYoung && needsRecord(f)) continue;
      const k = f.amc.toLowerCase();
      if ((perAmc[k] || 0) >= capAmc || (perCat[f.category] || 0) >= capCat) continue;
      perAmc[k] = (perAmc[k] || 0) + 1;
      perCat[f.category] = (perCat[f.category] || 0) + 1;
      out.push(f);
    }
    return out;
  };
  let top = take(false);
  let relaxed = false;
  if (top.length < Math.min(n, 5)) { top = take(true); relaxed = true; }
  const youngSkipped = !relaxed && ordered.some(needsRecord);
  return { top, poolSize: ordered.length, youngSkipped, relaxed };
}

/** Future value of a monthly SIP (paid at the start of each month) or a lump sum.
 *  annualPct is compounded yearly; the monthly rate is (1+r)^(1/12)-1. */
export function projectCorpus({ type, amount, years, annualPct, inflationPct }) {
  const r = annualPct / 100;
  const inf = inflationPct / 100;
  const yearly = [];
  let invested = 0;
  let value = 0;
  if (type === 'SIP') {
    const i = Math.pow(1 + r, 1 / 12) - 1;
    for (let m = 1; m <= years * 12; m++) {
      value = (value + amount) * (1 + i);
      invested += amount;
      if (m % 12 === 0) yearly.push({ year: m / 12, invested, value });
    }
  } else {
    invested = amount;
    for (let y = 1; y <= years; y++) {
      value = amount * Math.pow(1 + r, y);
      yearly.push({ year: y, invested, value });
    }
  }
  const real = value / Math.pow(1 + inf, years);
  return { invested, value, gain: value - invested, real, yearly };
}

export function ageGroupFor(age) {
  if (age <= 30) return '18-30';
  if (age <= 45) return '31-45';
  if (age <= 55) return '46-55';
  return '55+';
}
