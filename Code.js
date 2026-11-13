/**
 * SWAG Shop CRM (bound to the imported Google Sheet).
 * This file provides Sheet creation, sample import, conservative Gmail
 * message logging, scheduled trigger and sync logs. Classification lives in
 * Classify.js / ClassifyRunner.js; seed customers/suppliers in Seed.js;
 * quote/order/opportunity rows in Extract.js / RecordsRunner.js; attachments
 * in Attachments.js / AttachmentsRunner.js; follow-up drafts in FollowUps.js /
 * FollowUpsRunner.js; extra Dashboard rows in Dashboard.js.
 *
 * Data safety: no email is sent by this script. Do not add automatic sends.
 */

const SS_TZ = 'America/Chicago';
const EMAIL_TAB = 'Email Log';
const SYNC_TAB = 'Sync Log';
const HEADER_MAP = {
 'Customers':['company_id','company_name','domain','industry','status','first_seen','last_activity_at','last_order_at','order_count','total_order_value','notes'],
 'Contacts':['contact_id','company_id','full_name','email','phone','role','marketing_opt_out','last_activity_at'],
 'Email Log':['message_id','thread_id','date_time','direction','from_email','to_email','subject','body_excerpt','company_id','contact_id','classification','confidence','attachment_count','processed_at','source','review_status','source_link','attachment_names','classification_reason'],
 'Opportunities':['opportunity_id','company_id','contact_id','product','quantity','stage','estimated_value','last_activity','next_action','source_thread_id','specs','manual_lock'],
 'Quotes':['quote_id','opportunity_id','company_id','sent_at','product','quantity','unit_price','setup_fee','freight','quoted_total','status','source_message_id','supersedes','math_check','manual_lock'],
 'Orders':['order_id','company_id','quote_id','order_date','po_number','product','quantity','unit_price','freight','confirmed_order_total','status','source_message_id','quote_link_basis','amount_basis','review_reason','manual_lock'],
 'Supplier Quotes':['supplier_quote_id','supplier_id','customer_opportunity_id','received_at','product','quantity','unit_cost','setup_cost','freight_cost','moq','lead_time','source_message_id','link_basis','doc_check','manual_lock'],
 'Attachments':['attachment_id','message_id','filename','mime_type','drive_url','extracted_fields_json','parsed_at','review_status','sha256','document_type','company_id','opportunity_id','quote_id','missing_fields','review_reason','manual_lock'],
 'Follow Ups':['task_id','company_id','contact_email','due_date','reason','priority','status','source_thread_id','draft_subject','draft_body','approved','evidence_message_ids','manual_lock'],
 'Sync Log':['run_id','started_at','finished_at','status','processed_count','skipped_duplicate_count','error_count','details'],
 'Settings':['setting','value','notes'],
 'Suppliers':['supplier_id','supplier_name','email','category','region','notes']
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('SWAG CRM')
    .addItem('Setup missing tabs', 'setupCRM')
    .addItem('Import seed workbook (customers & suppliers)', 'importSeedWorkbook')
    .addItem('Import 100 sample emails', 'importSampleCsv')
    .addItem('Classify emails', 'classifyEmailLog')
    .addItem('Build quotes, orders & opportunities', 'buildCrmRecords')
    .addItem('Process attachments (PDF, Excel, images)', 'processAttachments')
    .addItem('Draft 10 follow-ups (nothing is sent)', 'buildFollowUps')
    .addItem('Run full pipeline (all steps above, after import)', 'runFullPipeline')
    .addSeparator()
    .addItem('Sync Gmail now (authorized test account)', 'syncNow')
    .addItem('Install daily sync trigger', 'installDailySync')
    .addItem('Backfill Gmail history (resumable)', 'backfillGmail')
    .addSeparator()
    .addItem('Reset demo data (asks first)', 'resetDemoData')
    .addToUi();
}

function setupCRM() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADER_MAP).forEach(name => ensureTab_(ss, name));
  ensureDashboardExtras_(ss);
  SpreadsheetApp.getUi().alert('CRM tabs available. Import sample data or run authorized test sync.');
}
function ensureTab_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const headers = HEADER_MAP[name];
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setBackground('#143e4b').setFontColor('#ffffff').setFontWeight('bold');
    sh.setFrozenRows(1);
  } else {
    ensureHeaders_(sh, headers);
  }
  return sh;
}
/**
 * Adds any header in `headers` missing from row 1. A missing header whose
 * template column is blank is restored in place (e.g. an emptied A1); the rest
 * are appended after the last header (sheets made from an older template).
 */
function ensureHeaders_(sh, headers) {
  const width = Math.max(sh.getLastColumn(), 1);
  const present = sh.getRange(1, 1, 1, width).getValues()[0].map(h => String(h).trim());
  const missing = headers.filter(h => present.indexOf(h) < 0);
  if (!missing.length) return;
  const style = range => range.setBackground('#143e4b').setFontColor('#ffffff').setFontWeight('bold');
  const append = [];
  missing.forEach(h => {
    const home = headers.indexOf(h);
    if (home < present.length && !present[home]) {
      style(sh.getRange(1, home + 1).setValue(h));
      present[home] = h;
    } else {
      append.push(h);
    }
  });
  if (!append.length) return;
  let last = present.length;
  while (last > 0 && !present[last - 1]) last--;
  style(sh.getRange(1, last + 1, 1, append.length).setValues([append]));
}

