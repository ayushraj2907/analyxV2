import { loadLang, savedLang, lang, t, applyStatic, inr, inrShort, pct, num, date, catName } from './i18n.js';
import { categoriesFor, pickTop, projectCorpus } from './recommend.js';
import { parseProfile } from './parse.js';
import { lineChart, corpusChart } from './chart.js';
import { buildExplanation } from './explain.js';
import * as speech from './speech.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  meta: null, funds: [], cards: [], rules: null, defaults: null, profile: null,
  last: null, detailCache: {}, benchSeries: {}, dataError: false,
};

/* ---------------- data ---------------- */

async function getJSON(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}

async function loadData() {
  const [rules, defaults] = await Promise.all([getJSON('config/profile_rules.json'), getJSON('config/app_defaults.json')]);
  S.rules = rules; S.defaults = defaults;
  try {
    const [meta, funds, bench] = await Promise.all([getJSON('data/meta.json'), getJSON('data/funds.json'), getJSON('data/benchmarks.json')]);
    S.meta = meta; S.funds = funds.funds; S.cards = bench.cards;
  } catch (e) {
    S.dataError = true;
  }
}

/* ---------------- form ---------------- */

function initProfile() {
  const d = S.defaults;
  const infl = S.meta ? S.meta.macro.inflation.value : null;
  S.profile = {
    goal: d.goal, risk: d.risk, age_group: d.age_group, type: d.type,
    amount: d.type === 'SIP' ? d.sip_amount : d.lumpsum_amount,
    horizon_years: d.horizon_years, expected_return_pct: d.expected_return_pct,
    inflation_pct: infl ?? 0,
  };
}

function renderForm() {
  const p = S.profile;
  $$('.opts').forEach((g) => {
    const field = g.dataset.field;
    $$('button', g).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === p[field])));
  });
  $('#amount-label').textContent = t(p.type === 'SIP' ? 'amountSip' : 'amountLump');
  $('#amount').value = p.amount ? Math.round(p.amount).toLocaleString('en-IN') : '';
  $('#amount-words').textContent = p.amount ? inrShort(p.amount) : '';
  $('#horizon').value = p.horizon_years;
  $('#horizon-out').textContent = t('yearsN', { n: p.horizon_years });
  $('#ret').value = p.expected_return_pct;
  $('#ret-out').textContent = pct(p.expected_return_pct, 1);
  $('#inf').value = p.inflation_pct;
  $('#inf-out').textContent = pct(p.inflation_pct, 2);
  if (S.meta) {
    const m = S.meta.macro.inflation;
    $('#inf-source').innerHTML = `${esc(t('infSource', { label: t('cpi'), period: m.period }))} · <a href="${esc(m.source_url)}" target="_blank" rel="noopener">${esc(t('source'))}</a>`;
  }
}

function bindForm() {
  $$('.opts').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const field = g.dataset.field;
    if (field === 'type' && S.profile.type !== b.dataset.value) {
      S.profile.amount = b.dataset.value === 'SIP' ? S.defaults.sip_amount : S.defaults.lumpsum_amount;
    }
    S.profile[field] = b.dataset.value;
    renderForm();
  }));
  $('#amount').addEventListener('input', (e) => {
    const v = parseInt(e.target.value.replace(/[^\d]/g, ''), 10);
    S.profile.amount = isFinite(v) ? v : 0;
    $('#amount-words').textContent = S.profile.amount ? inrShort(S.profile.amount) : '';
  });
  $('#amount').addEventListener('blur', renderForm);
  $('#horizon').addEventListener('input', (e) => { S.profile.horizon_years = +e.target.value; $('#horizon-out').textContent = t('yearsN', { n: +e.target.value }); });
  $('#ret').addEventListener('input', (e) => { S.profile.expected_return_pct = +e.target.value; $('#ret-out').textContent = pct(+e.target.value, 1); });
  $('#inf').addEventListener('input', (e) => { S.profile.inflation_pct = +e.target.value; $('#inf-out').textContent = pct(+e.target.value, 2); });
  $('#profile-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
}

/* ---------------- tabs ---------------- */

function bindTabs() {
  const tabs = $$('[role="tab"]');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((x) => {
      const on = x === tab;
      x.setAttribute('aria-selected', String(on));
      $('#' + x.getAttribute('aria-controls')).hidden = !on;
    });
  }));
}

