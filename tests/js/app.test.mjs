// Run: node --test tests/js/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProfile } from '../../app/js/parse.js';
import { toSpokenHindi, spokenAmount, spokenPct } from '../../app/js/speech.js';
import { categoriesFor, pickTop, projectCorpus, riskScore } from '../../app/js/recommend.js';

const rules = JSON.parse(readFileSync(new URL('../../config/profile_rules.json', import.meta.url)));
const scoring = JSON.parse(readFileSync(new URL('../../config/scoring.json', import.meta.url)));

test('English sentence', () => {
  const p = parseProfile('SIP of ₹10,000 a month for 20 years, medium risk, I am 32');
  assert.equal(p.type, 'SIP');
  assert.equal(p.amount, 10000);
  assert.equal(p.horizon_years, 20);
  assert.equal(p.risk, 'Moderate');
  assert.equal(p.age_group, '31-45');
});

test('Typos are fixed', () => {
  const p = parseProfile('Agresive SIP ₹25000 mounthly, 30 yeer harizon');
  assert.equal(p.risk, 'Aggressive');
  assert.equal(p.amount, 25000);
  assert.equal(p.horizon_years, 30);
});

test('Hindi words for numbers', () => {
  const p = parseProfile('मैं हर महीने दस हज़ार रुपये की SIP करना चाहता हूँ, बीस साल के लिए, मध्यम जोखिम');
  assert.equal(p.amount, 10000);
  assert.equal(p.horizon_years, 20);
  assert.equal(p.risk, 'Moderate');
  assert.equal(p.type, 'SIP');
});

test('Hindi age vs horizon', () => {
  const p = parseProfile('मेरी उम्र 58 साल है, रिटायरमेंट के लिए ढाई लाख एक बार लगाना है, 5 साल, कम जोखिम');
  assert.equal(p.age_group, '55+');
  assert.equal(p.goal, 'Retirement');
  assert.equal(p.amount, 250000);
  assert.equal(p.type, 'Lumpsum');
  assert.equal(p.horizon_years, 5);
  assert.equal(p.risk, 'Conservative');
});

test('Hinglish shorthand', () => {
  const p = parseProfile('10k SIP for child education 15 saal, high risk');
  assert.equal(p.amount, 10000);
  assert.equal(p.goal, 'Child Education');
  assert.equal(p.horizon_years, 15);
  assert.equal(p.risk, 'Aggressive');
});

test('Lakh and crore', () => {
  assert.equal(parseProfile('lumpsum 5 lakh').amount, 500000);
  assert.equal(parseProfile('1.5 crore one time').amount, 15000000);
  assert.equal(parseProfile('पाँच लाख एकमुश्त').amount, 500000);
  assert.equal(parseProfile('साढ़े तीन लाख').amount, 350000);
  assert.equal(parseProfile('५०००० रुपये महीने').amount, 50000);
});

test('Hindi spoken numbers', () => {
  assert.equal(toSpokenHindi(12.5), 'बारह दशमलव पाँच');
  assert.equal(toSpokenHindi(1234567, 0), 'बारह लाख चौंतीस हज़ार पाँच सौ सड़सठ');
  assert.equal(spokenAmount(10000, 'hi'), 'दस हज़ार रुपये');
  assert.equal(spokenAmount(25000000, 'en'), '2 crore 50 lakh rupees');
  assert.equal(spokenPct(-3.25, 'hi'), 'माइनस तीन दशमलव दो पाँच प्रतिशत');
});

test('Category rules incl. fixed 55+ rule', () => {
  const base = { goal: 'Wealth Creation', risk: 'Aggressive', age_group: '31-45', horizon_years: 10 };
  assert.deepEqual(categoriesFor(base, rules).categories, rules.goals['Wealth Creation'].Aggressive);
  const old = categoriesFor({ ...base, age_group: '55+' }, rules).categories;
  assert.ok(!old.includes('Small Cap') && !old.includes('Mid Cap') && old.length > 0);
  const oldCons = categoriesFor({ ...base, risk: 'Conservative', age_group: '55+' }, rules).categories;
  assert.ok(oldCons.includes('Conservative Hybrid') && !oldCons.includes('Flexi Cap'));
  assert.deepEqual(categoriesFor({ ...base, horizon_years: 1 }, rules).categories, rules.horizon.max_1_year);
  const tax = categoriesFor({ ...base, goal: 'Tax Saving', horizon_years: 2 }, rules);
  assert.deepEqual(tax.categories, ['ELSS']);
  assert.ok(tax.notes.includes('noteElssLock'));
});

