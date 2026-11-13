/**
 * Gmail sync, backfill and the full processing pipeline.
 *
 * Sync Now / the daily trigger: fetch mail since the last checkpoint (minus a
 * lookback), add new messages to the Email Log by message ID, then run the
 * pipeline: classify -> attachments -> quotes/orders -> follow-ups. A row's
 * processed_at is filled only after the whole pipeline succeeds; if any step
 * fails, the checkpoint does not move and the next run retries. Every step is
 * safe to repeat.
 *
 * Safety: sync is OFF unless Script property SYNC_ENABLED = true, so it can
 * only read the inbox of an account that was deliberately set up for it.
 */

/** Menu action. */
function syncNow() { runSync_('Sync Now'); }

/** Daily time-driven trigger target (see installDailySync). */
function dailySync() { runSync_('Daily trigger'); }

/** Menu action: run the pipeline on rows already in the Email Log (e.g. after the sample CSV import). */
function runFullPipeline() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another sync or import is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const detail = runPipeline_(ss, start);
    writeLog_(start, 'Pipeline', 0, 0, 0, detail);
    ss.toast('Pipeline finished. Details in Sync Log.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Pipeline: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function runSync_(mode) {
  requireSyncEnabled_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another sync or import is running');
  const start = new Date();
  const props = PropertiesService.getScriptProperties();
  let added = 0, skipped = 0, errors = 0;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const checkpoint = Number(props.getProperty('SYNC_CHECKPOINT')) || null;
    const win = syncWindow_(checkpoint, start.getTime(),
      {initialDays: Number(property_('SYNC_INITIAL_DAYS')) || SYNC.INITIAL_DAYS});
    const fetched = fetchGmailWindow_(win.startMs, null, start, SYNC.FETCH_BUDGET_MS);
    const batch = addBatch_(fetched.records, getExistingMessageIds_());
    added = batch.added; skipped = batch.skipped; errors = fetched.errors;

    const pipeline = runPipeline_(ss, start);
    const complete = fetched.complete && !fetched.errors;
    if (complete) props.setProperty('SYNC_CHECKPOINT', String(start.getTime()));
    const detail = mode + '. Window from ' + new Date(win.startMs).toISOString() + ' (query: ' + fetched.query + '). ' +
      fetched.threads + ' threads scanned, ' + added + ' new messages, ' + skipped + ' already logged, ' + errors +
      ' message errors. ' + (complete ? 'Checkpoint moved to ' + start.toISOString() + '.'
        : 'INCOMPLETE (' + (fetched.complete ? 'message errors' : 'time or thread cap reached') +
          '): checkpoint NOT moved; the next run re-reads this window.') + ' | ' + pipeline;
    writeLog_(start, complete ? 'Success' : 'Partial', added, skipped, errors, detail);
    console.log(detail);
    ss.toast(added + ' new emails synced' + (complete ? '' : ' (partial; will continue next run)') + '. Details in Sync Log.', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', added, skipped, errors + 1,
      mode + ': ' + String(e) + '. Checkpoint not moved; new rows stay unprocessed and are retried next run.');
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menu action: resumable history import. Walks from BACKFILL_FROM (yyyy-mm-dd,
 * default one year ago) to now in 7-day windows, saving its position after
 * each window. If it runs out of time it schedules itself to continue a
 * minute later. When caught up, it runs the pipeline once and sets the sync
 * checkpoint so the daily sync carries on from there.
 */
function backfillGmail() {
  requireSyncEnabled_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another sync or import is running');
  const start = new Date();
  const props = PropertiesService.getScriptProperties();
  let added = 0, skipped = 0, windows = 0;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const from = Date.parse(property_('BACKFILL_FROM') || '') || start.getTime() - SYNC.BACKFILL_DEFAULT_DAYS * 24 * HOUR_MS;
    let cursor = Number(props.getProperty('BACKFILL_CURSOR')) || from;
    let windowDays = Number(props.getProperty('BACKFILL_WINDOW_DAYS')) || SYNC.BACKFILL_WINDOW_DAYS;
    const known = getExistingMessageIds_();
    let win;
    while ((win = nextBackfillWindow_(cursor, start.getTime(), windowDays))) {
      if (Date.now() - start.getTime() > SYNC.BACKFILL_BUDGET_MS) break;
      const fetched = fetchGmailWindow_(win.startMs, win.endMs, start, SYNC.BACKFILL_BUDGET_MS);
      if (!fetched.complete || fetched.errors) {
        // Too much mail for one run, or a message failed: retry this window, smaller if possible.
        windowDays = Math.max(1, Math.floor(windowDays / 2));
        props.setProperty('BACKFILL_WINDOW_DAYS', String(windowDays));
        break;
      }
      const batch = addBatch_(fetched.records, known);
      added += batch.added; skipped += batch.skipped; windows++;
      cursor = win.endMs;
      props.setProperty('BACKFILL_CURSOR', String(cursor));
    }

    clearTriggers_('backfillGmail');
    if (cursor >= start.getTime()) {
      const pipeline = runPipeline_(ss, start);
      const checkpoint = Number(props.getProperty('SYNC_CHECKPOINT')) || 0;
      if (checkpoint < start.getTime()) props.setProperty('SYNC_CHECKPOINT', String(start.getTime()));
      props.deleteProperty('BACKFILL_CURSOR');
      writeLog_(start, 'Success', added, skipped, 0, 'Backfill complete: ' + windows + ' windows this run, ' + added +
        ' new messages. | ' + pipeline);
    } else {
      ScriptApp.newTrigger('backfillGmail').timeBased().after(60 * 1000).create();
      writeLog_(start, 'Partial', added, skipped, 0, 'Backfill paused at ' + new Date(cursor).toISOString() + ' after ' +
        windows + ' windows (' + added + ' new messages). Continues automatically in about 1 minute; position is saved.');
    }
  } catch (e) {
    writeLog_(start, 'Failed', added, skipped, 1, 'Backfill: ' + String(e) + '. Position saved; run again to resume.');
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads messages in [startMs, endMs) page by page, within a time budget.
 * @return {{records: Object[], threads: number, errors: number, complete: boolean, query: string}}
 */
function fetchGmailWindow_(startMs, endMs, runStart, budgetMs) {
  const query = gmailQuery_(startMs, endMs);
  const business = Array.from(businessEmails_());
  const records = [];
  let offset = 0, threads = 0, errors = 0, complete = true;
  for (;;) {
    if (Date.now() - runStart.getTime() > budgetMs || threads >= SYNC.MAX_THREADS_PER_RUN) { complete = false; break; }
    const page = GmailApp.search(query, offset, SYNC.PAGE_SIZE);
    page.forEach(thread => {
      thread.getMessages().forEach(m => {
        try {
          const t = m.getDate().getTime();
          if (m.isDraft() || m.isInTrash() || t < startMs || (endMs && t >= endMs)) return;
          records.push(gmailRecord_(m, thread, business));
        } catch (e) {
          errors++;
          console.error('Message in thread ' + thread.getId() + ': ' + e);
        }
      });
    });
    threads += page.length;
    if (page.length < SYNC.PAGE_SIZE) break;
    offset += SYNC.PAGE_SIZE;
  }
  return {records: records, threads: threads, errors: errors, complete: complete, query: query};
}

/** One Email Log record from a Gmail message; quoted reply history is stripped. */
function gmailRecord_(m, thread, business) {
  return {
    message_id: m.getId(), thread_id: thread.getId(), date_time: m.getDate(),
    direction: directionFor_(m.getFrom(), business), from_email: normalizeEmail_(m.getFrom()), to_email: m.getTo(),
    subject: m.getSubject(), body: stripQuotedReply_(m.getPlainBody()),
    attachment_filenames: m.getAttachments({includeInlineImages: false}).map(a => a.getName()).join('|'),
    source: 'LIVE_GMAIL', source_link: 'https://mail.google.com/mail/u/0/#all/' + thread.getId()
  };
}

/**
 * classify -> attachments -> quotes/orders -> follow-ups, then stamps
 * processed_at on rows that went through every step. Throws (naming the step)
 * if a step fails, leaving rows unprocessed for the next run.
 */
function runPipeline_(ss, now) {
  const step = (name, fn) => {
    try {
      return fn();
    } catch (e) {
      throw new Error(name + ' step failed: ' + (e && e.message ? e.message : e));
    }
  };
  if (ss.getSheetByName(EMAIL_TAB).getLastRow() < 2) return 'Email Log is empty; nothing to process.';
  const parts = [];
  parts.push(step('Classify', () => runClassify_(ss)).detail);
  let failedMessageIds = [];
  if (property_('ATTACHMENTS_FOLDER_ID')) {
    const att = step('Attachments', () => runAttachments_(ss));
    failedMessageIds = att.failedMessageIds;
    parts.push(att.detail);
  } else {
    parts.push('Attachments skipped: ATTACHMENTS_FOLDER_ID not set');
  }
  parts.push(step('Records', () => runBuildRecords_(ss)).detail);
  parts.push(step('Follow-ups', () => runFollowUps_(ss, now)).detail);
  const marked = markProcessed_(ss, failedMessageIds);
  parts.push('Marked processed: ' + marked + (failedMessageIds.length ? ' (' + failedMessageIds.length +
    ' left for retry: attachment could not be read)' : ''));
  return parts.join(' | ');
}

/** Fills processed_at on classified rows that have none, except messages whose attachments failed. */
function markProcessed_(ss, skipMessageIds) {
  const sh = ss.getSheetByName(EMAIL_TAB);
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const idCol = headers.indexOf('message_id'), atCol = headers.indexOf('processed_at'), clsCol = headers.indexOf('classification');
  const values = sh.getRange(2, 1, n - 1, headers.length).getValues();
  const skip = new Set(skipMessageIds || []);
  const now = new Date();
  let marked = 0;
  const column = values.map(r => {
    const pending = r[atCol] === '' || r[atCol] === null;
    if (pending && r[clsCol] && r[clsCol] !== 'Unclassified' && !skip.has(String(r[idCol]))) { marked++; return [now]; }
    return [r[atCol]];
  });
  if (marked) sh.getRange(2, atCol + 1, column.length, 1).setValues(column);
  return marked;
}

/** Refuses to touch Gmail unless this account was deliberately enabled for sync. */
function requireSyncEnabled_() {
  if (String(property_('SYNC_ENABLED') || '').toLowerCase() !== 'true') {
    throw new Error('Gmail sync is off for this project. On an authorized TEST account, set Script property ' +
      'SYNC_ENABLED = true (Project Settings > Script properties). This prevents reading a personal inbox by accident.');
  }
}

function clearTriggers_(handler) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === handler).forEach(t => ScriptApp.deleteTrigger(t));
}
