/**
 * SWAG Shop CRM (bound to the imported Google Sheet).
 * This file provides Sheet creation, sample import, conservative Gmail
 * message logging, scheduled trigger and sync logs. Classification lives in
 * Classify.js / ClassifyRunner.js; seed customers/suppliers in Seed.js;
 * quote/order/opportunity rows in Extract.js / RecordsRunner.js; attachments
 * in Attachments.js / AttachmentsRunner.js; extra Dashboard rows in Dashboard.js.
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
 'Follow Ups':['task_id','company_id','contact_email','due_date','reason','priority','status','source_thread_id','draft_subject','draft_body','approved'],
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
    .addSeparator()
    .addItem('Sync Gmail now (authorized test account)', 'syncNow')
    .addItem('Install daily sync trigger', 'installDailySync')
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
/** Appends any header in `headers` missing from row 1 (sheets made from an older template). */
function ensureHeaders_(sh, headers) {
  const width = Math.max(sh.getLastColumn(), 1);
  const present = sh.getRange(1, 1, 1, width).getValues()[0].map(h => String(h).trim());
  const missing = headers.filter(h => present.indexOf(h) < 0);
  if (!missing.length) return;
  let last = present.length;
  while (last > 0 && !present[last - 1]) last--;
  const at = last + 1;
  sh.getRange(1, at, 1, missing.length).setValues([missing])
    .setBackground('#143e4b').setFontColor('#ffffff').setFontWeight('bold');
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
function headerToRow_(record) {
  return [record.message_id,record.thread_id,record.date_time,record.direction,
    record.from_email,record.to_email,record.subject,String(record.body || '').slice(0,1200),
    '', '', 'Unclassified', '', (record.attachment_filenames || '').split('|').filter(Boolean).length,
    new Date(), record.source || 'SYNTHETIC_CSV','Needs Review','',
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
    const header=rows.shift();
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
    writeLog_(start,'Imported',added,skipped,0,'Sample CSV imported. Run "Classify emails" to label new rows.');
  } catch(e) {
    writeLog_(start,'Failed',added,skipped,1,String(e));
    throw e;
  } finally {lock.releaseLock();}
}

/**
 * SAFE, CONSERVATIVE starter Gmail sync: bounded recent-message import ONLY.
 * Students must improve checkpointing/pagination and verify complete coverage.
 * No historical backfill, AI extraction, or attachment parsing is implemented.
 */
function businessEmails_() {
  const configured=(property_('BUSINESS_EMAILS')||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  const owner=Session.getEffectiveUser().getEmail();
  const aliases=GmailApp.getAliases();
  return new Set(configured.concat(owner? [owner.toLowerCase()]:[]).concat(aliases.map(x=>x.toLowerCase())));
}
function fromAddress_(raw) {
  const match=String(raw||'').match(/<([^>]+)>/);
  return (match? match[1]:String(raw||'')).trim().toLowerCase();
}
function syncNow(){ syncGmailRecent_(); }
function dailySync(){ syncGmailRecent_(); }
function syncGmailRecent_(){
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another sync is running');
  const start=new Date();let processed=0,skipped=0,errors=0;
  try {
    const known=getExistingMessageIds_();
    const businessEmails=businessEmails_();
    const cutoff=new Date(Date.now()-14*24*60*60*1000);
    const query='newer_than:14d -in:spam -in:trash';
    const threads=GmailApp.search(query,0,100); // IMPORTANT: bounded starter, not a complete mailbox crawler
    let records=[];
    threads.forEach(thread=>{
      thread.getMessages().forEach(m=>{
        if(m.getDate()<cutoff) return;
        let from=m.getFrom();
        let direction=businessEmails.has(fromAddress_(from))?'OUT':'IN';
        // Configure additional owned inboxes/aliases via BUSINESS_EMAILS script property.
        records.push({
          message_id:m.getId(),thread_id:thread.getId(),date_time:m.getDate(),
          direction:direction,from_email:from,to_email:m.getTo(),subject:m.getSubject(),
          body:m.getPlainBody(),attachment_filenames:m.getAttachments({includeInlineImages:false}).map(a=>a.getName()).join('|'),
          source:'LIVE_GMAIL'
        });
      });
    });
    const res=addBatch_(records,known);processed=res.added;skipped=res.skipped;
    const isPartial=threads.length===100;
    writeLog_(start,isPartial?'Partial':'Success',processed,skipped,errors,
      isPartial?'Reached 100-thread safety cap. Do not assume complete sync; implement paging/checkpoints.':'Recent Gmail messages imported. Run "Classify emails" to label new rows.');
  }catch(e){errors++;writeLog_(start,'Failed',processed,skipped,errors,String(e));throw e;}
  finally{lock.releaseLock();}
}

function installDailySync() {
  ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='dailySync')
    .forEach(t=>ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailySync').timeBased().atHour(7).everyDays(1).inTimezone(SS_TZ).create();
  SpreadsheetApp.getUi().alert('Daily trigger installed for around 7 AM Central. Google chooses an execution time within a window. Triggers run under the creating account.');
}

// STUDENT WORK TODO (these are essential, not optional):
// - Implement customer/contact normalization and safe entity matching.
// - Write actual opportunity, quote, order and follow-up rows; keep source message IDs.
// - Parse PDFs, Excel, CSV and artwork securely and persist extraction evidence.
// - Validate order evidence; supplier quote is NOT a customer quote.
// - Add a resumable Gmail history backfill and durable checkpoint / retry scheme.
// - Validate multi-inbox direction and support aliases before production.
// - Respect opt-outs and prevent duplicates across imports and senders.
// - Add human-reviewed Gmail draft creation and careful error handling.
