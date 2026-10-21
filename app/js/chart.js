// Small dependency-free SVG line chart with a hover/touch read-out.
const W = 640, H = 260, PL = 8, PR = 8, PT = 14, PB = 26;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/**
 * lines: [{label, color, points: [[Date, value], ...]}]  (first line drives the x range)
 * opts: {fmtY(v), fmtX(date), ariaLabel}
 */
export function lineChart(el, lines, opts) {
  lines = lines.filter((l) => l.points.length > 1);
  if (!lines.length) { el.innerHTML = ''; return; }
  const xs = lines[0].points.map((p) => p[0].getTime());
  const x0 = xs[0], x1 = xs[xs.length - 1];
  let lo = Infinity, hi = -Infinity;
  lines.forEach((l) => l.points.forEach(([, v]) => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  const sx = (t) => PL + ((t - x0) / (x1 - x0 || 1)) * (W - PL - PR);
  const sy = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = lo + (hi - lo) * f;
    const y = sy(v);
    return `<line x1="${PL}" x2="${W - PR}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>
      <text x="${W - PR}" y="${y - 4}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(opts.fmtY(v))}</text>`;
  }).join('');
  const paths = lines.map((l) => {
    const d = l.points.map(([t, v], i) => `${i ? 'L' : 'M'}${sx(t.getTime()).toFixed(1)},${sy(v).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.width || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const xl = `<text x="${PL}" y="${H - 6}" font-size="11" fill="var(--muted)">${esc(opts.fmtX(new Date(x0)))}</text>
    <text x="${W - PR}" y="${H - 6}" font-size="11" text-anchor="end" fill="var(--muted)">${esc(opts.fmtX(new Date(x1)))}</text>`;
  el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.ariaLabel || '')}">
    ${grid}${paths}${xl}
    <line class="cursor" x1="0" x2="0" y1="${PT}" y2="${H - PB}" stroke="var(--muted)" stroke-dasharray="3 3" visibility="hidden"/>
    ${lines.map((l, i) => `<circle class="dot${i}" r="4" fill="${l.color}" visibility="hidden"/>`).join('')}
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" class="hit"/>
  </svg><div class="chart-tip" hidden></div></div>`;

  const svg = el.querySelector('svg');
  const tip = el.querySelector('.chart-tip');
  const cursor = svg.querySelector('.cursor');
  const nearest = (pts, t) => {
    let lo2 = 0, hi2 = pts.length - 1;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (pts[m][0].getTime() < t) lo2 = m + 1; else hi2 = m; }
    return pts[lo2];
  };
  const move = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const t = x0 + ((px - PL) / (W - PL - PR)) * (x1 - x0);
    const tt = Math.max(x0, Math.min(x1, t));
    const parts = [];
    let cx = 0;
    lines.forEach((l, i) => {
      const p = nearest(l.points, tt);
      const dot = svg.querySelector('.dot' + i);
      cx = sx(p[0].getTime());
      dot.setAttribute('cx', cx); dot.setAttribute('cy', sy(p[1])); dot.setAttribute('visibility', 'visible');
      parts.push(`${lines.length > 1 ? l.label + ': ' : ''}${opts.fmtY(p[1])}`);
      if (i === 0) parts.unshift(opts.fmtX(p[0]));
    });
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = parts.join(' · ');
    const left = (cx / W) * r.width;
    tip.style.left = Math.max(80, Math.min(r.width - 80, left)) + 'px';
  };
  const hide = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); svg.querySelectorAll('circle').forEach((c) => c.setAttribute('visibility', 'hidden')); };
  svg.addEventListener('pointermove', (e) => move(e.clientX));
  svg.addEventListener('pointerdown', (e) => move(e.clientX));
  svg.addEventListener('pointerleave', hide);
}

/** Simple vertical bar pair chart for corpus growth: invested vs value per year. */
export function corpusChart(el, yearly, opts) {
  if (!yearly.length) { el.innerHTML = ''; return; }
  const max = Math.max(...yearly.map((y) => y.value));
  const n = yearly.length;
  const bw = (W - PL - PR) / n;
  const sy = (v) => PT + (1 - v / max) * (H - PT - PB);
  const bars = yearly.map((y, i) => {
    const x = PL + i * bw;
    const w = Math.max(2, bw * 0.7);
    return `<rect x="${x + (bw - w) / 2}" y="${sy(y.value)}" width="${w}" height="${H - PB - sy(y.value)}" rx="2" fill="var(--accent)" opacity="0.85"><title>${esc(opts.label(y))}</title></rect>
      <rect x="${x + (bw - w) / 2}" y="${sy(y.invested)}" width="${w}" height="${H - PB - sy(y.invested)}" rx="2" fill="var(--muted)" opacity="0.55"/>`;
  }).join('');
  const ticks = yearly.filter((y, i) => i === 0 || i === n - 1 || (n > 6 && y.year % 5 === 0))
    .map((y) => `<text x="${PL + (y.year - 0.5) * bw}" y="${H - 8}" font-size="11" text-anchor="middle" fill="var(--muted)">${esc(opts.yearLabel(y.year))}</text>`).join('');
  el.innerHTML = `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.ariaLabel)}">
    <line x1="${PL}" x2="${W - PR}" y1="${H - PB}" y2="${H - PB}" stroke="var(--line-2)"/>${bars}${ticks}
    <text x="${W - PR}" y="${PT + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(opts.fmtY(max))}</text></svg></div>`;
}