/* ---------------- describe in words / voice ---------------- */

const FIELDS = ['goal', 'type', 'amount', 'horizon_years', 'risk', 'age_group'];

function fieldLabel(k, v) {
  if (k === 'goal') return t('goal.' + v);
  if (k === 'risk') return t('risk.' + v);
  if (k === 'type') return t('type.' + v);
  if (k === 'amount') return inr(v);
  if (k === 'horizon_years') return t('yearsN', { n: v });
  return v;
}

function showConfirm(box, found) {
  const pills = FIELDS.map((k) => {
    if (found[k] != null) return `<span class="pill"><span>${esc(t('f.' + k))}:</span> <b>${esc(fieldLabel(k, found[k]))}</b></span>`;
    return `<span class="pill missing">${esc(t('f.' + k))}: ${esc(t('notSaid'))} → ${esc(fieldLabel(k, S.profile[k]))}</span>`;
  }).join('');
  const nothing = !Object.keys(found).length;
  box.hidden = false;
  box.innerHTML = nothing
    ? `<p>${esc(t('parseNothing'))}</p>`
    : `<div>${esc(t('weUnderstood'))}</div><div class="pills">${pills}</div>
       <div class="confirm-actions"><button class="primary" data-act="go">${esc(t('looksRight'))}</button>
       <button class="secondary" data-act="edit">${esc(t('editInForm'))}</button></div>`;
  box.onclick = (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    Object.assign(S.profile, found);
    renderForm();
    if (act === 'go') runSearch();
    else $('#tab-form').click();
  };
}

function bindText() {
  const ex = t('examples').split('|');
  $('#examples').innerHTML = ex.map((s, i) => `<button type="button" data-i="${i}">${esc(s)}</button>`).join('');
  $('#examples').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) $('#free-text').value = ex[+b.dataset.i];
  };
}

let recognizer = null;
let listening = false;

function bindVoice() {
  if (!speech.sttSupported()) {
    $('#voice-supported').hidden = true;
    $('#voice-unsupported').hidden = false;
    return;
  }
  $('#mic-btn').addEventListener('click', () => {
    if (listening) { recognizer?.stop(); return; }
    recognizer = speech.createRecognizer({
      lang: lang(),
      onText: (txt) => { $('#voice-text').value = txt; },
      onState: (st) => {
        listening = st === 'listening';
        $('#mic-btn').setAttribute('aria-pressed', String(listening));
        $('#mic-status').textContent = listening ? t('listening') : ($('#voice-text').value ? t('doneListening') : '');
        if (!listening && $('#voice-text').value.trim()) showConfirm($('#voice-confirm'), parseProfile($('#voice-text').value));
      },
      onError: (err) => {
        listening = false;
        $('#mic-btn').setAttribute('aria-pressed', 'false');
        $('#mic-status').textContent = err === 'not-allowed' || err === 'service-not-allowed' ? t('micDenied') : err === 'no-speech' ? t('noSpeech') : t('micError');
      },
    });
    recognizer.start($('#voice-text').value.trim());
  });
  $('#voice-parse-btn').addEventListener('click', () => showConfirm($('#voice-confirm'), parseProfile($('#voice-text').value)));
}

/* ---------------- read aloud ---------------- */

function say(text) {
  if (!speech.ttsSupported()) { alertNote(t('ttsUnsupported')); return; }
  const r = speech.speak(text, lang());
  $('#pl-note').textContent = r.fallback ? t('noHindiVoice') : '';
}

function alertNote(msg) {
  const b = $('#banner');
  b.hidden = false; b.textContent = msg;
  setTimeout(() => { if (b.textContent === msg) b.hidden = true; }, 6000);
}

function bindPlayer() {
  speech.setPlayerHandlers((state) => {
    $('#player').hidden = state === 'ended';
    $('#pl-icon').setAttribute('d', state === 'paused' ? 'M8 5v14l11-7z' : 'M6 5h4v14H6zM14 5h4v14h-4z');
    $('#pl-toggle').setAttribute('aria-label', t(state === 'paused' ? 'resume' : 'pause'));
  });
  $('#pl-toggle').addEventListener('click', speech.togglePause);
  $('#pl-stop').addEventListener('click', speech.stopSpeaking);
  $('#pl-rate').addEventListener('change', (e) => speech.setRate(+e.target.value));
}