function property_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}
function getExistingMessageIds_() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EMAIL_TAB);
  if (!s) throw new Error('Email Log is missing. Run setupCRM().');
  const n = s.getLastRow();
  if (n < 2) return new Set();
  return new Set(s.getRange(2, 1, n - 1, 1).getValues().map(x => String(x[0])).filter(Boolean));
}
/** Email Log row. processed_at starts empty and is filled only after the whole pipeline succeeds. */
function headerToRow_(record) {
  return [record.message_id,record.thread_id,record.date_time,record.direction,
    record.from_email,record.to_email,record.subject,String(record.body || '').slice(0,1200),
    '', '', 'Unclassified', '', (record.attachment_filenames || '').split('|').filter(Boolean).length,
    '', record.source || 'SYNTHETIC_CSV','Needs Review',record.source_link || '',
    record.attachment_filenames || '', ''];
}
function writeLog_(start, status, processed, skipped, errorCount, detail) {
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SYNC_TAB);
  sh.appendRow([Utilities.getUuid(),start,new Date(),status,processed,skipped,errorCount,detail || '']);
}
function addBatch_(rows, known) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EMAIL_TAB);
  ensureHeaders_(sh, HEADER_MAP[EMAIL_TAB]);
  const accepted=[]; let skipped=0;
  rows.forEach(row => {
    if (!row.message_id || known.has(row.message_id)) {skipped++;return;}
    known.add(row.message_id); accepted.push(headerToRow_(row));
  });
  if (accepted.length) sh.getRange(sh.getLastRow()+1,1,accepted.length,HEADER_MAP[EMAIL_TAB].length).setValues(accepted);
  return {added:accepted.length,skipped};
}
function importSampleCsv() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import is running');
  const start=new Date(); let added=0, skipped=0;
  try {
    const fileId=property_('SAMPLE_EMAIL_CSV_FILE_ID');
    if (!fileId) throw new Error('Set Script property SAMPLE_EMAIL_CSV_FILE_ID to an authorized Drive CSV file ID');
    const rows=Utilities.parseCsv(DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8').replace(/^\uFEFF/,''));
    const header=(rows.shift()||[]).map(h=>String(h).trim());
    const needed=['message_id','thread_id','date_time','direction'].filter(h=>header.indexOf(h)<0);
    if (needed.length) throw new Error('Invalid CSV: missing column(s) '+needed.join(', ')+'. Row 1 has: '+header.join(', '));
    const known=getExistingMessageIds_();
    const dateIndex=header.indexOf('date_time');
    const imported=rows.filter(x=>x.some(Boolean)).map(cells=>{
      const r={}; header.forEach((h,i)=>r[h]=cells[i]||'');
      if (dateIndex < 0) throw new Error('Invalid CSV: missing date_time');
      // Parse local timestamp as a Date for accurate Sheet-based dashboard counts.
      r.date_time=Utilities.parseDate(r.date_time,SS_TZ,'yyyy-MM-dd HH:mm:ss');
      return r;
    });
    const r=addBatch_(imported,known);added=r.added;skipped=r.skipped;
    // 'Imported', not 'Success': the Dashboard's "Successful sync runs" should count Gmail syncs only.
    writeLog_(start,'Imported',added,skipped,0,'Sample CSV imported. Run "Run full pipeline" to classify and process new rows.');
    SpreadsheetApp.getActiveSpreadsheet().toast('Added '+added+' emails, skipped '+skipped+
      ' already in the Email Log. Next: Run full pipeline.','SWAG CRM',8);
  } catch(e) {
    writeLog_(start,'Failed',added,skipped,1,String(e));
    SpreadsheetApp.getActiveSpreadsheet().toast('Import failed: '+String(e).slice(0,200),'SWAG CRM',15);
    throw e;
  } finally {lock.releaseLock();}
}

/**
 * SWAG Shop's own addresses (mail FROM these is OUT): the account owner, its
 * Gmail send-as aliases, and any extra addresses in Script property BUSINESS_EMAILS.
 * Gmail sync itself lives in SyncRunner.js.
 */
function businessEmails_() {
  const configured=(property_('BUSINESS_EMAILS')||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  const owner=Session.getEffectiveUser().getEmail();
  const aliases=GmailApp.getAliases();
  return new Set(configured.concat(owner? [owner.toLowerCase()]:[]).concat(aliases.map(x=>x.toLowerCase())));
}

/** Installs (or replaces) the daily sync trigger at Settings > daily_sync_hour (default 7), company time zone. */
function installDailySync() {
  requireSyncEnabled_();
  const raw = setting_(SpreadsheetApp.getActiveSpreadsheet(), 'daily_sync_hour');
  const hour = raw === '' ? 7 : Number(raw);
  const atHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 7;
  clearTriggers_('dailySync');
  ScriptApp.newTrigger('dailySync').timeBased().atHour(atHour).everyDays(1).inTimezone(SS_TZ).create();
  SpreadsheetApp.getUi().alert('Daily sync installed for around ' + atHour + ':00 ' + SS_TZ + '. Google picks the exact ' +
    'minute within that hour. The trigger runs as the account that installed it; reinstall it after copying the project.');
}
