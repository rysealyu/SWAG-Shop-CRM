/**
 * Offline tests for src/GmailSync.js (the parts of Gmail sync that are pure logic).
 * The Gmail calls themselves (SyncRunner.js) are verified on the test account.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {loadSources} = require('./helpers');

const ctx = loadSources(['Classify.js', 'GmailSync.js']);
const H = 60 * 60 * 1000, D = 24 * H;
const now = Date.UTC(2026, 10, 13, 18, 0, 0);

test('first sync reads the last 14 days', () => {
  const w = ctx.syncWindow_(null, now);
  assert.equal(w.endMs - w.startMs, 14 * D);
});

test('later syncs start 48 hours before the checkpoint (late arrivals)', () => {
  const w = ctx.syncWindow_(now - 24 * H, now);
  assert.equal(w.startMs, now - 72 * H);
  assert.equal(w.endMs, now);
});

test('query covers received and sent mail, skips spam and trash', () => {
  const q = ctx.gmailQuery_(Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 13));
  assert.equal(q, 'after:1794268800 before:1794528000 -in:spam -in:trash'); // Nov 10 / Nov 13 2026 UTC
  assert.equal(/in:inbox|in:sent/.test(q), false);
  assert.equal(ctx.gmailQuery_(Date.UTC(2026, 10, 10), null), 'after:1794268800 -in:spam -in:trash');
});

test('backfill walks forward in windows and stops when caught up', () => {
  const start = now - 20 * D;
  const w1 = ctx.nextBackfillWindow_(start, now, 7);
  assert.deepEqual([w1.startMs, w1.endMs], [start, start + 7 * D]);
  const last = ctx.nextBackfillWindow_(now - 3 * D, now, 7);
  assert.equal(last.endMs, now); // never past "now"
  assert.equal(ctx.nextBackfillWindow_(now, now, 7), null);
});

test('direction comes from the sender address', () => {
  const ours = ['sales@swagshop.example', 'owner@gmail.com'];
  assert.equal(ctx.directionFor_('SWAG Shop <Sales@SwagShop.example>', ours), 'OUT');
  assert.equal(ctx.directionFor_('owner@gmail.com', ours), 'OUT');
  assert.equal(ctx.directionFor_('Jane Buyer <jane@client.example>', ours), 'IN');
});

test('quoted history is removed from replies', () => {
  const gmail = 'Approved, PO-3001 attached.\n\nOn Thu, Nov 13, 2026 at 10:02 AM SWAG Shop <sales@swagshop.example>\nwrote:\n> Quote Q-2001: 200 bottles. Total $1,810.\n> Thanks';
  assert.equal(ctx.stripQuotedReply_(gmail), 'Approved, PO-3001 attached.');
  const outlook = 'Looks good.\r\n\r\nFrom: SWAG Shop <sales@swagshop.example>\r\nSent: Thursday\r\nSubject: Quote Q-2001\r\nTotal $1,810';
  assert.equal(ctx.stripQuotedReply_(outlook), 'Looks good.');
  assert.equal(ctx.stripQuotedReply_('No quote here.\n> stray quoted line'), 'No quote here.');
  assert.equal(ctx.stripQuotedReply_('Plain message, nothing quoted.'), 'Plain message, nothing quoted.');
});

// ---- fetchGmailWindow_ against a fake GmailApp (paging, filters, caps, errors) ----
function fakeGmail(threadCount, extras = {}) {
  const base = Date.UTC(2026, 10, 12, 12);
  const msg = (id, opts = {}) => ({
    getId: () => id, getDate: () => new Date(opts.date || base), isDraft: () => Boolean(opts.draft),
    isInTrash: () => Boolean(opts.trash), getFrom: () => opts.from || 'Buyer <buyer@client.example>',
    getTo: () => 'owner@gmail.com', getSubject: () => 'Subject ' + id,
    getPlainBody: () => { if (opts.broken) throw new Error('boom'); return opts.body || 'Hello ' + id; },
    getAttachments: () => (opts.attachments || []).map(n => ({getName: () => n}))
  });
  const threads = Array.from({length: threadCount}, (_, i) => ({
    getId: () => 'T' + i,
    getMessages: () => (extras[i] || [msg('M' + i)])
  }));
  const searches = [];
  return {
    msg, searches,
    GmailApp: {search: (q, start, max) => { searches.push([q, start, max]); return threads.slice(start, start + max); },
      getAliases: () => ['sales@swagshop.example']},
    Session: {getEffectiveUser: () => ({getEmail: () => 'owner@gmail.com'})},
    PropertiesService: {getScriptProperties: () => ({getProperty: () => null})}
  };
}
function syncCtx(fake) {
  const c = loadSources(['Code.js', 'Classify.js', 'GmailSync.js', 'SyncRunner.js']);
  Object.assign(c, {GmailApp: fake.GmailApp, Session: fake.Session, PropertiesService: fake.PropertiesService});
  return c;
}
const windowStart = Date.UTC(2026, 10, 10);

test('fetch pages through all threads 50 at a time', () => {
  const fake = fakeGmail(120);
  const r = syncCtx(fake).fetchGmailWindow_(windowStart, null, new Date(), 60000);
  assert.deepEqual(fake.searches.map(s => s[1]), [0, 50, 100]);
  assert.equal(r.threads, 120);
  assert.equal(r.records.length, 120);
  assert.equal(r.complete, true);
});

test('fetch skips drafts, trash and messages before the window; counts broken messages', () => {
  const fake = fakeGmail(1);
  const extras = {0: [fake.msg('ok'), fake.msg('draft', {draft: true}), fake.msg('trash', {trash: true}),
    fake.msg('old', {date: Date.UTC(2026, 9, 1)}), fake.msg('bad', {broken: true})]};
  const fake2 = fakeGmail(1, extras);
  const r = syncCtx(fake2).fetchGmailWindow_(windowStart, null, new Date(), 60000);
  assert.deepEqual(Array.from(r.records, x => x.message_id), ['ok']);
  assert.equal(r.errors, 1); // the broken one: sync will not move the checkpoint
});

test('fetch stops at the thread cap or time budget and reports incomplete', () => {
  const capped = syncCtx(fakeGmail(600)).fetchGmailWindow_(windowStart, null, new Date(), 60000);
  assert.equal(capped.complete, false);
  assert.equal(capped.threads, 500);
  const late = syncCtx(fakeGmail(10)).fetchGmailWindow_(windowStart, null, new Date(Date.now() - 10 * 60000), 60000);
  assert.equal(late.complete, false);
  assert.equal(late.records.length, 0);
});

test('records carry direction, attachments, link, and a stripped body', () => {
  const fake = fakeGmail(1);
  const fake2 = fakeGmail(1, {0: [
    fake.msg('in1', {attachments: ['PO-3001.pdf'], body: 'Approved, PO-3001 attached.\n\nOn Thu, Nov 13 SWAG wrote:\n> Quote Q-2001 Total $1,810'}),
    fake.msg('out1', {from: 'Owner <owner@gmail.com>', body: 'Quote Q-2001: 200 bottles at $8.50 each. Total $1,810.'})]});
  const r = syncCtx(fake2).fetchGmailWindow_(windowStart, null, new Date(), 60000).records;
  const [inbound, outbound] = r;
  assert.deepEqual([inbound.direction, outbound.direction], ['IN', 'OUT']);
  assert.equal(inbound.body, 'Approved, PO-3001 attached.');
  assert.equal(inbound.attachment_filenames, 'PO-3001.pdf');
  assert.equal(inbound.from_email, 'buyer@client.example');
  assert.equal(inbound.source, 'LIVE_GMAIL');
  assert.match(inbound.source_link, /#all\/T0$/);
});

test('sync refuses to run unless SYNC_ENABLED is true', () => {
  const c = syncCtx(fakeGmail(1));
  assert.throws(() => c.requireSyncEnabled_(), /Gmail sync is off/);
  c.PropertiesService = {getScriptProperties: () => ({getProperty: k => (k === 'SYNC_ENABLED' ? 'TRUE' : null)})};
  assert.doesNotThrow(() => c.requireSyncEnabled_());
});

test('a stripped reply is no longer mistaken for a quote', () => {
  const dir = ctx.buildDirectory_([{email: 'jane@client.example', contact_id: 'C-9', company_id: 'A-9'}], [], [], ['sales@swagshop.example']);
  const reply = 'Thanks, will review.\n\nOn Thu, Nov 13, 2026 at 10:02 AM SWAG Shop <sales@swagshop.example> wrote:\n> Quote Q-2001: 200 bottles at $8.50 each. Total $1,810.';
  const msg = body => ({message_id: 'm', thread_id: 't', direction: 'OUT', from_email: 'sales@swagshop.example',
    to_email: 'jane@client.example', subject: 'Re: hello', body: body});
  assert.equal(ctx.classifyMessage_(msg(reply), dir).category, 'Customer Quote Sent'); // unstripped: wrong
  assert.notEqual(ctx.classifyMessage_(msg(ctx.stripQuotedReply_(reply)), dir).category, 'Customer Quote Sent');
});