/* ---------------- results ---------------- */

function metricCell(label, v, kind) {
  let txt, cls = '';
  if (v == null) { txt = `<span class="na">${esc(t('na'))}</span>`; }
  else if (kind === 'ret') { txt = pct(v); cls = v >= 0 ? 'pos' : 'neg'; }
  else if (kind === 'dd') { txt = '−' + pct(v); cls = 'neg'; }
  else if (kind === 'pct') { txt = pct(v); }
  else { txt = num(v); }
  return `<div class="metric"><div class="k" title="${esc(label)}">${esc(label)}</div><div class="v ${cls}">${txt}</div></div>`;
}

function fundSpeech(f, i) {
  const L = lang();
  const m = f.metrics;
  return t('sp.fund', {
    n: i + 1, name: f.name, cat: catName(f.category), rank: f.rank, peers: f.peers,
    r3: speech.spokenPct(m.return_3y, L), r1: speech.spokenPct(m.return_1y, L), dd: speech.spokenPct(m.max_drawdown_3y, L),
  });
}

function whyBars(f) {
  return Object.entries(f.percentiles).map(([k, p]) => `
    <div class="bar-row"><span>${esc(t('m.' + k))}</span>
      ${p == null ? `<span class="na">${esc(t('na'))}</span><span></span>` : `<span class="bar"><i style="width:${Math.max(2, p).toFixed(0)}%"></i></span><span class="pv">${Math.round(p)}</span>`}
    </div>`).join('');
}

function fundCard(f, i) {
  const m = f.metrics;
  return `<article class="fund" data-code="${esc(f.code)}">
    <div class="fund-top">
      <div class="rank" aria-label="${esc(t('rankN', { n: i + 1 }))}">${i + 1}</div>
      <div style="min-width:0">
        <div class="fund-name proper">${esc(f.name)}</div>
        <div class="fund-sub"><span class="proper">${esc(f.amc)}</span> · ${esc(catName(f.category))} · ${esc(t('directGrowth'))}</div>
      </div>
      <div class="score"><div class="s">${Math.round(f.score)}</div><div class="l">${esc(t('score'))}</div></div>
    </div>
    <div class="fund-sub">${esc(t('rankInCat', { rank: f.rank, peers: f.peers, cat: catName(f.category) }))} · ${esc(t('navOn', { nav: num(f.nav, 4), date: date(f.nav_date) }))}</div>
    <div class="metrics">
      ${metricCell(t('ms.return_1y'), m.return_1y, 'ret')}
      ${metricCell(t('ms.return_3y'), m.return_3y, 'ret')}
      ${metricCell(t('ms.return_5y'), m.return_5y, 'ret')}
      ${metricCell(t('ms.sharpe'), m.sharpe, 'num')}
      ${metricCell(t('ms.max_drawdown_3y'), m.max_drawdown_3y, 'dd')}
      ${metricCell(t('ms.std_dev'), m.std_dev, 'pct')}
    </div>
    <details class="why"><summary>${esc(t('whyRank'))}</summary>
      <p class="small muted">${esc(t('whyRankHelp'))}</p>
      <div class="bars">${whyBars(f)}</div>
    </details>
    <div class="fund-actions">
      <button class="secondary" data-act="detail">${esc(t('details'))}</button>
      <button class="listen" data-act="listen"><span aria-hidden="true">🔊</span> ${esc(t('listen'))}</button>
    </div>
  </article>`;
}

