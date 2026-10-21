# Analyx — free mutual fund finder (mobile + laptop, Hindi + English, voice)

Analyx ranks Indian mutual funds (Direct plan, Growth option) within their SEBI category and suggests the top 10 for a goal, risk level, age and time frame. It is a static web app (an installable PWA). Free GitHub Actions rebuild the data every night, and free GitHub Pages hosts it. No server, no API keys, no paid services.

**To publish it, follow [docs/PUBLISHING_GUIDE.md](docs/PUBLISHING_GUIDE.md).** It uses only the GitHub website, no terminal.

## What each folder does

| Folder | What's in it |
|---|---|
| `app/` | The app people use: `index.html`, styles, JavaScript modules, Hindi/English text (`i18n/`), icons, offline service worker, install manifest |
| `config/` | Settings you can edit: `macro.json` (inflation and risk-free rate, updated monthly), `scoring.json` (metric weights), `profile_rules.json` (goal/risk/age → categories), `benchmarks.json` (which index funds act as benchmarks), `app_defaults.json` (starting values in the form) |
| `pipeline/` | Python that downloads AMFI data, computes every metric and ranking, and writes the JSON the app reads. `build_site.py` is the entry point. |
| `tests/` | Formula unit tests (`test_pipeline.py`), parser/logic tests (`js/app.test.mjs`), browser check (`e2e_check.py`) |
| `.github/workflows/` | The nightly "Update data and publish" job (a visible copy is in `docs/workflow-copy.yml`) |

## Data sources

| Source | Used for |
|---|---|
| [AMFI NAVAll.txt](https://www.amfiindia.com/spages/NAVAll.txt) | Official list of schemes, SEBI category, fund house, latest NAV and date |
| [mfapi.in](https://www.mfapi.in/) | Daily NAV history (a free mirror of AMFI data). The latest NAV is cross-checked against AMFI every night. |
| [MoSPI CPI releases](https://www.mospi.gov.in) | Inflation (entered monthly in `config/macro.json`) |
| [RBI T-bill auction results](https://www.rbi.org.in) | Risk-free rate for Sharpe/Sortino/alpha (entered monthly in `config/macro.json`) |

Benchmarks (Nifty 50, 100, 500, Midcap 150, Smallcap 250, LargeMidcap 250, Gold in INR) are measured from the NAV of the longest-running Direct-Growth index fund that tracks each index. The pipeline picks it automatically, and the app labels it (e.g. "Nifty 500 via Motilal Oswal Nifty 500 Index Fund").

## How the numbers are computed (`pipeline/metrics.py`)

- **Returns:** found by date, not by row count. Start NAV = last NAV on or before (end date − N years); not shown if the nearest NAV is more than 7 days away. 1Y is the absolute return; 3Y/5Y/10Y are CAGR.
- **Risk:** the last 36 complete months of month-end NAVs give the annualised volatility, Sharpe, Sortino (true downside deviation), regression beta and Jensen's alpha vs the category benchmark.
- **Drawdown:** the worst peak-to-trough fall over the last 3 years and since inception.
- **Consistency:** % of rolling 3-year windows in which the fund beat its benchmark.
- **Ranking:** percentile rank within the SEBI category for each metric, combined with the weights in `config/scoring.json`. Missing metrics are skipped and the weights rescaled — nothing is filled in. Funds need 3+ years of history. Top 10 allows at most 2 per fund house.
- **Data cleaning:** one-day NAV spikes that fully reverse the next day are removed and counted in the build log. Real market moves are kept.

When something can't be computed from these sources, the app shows **"Not available" / "उपलब्ध नहीं"**. Expense ratio, AUM and SEBI riskometer are shown that way, because no free, official, machine-readable feed could be verified.

## Known limits

- mfapi.in is free and community-run with no uptime guarantee. If it's down, the nightly build fails safely and yesterday's data stays live.
- Data updates once a day (after AMFI's evening NAV release), not intraday.
- Voice input uses the browser's speech recognition. It works in Chrome and Edge (desktop and Android) and only partly in Safari on iPhone; Firefox has none. Read-aloud uses the device's voices: Hindi needs a Hindi voice installed (most Android phones have one).
- Benchmarks are index-fund NAVs, so they include that fund's small expense ratio (a few basis points below the pure index).
- Hybrid and debt categories have no free benchmark here, so their alpha, beta and consistency show "Not available".
- Only Direct plans are ranked.
- The live NSE ticker from the old app was removed: NSE blocks those requests, and stale numbers shown as "live" would be misleading.

## Run locally (optional, for developers)

```bash
python pipeline/build_site.py --out _site          # needs internet; ~2 minutes
python -m http.server 8765 --directory _site       # open http://127.0.0.1:8765
python -m pytest -q tests && node --test tests/js/app.test.mjs
python tests/e2e_check.py http://127.0.0.1:8765/ screenshots/   # needs: pip install playwright
```

## Disclaimer

Analyx is a decision-support tool, not investment advice, and is not registered with SEBI. Publicly recommending specific funds may require SEBI Investment Adviser registration — check before promoting it.
