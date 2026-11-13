/**
 * Applies classifyMessage_ (Classify.js) to every Email Log row and writes back
 * classification, confidence, matched company/contact, review status and the
 * reason. Safe to re-run. Rows a person has set to 'Human Verified' are left
 * alone, so corrections survive. Opt-out senders are marked in Contacts.
 */

const REVIEW = Object.freeze({AUTO: 'Auto', NEEDS: 'Needs Review', HUMAN: 'Human Verified'});

/** Menu action: classify all Email Log rows. */
function classifyEmailLog() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(EMAIL_TAB);
    if (!sh) throw new Error('Email Log is missing. Run setupCRM().');
    ensureHeaders_(sh, HEADER_MAP[EMAIL_TAB]);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    const col = name => headers.indexOf(name);
    const n = sh.getLastRow();
    if (n < 2) { ss.toast('Email Log is empty. Import emails first.', 'SWAG CRM', 5); return; }

    const data = sh.getRange(2, 1, n - 1, headers.length).getValues();
    const dir = loadDirectory_();
    const results = [], rowIndex = [];
    data.forEach((row, i) => {
      if (row[col('review_status')] === REVIEW.HUMAN) return;
      results.push(classifyMessage_({
        message_id: row[col('message_id')], thread_id: row[col('thread_id')], direction: row[col('direction')],
        from_email: row[col('from_email')], to_email: row[col('to_email')], subject: row[col('subject')],
        body: row[col('body_excerpt')], attachment_filenames: row[col('attachment_names')]
      }, dir));
      rowIndex.push(i);
    });
    flagThreadMismatches_(results);

    results.forEach((r, k) => {
      const row = data[rowIndex[k]];
      row[col('company_id')] = r.company_id;
      row[col('contact_id')] = r.contact_id;
      row[col('classification')] = r.category;
      row[col('confidence')] = r.confidence;
      row[col('review_status')] = r.needsReview ? REVIEW.NEEDS : REVIEW.AUTO;
      row[col('classification_reason')] = r.reason;
    });
    sh.getRange(2, 1, data.length, headers.length).setValues(data);

    const optOutsMarked = markOptOuts_(results.filter(r => r.category === CATEGORY.OPT_OUT).map(r => r.counterparty), dir);
    const counts = {};
    results.forEach(r => { counts[r.category] = (counts[r.category] || 0) + 1; });
    const review = results.filter(r => r.needsReview).length;
    const summary = Object.keys(counts).sort().map(k => k + ': ' + counts[k]).join(', ');
    const detail = 'Classified ' + results.length + ' (' + (data.length - results.length) + ' human-verified kept). ' +
      summary + '. Needs review: ' + review + '. Opt-outs newly marked: ' + optOutsMarked + '.';
    // Status 'Classified' (not 'Success') so the Dashboard's sync-run KPI only counts real syncs.
    writeLog_(start, 'Classified', results.length, data.length - results.length, 0, detail);
    console.log(detail);
    ss.toast('Classified ' + results.length + ' emails; ' + review + ' need review. Details in Sync Log.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Classification: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Builds the classifier directory from the Contacts, Customers and Suppliers tabs. */
function loadDirectory_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tab = name => ss.getSheetByName(name) ? readTable_(ss, name) : [];
  const business = (property_('BUSINESS_EMAILS') || '').split(',').map(x => x.trim()).filter(Boolean);
  const owner = Session.getEffectiveUser().getEmail();
  if (owner) business.push(owner);
  return buildDirectory_(tab('Contacts'), tab('Customers'), tab(SUPPLIER_TAB), business);
}

/**
 * Sets marketing_opt_out = TRUE for each address; adds a Contacts row for
 * senders not yet on file so the suppression is never lost.
 * @return {number} Contacts changed or added.
 */
function markOptOuts_(emails, dir) {
  const unique = Array.from(new Set(emails.filter(Boolean)));
  if (!unique.length) return 0;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Contacts');
  if (!sh) throw new Error('Contacts is missing. Run setupCRM().');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const emailCol = headers.indexOf('email'), optCol = headers.indexOf('marketing_opt_out');
  const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, headers.length).getValues() : [];
  const index = new Map(rows.map((r, i) => [normalizeEmail_(r[emailCol]), i]));
  let changed = 0;
  unique.forEach(email => {
    if (index.has(email)) {
      const row = rows[index.get(email)];
      if (!isTrue_(row[optCol])) { row[optCol] = true; changed++; }
      return;
    }
    const rec = {contact_id: 'C-NEW-' + Utilities.getUuid().slice(0, 8),
      company_id: dir.companyByDomain[companyDomain_(email)] || '', email: email, marketing_opt_out: true};
    rows.push(headers.map(h => rec[h] === undefined ? '' : rec[h]));
    changed++;
  });
  if (changed) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return changed;
}
