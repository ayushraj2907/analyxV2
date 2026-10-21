// Read a profile out of free text: English, Hindi (Devanagari) or Hinglish.
// Pure functions (no DOM) so they can be tested with node --test.
import { ageGroupFor } from './recommend.js';

const HI_NUM = 'शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानबे बानबे तिरानबे चौरानबे पचानबे छियानबे सत्तानबे अट्ठानबे निन्यानबे'.split(' ');
export const HINDI_WORDS = HI_NUM; // 0..99, also used for speaking numbers

const WORD_VAL = {};
HI_NUM.forEach((w, i) => { WORD_VAL[w] = i; });
Object.assign(WORD_VAL, {
  'पांच': 5, 'छः': 6, 'छे': 6, 'छह': 6, 'पन्द्रह': 15, 'उन्तीस': 29, 'इकत्तीस': 31,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40, fifty: 50,
  ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, das: 10, bees: 20, pachees: 25, pachis: 25, tees: 30, chalis: 40, pachas: 50,
});
const HALF = { 'डेढ़': 1.5, 'डेढ': 1.5, dedh: 1.5, 'ढाई': 2.5, dhai: 2.5 }; // allow-number: Hindi words for 1.5 and 2.5
const MULT = {
  'सौ': 100, hundred: 100, sau: 100,
  'हज़ार': 1e3, 'हजार': 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3, k: 1e3,
  'लाख': 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5,
  'करोड़': 1e7, 'करोड': 1e7, crore: 1e7, crores: 1e7, cr: 1e7,
  million: 1e6,
};

const KEYWORDS = ['aggressive', 'moderate', 'conservative', 'monthly', 'years', 'year', 'horizon', 'retirement',
  'education', 'emergency', 'lumpsum', 'wealth', 'children', 'medium', 'invest', 'months', 'month'];

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}

function fixTypos(word) {
  if (!/^[a-z]{4,}$/.test(word) || KEYWORDS.includes(word)) return word;
  let best = word, bestD = 99;
  for (const k of KEYWORDS) {
    const dist = lev(word, k);
    const max = k.length >= 7 ? 2 : 1;
    if (dist <= max && dist < bestD) { best = k; bestD = dist; }
  }
  return best;
}

export function normalise(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/[०-९]/g, (c) => String('०१२३४५६७८९'.indexOf(c)));
  s = s.replace(/(\d),(?=\d)/g, '$1');          // 10,000 -> 10000
  s = s.replace(/₹\s*/g, ' rs ');
  s = s.replace(/(\d+(?:\.\d+)?)\s*(k|l|cr|lakh|lakhs|lac|crore)\b/g, '$1 $2'); // 10k -> 10 k
  s = s.replace(/(\d)\s*%/g, '$1 percent');
  s = s.replace(/[।,;:!?()"“”]/g, ' ');
  s = s.replace(/\/\s*(month|mo|m)\b/g, ' per month');
  return s.split(/\s+/).filter(Boolean).map(fixTypos);
}

/** Collapse number phrases into numbers. Returns tokens where each number phrase is {n, start, end}. */
export function readNumbers(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const isNum = (w) => /^\d+(\.\d+)?$/.test(w) || w in WORD_VAL || w in HALF || w === 'साढ़े' || w === 'साढे' || w === 'sadhe';
    if (!isNum(tok)) { out.push(tok); i++; continue; }
    let total = 0, cur = 0, plusHalf = false, j = i, used = false;
    while (j < tokens.length) {
      const w = tokens[j];
      if (w === 'साढ़े' || w === 'साढे' || w === 'sadhe') { plusHalf = true; j++; continue; }
      if (/^\d+(\.\d+)?$/.test(w)) { cur += parseFloat(w) + (plusHalf ? 0.5 : 0); plusHalf = false; used = true; j++; continue; }
      if (w in HALF) { cur += HALF[w]; used = true; j++; continue; }
      if (w in WORD_VAL) {
        // "एक बार" / "one time" = once, not a number
        if (used && /^(बार|baar|bar|time|times|साथ|saath|ही)$/.test(tokens[j + 1] || '')) break;
        cur += WORD_VAL[w] + (plusHalf ? 0.5 : 0); plusHalf = false; used = true; j++; continue;
      }
      if (used && w in MULT) {
        const m = MULT[w];
        if (m === 100) cur = (cur || 1) * 100;
        else { total += (cur || 1) * m; cur = 0; }
        j++;
        continue;
      }
      break;
    }
    if (!used) { out.push(tok); i++; continue; }
    out.push({ n: total + cur, raw: tokens.slice(i, j).join(' ') });
    i = j;
  }
  return out;
}

