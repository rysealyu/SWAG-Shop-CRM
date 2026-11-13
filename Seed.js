/**
 * Seed workbook import: loads Customers, Contacts and Suppliers from the
 * organizer's SWAG_Shop_Seed_Data.xlsx. Re-running only fills blank cells, so
 * known contacts are enriched, never duplicated, and manual edits survive.
 *
 * Needs the Drive advanced service (appsscript.json) to convert the .xlsx.
 */

const SUPPLIER_TAB = 'Suppliers';

/** Menu action: import the seed workbook named by Script property SEED_XLSX_FILE_ID. */
function importSeedWorkbook() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import is running');
  const start = new Date();
  let tempId = null;
  try {
    const fileId = property_('SEED_XLSX_FILE_ID');
    if (!fileId) throw new Error('Set Script property SEED_XLSX_FILE_ID to the Drive file ID of SWAG_Shop_Seed_Data.xlsx');
    // Apps Script cannot read .xlsx directly; convert a temporary Google Sheet copy, read it, then trash it.
    const blob = DriveApp.getFileById(fileId).getBlob();
    tempId = Drive.Files.create({name: 'SWAG seed import (temporary)', mimeType: MimeType.GOOGLE_SHEETS}, blob).id;
    const seed = SpreadsheetApp.openById(tempId);
    const people = readTable_(seed, 'Customers_and_Contacts');
    const history = readTable_(seed, 'Historical_Orders');
    const suppliers = readTable_(seed, 'Supplier_Directory');

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureTab_(ss, SUPPLIER_TAB);
    const customers = upsertRows_('Customers', 'company_id', seedCustomers_(people, history));
    const contacts = upsertRows_('Contacts', 'email', people.map(p => ({
      contact_id: p.contact_id, company_id: p.company_id, full_name: p.contact_name,
      email: normalizeEmail_(p.email), marketing_opt_out: false
    })));
    const supplierRows = upsertRows_(SUPPLIER_TAB, 'email', suppliers.map(s => ({
      supplier_id: s.supplier_id, supplier_name: s.supplier_name, email: normalizeEmail_(s.email),
      category: s.category, region: s.region, notes: s.notes
    })));

    const detail = 'Seed workbook imported. Customers +' + customers.added + ' (' + customers.enriched + ' enriched), ' +
      'Contacts +' + contacts.added + ' (' + contacts.enriched + ' enriched), ' +
      'Suppliers +' + supplierRows.added + ' (' + supplierRows.enriched + ' enriched).';
    writeLog_(start, 'Imported', customers.added + contacts.added + supplierRows.added, 0, 0, detail);
    ss.toast(detail, 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, String(e));
    throw e;
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
    lock.releaseLock();
  }
}

/** One Customers record per company, with order totals from the seed's Historical_Orders. */
function seedCustomers_(people, history) {
  const byCompany = {};
  people.forEach(p => {
    if (!p.company_id || byCompany[p.company_id]) return;
    byCompany[p.company_id] = {company_id: p.company_id, company_name: p.company_name,
      domain: companyDomain_(normalizeEmail_(p.email)), industry: p.industry, status: p.relationship_status,
      order_count: 0, total_order_value: 0, last_order_at: '', notes: 'Seed import; order totals are historical (pre-email) orders'};
  });
  history.forEach(o => {
    const c = byCompany[o.company_id];
    if (!c) return;
    c.order_count += 1;
    c.total_order_value += Number(o.sales_value) || 0;
    const when = o.order_date instanceof Date ? o.order_date : new Date(o.order_date);
    if (!isNaN(when) && (!c.last_order_at || when > c.last_order_at)) c.last_order_at = when;
  });
  return Object.keys(byCompany).map(id => byCompany[id]);
}

/** Reads a tab with a header row into an array of {header: value} objects. */
function readTable_(spreadsheet, tabName) {
  const sh = spreadsheet.getSheetByName(tabName);
  if (!sh) throw new Error('Missing tab "' + tabName + '" in ' + spreadsheet.getName());
  const values = sh.getDataRange().getValues();
  const headers = (values.shift() || []).map(h => String(h).trim());
  return values.filter(r => r.some(v => v !== '' && v !== null))
    .map(r => headers.reduce((rec, h, i) => { if (h) rec[h] = r[i]; return rec; }, {}));
}

/**
 * Inserts new records and fills blank cells on existing ones (matched on keyField,
 * case-insensitive). Never overwrites a non-blank cell.
 * @return {{added: number, enriched: number}}
 */
function upsertRows_(tabName, keyField, records) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sh) throw new Error(tabName + ' is missing. Run setupCRM().');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const keyCol = headers.indexOf(keyField);
  if (keyCol < 0) throw new Error(tabName + ' has no "' + keyField + '" column');
  const n = sh.getLastRow();
  const rows = n > 1 ? sh.getRange(2, 1, n - 1, headers.length).getValues() : [];
  const index = new Map(rows.map((r, i) => [String(r[keyCol]).trim().toLowerCase(), i]));
  let added = 0, enriched = 0;
  records.forEach(rec => {
    const key = String(rec[keyField] || '').trim().toLowerCase();
    if (!key) return;
    if (index.has(key)) {
      const row = rows[index.get(key)];
      let changed = false;
      headers.forEach((h, i) => {
        if ((row[i] === '' || row[i] === null) && rec[h] !== undefined && rec[h] !== '') { row[i] = rec[h]; changed = true; }
      });
      if (changed) enriched++;
    } else {
      rows.push(headers.map(h => rec[h] === undefined ? '' : rec[h]));
      index.set(key, rows.length - 1);
      added++;
    }
  });
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return {added: added, enriched: enriched};
}
