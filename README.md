# SWAG Shop CRM

A free, self-updating CRM that lives in one Google Sheet. It reads SWAG Shop's Gmail, works out what each
email is (a customer asking for prices, a quote we sent, a supplier's cost sheet, a real purchase order, an
opt-out...), and keeps customers, quotes, orders, attachments and follow-ups organized, with a dashboard a
manager can open every morning.

Built for the SWAG Shop AI Sales Intelligence CRM hackathon. All data in this project is fictional.

- **Runs on:** Google Sheets + Google Apps Script. No CRM subscription, no paid AI, no API keys.
- **Install:** see [SETUP.md](SETUP.md) (about 20 minutes, no code changes).
- **Business rules:** see [SKILL.md](SKILL.md).
- **Test evidence and demo script:** see [TESTING.md](TESTING.md).

---

## What it does

| Capability | How |
|---|---|
| **Import history** | Loads the 100-email sample (CSV) and the customer/supplier seed workbook. Running an import again adds nothing: every email is keyed on its message ID. |
| **Daily Gmail sync** | Reads received *and* sent mail since the last successful sync (with a 48-hour lookback for late arrivals), once a day at about 7 AM Central, or on demand with **Sync Gmail now**. |
| **Classify every email** | Into the 10 categories from the brief: new inquiry, quote request, customer quote sent, supplier quote received, confirmed customer PO, order status, follow-up, marketing opt-out, unrelated, uncertain. Every label comes with a confidence and a written reason. |
| **Tell real orders from "looks good"** | An order counts only with a PO number, an attached PO document, approval wording and no "do not start production"-style phrase. Everything ambiguous goes to human review. |
| **Never count supplier costs as sales** | Suppliers are recognized by address; their pricing goes to Supplier Quotes only. |
| **Quotes, orders, opportunities** | One opportunity per deal. Quote revisions (Q-1001 then Q-1001-R1) are kept as versions of the same deal, never overwritten. |
| **Read attachments** | PDFs (POs, supplier price sheets, briefs), Excel request forms, and images. Missing fields are listed, never guessed. PO documents are cross-checked against the order. |
| **Dashboard** | Emails received/sent, quotes sent and their value, confirmed orders and their value, follow-ups due, review items and sync status, for today, this Monday-start week, and this calendar month. All formulas over the underlying rows; nothing is typed in. |
| **10 follow-up drafts** | Ranked, personalized, with the reason and the evidence email IDs. Opt-outs, suppliers and paused projects are excluded. **Nothing is ever sent**: each draft waits for a person to tick "approved". |

## How it works

```
Gmail / sample CSV
      |
      v
 Email Log  --classify-->  labels + company/contact + review flag
      |
      +--> Attachments (PDF / Excel / image)  --> fields, missing fields, cross-checks
      |
      +--> Opportunities, Quotes, Orders, Supplier Quotes
      |
      +--> Follow Ups (10 drafts, approval required)
      |
      v
 Dashboard (formulas)          Sync Log (every run, every step)
```

**Sync Now** runs the whole chain. A new email is marked processed only after every step succeeds; if a
step fails, the run is logged with the step's name and the email is retried on the next run.

## The SWAG CRM menu

| Item | What it does |
|---|---|
| Setup missing tabs | Creates any missing tabs and columns (safe to repeat) |
| Import seed workbook | Customers, contacts, suppliers and past orders from the seed Excel file |
| Import 100 sample emails | The sample mailbox (CSV) |
| Classify emails / Build quotes, orders & opportunities / Process attachments / Draft 10 follow-ups | Individual pipeline steps |
| **Run full pipeline** | All of the above steps, in order, after an import |
| **Sync Gmail now** | Fetch new mail, then run the full pipeline (test account only) |
| Install daily sync trigger | Daily automatic sync |
| Backfill Gmail history | Imports older mail in 7-day windows; resumes by itself if it runs out of time |

## Correcting the CRM

People stay in charge. Corrections are never overwritten by the next run:

