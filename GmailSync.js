/**
 * Gmail sync rules - pure logic, no Google services (SyncRunner.js does the I/O).
 *
 * Daily/manual sync reads mail since the last successful checkpoint minus a
 * lookback (late or out-of-order arrivals), received and sent alike. Backfill
 * walks older history forward in fixed windows and saves its position after
 * each window, so it can stop at the Apps Script time limit and resume.
 */

const SYNC = Object.freeze({
  LOOKBACK_HOURS: 48,          // re-read this much before the checkpoint; message IDs prevent duplicates
  INITIAL_DAYS: 14,            // first sync with no checkpoint
  PAGE_SIZE: 50,               // threads per GmailApp.search call
  MAX_THREADS_PER_RUN: 500,
  FETCH_BUDGET_MS: 3 * 60 * 1000,     // leave time for the pipeline inside the 6-minute limit
  BACKFILL_BUDGET_MS: 4 * 60 * 1000,
  BACKFILL_WINDOW_DAYS: 7,
  BACKFILL_DEFAULT_DAYS: 365
});
const HOUR_MS = 60 * 60 * 1000;

/**
 * Time window for a regular sync.
 * @param {?number} checkpointMs Last successful sync start (ms), or null for the first run.
 * @param {number} nowMs Current time (ms).
 * @param {Object=} opts {lookbackHours, initialDays}.
 * @return {{startMs: number, endMs: number}}
 */
function syncWindow_(checkpointMs, nowMs, opts) {
  const o = opts || {};
  const lookback = (o.lookbackHours || SYNC.LOOKBACK_HOURS) * HOUR_MS;
  const initial = (o.initialDays || SYNC.INITIAL_DAYS) * 24 * HOUR_MS;
  const startMs = checkpointMs ? Math.min(checkpointMs - lookback, nowMs) : nowMs - initial;
  return {startMs: startMs, endMs: nowMs};
}

/**
 * Gmail search query for a window. Gmail accepts epoch seconds in after:/before:.
 * Spam and trash are excluded; sent mail is included (no in:inbox filter).
 */
function gmailQuery_(startMs, endMs) {
  const parts = ['after:' + Math.floor(startMs / 1000)];
  if (endMs) parts.push('before:' + Math.ceil(endMs / 1000));
  return parts.concat(['-in:spam', '-in:trash']).join(' ');
}

/** Next backfill window from the saved cursor, or null when backfill has caught up to `untilMs`. */
function nextBackfillWindow_(cursorMs, untilMs, windowDays) {
  if (cursorMs >= untilMs) return null;
  const size = Math.max(1, windowDays || SYNC.BACKFILL_WINDOW_DAYS) * 24 * HOUR_MS;
  return {startMs: cursorMs, endMs: Math.min(cursorMs + size, untilMs)};
}

/** OUT when the sender is one of SWAG Shop's own addresses, else IN. */
function directionFor_(fromRaw, businessEmails) {
  return (businessEmails || []).map(normalizeEmail_).indexOf(normalizeEmail_(fromRaw)) >= 0 ? 'OUT' : 'IN';
}

/**
 * Drops quoted history from a reply so the earlier email is not counted twice
 * (e.g. a customer's "Approved" reply quoting our whole quote).
 * Cuts at "On <date>, <name> wrote:" (possibly wrapped over two lines),
 * "-----Original Message-----" or an Outlook "From:/Sent:" header block, and
 * removes any remaining ">" quoted lines.
 */
function stripQuotedReply_(body) {
  let text = String(body || '').replace(/\r\n/g, '\n');
  const markers = [
    /\n[ \t]*On [^\n]{1,200}(?:\n[^\n]{0,200})?wrote:[ \t]*(?:\n|$)/,
    /\n[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/i,
    /\n[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):[^\n]+/i
  ];
  markers.forEach(re => {
    const m = re.exec('\n' + text);
    if (m) text = text.slice(0, Math.max(0, m.index - 1));
  });
  return text.split('\n').filter(line => !/^\s*>/.test(line)).join('\n').trim();
}
