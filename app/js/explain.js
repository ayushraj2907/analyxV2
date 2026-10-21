// Plain-language explanation built ONLY from computed numbers (no AI, no invented facts).
// Returns {display: [paragraphs], speech: "..."} in the current language.
import { t, lang, pct, inr, inrShort, date, catName } from './i18n.js';
import { spokenAmount, spokenPct } from './speech.js';

export function buildExplanation({ profile, cats, top, poolSize, corpus, meta, benchmarks }) {
  const L = lang();
  const sp = (x) => spokenPct(x, L);
  const sa = (x) => spokenAmount(x, L);
  const display = [];
  const speech = [];
  const add = (key, dv, sv) => { display.push(t(key, dv)); speech.push(t(key, sv || dv)); };

  const catList = cats.map(catName).join(', ');
  add('ex.intro', {
    goal: t('goal.' + profile.goal), risk: t('risk.' + profile.risk), years: profile.horizon_years,
    cats: catList, count: poolSize, date: date(meta.nav_as_of),
  });

  const f = top[0];
  if (f) {
    const m = f.metrics;
    add('ex.top', { name: f.name, cat: catName(f.category), rank: f.rank, peers: f.peers, score: Math.round(f.score) },
      { name: f.name, cat: catName(f.category), rank: f.rank, peers: f.peers, score: Math.round(f.score) });
    if (m.return_3y != null) {
      const b = f.benchmark && benchmarks[f.benchmark];
      if (b && b.return_3y != null) {
        add('ex.vsBench', { r3: pct(m.return_3y), bench: b.index, b3: pct(b.return_3y) },
          { r3: sp(m.return_3y), bench: b.index, b3: sp(b.return_3y) });
      } else {
        add('ex.r3', { r3: pct(m.return_3y) }, { r3: sp(m.return_3y) });
      }
    }
    if (m.max_drawdown_3y != null) {
      add('ex.risk', { dd: pct(m.max_drawdown_3y) }, { dd: sp(m.max_drawdown_3y) });
    }
  }

  const amtKey = profile.type === 'SIP' ? 'ex.corpusSip' : 'ex.corpusLump';
  add(amtKey, {
    amount: inr(profile.amount), years: profile.horizon_years, invested: inrShort(corpus.invested),
    ret: pct(profile.expected_return_pct, 1), value: inrShort(corpus.value), real: inrShort(corpus.real),
    inf: pct(profile.inflation_pct, 2),
  }, {
    amount: sa(profile.amount), years: profile.horizon_years, invested: sa(corpus.invested),
    ret: sp(profile.expected_return_pct), value: sa(corpus.value), real: sa(corpus.real), inf: sp(profile.inflation_pct),
  });

  const tipKey = profile.type === 'SIP' ? 'ex.tipSip' : 'ex.tipLump';
  add(tipKey, {});
  if (['Emergency Fund', 'Short Term'].includes(profile.goal) || profile.horizon_years <= 3) add('ex.tipShort', {});
  else add('ex.tipLong', {});
  return { display, speech: speech.join(' ') };
}
