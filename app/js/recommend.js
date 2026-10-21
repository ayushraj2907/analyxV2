// Turn a profile into eligible categories and pick the top funds.
// Pure functions: no DOM, so they can be unit-tested with node --test.

export function categoriesFor(profile, rules) {
  const { goal, risk, age_group: age, horizon_years: horizon } = profile;
  const notes = [];
  let cats = [...((rules.goals[goal] || rules.goals['Wealth Creation'])[risk] || [])];

  const a = rules.age_55_plus;
  if (age === '55+' && !a.exempt_goals.includes(goal)) {
    cats = cats.filter((c) => !a.remove_always.includes(c));
    if (risk === 'Conservative') {
      cats = cats.filter((c) => !a.remove_if_conservative.includes(c));
      for (const c of a.add_if_conservative) if (!cats.includes(c)) cats.push(c);
    }
    if (!cats.length) cats = [...a.fallback];
    notes.push('note55');
  }

  const h = rules.horizon;
  if (!h.exempt_goals.includes(goal)) {
    if (horizon <= 1) { cats = [...h.max_1_year]; notes.push('noteH1'); }
    else if (horizon <= 3) { cats = [...h.max_3_years]; notes.push('noteH3'); }
  }
  if (goal === 'Tax Saving' && horizon < 3) notes.push('noteElssLock');
  return { categories: cats, notes };
}

export function pickTop(funds, categories, rules) {
  const n = rules.top_n || 10;
  const cap = rules.max_per_fund_house || 2;
  const pool = funds
    .filter((f) => categories.includes(f.category) && f.score != null)
    .sort((a, b) => (b.score - a.score) || ((b.metrics.return_3y ?? -1e9) - (a.metrics.return_3y ?? -1e9)));
  const out = [];
  const perAmc = {};
  for (const f of pool) {
    if (out.length >= n) break;
    const k = f.amc.toLowerCase();
    if ((perAmc[k] || 0) >= cap) continue;
    perAmc[k] = (perAmc[k] || 0) + 1;
    out.push(f);
  }
  return { top: out, poolSize: pool.length };
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