function runSearch() {
  if (S.dataError || !S.funds.length) { alertNote(t('dataMissing')); return; }
  if (!S.profile.amount || S.profile.amount < 100) { alertNote(t('enterAmount')); $('#amount').focus(); return; }
  const { categories, notes } = categoriesFor(S.profile, S.rules);
  const { top, poolSize } = pickTop(S.funds, categories, S.rules);
  const corpus = projectCorpus({
    type: S.profile.type, amount: S.profile.amount, years: S.profile.horizon_years,
    annualPct: S.profile.expected_return_pct, inflationPct: S.profile.inflation_pct,
  });
  S.last = { profile: { ...S.profile }, cats: categories, notes, top, poolSize, corpus };
  renderResults();
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function markNames(html, funds) {
  // fund names are proper nouns: mark them so screen readers / tests treat them as names
  for (const f of funds.slice(0, 1)) {
    const n = esc(f.name);
    html = html.split(n).join(`<span class="proper">${n}</span>`);
  }
  return html;
}

function renderResults() {
  const R = S.last;
  if (!R) return;
  const p = R.profile;
  $('#results').hidden = false;

  $('#summary').innerHTML = `
    <div class="chips">
      <span class="tag accent">${esc(t('goal.' + p.goal))}</span>
      <span class="tag">${esc(t('risk.' + p.risk))} ${esc(t('riskWord'))}</span>
      <span class="tag">${esc(t('ageWord'))} ${esc(p.age_group)}</span>
      <span class="tag">${esc(t('type.' + p.type))} · ${esc(inr(p.amount))}</span>
      <span class="tag">${esc(t('yearsN', { n: p.horizon_years }))}</span>
    </div>
    <div class="small">${esc(t('consideredCats'))}: <strong>${esc(R.cats.map(catName).join(', '))}</strong> — ${esc(t('poolSize', { n: R.poolSize }))}</div>
    ${R.notes.map((n) => `<p class="warn">${esc(t(n))}</p>`).join('')}
    ${R.top.length < (S.rules.top_n || 10) ? `<p class="warn">${esc(t('fewerFunds', { n: R.top.length }))}</p>` : ''}`;

  const c = R.corpus;
  $('#corpus-card').innerHTML = `
    <div class="card-head"><h3>${esc(t('corpusTitle'))}</h3></div>
    <div class="stat-row">
      <div class="stat"><div class="k">${esc(t('invested'))}</div><div class="v">${esc(inrShort(c.invested))}</div></div>
      <div class="stat"><div class="k">${esc(t('projected'))}</div><div class="v">${esc(inrShort(c.value))}</div></div>
      <div class="stat"><div class="k">${esc(t('gain'))}</div><div class="v">${esc(inrShort(c.gain))}</div></div>
      <div class="stat"><div class="k">${esc(t('todayMoney'))}</div><div class="v">${esc(inrShort(c.real))}</div></div>
    </div>
    <div id="corpus-chart"></div>
    <div class="legend"><span><i style="background:var(--accent)"></i>${esc(t('projected'))}</span><span><i style="background:var(--muted)"></i>${esc(t('invested'))}</span></div>
    <p class="small muted">${esc(t('corpusNote', { ret: pct(p.expected_return_pct, 1), inf: pct(p.inflation_pct, 2) }))}</p>`;
  corpusChart($('#corpus-chart'), c.yearly, {
    ariaLabel: t('corpusTitle'), fmtY: (v) => inrShort(v), yearLabel: (y) => t('yearShort', { n: y }),
    label: (y) => `${t('yearShort', { n: y.year })}: ${inrShort(y.value)}`,
  });

  const ex = buildExplanation({ profile: p, cats: R.cats, top: R.top, poolSize: R.poolSize, corpus: c, meta: S.meta, benchmarks: S.meta.benchmarks });
  R.explainSpeech = ex.speech;
  $('#explain-card').innerHTML = `
    <div class="card-head"><h3>${esc(t('explainTitle'))}</h3>
      <button class="listen" id="listen-explain"><span aria-hidden="true">🔊</span> ${esc(t('listen'))}</button></div>
    <div class="explain">${ex.display.map((x) => `<p>${markNames(esc(x), R.top)}</p>`).join('')}</div>
    <p class="small muted">${esc(t('explainNote'))}</p>`;
  $('#listen-explain').onclick = () => say(R.explainSpeech);

  $('#fund-list').innerHTML = R.top.length ? R.top.map(fundCard).join('') : `<div class="card">${esc(t('noFunds'))}</div>`;
  $('#results-source').textContent = t('resultsSource', { date: date(S.meta.nav_as_of), built: date(S.meta.built_at.slice(0, 10)) });
}

function bindResults() {
  $('#fund-list').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const card = b.closest('.fund');
    const i = $$('.fund', $('#fund-list')).indexOf(card);
    const f = S.last.top[i];
    if (b.dataset.act === 'detail') openDetail(f.code);
    if (b.dataset.act === 'listen') say(fundSpeech(f, i));
  });
  $('#listen-summary').addEventListener('click', () => {
    const R = S.last;
    if (!R) return;
    const parts = [R.explainSpeech, t('sp.topIntro')];
    R.top.slice(0, 3).forEach((f, i) => parts.push(fundSpeech(f, i)));
    say(parts.join(' '));
  });
}

