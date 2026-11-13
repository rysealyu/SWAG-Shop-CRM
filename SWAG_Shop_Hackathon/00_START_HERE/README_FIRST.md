# SWAG Shop | AI Sales Intelligence CRM Hackathon

**Start here.** You are building for SWAG Shop, a completely fictional B2B promotional products company. The challenge is to transform messy customer email history into a working, daily-updating CRM built in **Google Sheets + Google Apps Script**, with an optional polished HTML interface.

## The goal

A manager should be able to open one Google Sheet every morning and see customer communications, daily/weekly/monthly email volume, customer quotes sent, actual orders, attachments, follow-ups, and AI-recommended sales opportunities.

This is **not** a static mockup. Students must show working ingestion, persistent records, reproducible counts, and portable source code.

## Where everything is

| Location | Contents |
|---|---|
| `01_CHALLENGE/` | Shareable PDF brief, detailed functional requirements, rubric, live demo script |
| `02_SAMPLE_DATA/` | 100 fictional Gmail-like messages (CSV + JSONL), realistic email attachments, Excel seed data, selected `.eml` examples |
| `03_APPS_SCRIPT_STARTER/` | CRM workbook template and optional Apps Script starter; you must complete classification, quoting and outreach logic |
| `04_PORTABILITY/` | Setup, migration, source-export and second-account test criteria |
| `05_REFERENCE/` | Data dictionary, AI agent contract, reliability rules, example prompts and documentation links |

## First 20 minutes

1. Read `01_CHALLENGE/Student_Challenge_Brief.pdf` and `01_CHALLENGE/Acceptance_Tests.md`.
2. Create a Google Sheet by importing `03_APPS_SCRIPT_STARTER/SWAG_Shop_CRM_Template.xlsx` into Google Sheets.
3. Open **Extensions > Apps Script**, paste `.gs` files from the starter, and save (or use `clasp`). Run `setupCRM()` once to authorize.
4. Upload `02_SAMPLE_DATA/Sample_Gmail_100_Emails.csv` to your own Google Drive; set its file ID in **Project Settings > Script properties** as `SAMPLE_EMAIL_CSV_FILE_ID`.
5. Run `importSampleCsv()`; verify that the email log fills. Finish the classification, customer matching, quote/order extraction, attachment parsing, and dashboard logic.
6. Once it works on fictional data, demonstrate `installDailySync()` and `syncNow()` with an authorized **test** Gmail account. Daily sync needs permission from the account owner.

**Do not use any real customer data from the organizer.** No live marketing emails should be sent. No real credentials or API keys should be present in submitted code.

## Boundaries and costs

Google Sheets, Apps Script and Drive can be used without an additional CRM subscription, subject to Google account limits and quotas. Cloud AI model APIs, large-scale OCR, storage and future hosting may incur costs. Disclose anything paid. Students may use an approved free tier, a local model, or a controlled demonstration with declared limitations.

## Definition of done

- Import and reconcile 100 emails with zero duplicates on second run.
- Show a usable CRM, not just a raw email dump.
- Classify actual customer quotes vs supplier pricing vs inquiries vs confirmed POs.
- Update daily, weekly and monthly KPIs from underlying records.
- Extract at least one PDF, one Excel attachment and one image/artwork file (or correctly flag unsupported extraction).
- Identify and draft 10 personalized customer follow-ups; human review before sending.
- Copy the solution to a separate account and successfully run it on a second dataset.

**Organizer answer key is intentionally NOT inside this package.**
