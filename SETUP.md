# SWAG Shop CRM: Setup Guide

How to install the CRM in any Google account, from nothing to a working daily Gmail sync.
No code changes are needed. Expect about 20 minutes.

Everything runs inside Google Sheets + Google Apps Script. No paid services, no API keys.

---

## What you need

- A Google account. **Use a test account for Gmail sync**, not a personal inbox.
- These files from the hackathon package:
  - `03_APPS_SCRIPT_STARTER/SWAG_Shop_CRM_Template.xlsx`
  - `02_SAMPLE_DATA/Sample_Gmail_100_Emails.csv`
  - `02_SAMPLE_DATA/SWAG_Shop_Seed_Data.xlsx`
  - the folder `02_SAMPLE_DATA/attachments/`
- This project's source code (the `src/` folder).

> **Tip:** use one browser profile signed in to only this Google account (or an Incognito window).
> Being signed in to several accounts at once is the most common cause of "Access denied" errors.

---

## Part 1: Create the CRM Sheet

1. Go to **drive.google.com**, click **New > File upload**, and choose `SWAG_Shop_CRM_Template.xlsx`.
2. Right-click the uploaded file, choose **Open with > Google Sheets**, then **File > Save as Google Sheets**.
3. Rename the new Sheet `SWAG Shop CRM`.

## Part 2: Install the code

Open the Sheet, then **Extensions > Apps Script**. This creates the script project attached to the Sheet.

**Option A: clasp (recommended, one command)**

1. Turn on the Apps Script API for this account: **script.google.com/home/usersettings**, switch it **On**.
2. In Apps Script, open **Project Settings (gear icon)** and copy the **Script ID**.
3. On your computer (needs Node.js):
   ```
   npm install -g @google/clasp
   clasp login
   ```
   Sign in with the same account that owns the Sheet.
