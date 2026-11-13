# Acceptance tests / live judge script

Work through these steps on a fresh copy of the student's solution; no direct edits to calculated KPI cells are allowed.

1. **First import:** import `Sample_Gmail_100_Emails.csv`; verify exactly 100 distinct Email Log message IDs.
2. **Replay:** import the same file again; verify zero new Email Log rows; existing source-to-CRM references still work.
3. **Customer vs supplier:** identify the customer-facing quote messages, supplier pricing communications and confirmed POs separately; explain how false positives are prevented.
4. **Quantity revision:** show the Acme Events tote conversation and demonstrate that 2,500 -> 3,000 is one opportunity with quote versions preserved.
5. **Ambiguous approval:** show messages saying 'looks good' or 'send invoice' while approval remains pending; do not classify as confirmed orders.
6. **Order PO:** open PO-2501 PDF and show fields: company, PO, quantity, unit price, product, date; link to correct company and message.
7. **Supplier economics:** open Supplier_Quote_Tumblers.pdf, extract $5.40 net unit, $55 setup, $180 freight, 10-12 business days. Do not mistake costs for selling prices.
8. **Excel:** read `Tumbler_Request.xlsx` and show quantity 500, color navy, imprint white, destination Denver, in-hand Dec 8.
9. **Artwork image:** show Northstar_Retail_Logo.png attached, linked to customer quote; image description does not substitute for manufacturer-ready artwork.
10. **Dashboard:** today, Monday-start week and calendar month metrics must be derived from records and recalculate after newly imported activity.
11. **Outreach:** show 10 customer-specific draft messages with evidence references. All 3 marketing opt-out senders are excluded from marketing drafts.
12. **Daily sync:** create a time-driven daily Apps Script trigger for an authorized test account, run `syncNow`, then add an unseen message and demonstrate update without duplication.
13. **Transfer test:** fresh Sheet and authorized account, reauthorize permissions, install trigger, import sample, show same end-to-end operation.

**Judge tip:** The student data contains 100 emails with mixed types and deliberately deceptive approval phrasing. The organizer has a separate, confidential answer key.
