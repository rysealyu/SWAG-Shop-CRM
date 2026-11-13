/**
 * Offline tests for src/FollowUps.js on the sample data. Run: npm test
 * "Now" is fixed at 2026-11-13 12:00, the last day of the sample mailbox.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {loadSources, sampleCrm} = require('./helpers');

const ctx = loadSources(['Classify.js', 'Attachments.js', 'Extract.js', 'FollowUps.js']);
const crm = sampleCrm(ctx);
const NOW = '2026-11-13 12:00:00';
const run = (tabs = crm.tabs, now = NOW) =>
  JSON.parse(JSON.stringify(ctx.buildFollowUps_(tabs, {now: now, businessName: 'SWAG Shop'})));
const result = run();
const task = id => result.tasks.find(t => t.company_id === id);

test('10 prioritized drafts, one per company, all unapproved and open', () => {
  assert.equal(result.tasks.length, 10);
  assert.deepEqual(result.tasks.map(t => t.priority), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(result.tasks.map(t => t.company_id)).size, 10);
  assert.equal(result.tasks.every(t => t.approved === false && t.status === 'Open'), true);
  assert.deepEqual(result.tasks.map(t => t.company_id),
    ['A-001', 'A-003', 'A-004', 'A-006', 'A-011', 'A-010', 'A-009', 'A-013', 'A-008', 'A-007']);
});

test('the 3 marketing opt-outs are never drafted', () => {
  const optOuts = ['leo.kim@eastwind-travel.example', 'grace.adams@marblewood-group.example',
    'benjamin.clark@riverside-consulting.example'];
  // No top-10 cutoff here: opted-out companies must be filtered out, not merely outranked.
  const everyone = JSON.parse(JSON.stringify(ctx.buildFollowUps_(crm.tabs, {now: NOW, businessName: 'SWAG Shop', limit: 100})));
  assert.ok(everyone.tasks.length > 10);
  assert.equal(everyone.tasks.some(t => optOuts.includes(t.contact_email)), false);
  assert.equal(everyone.tasks.some(t => ['A-018', 'A-019', 'A-020'].includes(t.company_id)), false);
  for (const email of optOuts) assert.ok(result.excluded.some(e => e.company_name === email), email);
});

test('suppliers are never drafted and supplier costs never appear', () => {
  assert.equal(result.tasks.some(t => /^SUP-/.test(t.company_id)), false);
  const text = result.tasks.map(t => t.draft_subject + ' ' + t.draft_body).join('\n');
  for (const cost of ['$3.15', '$5.40', '$0.92', 'PrintForge', 'Coastal Custom', 'Pacific Sourcing']) {
    assert.equal(text.includes(cost), false, cost);
  }
});

test('every draft cites evidence that exists in the Email Log', () => {
  const ids = new Set(crm.messages.map(m => m.message_id));
  for (const t of result.tasks) {
    const cited = t.evidence_message_ids.split(', ');
    assert.ok(cited.length > 0 && cited.every(id => ids.has(id)), t.task_id + ': ' + t.evidence_message_ids);
    assert.ok(t.reason.length > 20, t.task_id);
  }
});

test('Acme draft: revised quote, real numbers, pending logo', () => {
  const t = task('A-001');
  assert.equal(t.draft_subject, 'Following up on your revised quote Q-1001-R1: natural totes');
  for (const s of ['Hi Sarah', '3,000 natural totes', '$13,425.00', 'December conference', 'final logo', '150 cooler bags']) {
    assert.ok(t.draft_body.includes(s), s);
  }
  assert.equal(t.draft_body.includes('bought'), false);
  assert.ok(!/canvas tote bags before/.test(t.reason), 'cooler bags are not the same product as tote bags');
});

test('ambiguous approvals restate what the customer said', () => {
  assert.match(task('A-003').draft_body, /checking with your team/);
  assert.match(task('A-004').draft_body, /approval from purchasing/);
  assert.match(task('A-004').draft_body, /send the invoice/);
  assert.match(task('A-004').draft_body, /will not until you confirm in writing/);
});

test('expired quote pricing is flagged for reconfirmation', () => {
  assert.match(task('A-006').draft_body, /valid for 7 days, so I will reconfirm/);
  assert.equal(task('A-001').draft_body.includes('valid for'), false); // Q-1001-R1 states no validity
});

test('repeat buyer is reminded of the same past order', () => {
  assert.match(task('A-013').draft_body, /We produced 1,000 travel mugs for you in February 2026/);
});

test('a product the customer put on hold is not pushed', () => {
  assert.equal(task('A-009').draft_body.includes('badge holders'), false);
  assert.ok(result.excluded.some(e => e.company_id === 'A-009' && /on hold \(SWAG-MSG-0069\)/.test(e.reason)));
});

test('someone emailed in the last 2 days is scheduled 3 days after that email', () => {
  assert.equal(task('A-001').due_date.slice(0, 10), new Date(2026, 10, 15).toISOString().slice(0, 10)); // Q-1001-R1 sent Nov 12
  assert.equal(task('A-006').due_date.slice(0, 10), new Date(2026, 10, 13).toISOString().slice(0, 10));
});

test('a customer reply stops the sequence for that company', () => {
  const messages = crm.tabs.messages.concat([{message_id: 'NEW-1', thread_id: 'SWAG-GENERIC-05',
    date_time: '2026-11-13 09:00:00', direction: 'IN', from_email: 'jordan.hill@peak-wellness.example',
    to_email: 'sales@swagshop.example', subject: 'Re: Quote Q-1008', body: 'Thanks, reviewing internally.',
    category: 'Follow-Up', company_id: 'A-006', reason: ''}]);
  const r = run(Object.assign({}, crm.tabs, {messages: messages}));
  assert.equal(r.tasks.some(t => t.company_id === 'A-006'), false);
  assert.ok(r.excluded.some(e => e.company_id === 'A-006' && /replied on November 13 \(NEW-1\); answer personally/.test(e.reason)));
  assert.equal(r.tasks.length, 10); // the next-best company fills the slot
});