/* ---------------- fund detail ---------------- */

const RANGES = [['1M', 1 / 12], ['3M', 0.25], ['6M', 0.5], ['1Y', 1], ['3Y', 3], ['5Y', 5], ['All', 0]];

async function openDetail(code) {
  S.openCode = code;
  const sheet = $('#sheet');
  $('#sheet-backdrop').hidden = false;
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#sheet-body').innerHTML = `<div class="skel"></div>`;
  $('#sheet-title').textContent = '';
  $('#sheet-close').focus();
  try {
    const d = S.detailCache[code] || (S.detailCache[code] = await getJSON(`data/funds/${code}.json`));
    const f = d.fund;
    let bench = null;
    if (f.benchmark) {
      bench = S.benchSeries[f.benchmark] || (S.benchSeries[f.benchmark] = await getJSON(`data/benchmarks/${f.benchmark}.json`).catch(() => null));
    }
    renderDetail(d, bench);
  } catch (e) {
    $('#sheet-body').innerHTML = `<p>${esc(t('detailError'))}</p>`;
  }
}

function closeDetail() {
  S.openCode = null;
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
}

function renderDetail(d, benchData) {
  const f = d.fund;
  const m = f.metrics;
  const bmeta = f.benchmark ? S.meta.benchmarks[f.benchmark] : null;
  $('#sheet-title').textContent = f.name;
  const row = (k, v, kind) => {
    let txt;
    if (v == null) txt = `<span class="na">${esc(t('na'))}</span>`;
    else if (kind === 'ret') txt = `<span class="${v >= 0 ? 'pos' : 'neg'}">${pct(v)}</span>`;
    else if (kind === 'dd') txt = `<span class="neg">−${pct(v)}</span>`;
    else if (kind === 'pct') txt = pct(v);
    else txt = num(v);
    return `<tr><th>${esc(t('m.' + k))}<span class="ex">${esc(t('mx.' + k))}</span></th><td class="v">${txt}</td></tr>`;
  };
  $('#sheet-body').innerHTML = `
    <div class="fund-sub"><span class="proper">${esc(f.amc)}</span> · ${esc(catName(f.category))} · ${esc(t('directGrowth'))} · ${esc(t('schemeCode'))} ${esc(f.code)}</div>
    <div class="stat-row">
      <div class="stat"><div class="k">${esc(t('latestNav'))}</div><div class="v">₹${esc(num(f.nav, 4))}</div></div>
      <div class="stat"><div class="k">${esc(t('navDate'))}</div><div class="v">${esc(date(f.nav_date))}</div></div>
      <div class="stat"><div class="k">${esc(t('score'))}</div><div class="v">${Math.round(f.score)}/100</div></div>
      <div class="stat"><div class="k">${esc(t('catRank'))}</div><div class="v">${f.rank}/${f.peers}</div></div>
    </div>
    <div class="card-head"><h3>${esc(t('navChart'))}</h3>
      <button class="listen" id="listen-detail"><span aria-hidden="true">🔊</span> ${esc(t('listen'))}</button></div>
    <div class="ranges" id="ranges">${RANGES.map(([k]) => `<button type="button" data-r="${k}" aria-pressed="${k === '3Y'}">${esc(t('range.' + k))}</button>`).join('')}</div>
    <div id="detail-chart"></div>
    <div class="legend" id="detail-legend"></div>
    <table class="kv" style="margin-top:12px"><tbody>
      ${row('return_1y', m.return_1y, 'ret')}${row('return_3y', m.return_3y, 'ret')}${row('return_5y', m.return_5y, 'ret')}${row('return_10y', m.return_10y, 'ret')}
      ${row('std_dev', m.std_dev, 'pct')}${row('sharpe', m.sharpe)}${row('sortino', m.sortino)}
      ${row('beta', m.beta)}${row('alpha', m.alpha, 'ret')}${row('consistency', m.consistency, 'pct')}
      ${row('max_drawdown_3y', m.max_drawdown_3y, 'dd')}${row('max_drawdown_all', m.max_drawdown_all, 'dd')}
      <tr><th>${esc(t('terAum'))}<span class="ex">${esc(t('terAumEx'))}</span></th><td class="v"><span class="na">${esc(t('na'))}</span></td></tr>
    </tbody></table>
    <p class="src">${esc(t('detailSources', { date: date(f.nav_date), since: date(f.inception) }))}
      ${bmeta ? esc(t('benchSource', { index: bmeta.index, fund: bmeta.fund_name })) : esc(t('noBench'))}
      ${esc(t('rfSource', { rf: pct(S.meta.macro.risk_free_rate.value, 2), period: S.meta.macro.risk_free_rate.period }))}
      <a href="https://www.amfiindia.com/net-asset-value" target="_blank" rel="noopener">${esc(t('checkAmfi'))}</a></p>`;

  const series = d.series.map(([dt, v]) => [new Date(dt + 'T00:00:00'), v]);
  const bser = benchData ? benchData.series.map(([dt, v]) => [new Date(dt + 'T00:00:00'), v]) : null;
  const draw = (rk) => {
    const yrs = RANGES.find((r) => r[0] === rk)[1];
    const end = series[series.length - 1][0];
    const start = yrs ? new Date(end.getTime() - yrs * 365.25 * 864e5) : series[0][0];
    const fs = series.filter((p) => p[0] >= start);
    const lines = [];
    if (bser) {
      const bs = bser.filter((p) => p[0] >= fs[0][0] && p[0] <= end);
      if (bs.length > 1 && bs[0][0] - fs[0][0] < 10 * 864e5) {
        const k = fs[0][1] / bs[0][1];
        lines.push({ label: bmeta.index, color: 'var(--bench)', width: 1.6, points: bs.map(([d2, v]) => [d2, v * k]) });
      }
    }
    lines.unshift({ label: t('thisFund'), color: 'var(--accent)', points: fs });
    lineChart($('#detail-chart'), lines, { fmtY: (v) => '₹' + num(v, v < 100 ? 2 : 0), fmtX: (x) => date(x.toISOString().slice(0, 10)), ariaLabel: t('navChart') });
    $('#detail-legend').innerHTML = `<span><i style="background:var(--accent)"></i>${esc(t('thisFund'))}</span>` +
      (lines.length > 1 ? `<span><i style="background:var(--bench)"></i>${esc(t('benchRebased', { index: bmeta.index }))}</span>` : '');
  };
  draw('3Y');
  $('#ranges').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#ranges button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw(b.dataset.r);
  };
  $('#listen-detail').onclick = () => {
    const L = lang();
    say(t('sp.detail', {
      name: f.name, cat: catName(f.category), rank: f.rank, peers: f.peers,
      r1: speech.spokenPct(m.return_1y, L), r3: speech.spokenPct(m.return_3y, L), r5: speech.spokenPct(m.return_5y, L),
      dd: speech.spokenPct(m.max_drawdown_3y, L), sd: speech.spokenPct(m.std_dev, L),
    }));
  };
}