4. In this project's folder (the one containing `src/`), create a config file for your copy,
   e.g. `.clasp.mine.json`:
   ```json
   {"scriptId": "<YOUR_SCRIPT_ID>", "rootDir": "src"}
   ```
   (Keep it inside the project folder: clasp refuses a `rootDir` that points outside the config file's folder.)
5. Run `clasp push --force -P .clasp.mine.json`. All 14 `.js` files and `appsscript.json` are uploaded.
   Already logged in to clasp with a different Google account? Add a named login instead of replacing it:
   `clasp login --user mine`, then `clasp push --force -P .clasp.mine.json --user mine`.

**Option B: copy and paste (no tools)**

1. In Apps Script, click the gear and tick **Show "appsscript.json" manifest file in editor**.
2. Replace the contents of `appsscript.json` with `src/appsscript.json`.
3. For each `src/*.js` file, click **+ > Script**, give it the same name (without `.js`), and paste the contents.
   Replace the default `Code.gs` contents with `src/Code.js`.
4. Click **Save**.

**Either way:** in Project Settings, check that the time zone is **America/Chicago**.

## Part 3: Upload the sample files and set Script Properties

1. Upload to **your own Drive**, leaving them as they are (do not convert):
   - `Sample_Gmail_100_Emails.csv`
   - `SWAG_Shop_Seed_Data.xlsx`
   - the `attachments` folder (**New > Folder upload**). Keep its sharing **private**.
2. Copy each ID from its Drive URL:
   - File: the part between `/d/` and `/view`
   - Folder: the part after `/folders/` (stop before any `?`)
3. In Apps Script, **Project Settings > Script Properties > Add script property**:

| Property | Value | Required |
|---|---|---|
| `SAMPLE_EMAIL_CSV_FILE_ID` | ID of the CSV | For the sample data |
| `SEED_XLSX_FILE_ID` | ID of the seed workbook | For the sample data |
| `ATTACHMENTS_FOLDER_ID` | ID of the attachments folder | For attachment parsing and Gmail attachments |
| `SYNC_ENABLED` | `true` | **Only on the account whose Gmail should be read** |
| `BUSINESS_EMAILS` | e.g. `sales@yourco.com,info@yourco.com` | Optional: extra addresses that count as "sent by us" |
| `SYNC_INITIAL_DAYS` | e.g. `14` | Optional: how far back the first sync looks (default 14) |
| `BACKFILL_FROM` | e.g. `2026-01-01` | Optional: where history backfill starts (default one year ago) |

These are IDs and switches, not secrets. **No passwords or API keys are used anywhere.**

## Part 4: Load the sample data

1. **Reload the Sheet** (F5). A **SWAG CRM** menu appears after a few seconds.
2. **SWAG CRM > Setup missing tabs.** Google asks for permission the first time: choose your account,
   then **Advanced > Go to project > Select all > Continue**. (The warning appears because this is your own
   unreviewed script.)
3. Run, in order:
   1. **Import seed workbook (customers & suppliers)**
   2. **Import 100 sample emails**
   3. **Run full pipeline**: classify, attachments, quotes and orders, follow-up drafts. About 1 minute the first time.

### Expected results (check these to confirm the install)

| Where | Expected |
|---|---|
| Email Log | 100 rows. Running the email import again adds 0. |
| Sync Log, "Classified" row | Customer Quote Sent 12, Supplier Quote Received 3, Confirmed Customer PO 4, Uncertain 4, Marketing Opt-Out 3, Needs review 30 |
| Quotes / Orders | 12 quotes (Q-1001 Superseded by Q-1001-R1); 4 Confirmed orders totaling $16,175 |
| Attachments | 12 rows: 7 Auto, 5 Needs Review |
| Follow Ups | 10 drafts, none approved; the 3 opt-outs never appear |
| Dashboard | Counts depend on today's date relative to the sample (Oct 19 to Nov 13, 2026) |

## Part 5: Gmail sync (test account only)

1. Make sure `SYNC_ENABLED` = `true` is set (Part 3). Without it, sync refuses to run.
2. **Tell the CRM who your demo customer is.** Add a row to **Customers** (e.g. `A-900`, `Demo Customer Co`) and to
   **Contacts** (`C-900`, `A-900`, full name, the email address that will play the customer, `FALSE` for opt-out).
   Free-mail addresses like gmail.com are matched by exact address only, never by domain.
3. **SWAG CRM > Sync Gmail now.** The first run reads the last 14 days (received and sent), then runs the full
   pipeline. Check the Sync Log: status **Success**, with the number of new messages.
4. Send a new email to this account, then **Sync Gmail now** again. It appears once in the Email Log.
   Run Sync again: 0 new, no duplicates.
5. **SWAG CRM > Install daily sync trigger.** It runs once a day around 7 AM Central
   (Settings tab `daily_sync_hour`). Google picks the exact minute within that hour.
6. Optional: **Backfill Gmail history (resumable)** imports older mail in 7-day windows. If it runs out of time,
   it saves its place and continues automatically about a minute later.

### How sync stays safe and complete

- Only mail since the last successful sync is read, plus a 48-hour lookback for late arrivals.
  Message IDs prevent duplicates.
- Pages of 50 threads, at most 500 per run, within a 3-minute budget. If a limit is hit, the run is logged as
  **Partial** and the checkpoint does not move, so the next run re-reads the window.
- A new email's `processed_at` stays empty until every step succeeds. If a step fails, the run is logged as
  **Failed** with the step's name and is retried next time. The Dashboard's
  "Emails waiting to process" row shows the retry queue.
- Quoted reply history is stripped, so a reply that quotes our quote is not counted as a second quote.
- Nothing is ever sent. Follow-ups are drafts in the Sheet with an `approved` checkbox.

## What does NOT copy between accounts

Setting this up again on another account means redoing these steps. They cannot be copied:

- **Permissions (OAuth):** each account approves the script itself (Part 4, step 2).
- **Script Properties:** set them again (Part 3). They are not copied with the Sheet.
- **Triggers:** the daily sync trigger belongs to the account that installed it. Reinstall it (Part 5, step 5).
- **Drive files and Gmail data:** each account uses its own uploads and its own inbox.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Exception: Access denied: DriveApp` | Signed in to several Google accounts: use one account only (Incognito). Or a Drive box was unticked on the permission screen: remove the app at myaccount.google.com/permissions and approve again with **Select all**. School and work accounts may block this entirely; use a personal Gmail. |
| SWAG CRM menu missing or outdated | Reload the browser tab (F5). The menu is built when the Sheet opens. |
| `... has no "attachment_id" column` (or another column) | A header cell in row 1 was blank. Current code repairs it automatically; reload and run again. |
| `Gmail sync is off for this project` | Expected on any account without `SYNC_ENABLED` = `true`. Only set it on the test account. |
| A run failed | Open the **Sync Log**. The newest row names the failing step and the error. Fix it and run again; every step is safe to repeat. |
