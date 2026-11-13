/**
 * Finds each email attachment in a restricted Drive folder (live Gmail
 * attachments are saved there first), extracts its content, interprets it with
 * Attachments.js and writes one Attachments row per file. Then rebuilds the
 * quote/order rows so documents are cross-checked against the emails.
 *
 * Content extraction: PDF/DOCX via a temporary Google Doc (Drive conversion,
 * with OCR for scanned pages), Excel via a temporary Google Sheet, PNG size
 * from the file header. Temporary copies are trashed. Files already parsed
 * with the same SHA-256 are not re-read. Sharing is never changed.
 */

const ATTACHMENT_TAB = 'Attachments';
const SPREADSHEET_MIME = /spreadsheetml|ms-excel/i;
const WORD_OR_PDF_MIME = /pdf|wordprocessingml|msword/i;

/** Menu action: parse attachments named in the Email Log plus any other file in the folder. */
function processAttachments() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const r = runAttachments_(ss);
    const rebuilt = runBuildRecords_(ss);
    const detail = r.detail + ' ' + rebuilt.detail;
    writeLog_(start, 'Attachments', r.counts.parsed, r.counts.reused, r.counts.failed, detail);
    console.log(detail);
    ss.toast(r.counts.parsed + ' attachments parsed, ' + r.counts.missing + ' not found, ' + r.counts.failed +
      ' failed. Details in Sync Log.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Attachments: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Parses every attachment named in the Email Log plus any other file in the
 * folder, and writes the Attachments tab. Caller holds the script lock.
 * @return {{counts: Object, failedMessageIds: string[], detail: string}} failedMessageIds:
 *     messages with a file that could not be read; they stay unprocessed so the next sync retries.
 */
function runAttachments_(ss) {
  const folderId = property_('ATTACHMENTS_FOLDER_ID');
  if (!folderId) throw new Error('Set Script property ATTACHMENTS_FOLDER_ID to the Drive folder that holds attachment files');
  const folder = DriveApp.getFolderById(folderId);
  const files = filesByName_(folder);
  const previous = {};
  if (ss.getSheetByName(ATTACHMENT_TAB)) readTable_(ss, ATTACHMENT_TAB).forEach(r => { previous[r.attachment_id] = r; });

  const counts = {parsed: 0, reused: 0, missing: 0, failed: 0};
  const rows = [], used = new Set(), failedMessageIds = new Set();
  readTable_(ss, EMAIL_TAB).forEach(email => {
    splitAttachments_(email.attachment_names).forEach((name, i) => {
      const id = 'ATT-' + email.message_id + '-' + (i + 1);
      const failedBefore = counts.failed;
      let file = null;
      try {
        file = locateAttachment_(email, name, files, folder);
      } catch (e) {
        counts.failed++;
        console.error('Could not fetch attachment ' + name + ' for ' + email.message_id + ': ' + e);
        rows.push({attachment_id: id, message_id: String(email.message_id), filename: name,
          review_status: REVIEW.NEEDS, review_reason: 'Could not fetch from Gmail: ' + (e && e.message ? e.message : e)});
        failedMessageIds.add(String(email.message_id));
        return;
      }
      if (file) used.add(file.getId());
      rows.push(attachmentRow_(id, String(email.message_id), name, file, previous[id], counts));
      if (counts.failed > failedBefore) failedMessageIds.add(String(email.message_id));
    });
  });
  // Files no email points to (e.g. Invoice_Dispute_Example.pdf) still get a reviewed row.
  files.all.filter(f => !used.has(f.getId())).forEach(file => {
    const id = 'ATT-FILE-' + file.getId().slice(0, 12);
    rows.push(attachmentRow_(id, '', file.getName(), file, previous[id], counts));
  });

  writeDerived_(ss, ATTACHMENT_TAB, 'attachment_id', rows);
  const detail = 'Attachments: ' + counts.parsed + ' parsed, ' + counts.reused + ' unchanged, ' +
    counts.missing + ' not found, ' + counts.failed + ' failed.';
  return {counts: counts, failedMessageIds: Array.from(failedMessageIds), detail: detail};
}

/** Index of the folder's files by lower-case name, with and without extension. */
function filesByName_(folder) {
  const byName = new Map(), all = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    all.push(f);
    const name = f.getName().toLowerCase();
    byName.set(name, f);
    if (!byName.has(name.replace(/\.[^.]+$/, ''))) byName.set(name.replace(/\.[^.]+$/, ''), f);
  }
  return {byName: byName, all: all};
}

/**
 * Sample data: the file is looked up by name. Live Gmail: the attachment is
 * copied from the message into the folder as "<message_id>__<name>" once.
 */
function locateAttachment_(email, name, files, folder) {
  const saved = (email.message_id + '__' + name).toLowerCase();
  if (files.byName.has(saved)) return files.byName.get(saved);
  if (email.source !== 'LIVE_GMAIL') {
    return files.byName.get(name.toLowerCase()) || files.byName.get(name.toLowerCase().replace(/\.[^.]+$/, '')) || null;
  }
  const message = GmailApp.getMessageById(String(email.message_id));
  const att = message && message.getAttachments({includeInlineImages: false}).find(a => a.getName() === name);
  if (!att) return null;
  const file = folder.createFile(att.copyBlob()).setName(email.message_id + '__' + name);
  files.byName.set(saved, file);
  files.all.push(file);
  return file;
}