const YEAR_WORDS = /^(years?|yrs?|yr|साल|सालों|वर्ष|वर्षों|बरस|saal|sal|varsh)$/;
const AGE_BEFORE = /^(age|aged|उम्र|आयु|umar|umr|umra)$/;
const AGE_AFTER = /^(old|हूं|हूँ|hoon|hu|hun|हु)$/;
const MONTH_CUES = /^(sip|monthly|month|months|महीने|महीना|मासिक|माह|mahine|mahina|pm|har)$/;

function has(text, re) { return re.test(text); }

export function parseProfile(text) {
  const raw = String(text || '');
  const toks = readNumbers(normalise(raw));
  const flat = toks.map((x) => (typeof x === 'string' ? x : '#')).join(' ');
  const plain = ' ' + normalise(raw).join(' ') + ' ';
  const found = {};

  // goal
  const goals = [
    ['Retirement', /retire|retirement|pension|रिटायर|सेवानिवृत्ति|पेंशन|बुढ़ापे/],
    ['Child Education', /child|children|kid|education|college|school|बच्च|पढ़ाई|पढाई|शिक्षा|कॉलेज|beti|beta|बेटी|बेटे/],
    ['Tax Saving', /\btax\b|elss|80c|टैक्स|कर बचत|टेक्स/],
    ['Emergency Fund', /emergency|आपात|इमरजेंसी|ज़रूरत के समय|आपातकाल/],
    ['Short Term', /short term|short-term|कम समय|छोटी अवधि|शॉर्ट टर्म/],
    ['Wealth Creation', /wealth|grow|growth|long term|धन|संपत्ति|पैसा बढ़|वेल्थ|दौलत/],
  ];
  for (const [g, re] of goals) if (has(plain, re)) { found.goal = g; break; }

  // risk
  if (has(plain, /\b(aggressive|high risk|high-risk|high return|risky)\b|ज़्यादा जोखिम|ज्यादा जोखिम|अधिक जोखिम|उच्च जोखिम|हाई रिस्क|ज्यादा रिस्क|ज़्यादा रिस्क/)) found.risk = 'Aggressive';
  else if (has(plain, /\b(conservative|low risk|low-risk|safe|safety)\b|कम जोखिम|सुरक्षित|कम रिस्क|लो रिस्क/)) found.risk = 'Conservative';
  else if (has(plain, /\b(moderate|medium|balanced|average)\b|मध्यम|मीडियम|बीच का|सामान्य जोखिम/)) found.risk = 'Moderate';

  // type
  const lump = /\b(lumpsum|lump sum|one time|one-time|onetime|once|ek baar)\b|एकमुश्त|एक बार|एक साथ|एक ही बार/;
  if (has(plain, lump)) found.type = 'Lumpsum';
  else if (has(plain, /\b(sip|monthly|per month|every month|each month|har mahine|mahina)\b|महीने|मासिक|हर महीना|प्रति माह/)) found.type = 'SIP';

  // numbers with context
  const amounts = [];
  toks.forEach((x, idx) => {
    if (typeof x === 'string') return;
    const next = toks.slice(idx + 1, idx + 3).filter((y) => typeof y === 'string');
    const prev = toks.slice(Math.max(0, idx - 3), idx).filter((y) => typeof y === 'string');
    const n1 = next[0] || '';
    const n2 = next[1] || '';
    const after3 = toks.slice(idx + 1, idx + 5).filter((y) => typeof y === 'string');
    if (YEAR_WORDS.test(n1)) {
      const isAge = prev.some((p) => AGE_BEFORE.test(p)) || after3.some((w) => AGE_AFTER.test(w))
        || (prev.includes('i') && prev.includes('am')) || prev.includes("i'm");
      if (isAge) found.age = x.n; else if (found.horizon_years == null) found.horizon_years = x.n;
      return;
    }
    const iAm = (prev[prev.length - 2] === 'i' && prev[prev.length - 1] === 'am') || prev[prev.length - 1] === "i'm";
    if ((prev.some((p) => AGE_BEFORE.test(p)) || iAm) && x.n >= 18 && x.n <= 100) { found.age = x.n; return; }
    if (/^(percent|%|प्रतिशत|फीसदी)$/.test(n1)) return;
    if (/^(months?|महीने|महीनों)$/.test(n1) && x.n <= 600) { if (found.horizon_years == null) found.horizon_years = Math.max(1, Math.round(x.n / 12)); return; }
    if (x.n >= 100) amounts.push({ n: x.n, monthly: MONTH_CUES.test(n1) || MONTH_CUES.test(n2) || prev.some((p) => MONTH_CUES.test(p)) });
  });
  if (amounts.length) {
    const a = amounts.sort((p, q) => q.n - p.n)[0];
    found.amount = Math.round(a.n);
    if (!found.type && a.monthly) found.type = 'SIP';
  }
  if (found.horizon_years != null) found.horizon_years = Math.min(40, Math.max(1, Math.round(found.horizon_years)));
  if (found.age != null) {
    if (found.age >= 18 && found.age <= 100) found.age_group = ageGroupFor(found.age);
    delete found.age;
  }
  return found;
}
