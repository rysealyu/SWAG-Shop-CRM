# Functional requirements and acceptance criteria

## CRM sheets

Required: Dashboard, Customers, Contacts, Email Log, Opportunities, Quotes, Orders, Supplier Quotes, Attachments, Follow Ups, Sync Log and Settings. Fields and IDs are described in `05_REFERENCE/Data_Dictionary.md`. Students may add tabs, but cannot replace the persistent CRM with chat history alone.

## Historical import

- Load 100 fictional email messages (CSV/JSONL); receive and sent are both present.
- Import `SWAG_Shop_Seed_Data.xlsx` and enrich known contacts rather than creating duplicates.
- Support multiple messages within the same conversation (thread ID), but deduplicate by source message ID.
- If the same import is repeated, the Email Log row count must remain unchanged.
- A separate, resumable initial Gmail backfill must be described; daily sync alone is not historical backfill.

## Daily synchronization

- Apps Script installable time-driven trigger runs once a day, scheduled in America/Chicago time zone.
- Detect incoming **and** sent Gmail messages since the prior checkpoint. Use a lookback and message-level deduplication; consider missed or late-arriving messages.
- Preserve source message and thread IDs, last-sync timestamp, processed/skipped/error counts and any incomplete-run warning.
- Offer a Sync Now menu option. Do not overclaim instantaneous arrival; scheduled triggers are not exact-timing guarantees.
- Do not mark a message processed if its associated structured updates failed; retry it safely.
- Avoid full inbox scans every day; use checkpoints, pagination and bounded batches.

## Business classification

- Categorize: new inquiry, quote request, customer quotation sent, supplier quotation received, confirmed customer PO, order status, follow-up, marketing opt-out, unrelated message, uncertain.
- Associate each with appropriate account/contact/opportunity, and preserve quote revisions with a shared opportunity ID.
- Detect both affirmative AND negative evidence; phrases like 'looks good but do not start production' are not orders.
- Record evidence message ID, extracted amount and confidence; uncertain PO or product identity must be reviewed.
- Do not count supplier quote emails toward customer quotes sent.

## Dashboard

- Show email messages received, sent and total (today, week, month).
- Show count and amount of customer quotes **sent** by period, number and value of **confirmed** customer orders, follow-ups due, AI review items and sync status.
- Week starts Monday; month is calendar month; day is in configured company time zone.
- Monthly quote conversion must be cohort-based if implemented; `orders this month / quotes this month` is NOT a reliable conversion rate.
- Provide detail tab/filters to explain numbers, and permit corrections without destroying source records.

## Attachment intelligence

- Attachments: PDF text, optional scanned PDF/OCR, `.xlsx`/CSV, images / artwork, optional `.docx`.
- Save original files safely in a restricted Drive folder (or retain links to authorized originals), never expose as public sharing links by default.
- Store attachment ID, Gmail message ID, file name, mime type, Drive link, extraction JSON, status, confidence or review state.
- Extract only available fields: product/color/quantity/imprint/date/zip/net cost/setup/freight/MOQ/lead time.
- Put discrepancies, unknown shipping costs, blurry artwork and incomplete prices into human review.

## Sales outreach

- Identify dormant buyers, unanswered customer quotes, and unanswered inquiries.
- Explain recommendation with relevant customer history and specific product details.
- Draft outreach only; require human approval for any send. Stop sequences upon reply or opt-out.
- Avoid marketing to suppliers or contacts who opted out. Log draft/approval status and avoid duplicate send recommendations.

## Portability

- Copy the Sheet, source code, Apps Script project and Drive fixture folder; run in a different authorized Google account.
- Include README, configuration template, source, data schema, prompts / agent skill, deployment steps, tests and cost statement.
- Triggers and OAuth grants need to be installed/authorized anew; don't assume Sheet copies preserve them.
- Use no hardcoded organizer account IDs, passwords, tokens or proprietary URLs.
