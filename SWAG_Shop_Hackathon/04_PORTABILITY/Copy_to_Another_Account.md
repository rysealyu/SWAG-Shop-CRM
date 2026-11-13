# Mandatory deployment and portability handoff

The winning team must deliver a zip/Git repository that another person can use without rebuilding the business logic.

## Student handoff contents

- Bound Apps Script project source files (`.gs` and `appsscript.json`) or a reproducible `clasp` project.
- Google Sheets CRM template (XLSX is supplied; also export a copy of your populated demo Sheet as XLSX or provide a clearly documented copy method).
- Database / sheet schema, required named ranges, menus and triggers.
- AI extractor prompts, data schema, validations, business logic and tested examples (`SKILL.md`, see `05_REFERENCE/Agent_SKILL.md`).
- Sample import scripts, fixture files, tests and expected results for student's own tests.
- `SETUP.md` specifying permissions, daily trigger schedule, Drive folder access, keys/costs, and the list of secret **names**, not values.
- Versioned migration/upgrade plan to preserve user data during updates.

## Independent verification

1. Judge gets source ZIP and creates their own Google Sheet.
2. Judge copies `.gs` code and imports the starter workbook schema.
3. Judge authorizes Google scopes and uploads synthetic fixtures to their own Drive folder.
4. Judge sets their **own** Script properties and runs `setupCRM()` and import.
5. Judge adds at least one new fictional test Gmail email; runs Sync Now and sees CRM activity update.
6. Judge installs their own daily trigger (triggers are owned by and execute as the authorizing user).
7. Judge has the same dashboard logic, customer matching, quote/order distinctions and 10 draft recommendations without editing constants for the original student account.
8. Judge opens project with a different AI coding assistant and can change one workflow using included prompts/docs.

## What cannot safely be exported as a magic copy

- User OAuth permissions, Gmail credentials, API keys, script trigger owners, Drive permissions and live customer data.
- Historical Gmail IDs that don't exist in another Gmail account.
- Cloud LLM subscription entitlements, free-tier quotas or service billing agreements.

A successful transfer is a **repeatable setup process**, not a copy of private tokens.
