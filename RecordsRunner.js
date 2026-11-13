/**
 * Writes Opportunities, Quotes, Orders and Supplier Quotes rows derived from
 * the classified Email Log (logic in Extract.js). Safe to re-run: rows are
 * matched on their ID and updated in place, never duplicated. A row with
 * manual_lock = TRUE is never overwritten, so hand corrections survive.
 */

/** Menu action: rebuild quote/order/opportunity rows from the Email Log. */
function buildCrmRecords() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const built = runBuildRecords_(ss);
    // Status 'Records' (not 'Success') so the Dashboard's sync-run KPI only counts real syncs.
    writeLog_(start, 'Records', built.records.quotes.length + built.records.orders.length, 0, 0, built.detail);
    console.log(built.detail);
    ss.toast(built.records.quotes.length + ' quotes, ' + built.confirmed + ' confirmed orders. Details in Sync Log.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Build records: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Derives and writes all record tabs, using parsed attachments when present.
 * Caller holds the script lock.
 * @return {{records: Object, confirmed: number, detail: string}}
 */
function runBuildRecords_(ss) {
  const log = readTable_(ss, EMAIL_TAB);
  if (!log.some(r => r.classification && r.classification !== 'Unclassified')) {
    throw new Error('No classified emails yet. Run "Classify emails" first.');
  }
  const messages = log.map(r => ({
    message_id: String(r.message_id), thread_id: String(r.thread_id), date_time: r.date_time,
    direction: r.direction, subject: r.subject, body: r.body_excerpt, attachment_filenames: r.attachment_names,
    category: r.classification, company_id: r.company_id, contact_id: r.contact_id, reason: r.classification_reason
  }));
  const companies = ss.getSheetByName('Customers') ? readTable_(ss, 'Customers') : [];
  const attachments = readParsedAttachments_(ss);
  const records = deriveRecords_(messages, companies, attachments);

  const results = {
    'Opportunities': writeDerived_(ss, 'Opportunities', 'opportunity_id', records.opportunities),
    'Quotes': writeDerived_(ss, 'Quotes', 'quote_id', records.quotes),
    'Orders': writeDerived_(ss, 'Orders', 'order_id', records.orders),
    'Supplier Quotes': writeDerived_(ss, 'Supplier Quotes', 'supplier_quote_id', records.supplierQuotes)
  };
  if (records.attachmentLinks.length) writeDerived_(ss, ATTACHMENT_TAB, 'attachment_id', records.attachmentLinks);
  ensureDashboardExtras_(ss);
  const confirmed = records.orders.filter(o => o.status === ORDER_STATUS.CONFIRMED);
  const orderValue = confirmed.reduce((sum, o) => sum + (o.confirmed_order_total || 0), 0);
  const detail = Object.keys(results).map(tab => tab + ' +' + results[tab].added + ' new, ' +
    results[tab].updated + ' updated, ' + results[tab].locked + ' locked').join('; ') +
    '. Confirmed orders: ' + confirmed.length + ' ($' + orderValue.toFixed(2) + '). Orders needing review: ' +
    (records.orders.length - confirmed.length) + '. Attachments used: ' + attachments.length + '.';
  return {records: records, confirmed: confirmed.length, detail: detail};
}

/** Parsed attachment rows (Attachments tab) in the shape deriveRecords_ expects. */
function readParsedAttachments_(ss) {
  if (!ss.getSheetByName(ATTACHMENT_TAB)) return [];
  return readTable_(ss, ATTACHMENT_TAB).filter(r => r.extracted_fields_json).map(r => {
    let parsed = {};
    try {
      parsed = JSON.parse(r.extracted_fields_json);
    } catch (e) {
      console.warn('Bad extracted_fields_json on ' + r.attachment_id + ': ' + e);
    }
    return {attachment_id: String(r.attachment_id), message_id: String(r.message_id || ''), filename: r.filename,
      document_type: parsed.document_type || r.document_type, fields: parsed.fields || {}, missing: parsed.missing || []};
  });
}

/**
 * Upserts records into a tab keyed on keyField. Existing rows are overwritten
 * with fresh values unless their manual_lock cell is TRUE. Rows no longer
 * produced by the source are left in place, never deleted.
 * @return {{added: number, updated: number, locked: number}}
 */
function writeDerived_(ss, tabName, keyField, records) {
  const sh = ensureTab_(ss, tabName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const keyCol = headers.indexOf(keyField), lockCol = headers.indexOf('manual_lock');
  if (keyCol < 0) {
    throw new Error(tabName + ' has no "' + keyField + '" column. Row 1 has: ' +
      headers.map((h, i) => columnLetter_(i + 1) + '="' + h + '"').join(', '));
  }
  const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, headers.length).getValues() : [];
  const index = new Map(rows.map((r, i) => [String(r[keyCol]).trim(), i]));
  const cell = v => (v === null || v === undefined ? '' : v);
  let added = 0, updated = 0, locked = 0;
  records.forEach(rec => {
    const key = String(rec[keyField] || '').trim();
    if (!key) return;
    if (!index.has(key)) {
      rows.push(headers.map(h => (h === 'manual_lock' ? false : cell(rec[h]))));
      index.set(key, rows.length - 1);
      added++;
      return;
    }
    const row = rows[index.get(key)];
    if (lockCol >= 0 && isTrue_(row[lockCol])) { locked++; return; }
    headers.forEach((h, i) => { if (h !== 'manual_lock' && h in rec) row[i] = cell(rec[h]); });
    updated++;
  });
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return {added: added, updated: updated, locked: locked};
}
