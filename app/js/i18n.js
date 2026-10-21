// Language strings + Indian number/date formatting.
const store = { lang: 'en', dict: {}, en: {} };

export async function loadLang(lang) {
  const get = async (l) => (await fetch(`i18n/${l}.json`, { cache: 'no-cache' })).json();
  if (!Object.keys(store.en).length) store.en = await get('en');
  store.dict = lang === 'en' ? store.en : await get(lang);
  store.lang = lang;
  document.documentElement.lang = lang;
  try { localStorage.setItem('analyx-lang', lang); } catch (e) { /* storage unavailable */ }
  applyStatic();
}

export function savedLang() {
  try { return localStorage.getItem('analyx-lang') || null; } catch (e) { return null; }
}

export const lang = () => store.lang;

/** t('key', {var: value}) — falls back to English, then to the key itself. */
export function t(key, vars) {
  let s = store.dict[key] ?? store.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

export function has(key) { return key in store.dict || key in store.en; }

export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  document.title = t('docTitle');
}

const loc = () => (store.lang === 'hi' ? 'hi-IN' : 'en-IN');

/** ₹12,34,567 */
export function inr(n) {
  if (n == null || !isFinite(n)) return t('na');
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/** ₹12.3 lakh / ₹1.2 करोड़ */
export function inrShort(n) {
  if (n == null || !isFinite(n)) return t('na');
  const a = Math.abs(n);
  const f = (x) => x.toLocaleString(loc(), { maximumFractionDigits: x < 10 ? 2 : 1 });
  if (a >= 1e7) return `₹${f(n / 1e7)} ${t('unit.crore')}`;
  if (a >= 1e5) return `₹${f(n / 1e5)} ${t('unit.lakh')}`;
  return inr(n);
}

export function pct(x, digits = 2, signed = false) {
  if (x == null || !isFinite(x)) return null;
  const s = x.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (signed && x > 0 ? '+' : '') + s + '%';
}

export function num(x, digits = 2) {
  if (x == null || !isFinite(x)) return null;
  return x.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function date(iso) {
  if (!iso) return t('na');
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric' });
}

export function catName(c) { return has('cat.' + c) ? t('cat.' + c) : c; }
