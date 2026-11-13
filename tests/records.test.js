/**
 * Offline tests for src/Extract.js: classified sample emails -> Quotes, Orders,
 * Supplier Quotes and Opportunities rows. Run: npm test
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
for (const file of ['Classify.js', 'Attachments.js', 'Extract.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, {filename: file});
}

const seed = JSON.parse(fs.readFileSync(fixture('seed_directory.json'), 'utf8'));
const dir = ctx.buildDirectory_(seed.contacts, seed.customers, seed.suppliers, ['sales@swagshop.example']);
const emails = fs.readFileSync(fixture('Sample_Gmail_100_Emails.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line));

// Same shape the Sheet runner passes in: Email Log columns after classification.
const verdicts = emails.map(m => ctx.classifyMessage_(m, dir));
ctx.flagThreadMismatches_(verdicts);
const classified = emails.map((m, i) => Object.assign({}, m, {
  category: verdicts[i].category, company_id: verdicts[i].company_id,
  contact_id: verdicts[i].contact_id, reason: verdicts[i].reason
}));
const records = ctx.deriveRecords_(classified, seed.customers);
const quote = id => records.quotes.find(q => q.quote_id === id);
const opp = id => records.opportunities.find(o => o.opportunity_id === id);

test('12 customer quote rows, all totals reconcile', () => {
  assert.equal(records.quotes.length, 12);
  const bad = records.quotes.filter(q => q.math_check !== 'OK').map(q => `${q.quote_id}: ${q.math_check}`);
  assert.deepEqual(bad, []);
});

test('Acme revision: one opportunity, both versions kept', () => {
  const v1 = quote('Q-1001'), v2 = quote('Q-1001-R1');
  assert.equal(v1.opportunity_id, v2.opportunity_id);
  assert.equal(v1.status, 'Superseded');
  assert.equal(v2.supersedes, 'Q-1001');
  assert.deepEqual([v1.quantity, v1.quoted_total], [2500, 11830]);
  assert.deepEqual([v2.quantity, v2.quoted_total, v2.unit_price], [3000, 13425, 4.35]);
  assert.equal(opp(v2.opportunity_id).quantity, 3000);
});

test('quote fields are extracted, including "Setup $45" word order', () => {
  const q = quote('Q-1008');
  assert.deepEqual([q.quantity, q.unit_price, q.setup_fee, q.freight, q.quoted_total], [250, 16.5, 45, 90, 4260]);
  assert.equal(q.product, 'branded fleece blankets');
  assert.equal(quote('Q-1002').product, '20 oz navy steel tumblers'); // "500 units" -> product from request
});

test('4 confirmed orders worth $16,175, each linked to its quote', () => {
  const orders = Object.fromEntries(records.orders.map(o => [o.po_number, [o.status, o.quote_id, o.confirmed_order_total]]));
  assert.deepEqual(orders, {
    'PO-2501': ['Confirmed', 'Q-1002', 3475],
    'PO-2502': ['Confirmed', 'Q-1003', 3750],
    'PO-2503': ['Confirmed', 'Q-1004', 7300],
    'PO-2504': ['Confirmed', 'Q-1005', 1650]
  });
  assert.equal(records.orders.reduce((s, o) => s + o.confirmed_order_total, 0), 16175);
  assert.equal(records.orders.find(o => o.po_number === 'PO-2503').quote_link_basis, 'Same email thread');
});

test('accepted quotes are marked; ambiguous approvals are not orders', () => {
  for (const id of ['Q-1002', 'Q-1003', 'Q-1004', 'Q-1005']) assert.equal(quote(id).status, 'Accepted', id);
  for (const id of ['Q-1006', 'Q-1007']) assert.equal(quote(id).status, 'Sent', id);
  assert.equal(records.orders.some(o => ['A-003', 'A-004'].includes(o.company_id)), false);
});

test('opportunity stages', () => {
  const stages = Object.fromEntries(records.opportunities.map(o => [o.opportunity_id, o.stage]));
  assert.equal(records.opportunities.length, 11);
  assert.equal(stages['OPP-SWAG-TUMBLER-02'], 'Won');
  assert.equal(stages['OPP-SWAG-MUGS-03'], 'Approval Pending');
  assert.equal(stages['OPP-SWAG-LUNCH-04'], 'Approval Pending');
  assert.equal(stages['OPP-SWAG-TOTE-01'], 'Quoted');
  const count = s => Object.values(stages).filter(x => x === s).length;
  assert.deepEqual([count('Won'), count('Approval Pending'), count('Quoted')], [4, 2, 5]);
});

test('supplier quotes hold costs and link to the right customer deal', () => {
  const sq = Object.fromEntries(records.supplierQuotes.map(s => [s.supplier_id,
    [s.customer_opportunity_id, s.quantity, s.unit_cost, s.setup_cost, s.freight_cost, s.lead_time]]));
  assert.deepEqual(sq, {
    'SUP-001': ['OPP-SWAG-TUMBLER-02', 500, 5.4, 55, 180, '10-12 business days'],
    'SUP-002': ['OPP-SWAG-TOTE-01', 2500, 3.15, 65, 210, '12 business days'],
    'SUP-003': ['OPP-SWAG-LANYARD-08', 1000, 0.92, 30, 75, '8 business days']
  });
  assert.equal(records.supplierQuotes.find(s => s.supplier_id === 'SUP-002').moq, 500);
});

test('supplier costs never appear as customer quotes', () => {
  const supplierMsgs = new Set(records.supplierQuotes.map(s => s.source_message_id));
  assert.equal(records.quotes.some(q => supplierMsgs.has(q.source_message_id)), false);
});

// Edge cases not in the sample data.
const base = {thread_id: 'T-EDGE', direction: 'IN', subject: '', attachment_filenames: '', contact_id: '', reason: ''};

test('PO quantity that differs from the quote needs review', () => {
  const r = ctx.deriveRecords_([
    Object.assign({}, base, {message_id: 'E1', date_time: '2026-11-01 09:00:00', direction: 'OUT', company_id: 'A-001',
      category: 'Customer Quote Sent', body: 'Quote Q-2000: 100 mugs at $5.00 each, $10 setup. Total $510.'}),
    Object.assign({}, base, {message_id: 'E2', date_time: '2026-11-02 09:00:00', company_id: 'A-001',
      category: 'Confirmed Customer PO', body: 'Approved PO-3000 for 150 mugs.'})
  ], []);
  assert.equal(r.orders[0].status, 'Needs Review');
  assert.match(r.orders[0].review_reason, /150 differs from quoted 100/);
  assert.equal(r.quotes[0].status, 'Sent');
});

test('PO with no matching quote needs review', () => {
  const r = ctx.deriveRecords_([Object.assign({}, base, {message_id: 'E3', date_time: '2026-11-02 09:00:00',
    company_id: 'A-009', category: 'Confirmed Customer PO', body: 'Approved PO-3001 for 40 pens.'})], []);
  assert.equal(r.orders[0].status, 'Needs Review');
  assert.equal(r.orders[0].review_reason.startsWith('No matching customer quote'), true);
});

test('a quote whose total does not add up is flagged', () => {
  const r = ctx.deriveRecords_([Object.assign({}, base, {message_id: 'E4', date_time: '2026-11-01 09:00:00',
    direction: 'OUT', company_id: 'A-001', category: 'Customer Quote Sent',
    body: 'Quote Q-2001: 100 mugs at $5.00 each, $10 setup. Total $600.'})], []);
  assert.match(r.quotes[0].math_check, /differs .* by \$90/);
});
