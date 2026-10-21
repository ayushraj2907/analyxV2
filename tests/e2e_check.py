"""Browser check of the built site (phone + laptop, English + Hindi).

Usage:
    python -m http.server 8765 --directory _site &
    python tests/e2e_check.py http://127.0.0.1:8765/ screenshots/

Fails if there are console errors, horizontal scrolling, or English UI text
left over in Hindi mode (fund names, AMC names and index names are allowed).
"""
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "screenshots")
OUT.mkdir(parents=True, exist_ok=True)

# English words allowed to appear in Hindi mode (acronyms / brand terms)
ALLOWED = {"SIP", "NAV", "AMFI", "ELSS", "CPI", "PSU", "STP", "SEBI", "Analyx", "English", "mfapi", "AI",
           "NAVAll", "txt", "MoSPI", "Business", "Standard", "RBI", "Oct", "press", "release", "report",
           "on", "auctions", "T-bill", "CAGR", "Direct", "Growth", "Actions", "GitHub", "Update", "data",
           "and", "publish", "config", "scoring", "json", "in", "of", "the", "CPI", "Chrome", "Edge", "Nifty",
           "Combined", "SEBI-", "Sep", "Sept", "September", "Auction", "Index"}

problems = []


def visible_english(page):
    """English words in visible text outside fund/AMC/index names (.proper) and links."""
    text = page.evaluate("""() => {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 3) { out.push(n.textContent); return; }
        if (n.nodeType !== 1) return;
        const el = n;
        if (el.closest('.proper, a, script, style, [hidden], option, .chart-wrap, .src')) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        el.childNodes.forEach(walk);
      };
      walk(document.body);
      return out.join(' ');
    }""")
    words = set(re.findall(r"[A-Za-z][A-Za-z\-]{2,}", text))
    return sorted(w for w in words if w not in ALLOWED)


def run(pw, name, viewport, lang, mobile):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile,
                              device_scale_factor=2 if mobile else 1, locale="en-IN")
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(f"try {{ localStorage.setItem('analyx-lang', '{lang}'); }} catch(e) {{}}")
    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("#bench-grid .bench-card")
    page.screenshot(path=str(OUT / f"{name}-1-home.png"), full_page=False)

    # describe-in-words flow
    page.click("#tab-text")
    sample = "हर महीने दस हज़ार की SIP, बीस साल, मध्यम जोखिम, मेरी उम्र 28 साल है" if lang == "hi" \
        else "SIP of 10,000 a month for 20 years, medium risk, I am 28"
    page.fill("#free-text", sample)
    page.click("#parse-btn")
    page.wait_for_selector("#text-confirm .pill")
    page.screenshot(path=str(OUT / f"{name}-2-understood.png"))
    page.click("#text-confirm [data-act=go]")
    page.wait_for_selector("#fund-list .fund")
    page.wait_for_timeout(400)
    n = page.locator("#fund-list .fund").count()
    if n == 0:
        problems.append(f"{name}: no funds shown")
    page.screenshot(path=str(OUT / f"{name}-3-results.png"), full_page=True)

    # fund detail
    page.locator("#fund-list .fund [data-act=detail]").first.click()
    page.wait_for_selector("#detail-chart svg")
    page.screenshot(path=str(OUT / f"{name}-4-detail.png"))

    if lang == "hi":
        eng = visible_english(page)
        if eng:
            problems.append(f"{name}: English words visible in Hindi mode: {eng[:40]}")
    sw = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
    if sw:
        problems.append(f"{name}: horizontal scroll present")
    page.click("#sheet-close")
    if errors:
        problems.append(f"{name}: console errors: {errors[:5]}")
    print(f"{name}: {n} funds shown, console errors: {len(errors)}")
    browser.close()


def offline_check(pw):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle")
    page.evaluate("navigator.serviceWorker.ready.then(() => true)")
    page.wait_for_timeout(1500)
    page.reload(wait_until="networkidle")  # page now controlled by the service worker
    ctx.set_offline(True)
    page.reload()
    try:
        page.wait_for_selector("#bench-grid .bench-card", timeout=8000)
        page.click("#find-btn")
        page.wait_for_selector("#fund-list .fund", timeout=8000)
        print("offline: app opens and shows funds without internet")
    except Exception as e:  # noqa: BLE001
        problems.append(f"offline: app did not work offline ({e})")
    # read-aloud button must not throw
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.click("#listen-summary")
    page.wait_for_timeout(500)
    if errs:
        problems.append(f"listen: {errs}")
    browser.close()


with sync_playwright() as pw:
    offline_check(pw)
    run(pw, "phone-en", {"width": 390, "height": 844}, "en", True)
    run(pw, "phone-hi", {"width": 390, "height": 844}, "hi", True)
    run(pw, "laptop-en", {"width": 1440, "height": 900}, "en", False)
    run(pw, "laptop-hi", {"width": 1440, "height": 900}, "hi", False)
    run(pw, "small-360-en", {"width": 360, "height": 640}, "en", True)

if problems:
    print("\nPROBLEMS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("\nAll browser checks passed.")
