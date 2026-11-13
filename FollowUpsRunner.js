/**
 * Writes the Follow Ups tab from buildFollowUps_ (FollowUps.js). Draft-only:
 * nothing is sent. Rows a person has handled (status changed from Open,
 * approved = TRUE, or manual_lock = TRUE) are never overwritten. An Open,
 * unapproved row that is no longer recommended (e.g. the customer replied)
 * is marked Withdrawn rather than deleted.
 */

const FOLLOW_UP_TAB = 'Follow Ups';

/** Menu action: rank follow-ups and (re)draft the top 10. */
function buildFollowUps() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const r = runFollowUps_(ss, start);
    writeLog_(start, 'Follow-ups', r.drafted, r.handled, 0, r.detail);
    console.log(r.detail);
    ss.toast(r.drafted + ' follow-up drafts ready for review in "' + FOLLOW_UP_TAB + '". Nothing was sent.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Follow-ups: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ranks follow-ups and writes the Follow Ups tab. Caller holds the script lock.
 * @return {{drafted: number, handled: number, detail: string}}
 */
function runFollowUps_(ss, now) {
  const tab = name => (ss.getSheetByName(name) ? readTable_(ss, name) : []);
  const messages = tab(EMAIL_TAB).map(r => ({
    message_id: String(r.message_id), thread_id: String(r.thread_id), date_time: r.date_time, direction: r.direction,
    from_email: r.from_email, to_email: r.to_email, subject: r.subject, body: r.body_excerpt,
    category: r.classification, company_id: r.company_id, contact_id: r.contact_id, reason: r.classification_reason
  }));
  if (!messages.some(m => m.category && m.category !== 'Unclassified')) {
    throw new Error('No classified emails yet. Run "Classify emails" and "Build quotes, orders & opportunities" first.');
  }
  const result = buildFollowUps_({
    messages: messages, opportunities: tab('Opportunities'), quotes: tab('Quotes'), orders: tab('Orders'),
    contacts: tab('Contacts'), customers: tab('Customers')
  }, {now: now, businessName: setting_(ss, 'business_name') || 'SWAG Shop'});

  const existing = {};
  tab(FOLLOW_UP_TAB).forEach(r => { existing[r.task_id] = r; });
  const handled = r => Boolean(r) && (r.status !== TASK_STATUS.OPEN || isTrue_(r.approved));
  const fresh = new Set(result.tasks.map(t => t.task_id));
  const drafts = result.tasks.filter(t => !handled(existing[t.task_id]));
  const withdrawn = Object.keys(existing).filter(id => id && !fresh.has(id) && !handled(existing[id])).map(id => ({
    task_id: id, status: TASK_STATUS.WITHDRAWN,
    reason: 'Withdrawn ' + now.toDateString() + ': no longer in the top recommendations. Was: ' + existing[id].reason
  }));
  const written = writeDerived_(ss, FOLLOW_UP_TAB, 'task_id', drafts.concat(withdrawn));
  addCheckboxes_(ss.getSheetByName(FOLLOW_UP_TAB), ['approved', 'manual_lock']);

  const skipped = result.excluded.map(e => e.company_name + ' (' + e.reason + ')').join('; ');
  const handledCount = result.tasks.length - drafts.length;
  const detail = 'Follow-ups: ' + result.tasks.length + ' recommended, ' + drafts.length + ' drafted (' + written.added +
    ' new, ' + written.updated + ' updated, ' + written.locked + ' locked), ' + handledCount +
    ' already handled by a person, ' + withdrawn.length + ' withdrawn. Nothing was sent. Not drafted: ' +
    (skipped || 'none') + '.';
  return {drafted: drafts.length, handled: handledCount, detail: detail};
}

/** Value of a row in the Settings tab (setting | value | notes), or ''. */
function setting_(ss, name) {
  if (!ss.getSheetByName('Settings')) return '';
  const row = readTable_(ss, 'Settings').find(r => String(r.setting).trim() === name);
  return row ? String(row.value).trim() : '';
}

/** Turns TRUE/FALSE columns into checkboxes so approving a draft is one click. */
function addCheckboxes_(sh, columnNames) {
  const n = sh.getLastRow();
  if (n < 2) return;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  columnNames.forEach(name => {
    const col = headers.indexOf(name);
    if (col >= 0) sh.getRange(2, col + 1, n - 1, 1).insertCheckboxes();
  });
}
