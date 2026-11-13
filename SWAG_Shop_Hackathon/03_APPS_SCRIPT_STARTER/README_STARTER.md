# Google Apps Script starter

`Code.gs` is **starter scaffolding, not a completed solution**. It creates/checks tabs, reads a sample CSV from Google Drive, conservatively logs recent Gmail messages, deduplicates by message ID, includes Sync Now and installs a daily scheduled trigger. It intentionally leaves AI extraction, customer matching, attachment parsing, full mailbox backfill, customer quote and order rows, outreach and reliable pagination for students.

## Setup

1. Import `SWAG_Shop_CRM_Template.xlsx` as a Google Sheet (File > Import > Upload, or upload as a new Sheet).
2. Open Extensions > Apps Script. Paste Code.gs into the editor and set project time zone to America/Chicago. Save.
3. Run `setupCRM()` and grant authorized permissions.
4. Upload `Sample_Gmail_100_Emails.csv` to your Google Drive.
5. In Apps Script > Project Settings > Script properties, add `SAMPLE_EMAIL_CSV_FILE_ID` with that CSV's Drive file ID. Optionally set `BUSINESS_EMAILS` (comma-separated authorized sender addresses) for accurate IN/OUT counting.
6. Run `importSampleCsv()`; note message classification stays `Unclassified` until you build the extractor and CRM writers.
7. Create your extraction logic and populate Quotes, Orders, Supplier Quotes, Customers, Opportunities and Attachments. Dashboard formulas update from those rows.
8. On an **authorized test Gmail account**, run `syncNow()` then `installDailySync()`. Confirm a new message logs. The current starter only inspects 100 recent Gmail threads; hitting the limit is logged as `Partial` and students must implement paging/checkpoints.

## Important

- Account owner must authorize access. No secrets belong in source code or source control.
- A copied spreadsheet does **not** automatically transfer installable triggers, OAuth grants, or Drive file permissions. Reauthorize and reinstall for each owner.
- A Sheet import may adapt formulas or data types. Confirm dashboard number/date formats after import.
- Never enable live bulk emailing during the hackathon. Outreach should create draft text for human approval.
- Trial with synthetic/test email only. Do not give students live SWAG Shop/QQP data.
- Google may schedule a daily time-driven trigger at an approximate time within the target hour.

## Docs

- Apps Script triggers: https://developers.google.com/apps-script/guides/triggers/installable
- GmailApp: https://developers.google.com/apps-script/reference/gmail/gmail-app
- GmailMessage attachments: https://developers.google.com/apps-script/reference/gmail/gmail-message
- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
- Sheets service: https://developers.google.com/apps-script/reference/spreadsheet
- clasp: https://github.com/google/clasp
