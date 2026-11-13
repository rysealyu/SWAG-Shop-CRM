# Data dictionary and metric definitions

All identifiers are fictional. Gmail-like sample CSV contains:

`message_id` = immutable unique message identifier; `thread_id` = conversation identifier; `date_time` = local America/Chicago timestamp; `direction` = IN/OUT from SWAG Shop's perspective; `from_email`, `to_email`, `subject`, `body`, `attachment_filenames` (pipe-separated names), `source` (SYNTHETIC_CSV) and `company_hint` (blank to force matching).

## Google Sheets CRM

- **Customers:** company_id, company_name, domain, industry, status, first_seen, last_activity_at, last_order_at, order_count, total_order_value, notes.
- **Contacts:** contact_id, company_id, full_name, email, phone, role, marketing_opt_out, last_activity_at.
- **Email Log:** message_id, thread_id, date_time (native date), direction, from_email, to_email, subject, body_excerpt, company_id, contact_id, classification, confidence, attachment_count, processed_at, source, review_status, source_link.
- **Opportunities:** opportunity_id, company_id, contact_id, product, quantity, stage, estimated_value, last_activity, next_action, source_thread_id.
- **Quotes:** quote_id, opportunity_id, company_id, sent_at, product, quantity, unit_price, setup_fee, freight, quoted_total, status, source_message_id.
- **Orders:** order_id, company_id, quote_id, order_date, po_number, product, quantity, unit_price, freight, confirmed_order_total, status, source_message_id.
- **Supplier Quotes:** supplier_quote_id, supplier_id, customer_opportunity_id, received_at, product, quantity, unit_cost, setup_cost, freight_cost, moq, lead_time, source_message_id.
- **Attachments:** attachment_id, message_id, filename, mime_type, drive_url, extracted_fields_json, parsed_at, review_status, sha256.
- **Follow Ups:** task_id, company_id, contact_email, due_date, reason, priority, status, source_thread_id, draft_subject, draft_body, approved.
- **Sync Log:** run_id, started_at, finished_at, status, processed_count, skipped_duplicate_count, error_count, details.

## Metric semantics

- **Today:** midnight through next midnight in company time zone.
- **This week:** Monday 00:00 through next Monday 00:00.
- **This month:** first day of month through first day of next month.
- **Email totals:** message count, unique by message_id; IN and OUT totals; thread count is a separate metric.
- **Quotes sent:** count of actual customer-facing outgoing quotation events. Revised quotes count as separate sent quote events but same opportunity. Supplier costs are NOT customer quotes.
- **Quoted amount:** signed/stated customer quote value; not supplier cost, realized revenue or payment.
- **Confirmed orders:** customer PO / explicit supported authorization with validated quantity and commercial terms; an ambiguous 'looks good' is not a confirmed order.
- **Confirmed order amount:** stated customer PO amount; taxes/freight not assumed if absent; avoid counting both PO and invoice as separate orders.
- **Conversion rate:** if built, cohort based: approved quotes ÷ quotes issued in a defined cohort. Do NOT mislabel same-month order count / same-month quote count as conversion.
- **Suppression:** opt-out blocks marketing drafts and campaign sends; it does not prevent necessary nonmarketing service communications.

## Primary keys and safety

- Email Log unique `message_id`, Attachments unique (`message_id`, `filename` / attachment ID, checksum), Contacts unique normalized email by authorized mailbox, Companies use stable ID with domain/name aliases and human review for uncertain matches.
- Keep source references for disputed values; do not overwrite historical quote versions.
- Avoid overwriting structured data with low-confidence AI output; set review status.
