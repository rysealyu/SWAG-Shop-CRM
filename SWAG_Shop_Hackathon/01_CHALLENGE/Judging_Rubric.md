# Judging rubric - 100 points

| Category | Points | Evidence |
|---|---:|---|
| Correct Gmail + Excel ingestion | 20 | 100 imports, accurate account matching, source IDs, 0 duplicates on replay |
| Reliable quote/order classification | 20 | Supplier costs excluded, verified PO status, quote revision preserved, ambiguous approvals flagged |
| Google Sheets dashboard & metrics | 20 | Day/week/month sent/received, quote and order figures traceable to records |
| Attachment parsing | 15 | PDF, Excel, image/artwork or explicit unsupported flag; source links, missing-field handling |
| AI outreach quality & safety | 10 | 10 grounded personalized drafts, priority rationale, suppression/approvals |
| Daily automation and recovery | 10 | Trigger, Sync Now, checkpoints, logs, new email updates, retries |
| Portability and documentation | 5 | Can copy and run under another account, no hardcoded secrets |
| **Total** | **100** | |

**Hard failures:** Live unapproved sends, sharing passwords/API keys, unrecoverable data loss, fabricated order amounts, or a demo that works only through manually editing the dashboard must significantly reduce the score irrespective of appearance.

**Bonus (not part of 100):** useful optional HTML interface; product-image/similarity search with citations and competitive net cost analysis; safe 2-inbox sync; local zero-paid-API inference; resilient 10k-message backfill; deployable skill/prompt package for multiple AI tools.
