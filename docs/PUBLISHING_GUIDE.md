# Publish Analyx for free — step by step (no coding, no terminal)

You only need a web browser and a free GitHub account. Once it's set up, GitHub rebuilds the fund data every night and hosts the app. Nothing runs on your computer.

**Before you start**
- The original code belongs to someone else. Get the owner's OK before publishing a copy. The app will be public, and so will its code.
- The old project's `backend/.env` file contained a Groq API key. Ask the owner to delete that key at console.groq.com → API Keys. The new app doesn't use any keys.

---

## 1. Create a free GitHub account
Go to <https://github.com/signup>, sign up, and verify your email.

## 2. Create a public repository
1. Click the **+** at the top right, then **New repository**.
2. Repository name: `analyx` (lowercase is easiest).
3. Choose **Public**. Public repositories get GitHub Pages and Actions for free.
4. Leave "Add a README" unticked. Click **Create repository**.

## 3. Upload the files
1. Unzip `analyx.zip` on your computer. You'll get a folder called `analyx`.
2. On the new repository page, click the link **uploading an existing file**.
3. Open the `analyx` folder on your computer. Select everything inside it (`app`, `config`, `docs`, `pipeline`, `tests`, `README.md`) and drag it all into the browser window.
4. Wait until every file is listed, then click **Commit changes**.

> Your computer hides the `.github` folder (its name starts with a dot), so it won't be uploaded here. Step 5 adds it by hand.

## 4. Turn on GitHub Pages
1. In the repository, open **Settings**, then **Pages** (left menu).
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

## 5. Add the automatic update workflow
1. In the repository, open the `docs` folder, then click `workflow-copy.yml`.
2. Click the **Copy raw file** button (two overlapping squares, top right of the file view).
3. Go back to the repository's main page. Click **Add file → Create new file**.
4. In the name box, type exactly: `.github/workflows/update-and-deploy.yml`. Each `/` creates a folder as you type.
5. Paste the copied text into the big box. Click **Commit changes…**, then **Commit changes**.

## 6. Run it the first time
1. Open the **Actions** tab. If GitHub asks you to enable workflows, click the green button to enable them.
2. Saving the file in step 5 has probably started a run already, shown with a yellow dot. If not, click **Update data and publish** on the left, then **Run workflow → Run workflow**.
3. The first run takes about 3–6 minutes because it downloads every fund's history. A **green tick** means it's live.

## 7. Find your app link
Your app link is `https://YOUR-GITHUB-USERNAME.github.io/analyx/`. You can also find it under **Settings → Pages**, or click the run, then **deploy**.

## 8. Install it as an app
- **Android (Chrome):** open the link. Tap **Install app** in the page header, or ⋮ menu → **Install app / Add to Home screen**.
- **iPhone / iPad (Safari):** open the link. Tap **Share** → **Add to Home Screen**.
- **Laptop (Chrome or Edge):** open the link. Click **Install app** in the page header, or the install icon at the right end of the address bar.

## 9. Monthly update: inflation and risk-free rate (5 minutes)
These two numbers come from official releases. The app never guesses them, so you update them by hand once a month.

1. In the repository, open `config` → `macro.json` and click the **pencil (Edit)** icon.
2. **Inflation:** MoSPI publishes CPI around the 12th of each month (<https://www.mospi.gov.in> → Press Releases → CPI). In the `"inflation"` block, change:
   - `"value"`: the all-India CPI (Combined) year-on-year inflation, e.g. `5.54` (number only, no % sign)
   - `"period"`: e.g. `"October 2026"`
   - `"source_name"`, `"source_url"`: the press-release name and link
   - `"updated_on"`: today's date, e.g. `"2026-11-13"`
3. **Risk-free rate:** RBI announces 91-day T-bill auction results every Wednesday (<https://www.rbi.org.in> → Press Releases → "Auction Result of 91-day … Treasury Bill"). Take the **cut-off yield** and update the `"risk_free_rate"` block the same way.
4. Click **Commit changes**. The site rebuilds automatically in a few minutes.

Keep the quotes, commas and brackets exactly as they are. If a run fails right after an edit, a missing comma or quote is the usual cause. Open the file again and compare it with the example above.

## 10. Did last night's update work?
- Open the **Actions** tab. A green tick means it worked. A red ✗ means it failed, and **the site keeps yesterday's data**: nothing wrong is ever published.
- GitHub emails you when a run fails.
- To see why, click the red run → **build** → **Build site and data**. Read the lines starting with `ERROR:`.
  - "AMFI latest NAV date … is more than 5 days old" usually means a long market holiday or an AMFI delay. Wait a day, or re-run.
  - "histories failed" means mfapi.in was down. Click **Re-run jobs** later.
- In the app itself, a yellow banner appears if the data is more than 5 days old.

## 11. Keep the nightly update switched on
GitHub pauses scheduled workflows in public repositories after **60 days with no changes**. Your monthly `macro.json` edit counts as a change, so doing step 9 keeps it running. If you ever see "This scheduled workflow is disabled" in Actions, click **Enable workflow**.

## 12. After the first run: quick accuracy check (10 minutes)
Open these funds in the app (Direct Growth). Compare the 1Y / 3Y / 5Y returns with the same fund's page on the AMC website or a site like INDmoney, **for the same NAV date**. They should agree within about ±0.05 percentage points. Small gaps come from a 365 vs 365.25 day-count rounding.
- Parag Parikh Flexi Cap Fund
- HDFC Flexi Cap Fund
- ICICI Prudential Large Cap Fund
- Nippon India Small Cap Fund
- SBI Small Cap Fund

## Optional extras
- **Problem reports:** the "Report a problem" link at the bottom opens a pre-filled GitHub Issue in your repository automatically. Issues are on by default (Settings → General → Features → Issues).
- **AI explanations (optional, not built in):** the app writes its explanation from the numbers with no AI, so it costs nothing and can't invent facts. To add an AI-written version later, the free route is a Cloudflare Worker (free plan) that holds a Groq API key and receives only the computed numbers. The app must keep working when the Worker is down. This is a separate project. Ask for it when you want it.
- **Own domain:** Settings → Pages → Custom domain (the domain itself costs money; Pages is free).