- **Email Log:** fix a label, then set `review_status` to **Human Verified**.
- **Quotes, Orders, Opportunities, Supplier Quotes, Attachments, Follow Ups:** tick `manual_lock` on a row you edited.
- **Follow Ups:** a row you approve, or whose status you change, is left alone. Drafts that stop being relevant
  are marked **Withdrawn**, not deleted.

## Safety and privacy

- **No email is ever sent.** There is no send code in the project.
- **Gmail is read only where explicitly enabled:** sync refuses to run unless Script property `SYNC_ENABLED` is `true`.
- **No secrets anywhere.** Configuration is Drive file and folder IDs in Script Properties (listed in SETUP.md).
- **Attachments stay private.** Files are kept in a Drive folder you choose. The code never changes sharing and
  flags any file that is shared publicly.
- **Email content is treated as data, not instructions.** Classification is rule-based; no email text is sent to an AI service.
- **Opt-outs are permanent suppressions** for marketing drafts. Service emails still get logged.

## Costs

| Item | Cost |
|---|---|
| Google Sheets, Apps Script, Drive, Gmail | $0 within the Google account's normal free quotas |
| CRM subscription | None needed |
| AI / OCR services | None used. Classification and drafting are rules and templates; PDF text comes from Google Drive's built-in conversion. |
| Recurring charges | None |

**Quotas to know about** ([official list](https://developers.google.com/apps-script/guides/services/quotas)):
each Apps Script run is limited to 6 minutes, triggers have a daily total runtime, and Gmail and Drive calls have
daily limits. The sync is built for this: bounded pages, a time budget per run, and a resumable backfill.
A business with very high email volume would need a Google Workspace account (higher quotas) or a move off
Apps Script.

## Limitations (honest list)

- **Rule-based classification.** It is tuned and tested on the sample's phrasing ("please quote", "do not start
  production", "remove me from your mailing list"). New phrasing can land in **Uncertain**, which is the safe
  failure: a person reviews it. English only.
- **Quote amounts** are read from text like "Total $3,760". A quote sent only as a PDF with no total in the
  email body is flagged as incomplete rather than guessed.
- **PDF reading** relies on Google Drive's PDF-to-Doc conversion. Clean PDFs work well; poor scans may lose
  fields, which then show up as missing and go to review.
- **Images are not analyzed.** A logo is recorded (type, size) and always flagged as "not manufacturer-ready
  artwork". A person checks it.
- **Follow-up drafts are templates** filled with real facts, not free-form AI writing.
- **One inbox** per installation. Multiple inboxes would need one install per account or a shared-mailbox design.
- **Dashboard formulas cover 5,000 rows** per tab, enough for this business; larger volumes need wider ranges.
- **Customers tab totals** (order count, total value) come from the seed workbook and are not yet updated by new orders.
- **Conversion rate is not shown.** The brief warns that "orders this month / quotes this month" is misleading; a
  proper cohort-based rate is a next step.

## Next steps toward production

1. Optional AI classifier for **Uncertain** emails only, behind the same review queue, with the cost disclosed.
2. Cohort-based quote conversion rate on the Dashboard.
3. Roll new orders into Customers totals and last-activity dates.
4. "Create Gmail draft" for approved follow-ups (still never auto-send).
5. Margin view per deal (supplier cost vs. our price) for internal use only.

## Project layout

```
src/                 Apps Script source (deployed with clasp)
  Code.js            tabs, menu, CSV import, Sync Log
  Seed.js            seed workbook import
  Classify.js        classification rules (pure logic)       ClassifyRunner.js   applies them to the Email Log
  Extract.js         quotes, orders, opportunities (pure)    RecordsRunner.js    writes those tabs
  Attachments.js     document field extraction (pure)        AttachmentsRunner.js  Drive conversion, Attachments tab
  FollowUps.js       ranking and draft text (pure)           FollowUpsRunner.js  Follow Ups tab
  GmailSync.js       sync windows, query, reply stripping    SyncRunner.js       Gmail sync, backfill, pipeline
  Dashboard.js       extra Dashboard rows
tests/               67 offline tests (npm test) on the sample data
SETUP.md  SKILL.md  TESTING.md
```

The "pure" files use no Google services, so the business rules run and are tested on any computer with Node.js.
