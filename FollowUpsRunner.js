/**
 * Writes the Follow Ups tab from buildFollowUps_ (FollowUps.js). Safe to re-run:
 * rows are keyed on task_id and refreshed in place. A row a person has touched
 * (approved = TRUE, or status changed from Open) is never overwritten. Open,
 * unapproved rows that no longer qualify are marked Not Needed, not deleted.
 *
 * Nothing is sent. "Create Gmail drafts" only saves drafts for approved rows,
 * for a person to review and send from Gmail.
 */

const FOLLOW_UP_TAB = 'Follow Ups';

/** Menu action: rank customers and write up to 10 follow-up drafts. */
function generateFollowUps() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = runFollowUps_(ss);
    writeLog_(start, 'Follow-ups', result.added + result.updated, result.kept, 0, result.detail);
    console.log(result.detail);
    ss.toast(result.tasks + ' follow-up drafts ready for review (none sent). Details in Sync Log.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Follow-ups: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Builds and writes follow-ups. Caller holds the script lock.
 * @return {{tasks: number, added: number, updated: number, kept: number, retired: number, detail: string}}
 */
function runFollowUps_(ss) {
  const tab = name => ss.getSheetByName(name) ? readTable_(ss, name) : [];
  const log = tab(EMAIL_TAB);
  if (!log.some(r => r.classification && r.classification !== 'Unclassified')) {
    throw new Error('No classified emails yet. Run "Classify emails" first.');
  }
  const str = v => String(v === null || v === undefined ? '' : v).trim();
  const messages = log.map(r => ({
    message_id: str(r.message_id), thread_id: str(r.thread_id), date_time: r.date_time, direction: r.direction,
    from_email: r.from_email, to_email: r.to_email, subject: r.subject, body: r.body_excerpt,
    category: r.classification, company_id: str(r.company_id), contact_id: str(r.contact_id),
    reason: r.classification_reason
  }));
  const ids = rows => rows.map(r => Object.assign({}, r, {company_id: str(r.company_id)}));
  const input = {
    messages: messages,
    customers: ids(tab('Customers')),
    contacts: ids(tab('Contacts')),
    opportunities: ids(tab('Opportunities')),
    quotes: ids(tab('Quotes')).map(q => Object.assign(q, {source_message_id: str(q.source_message_id)})),
    orders: ids(tab('Orders'))
  };
  const result = buildFollowUps_(input, new Date(), {signature: property_('SENDER_NAME') || 'SWAG Shop Sales'});
  const written = writeFollowUps_(ss, result.tasks);

  const skips = result.skipped.map(s => s.company_id + ' (' + s.reason + ')').join('; ');
  const detail = result.tasks.length + ' follow-ups: +' + written.added + ' new, ' + written.updated + ' refreshed, ' +
    written.kept + ' kept as edited by a person, ' + written.retired + ' marked Not Needed. ' +
    (input.opportunities.length ? '' : 'Opportunities tab is empty: run "Build quotes, orders & opportunities" for quote follow-ups. ') +
    'Skipped: ' + (skips || 'none') + '.';
  return {tasks: result.tasks.length, added: written.added, updated: written.updated, kept: written.kept,
    retired: written.retired, detail: detail};
}

/** Upserts tasks on task_id, protecting rows a person has approved or closed. */
function writeFollowUps_(ss, tasks) {
  const sh = ensureTab_(ss, FOLLOW_UP_TAB);
  ensureHeaders_(sh, HEADER_MAP[FOLLOW_UP_TAB]);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const col = name => headers.indexOf(name);
  const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, headers.length).getValues() : [];
  const index = new Map(rows.map((r, i) => [String(r[col('task_id')]).trim(), i]));
  // Open and Not Needed are set by this code; any other status (Done, Sent, Dismissed...) came from a person.
  const systemStatus = ['', FOLLOW_UP.STATUS.OPEN, FOLLOW_UP.STATUS.NOT_NEEDED];
  const touched = row => isTrue_(row[col('approved')]) || systemStatus.indexOf(String(row[col('status')]).trim()) < 0;
  const cell = v => (v === null || v === undefined ? '' : v);

  let added = 0, updated = 0, kept = 0, retired = 0;
  const current = new Set();
  tasks.forEach(t => {
    current.add(t.task_id);
    if (!index.has(t.task_id)) {
      rows.push(headers.map(h => cell(t[h])));
      index.set(t.task_id, rows.length - 1);
      added++;
      return;
    }
    const row = rows[index.get(t.task_id)];
    if (touched(row)) { kept++; return; }
    // Refresh everything except columns a person owns.
    headers.forEach((h, i) => { if (h in t && h !== 'approved' && h !== 'gmail_draft_id') row[i] = cell(t[h]); });
    updated++;
  });
  rows.forEach(row => {
    const id = String(row[col('task_id')]).trim();
    if (!id || current.has(id) || touched(row) || row[col('status')] === FOLLOW_UP.STATUS.NOT_NEEDED) return;
    row[col('status')] = FOLLOW_UP.STATUS.NOT_NEEDED;
    retired++;
  });
  if (rows.length) {
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sh.getRange(2, col('due_date') + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, col('approved') + 1, rows.length, 1).insertCheckboxes();
  }
  return {added: added, updated: updated, kept: kept, retired: retired};
}

/**
 * Menu action: saves a Gmail draft (not sent) for each approved, open follow-up
 * that has no draft yet. Re-checks opt-outs first, in case one arrived since.
 */
function createApprovedFollowUpDrafts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ensureTab_(ss, FOLLOW_UP_TAB);
    ensureHeaders_(sh, HEADER_MAP[FOLLOW_UP_TAB]);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const col = name => headers.indexOf(name);
    const n = sh.getLastRow();
    if (n < 2) { ss.toast('No follow-ups yet. Run "Generate follow-up drafts" first.', 'SWAG CRM', 5); return; }
    const rows = sh.getRange(2, 1, n - 1, headers.length).getValues();
    const optedOut = new Set(readTable_(ss, 'Contacts').filter(c => isTrue_(c.marketing_opt_out))
      .map(c => normalizeEmail_(c.email)));

    let created = 0, blocked = 0;
    rows.forEach(row => {
      if (!isTrue_(row[col('approved')]) || row[col('status')] !== FOLLOW_UP.STATUS.OPEN || row[col('gmail_draft_id')]) return;
      const to = normalizeEmail_(row[col('contact_email')]);
      if (!to || optedOut.has(to)) { blocked++; return; }
      const draft = GmailApp.createDraft(to, String(row[col('draft_subject')]), String(row[col('draft_body')]));
      row[col('gmail_draft_id')] = draft.getId();
      created++;
    });
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
    const detail = 'Gmail drafts created: ' + created + ' (not sent). Blocked by opt-out or missing address: ' + blocked + '.';
    writeLog_(start, 'Drafts', created, blocked, 0, detail);
    ss.toast(detail + ' Review and send them from Gmail.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Gmail drafts: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}
