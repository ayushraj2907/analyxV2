// Checks EVERY investor profile against the published data.
// Run after a build:  node tests/js/verify_profiles.mjs _site
// Exit code 1 if any recommendation breaks a rule.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { categoriesFor, pickTop } from '../../app/js/recommend.js';

const site = process.argv[2] || '_site';
const J = (p) => JSON.parse(readFileSync(join(site, p), 'utf8'));
const funds = J('data/funds.json').funds;
const meta = J('data/meta.json');
const rules = J('config/profile_rules.json');
const scoring = J('config/scoring.json');
const asOf = new Date(meta.nav_as_of + 'T00:00:00Z');

const goals = Object.keys(rules.goals);
const risks = ['Conservative', 'Moderate', 'Aggressive'];
const ages = ['18-30', '31-45', '46-55', '55+'];
const horizons = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30];
const DEBT_SHORT = new Set(rules.horizon.max_3_years);
const problems = [];
let profiles = 0, recs = 0;
const lists = new Set();
const riskDiffers = { same: 0, differ: 0 };

function indepScore(f, risk) {
  const w = scoring.risk_weights[risk];
  let n = 0, d = 0;
  for (const [k, wt] of Object.entries(w)) { const p = f.percentiles[k]; if (p == null) continue; n += wt * p; d += wt; }
  return d ? n / d : null;
}

for (const goal of goals) for (const age of ages) for (const h of horizons) {
  const perRisk = {};
  for (const risk of risks) {
    profiles++;
    const p = { goal, risk, age_group: age, horizon_years: h };
    const { categories, notes } = categoriesFor(p, rules);
    const r = pickTop(funds, categories, rules, { risk, horizon: h, scoring });
    const top = r.top;
    const tag = `${goal}/${risk}/${age}/${h}y`;
    perRisk[risk] = top.map((f) => f.code).join(',');
    lists.add(perRisk[risk]);
    recs += top.length;

    // category rules
    const exemptH = rules.horizon.exempt_goals.includes(goal);
    if (goal === 'Tax Saving' && categories.some((c) => c !== 'ELSS')) problems.push(`${tag}: tax saving must be ELSS only`);
    if (!exemptH && h <= 1 && categories.some((c) => !rules.horizon.max_1_year.includes(c))) problems.push(`${tag}: 1-year horizon must be liquid/overnight`);
    if (!exemptH && h > 1 && h <= 3 && categories.some((c) => !DEBT_SHORT.has(c))) problems.push(`${tag}: <=3y must be short debt`);
    if (!exemptH && h > 3 && h <= 5 && categories.some((c) => c === 'Small Cap' || c === 'Mid Cap')) problems.push(`${tag}: <=5y must not include small/mid cap`);
    if (age === '55+' && !rules.age_55_plus.exempt_goals.includes(goal) && categories.some((c) => c === 'Small Cap' || c === 'Mid Cap')) problems.push(`${tag}: 55+ must not include small/mid cap`);
    if (age === '46-55' && !rules.age_46_55.exempt_goals.includes(goal) && categories.includes('Small Cap')) problems.push(`${tag}: 46-55 must not include small cap`);
    if (!top.length) problems.push(`${tag}: no funds`);

    const seen = new Set(), perAmc = {}, perCat = {};
    let prev = Infinity;
    for (const f of top) {
      if (seen.has(f.code)) problems.push(`${tag}: duplicate ${f.name}`);
      seen.add(f.code);
      if (!categories.includes(f.category)) problems.push(`${tag}: ${f.name} category ${f.category} not allowed`);
      if (f.plan !== 'Direct' || f.option !== 'Growth') problems.push(`${tag}: ${f.name} not Direct-Growth`);
      const age_d = (asOf - new Date(f.nav_date + 'T00:00:00Z')) / 864e5;
      if (age_d > 7) problems.push(`${tag}: ${f.name} NAV is ${age_d} days old`);
      if (f.history_years < 3) problems.push(`${tag}: ${f.name} has under 3 years of history`);
      if (h >= 5 && !r.relaxed && (f.asset_type === 'equity' || f.asset_type === 'hybrid') && f.history_years < rules.min_track_record_years.equity_long_term) problems.push(`${tag}: ${f.name} under 5-year record`);
      perAmc[f.amc] = (perAmc[f.amc] || 0) + 1;
      perCat[f.category] = (perCat[f.category] || 0) + 1;
      const s = indepScore(funds.find((x) => x.code === f.code), risk);
      if (Math.abs(s - f.score) > 1e-9) problems.push(`${tag}: ${f.name} score ${f.score} vs independent ${s}`);
      if (f.score > prev + 1e-9) problems.push(`${tag}: list not sorted by score`);
      prev = f.score;
      const pub = funds.find((x) => x.code === f.code);
      for (const k of Object.keys(pub.metrics)) if (pub.metrics[k] !== f.metrics[k]) problems.push(`${tag}: ${f.name} ${k} differs from published data`);
    }
    if (Object.values(perAmc).some((c) => c > rules.max_per_fund_house)) problems.push(`${tag}: more than ${rules.max_per_fund_house} funds from one fund house`);

    // nothing better was skipped without a rule: every higher-scoring eligible fund must be blocked by a cap or the record rule
    if (top.length) {
      const minScore = top[top.length - 1].score;
      const capCat = Math.max(rules.max_per_category_min || 3, Math.ceil((rules.top_n || 10) / Math.max(1, categories.length)));
      for (const f of funds) {
        if (!categories.includes(f.category) || seen.has(f.code)) continue;
        const s = indepScore(f, risk);
        if (s == null || s <= minScore) continue;
        const young = h >= 5 && !r.relaxed && (f.asset_type === 'equity' || f.asset_type === 'hybrid') && f.history_years < rules.min_track_record_years.equity_long_term;
        const amcFull = (perAmc[f.amc] || 0) >= rules.max_per_fund_house;
        const catFull = (perCat[f.category] || 0) >= capCat;
        if (!young && !amcFull && !catFull) problems.push(`${tag}: ${f.name} (score ${s.toFixed(1)}) skipped without a reason`);
      }
    }
  }
  if (perRisk.Conservative === perRisk.Aggressive) riskDiffers.same++; else riskDiffers.differ++;
}

const report = { profiles, recommendations: recs, distinct_lists: lists.size, risk_changes_list: riskDiffers, problems: problems.slice(0, 200), ok: !problems.length };
writeFileSync(join(site, 'data', 'verification_profiles.json'), JSON.stringify(report, null, 1));
console.log(`Profiles checked: ${profiles} (6 goals x 3 risks x 4 ages x 10 time frames)`);
console.log(`Recommendations checked: ${recs}; distinct lists: ${lists.size}`);
console.log(`Low vs high risk give a different list in ${riskDiffers.differ} of ${riskDiffers.differ + riskDiffers.same} goal/age/time-frame combinations`);
if (problems.length) { console.log('\nPROBLEMS:'); problems.slice(0, 40).forEach((p) => console.log(' -', p)); process.exit(1); }
console.log('All recommendations follow the rules and use the verified numbers.');