/** One Attachments row. Never throws: a bad file becomes a Needs Review row. */
function attachmentRow_(id, messageId, name, file, prev, counts) {
  const base = {attachment_id: id, message_id: messageId, filename: name};
  if (!file) {
    counts.missing++;
    return Object.assign(base, {review_status: REVIEW.NEEDS,
      review_reason: 'File not found in the attachments folder (ATTACHMENTS_FOLDER_ID)'});
  }
  try {
    const mime = file.getMimeType();
    const native = /google-apps/.test(mime);
    const blob = native ? null : file.getBlob();
    const sha = native ? '' : sha256Hex_(blob.getBytes());
    if (prev && sha && prev.sha256 === sha && prev.extracted_fields_json) {
      counts.reused++;
      return Object.assign(base, {drive_url: file.getUrl()});
    }
    const content = readFileContent_(file, blob, mime);
    const r = interpretAttachment_({filename: name, mimeType: mime, text: content.text || '',
      tables: content.tables || [], image: content.image});
    const reasons = [r.review_reason, publicSharingWarning_(file)].filter(Boolean);
    counts.parsed++;
    return Object.assign(base, {
      mime_type: mime,
      drive_url: file.getUrl(),
      extracted_fields_json: JSON.stringify({document_type: r.document_type, fields: r.fields, missing: r.missing,
        strategy: r.strategy, text_excerpt: String(content.text || '').slice(0, 500)}),
      parsed_at: new Date(),
      review_status: reasons.length ? REVIEW.NEEDS : REVIEW.AUTO,
      sha256: sha,
      document_type: r.document_type,
      missing_fields: r.missing.join(', '),
      review_reason: reasons.join('; ')
    });
  } catch (e) {
    counts.failed++;
    console.error('Attachment ' + name + ': ' + e);
    return Object.assign(base, {drive_url: file.getUrl(), review_status: REVIEW.NEEDS,
      review_reason: 'Could not read file: ' + (e && e.message ? e.message : e)});
  }
}

/** Plain content for Attachments.js: {text, tables, image}. */
function readFileContent_(file, blob, mime) {
  if (/^image\//i.test(mime)) {
    const bytes = blob.getBytes();
    return {image: Object.assign({bytes: bytes.length}, /png/i.test(mime) ? (pngSize_(bytes) || {}) : {})};
  }
  if (mime === MimeType.GOOGLE_SHEETS) return {tables: sheetTables_(SpreadsheetApp.openById(file.getId()))};
  if (mime === MimeType.GOOGLE_DOCS) return docContent_(DocumentApp.openById(file.getId()));
  if (/csv/i.test(mime)) return {tables: [Utilities.parseCsv(blob.getDataAsString())]};
  if (SPREADSHEET_MIME.test(mime)) {
    return withTempConversion_(blob, MimeType.GOOGLE_SHEETS, {}, id => ({tables: sheetTables_(SpreadsheetApp.openById(id))}));
  }
  if (WORD_OR_PDF_MIME.test(mime)) {
    return withTempConversion_(blob, MimeType.GOOGLE_DOCS, {ocrLanguage: 'en'}, id => docContent_(DocumentApp.openById(id)));
  }
  if (/^text\//i.test(mime)) return {text: blob.getDataAsString()};
  return {};
}

/** Converts a blob to a temporary Google file, reads it, and always trashes the copy. */
function withTempConversion_(blob, targetMime, options, read) {
  const id = Drive.Files.create({name: 'SWAG attachment conversion (temporary)', mimeType: targetMime}, blob, options).id;
  try {
    return read(id);
  } finally {
    DriveApp.getFileById(id).setTrashed(true);
  }
}

function docContent_(doc) {
  const body = doc.getBody();
  const tables = body.getTables().map(t => {
    const rows = [];
    for (let r = 0; r < t.getNumRows(); r++) {
      const row = t.getRow(r), cells = [];
      for (let c = 0; c < row.getNumCells(); c++) cells.push(row.getCell(c).getText().trim());
      rows.push(cells);
    }
    return rows;
  });
  return {text: body.getText(), tables: tables};
}

function sheetTables_(spreadsheet) {
  return spreadsheet.getSheets().map(sh => sh.getDataRange().getValues());
}

function sha256Hex_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

/** Flags files anyone can open; customer artwork, quotes and POs should stay private. */
function publicSharingWarning_(file) {
  try {
    const access = file.getSharingAccess();
    if (access === DriveApp.Access.ANYONE || access === DriveApp.Access.ANYONE_WITH_LINK) {
      return 'File is shared publicly; restrict its sharing';
    }
  } catch (e) {
    console.warn('Could not read sharing for ' + file.getName() + ': ' + e);
  }
  return '';
}
