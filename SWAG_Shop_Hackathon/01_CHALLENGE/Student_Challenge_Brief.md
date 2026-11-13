# SWAG Shop AI CRM Hackathon

## Your customer

SWAG Shop is a fictional business that sources promotional merchandise for companies: custom tote bags, drinkware, lanyards, apparel, corporate gifts and more. The business operates primarily through Gmail and spreadsheets. Old conversations contain customer names, requirements, supplier quotations, requests for pricing, purchase orders, delivery details and opportunities to follow up. There is no organized CRM today.

## Your mission

Build a **free-to-run, portable, Google Sheets CRM** that automatically converts historical and newly arriving Gmail messages into structured customer records and a reliable, daily-updating sales dashboard. Use **Google Sheets + Google Apps Script** as the foundation. You may use Google Drive for attachments and your preferred AI model or rules engine, provided costs and limits are disclosed.

### The required end-to-end flow

1. Import historical messages and Excel lists.
2. Deduplicate email messages and customer/contact profiles.
3. Identify conversation type and pull relevant details from email text and attachments.
4. Create or update Customers, Contacts, Opportunities, Quotes, Orders, Supplier Quotes and Follow-Ups in Sheets.
5. Update the Dashboard: daily, weekly and monthly email counts, quotes sent, confirmed customer orders, values and work requiring attention.
6. Generate highly contextual outreach drafts from customer history. Do not send without human approval. Respect opt-outs.
7. Run an authorized daily Gmail synchronization; offer a **Sync Now** action and run/error log.
8. Export all source code, config templates, prompt/skills, docs and workbook so someone else can install it under their Google account.

### Metrics you must get right

- **Inbound emails:** messages actually received, not threads. Exclude deleted/spam from real operation.
- **Outbound emails:** messages actually sent, not drafts.
- **Customer quote sent:** an actual outgoing quotation with an identified customer, date, amount and quote identifier; keep revisions and link versions. Do not count a supplier's pricing email.
- **Confirmed order:** an explicit customer PO/approval supported by credible records, not "looks good," "please send invoice," or a supplier order acknowledgement. Escalate uncertainty.
- **Quoted value:** customer-facing quote amount, not cost or revenue.
- **Order value:** accepted/confirmed customer order amount, not automatically payment collected or recognized revenue.
- **Follow-up:** personalized recommendations with reasons and source evidence; skip opt-outs and active conversations.

### Document intelligence

Support customer PDFs, Excel attachments, purchase orders, logos/images, and supplier price sheets. Extract product, quantity, item color, imprint color/method, imprint location, artwork, ship-to ZIP, in-hand date, net costs, setup, freight, MOQ and lead times when present. Record missing fields instead of guessing; keep a source link, confidence and a human-review path. Parse binary attachments only when supported and authorized.

### Required live demonstration

1. Show the 100-message fictional mailbox dataset and seed workbook.
2. Import it into a Google Sheet and show customer profiles and email history.
3. Run the import again; show that no duplicate email entries were created.
4. Show quote counts, confirmed PO counts, value totals and calendar-based day/week/month trends.
5. Open one conversation whose customer changed a quantity. Show the existing opportunity updated and the revised quote preserved.
6. Open PDF supplier pricing, Excel product specs and a PO; show extracted fields and original file links.
7. Show 10 prioritized personalized outreach drafts and explain the reason for each; do not send.
8. Enable a daily Apps Script time-driven trigger and show a manual Sync Now run for a new test email.
9. Show the project copied to another authorized test account without rewriting it.

### What we will judge

Accuracy, persistence, duplicate prevention, user experience, portability, security and clear evidence of work. A polished interface cannot compensate for fabricated financial metrics or missing history.

### Technology and cost policy

The CRM must remain operational without a HubSpot or another CRM subscription. The default business data store is Google Sheets. Apps Script runs scheduled syncs. Use Drive for supporting files. Optional HTML front end is welcome but the Dashboard must still work directly inside Sheets. External AI may be used, but you must document recurring charges, quotas and how to run a limited no-paid-API demo.

**Do not share real email passwords, expose sensitive data to an AI service without explicit consent, or send marketing messages from the sample data.**
