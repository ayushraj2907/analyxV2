// Voice: speech-to-text (Web Speech API) and read-aloud (speechSynthesis),
// plus number-to-words in Indian style for natural speech.
import { HINDI_WORDS } from './parse.js';

/* ---------------- numbers as words ---------------- */

function hiInt(n) {
  n = Math.floor(Math.abs(n));
  if (n < 100) return HINDI_WORDS[n];
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1e3); n %= 1e3;
  const h = Math.floor(n / 100); n %= 100;
  if (crore) parts.push(hiInt(crore) + ' करोड़');
  if (lakh) parts.push(HINDI_WORDS[lakh] + ' लाख');
  if (th) parts.push(HINDI_WORDS[th] + ' हज़ार');
  if (h) parts.push(HINDI_WORDS[h] + ' सौ');
  if (n) parts.push(HINDI_WORDS[n]);
  return parts.join(' ');
}

/** 12.5 -> "बारह दशमलव पाँच" ; -3 -> "माइनस तीन" */
export function toSpokenHindi(x, decimals = 2) {
  if (x == null || !isFinite(x)) return 'उपलब्ध नहीं';
  const neg = x < 0;
  const fixed = Math.abs(x).toFixed(decimals);
  let [i, d] = fixed.split('.');
  d = (d || '').replace(/0+$/, '');
  let s = hiInt(parseInt(i, 10));
  if (d) s += ' दशमलव ' + d.split('').map((c) => HINDI_WORDS[+c]).join(' ');
  return (neg ? 'माइनस ' : '') + s;
}

function enInt(n) {
  n = Math.floor(Math.abs(n));
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const th = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${crore} crore`);
  if (lakh) parts.push(`${lakh} lakh`);
  if (th) parts.push(`${th} thousand`);
  if (n || !parts.length) parts.push(String(n));
  return parts.join(' ');
}

export function spokenAmount(n, lang) {
  if (n == null || !isFinite(n)) return lang === 'hi' ? 'उपलब्ध नहीं' : 'not available';
  n = Math.round(n);
  return lang === 'hi' ? hiInt(n) + ' रुपये' : enInt(n) + ' rupees';
}

export function spokenPct(x, lang) {
  if (x == null || !isFinite(x)) return lang === 'hi' ? 'उपलब्ध नहीं' : 'not available';
  if (lang === 'hi') return toSpokenHindi(Math.round(x * 100) / 100) + ' प्रतिशत';
  const v = (Math.round(x * 100) / 100).toString();
  return (x < 0 ? 'minus ' + v.slice(1) : v) + ' percent';
}

/* ---------------- speech to text ---------------- */

export function sttSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createRecognizer({ lang, onText, onState, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    onText((finalText + interim).trim());
  };
  rec.onstart = () => onState('listening');
  rec.onend = () => onState('stopped');
  rec.onerror = (e) => onError(e.error || 'error');
  return {
    start(seed = '') { finalText = seed ? seed + ' ' : ''; try { rec.start(); } catch (e) { onError('busy'); } },
    stop() { try { rec.stop(); } catch (e) { /* already stopped */ } },
  };
}

/* ---------------- read aloud ---------------- */

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
let voices = [];
function loadVoices() { voices = synth ? synth.getVoices() : []; }
if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', loadVoices); }

export function ttsSupported() { return !!synth; }

export function pickVoice(lang) {
  if (!voices.length) loadVoices();
  if (lang === 'hi') return voices.find((v) => /^hi(-|_|$)/i.test(v.lang)) || null;
  return voices.find((v) => /^en[-_]IN/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
}

function chunks(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?।]+[.!?।]?/g) || [text];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    while (p.length > 200) {
      const cut = p.lastIndexOf(' ', 200);
      out.push(p.slice(0, cut > 50 ? cut : 200));
      p = p.slice(cut > 50 ? cut : 200).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

const player = { queue: [], rate: 1, lang: 'en', onState: () => {}, paused: false };

export function setPlayerHandlers(onState) { player.onState = onState; }
export function setRate(r) { player.rate = r; }

/** Speak text. Returns {ok, fallback} - fallback=true if no Hindi voice and English used. */
export function speak(text, lang) {
  if (!synth) return { ok: false };
  stopSpeaking();
  let voice = pickVoice(lang);
  let fallback = false;
  if (lang === 'hi' && !voice) fallback = true;
  player.queue = chunks(text);
  player.lang = lang;
  player.paused = false;
  const next = () => {
    const c = player.queue.shift();
    if (!c) { player.onState('ended'); return; }
    const u = new SpeechSynthesisUtterance(c);
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
    if (voice) u.voice = voice;
    u.rate = player.rate;
    u.onend = next;
    u.onerror = () => player.onState('ended');
    synth.speak(u);
  };
  player.onState('playing', { fallback });
  next();
  return { ok: true, fallback };
}

export function togglePause() {
  if (!synth) return;
  if (player.paused) { synth.resume(); player.paused = false; player.onState('playing'); }
  else { synth.pause(); player.paused = true; player.onState('paused'); }
}

export function stopSpeaking() {
  if (!synth) return;
  player.queue = [];
  synth.cancel();
  player.paused = false;
  player.onState('ended');
}