test('Top-10 respects max 2 per fund house', () => {
  const funds = [];
  for (let i = 0; i < 30; i++) funds.push({ amc: 'AMC' + (i % 4), category: 'Large Cap', score: 100 - i, metrics: { return_3y: 10 } });
  const { top } = pickTop(funds, ['Large Cap'], rules);
  assert.equal(top.length, 8); // 4 fund houses x 2
  const counts = {};
  top.forEach((f) => { counts[f.amc] = (counts[f.amc] || 0) + 1; });
  assert.ok(Object.values(counts).every((c) => c <= 2));
});

test('SIP projection matches closed-form annuity-due', () => {
  const r = projectCorpus({ type: 'SIP', amount: 10000, years: 10, annualPct: 12, inflationPct: 6 });
  const i = Math.pow(1.12, 1 / 12) - 1;
  const n = 120;
  const fv = 10000 * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
  assert.ok(Math.abs(r.value - fv) < 1e-6);
  assert.equal(r.invested, 1200000);
  assert.ok(Math.abs(r.real - fv / Math.pow(1.06, 10)) < 1e-6);
  const l = projectCorpus({ type: 'Lumpsum', amount: 100000, years: 5, annualPct: 10, inflationPct: 0 });
  assert.ok(Math.abs(l.value - 100000 * Math.pow(1.1, 5)) < 1e-6);
});

test('Risk level changes the order inside a category', () => {
  const mk = (code, amc, pr) => ({ code, amc, category: 'Large Cap', asset_type: 'equity', history_years: 10, score: 50, metrics: { return_3y: 10 }, percentiles: pr });
  const growth = mk('A', 'X', { return_3y: 100, return_5y: 100, alpha: 100, max_drawdown_3y: 0, std_dev: 0, sortino: 20, sharpe: 50, consistency: 50 });
  const steady = mk('B', 'Y', { return_3y: 30, return_5y: 30, alpha: 30, max_drawdown_3y: 100, std_dev: 100, sortino: 100, sharpe: 60, consistency: 50 });
  const low = pickTop([growth, steady], ['Large Cap'], rules, { risk: 'Conservative', horizon: 10, scoring }).top;
  const high = pickTop([growth, steady], ['Large Cap'], rules, { risk: 'Aggressive', horizon: 10, scoring }).top;
  assert.equal(low[0].code, 'B');
  assert.equal(high[0].code, 'A');
  assert.ok(riskScore(steady, scoring.risk_weights.Conservative) > riskScore(steady, scoring.risk_weights.Aggressive));
});

test('Long-term equity needs a 5-year record; short horizons and 46-55 drop small caps', () => {
  const funds = [];
  for (let i = 0; i < 12; i++) funds.push({ code: 'o' + i, amc: 'A' + i, category: 'Flexi Cap', asset_type: 'equity', history_years: 8, score: 50, metrics: {}, percentiles: { return_3y: 40 } });
  funds.push({ code: 'young', amc: 'Z', category: 'Flexi Cap', asset_type: 'equity', history_years: 3.2, score: 99, metrics: {}, percentiles: { return_3y: 100 } });
  const r = pickTop(funds, ['Flexi Cap'], rules, { risk: 'Moderate', horizon: 10, scoring });
  assert.ok(!r.top.some((f) => f.code === 'young') && r.youngSkipped);
  const r2 = pickTop(funds, ['Flexi Cap'], rules, { risk: 'Moderate', horizon: 3, scoring });
  assert.equal(r2.top[0].code, 'young');
  const base = { goal: 'Wealth Creation', risk: 'Aggressive', age_group: '31-45', horizon_years: 5 };
  const c5 = categoriesFor(base, rules).categories;
  assert.ok(!c5.includes('Small Cap') && !c5.includes('Mid Cap') && c5.includes('Balanced Advantage'));
  const c46 = categoriesFor({ ...base, horizon_years: 15, age_group: '46-55' }, rules).categories;
  assert.ok(!c46.includes('Small Cap') && c46.includes('Mid Cap'));
});

test('A category cannot fill the whole list when several are chosen', () => {
  const funds = [];
  for (let i = 0; i < 20; i++) funds.push({ code: 'l' + i, amc: 'L' + i, category: 'Large Cap', asset_type: 'equity', history_years: 9, score: 90, metrics: {}, percentiles: { return_3y: 90 - i } });
  for (let i = 0; i < 20; i++) funds.push({ code: 'f' + i, amc: 'F' + i, category: 'Flexi Cap', asset_type: 'equity', history_years: 9, score: 50, metrics: {}, percentiles: { return_3y: 40 - i } });
  const { top } = pickTop(funds, ['Large Cap', 'Flexi Cap', 'Multi Cap'], rules, { risk: 'Moderate', horizon: 10, scoring });
  assert.ok(top.filter((f) => f.category === 'Large Cap').length <= 4);
});