/* ---------------- benchmarks + about ---------------- */

function renderBench() {
  if (!S.cards.length) { $('#bench-grid').innerHTML = `<p class="muted">${esc(t('na'))}</p>`; return; }
  const v = (x) => (x == null ? `<span class="na">${esc(t('na'))}</span>` : `<span class="${x >= 0 ? 'pos' : 'neg'}">${pct(x)}</span>`);
  $('#bench-grid').innerHTML = S.cards.map((c) => `
    <div class="bench-card">
      <div class="t proper">${esc(c.index)}</div>
      <div class="via">${esc(t('via'))} <span class="proper">${esc(c.fund_name)}</span> · ${esc(date(c.as_of))}</div>
      <div class="rows"><span>${esc(t('m.return_1y'))}</span>${v(c.return_1y)}<span>${esc(t('m.return_3y'))}</span>${v(c.return_3y)}<span>${esc(t('m.return_5y'))}</span>${v(c.return_5y)}</div>
    </div>`).join('');
}

function renderAbout() {
  if (!S.meta) { $('#about-body').innerHTML = `<p>${esc(t('dataMissing'))}</p>`; return; }
  const M = S.meta;
  const mac = (o) => `${esc(t(o === M.macro.inflation ? 'cpi' : 'rf'))}: <strong>${pct(o.value, 2)}</strong> (${esc(o.period)}) — <a href="${esc(o.source_url)}" target="_blank" rel="noopener">${esc(o.source_name)}</a>`;
  $('#about-body').innerHTML = `
    <ul>
      <li>${esc(t('about.nav', { date: date(M.nav_as_of) }))} <a href="https://www.amfiindia.com/spages/NAVAll.txt" target="_blank" rel="noopener">AMFI NAVAll.txt</a></li>
      <li>${esc(t('about.hist'))} <a href="https://www.mfapi.in/" target="_blank" rel="noopener">mfapi.in</a></li>
      <li>${mac(M.macro.inflation)}</li>
      <li>${mac(M.macro.risk_free_rate)}</li>
      <li>${esc(t('about.counts', { ranked: M.counts.ranked, universe: M.counts.universe, built: date(M.built_at.slice(0, 10)) }))}</li>
      <li>${esc(t('about.method'))}</li>
      <li>${esc(t('about.na'))}</li>
    </ul>`;
}

