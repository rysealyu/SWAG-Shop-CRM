/**
 * Offline tests for src/Classify.js against the 100 sample emails.
 * Run: npm test
 *
 * expected_classification.json is our own answer sheet (the organizer's key is
 * confidential). If a rule change breaks it, either the rule or the sheet is
 * wrong; decide which before "fixing" the test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixture = name => path.join(__dirname, 'fixtures', name);

// Apps Script files share one global scope; emulate that with a VM context.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'Classify.js'), 'utf8'), ctx, {filename: 'Classify.js'});
const CATEGORY = vm.runInContext('CATEGORY', ctx);

const seed = JSON.parse(fs.readFileSync(fixture('seed_directory.json'), 'utf8'));
const dir = ctx.buildDirectory_(seed.contacts, seed.customers, seed.suppliers, ['sales@swagshop.example']);
const messages = fs.readFileSync(fixture('Sample_Gmail_100_Emails.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));
const expected = JSON.parse(fs.readFileSync(fixture('expected_classification.json'), 'utf8'));

const results = messages.map(m => ctx.classifyMessage_(m, dir));
const flaggedThreads = ctx.flagThreadMismatches_(results);
const byId = Object.fromEntries(results.map(r => [r.message_id, r]));
const ids = (category) => results.filter(r => r.category === category).map(r => r.message_id).sort();

test('every sample email gets the expected category', () => {
  const wrong = results
    .filter(r => r.category !== expected[r.message_id])
    .map(r => `${r.message_id}: got "${r.category}", expected "${expected[r.message_id]}" (${r.reason})`);
  assert.deepEqual(wrong, []);
});

test('headline counts', () => {
  assert.equal(ids(CATEGORY.CUSTOMER_QUOTE).length, 12);
  assert.equal(ids(CATEGORY.SUPPLIER_QUOTE).length, 3);
  assert.equal(ids(CATEGORY.CONFIRMED_PO).length, 4);
  assert.equal(ids(CATEGORY.OPT_OUT).length, 3);
});

test('supplier emails are never customer quotes or orders', () => {
  const supplierMoney = results
    .filter(r => r.role === 'supplier')
    .filter(r => r.category === CATEGORY.CUSTOMER_QUOTE || r.category === CATEGORY.CONFIRMED_PO)
    .map(r => r.message_id);
  assert.deepEqual(supplierMoney, []);
});

test('ambiguous approvals are not orders and go to review', () => {
  for (const id of ['SWAG-MSG-0025', 'SWAG-MSG-0028', 'SWAG-MSG-0095', 'SWAG-MSG-0098']) {
    assert.equal(byId[id].category, CATEGORY.UNCERTAIN, id);
    assert.equal(byId[id].needsReview, true, id);
  }
});

test('quote revision keeps its own ID and total', () => {
  assert.equal(byId['SWAG-MSG-0005'].quote_id, 'Q-1001');
  assert.equal(byId['SWAG-MSG-0005'].amount, 11830);
  assert.equal(byId['SWAG-MSG-0007'].quote_id, 'Q-1001-R1');
  assert.equal(byId['SWAG-MSG-0007'].amount, 13425);
});

test('confirmed POs carry the PO number and the right company', () => {
  const pos = Object.fromEntries(ids(CATEGORY.CONFIRMED_PO).map(id => [byId[id].po_number, byId[id].company_id]));
  assert.deepEqual(pos, {'PO-2501': 'A-002', 'PO-2502': 'A-005', 'PO-2503': 'A-007', 'PO-2504': 'A-008'});
});

test('supplier sharing a sales@ prefix is still a supplier', () => {
  assert.equal(byId['SWAG-MSG-0004'].role, 'supplier');
  assert.equal(byId['SWAG-MSG-0004'].company_id, 'SUP-002');
});

test('13 threads with replies from a different company are flagged', () => {
  assert.equal(flaggedThreads.size, 13);
  assert.equal(byId['SWAG-MSG-0067'].needsReview, true);
  assert.equal(byId['SWAG-MSG-0067'].company_id, 'A-005'); // reply came from Harbor, not Northstar
});

test('opt-outs identify the sender', () => {
  const senders = ids(CATEGORY.OPT_OUT).map(id => byId[id].counterparty).sort();
  assert.deepEqual(senders, ['benjamin.clark@riverside-consulting.example',
    'grace.adams@marblewood-group.example', 'leo.kim@eastwind-travel.example']);
});

// Edge cases not in the sample data, for live Gmail.
const edge = (fields) => ctx.classifyMessage_(Object.assign({message_id: 'X', thread_id: 'T', direction: 'IN',
  to_email: 'sales@swagshop.example', subject: '', body: '', attachment_filenames: ''}, fields), dir);

test('PO number without a PO document is not confirmed', () => {
  const r = edge({from_email: 'david.chen@northstar-retail.example', body: 'Approved, PO-9999 to follow.'});
  assert.equal(r.category, CATEGORY.UNCERTAIN);
});

test('PO with a stop phrase is not confirmed', () => {
  const r = edge({from_email: 'david.chen@northstar-retail.example', attachment_filenames: 'PO-9999.pdf',
    body: 'Approved PO-9999 attached, but do not start production until Monday.'});
  assert.equal(r.category, CATEGORY.UNCERTAIN);
});

test('PO from an unknown sender is flagged for review', () => {
  const r = edge({from_email: 'buyer@newco.example', attachment_filenames: 'PO-7777.pdf',
    body: 'Approved. PO-7777 attached.'});
  assert.equal(r.category, CATEGORY.CONFIRMED_PO);
  assert.equal(r.needsReview, true);
});

test('new contact at a known company matches by domain', () => {
  const r = edge({from_email: 'New Buyer <buyer@acme-events.example>', body: 'Please quote 200 pens.'});
  assert.equal(r.company_id, 'A-001');
  assert.equal(r.contact_id, '');
});

test('gmail.com senders are never matched to a company by domain', () => {
  const r = edge({from_email: 'someone@gmail.com', body: 'Please quote 200 pens.'});
  assert.equal(r.role, 'unknown');
});

test('newsletter from an unknown sender is unrelated', () => {
  const r = edge({from_email: 'news@vendor-blog.example', body: 'Our monthly newsletter. Unsubscribe here.'});
  assert.equal(r.category, CATEGORY.UNRELATED);
});