function checkFreshness() {
  const b = $('#banner');
  if (S.dataError) { b.hidden = false; b.textContent = t('dataMissing'); return; }
  if (S.meta.sample) { b.hidden = false; b.textContent = t('sampleData'); return; }
  const age = (Date.now() - new Date(S.meta.nav_as_of + 'T00:00:00+05:30').getTime()) / 864e5;
  if (age > 5) { b.hidden = false; b.textContent = t('staleData', { date: date(S.meta.nav_as_of) }); }
  else b.hidden = true;
}

/* ---------------- misc ---------------- */

function setupReport() {
  const a = $('#report-link');
  const host = location.hostname;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  const body = encodeURIComponent(`Page: ${location.href}\nData as of: ${S.meta?.nav_as_of || '-'}\nBrowser: ${navigator.userAgent}\n\nWhat went wrong:\n`);
  if (host.endsWith('.github.io') && seg) {
    a.href = `https://github.com/${host.split('.')[0]}/${seg}/issues/new?title=${encodeURIComponent('Problem report')}&body=${body}`;
  } else if (S.defaults.report_email) {
    a.href = `mailto:${S.defaults.report_email}?subject=${encodeURIComponent('Analyx problem report')}&body=${body}`;
  } else {
    a.parentElement.hidden = true;
  }
}

let deferredInstall = null;
function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#install-btn').hidden = false;
  });
  $('#install-btn').addEventListener('click', async () => {
    if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#install-btn').hidden = true; }
  });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  let dismissed = false;
  try { dismissed = localStorage.getItem('analyx-ios-tip') === '1'; } catch (e) { /* ignore */ }
  if (ios && !dismissed) $('#ios-tip').hidden = false;
  $('#ios-tip-close').addEventListener('click', () => {
    $('#ios-tip').hidden = true;
    try { localStorage.setItem('analyx-ios-tip', '1'); } catch (e) { /* ignore */ }
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

function bindChrome() {
  $('#lang-btn').addEventListener('click', async () => {
    speech.stopSpeaking();
    await loadLang(lang() === 'en' ? 'hi' : 'en');
    rerender();
  });
  $('#theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('analyx-theme', next); } catch (e) { /* ignore */ }
  });
  $('#sheet-close').addEventListener('click', closeDetail);
  $('#sheet-backdrop').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeDetail(); });
  $('#parse-btn').addEventListener('click', () => showConfirm($('#text-confirm'), parseProfile($('#free-text').value)));
}

function rerender() {
  applyStatic();
  renderForm();
  bindText();
  renderBench();
  renderAbout();
  if (S.meta) checkFreshness();
  if (S.last) renderResults();
  $('#text-confirm').hidden = true;
  $('#voice-confirm').hidden = true;
  if (!$('#sheet').hidden && S.openCode) openDetail(S.openCode);
}

async function main() {
  const initial = savedLang() || ((navigator.language || '').toLowerCase().startsWith('hi') ? 'hi' : 'en');
  await Promise.all([loadLang(initial), loadData()]);
  initProfile();
  bindForm(); bindTabs(); bindVoice(); bindPlayer(); bindResults(); bindChrome();
  setupInstall();
  setupReport();
  rerender();
}

main();
