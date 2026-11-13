/**
 * Offline tests for src/Attachments.js and the attachment cross-checks in
 * src/Extract.js, using the real sample files. Run: npm test
 *
 * PDF text comes from the files' own text layer (tests/fixtures/attachments_extracted.json).
 * In the Sheet, Google Drive's PDF->Doc conversion produces the text, and its exact
 * layout is not guaranteed, so every PDF is tested in three layouts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixture = name => path.join(__dirname, 'fixtures', name);

const ctx = vm.createContext({});
for (const file of ['Classify.js', 'Attachments.js', 'Extract.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, {filename: file});
}
const DOC = vm.runInContext('DOC_TYPE', ctx);
const extracted = JSON.parse(fs.readFileSync(fixture('attachments_extracted.json'), 'utf8'));
const plain = x => JSON.parse(JSON.stringify(x)); // VM-realm objects -> this realm, for deepEqual

// Three ways a converter might lay out a two-column PDF table.
const LAYOUTS = {
  'one cell per line': lines => ({text: lines.join('\n'), tables: []}),
  'label and value on one line': lines => ({
    text: [lines[0], lines[1]].concat(pairUp(lines.slice(2)).map(p => p.join('   '))).join('\n'), tables: []}),
  'a real table': lines => ({text: lines.slice(0, 2).join('\n'), tables: [pairUp(lines.slice(2))]})
};
function pairUp(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push(lines.slice(i, i + 2));
  return out;
}
const pdf = (name, layout = 'one cell per line') =>
  Object.assign({filename: name, mimeType: 'application/pdf'}, LAYOUTS[layout](extracted.pdf[name]));
const xlsx = name => ({filename: name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  text: '', tables: Object.values(extracted.xlsx[name])});
const read = doc => plain(ctx.interpretAttachment_(doc));

for (const layout of Object.keys(LAYOUTS)) {
  test(`PO-2501 PDF fields (${layout})`, () => {
    const r = read(pdf('PO-2501_Purchase_Order.pdf', layout));
    assert.equal(r.document_type, DOC.PO);
    assert.deepEqual(
      [r.fields.company, r.fields.po_number, r.fields.product, r.fields.quantity, r.fields.unit_price, r.fields.line_total, r.fields.delivery_date],
      ['Northstar Retail', 'PO-2501', 'Custom 20 oz Navy Tumblers', 500, 6.95, 3475, '2026-12-08']);
    assert.deepEqual(r.missing, []);
  });

  test(`supplier tumbler PDF: costs, not prices (${layout})`, () => {
    const r = read(pdf('Supplier_Quote_Tumblers.pdf', layout));
    assert.equal(r.document_type, DOC.SUPPLIER);
    assert.deepEqual([r.fields.supplier, r.fields.unit_cost, r.fields.setup_cost, r.fields.freight_cost, r.fields.moq],
      ['PrintForge Manufacturing', 5.4, 55, 180, 250]);
    assert.match(r.fields.lead_time, /^10-12 business days/);
    assert.equal(r.fields.unit_price, undefined); // a supplier sheet never yields a selling price
    assert.equal(r.needs_review, false);
  });
}

test('all four POs reconcile: line total = quantity x unit price', () => {
  for (const name of Object.keys(extracted.pdf).filter(n => n.startsWith('PO-'))) {
    const f = read(pdf(name)).fields;
    assert.equal(Math.round(f.quantity * f.unit_price * 100) / 100, f.line_total, name);
  }
});

test('Tumbler_Request.xlsx: the judge-script fields', () => {
  const r = read(xlsx('Tumbler_Request.xlsx'));
  assert.equal(r.document_type, DOC.REQUEST);
  const f = r.fields;
  assert.deepEqual([f.quantity, f.product_color, f.imprint_color, f.imprint_location, f.ship_to, f.ship_to_zip, f.in_hand_date],
    [500, 'Navy', 'White', 'One side', 'Denver, CO 80202', '80202', '2026-12-08']);
  assert.deepEqual(r.missing, []);
});

test('missing fields are listed, not guessed', () => {
  const sleeves = read(xlsx('Laptop_Sleeves_Request.xlsx'));
  assert.deepEqual(sleeves.missing, ['imprint_color', 'imprint_location']);
  assert.equal(sleeves.fields.imprint_method, 'Full color');
  assert.equal(sleeves.needs_review, true);
  assert.deepEqual(read(pdf('Supplier_Quote_Lanyards.pdf')).missing, ['moq']);
  const brief = read(pdf('Customer_Product_Brief_Tumblers.pdf'));
  assert.equal(brief.document_type, DOC.REQUEST);
  assert.deepEqual(brief.missing, ['product_color', 'imprint_color', 'imprint_location']);
});

test('logo image is flagged as not manufacturer-ready', () => {
  const bytes = fs.readFileSync(fixture('Northstar_Retail_Logo.png'));
  const image = Object.assign({bytes: bytes.length}, plain(ctx.pngSize_(bytes)));
  const r = read({filename: 'Northstar_Retail_Logo.png', mimeType: 'image/png', image: image});
  assert.equal(r.document_type, DOC.ARTWORK);
  assert.deepEqual([r.fields.width_px, r.fields.height_px], [900, 420]);
  assert.equal(r.needs_review, true);
  assert.match(r.review_reason, /not manufacturer-ready/);
});

test('invoice dispute is billing, never an order', () => {
  const r = read(pdf('Invoice_Dispute_Example.pdf'));
  assert.equal(r.document_type, DOC.BILLING);
  assert.equal(r.needs_review, true);
  assert.match(r.review_reason, /Quoted quantity 600 differs from PO quantity 500/);
});

test('unsupported files go to review', () => {
  const r = read({filename: 'artwork.zip', mimeType: 'application/zip'});
  assert.equal(r.document_type, DOC.UNSUPPORTED);
  assert.equal(r.needs_review, true);
});

test('date formats', () => {
  assert.equal(ctx.parseDateValue_(new Date(2026, 11, 8)), '2026-12-08');
  assert.equal(ctx.parseDateValue_('12/8/2026'), '2026-12-08');
  assert.equal(ctx.parseDateValue_('Dec 8, 2026'), '2026-12-08');
  assert.equal(ctx.parseDateValue_('next Tuesday'), 'next Tuesday');
});

// ---- Cross-checks between documents and the CRM records ----
const seed = JSON.parse(fs.readFileSync(fixture('seed_directory.json'), 'utf8'));
const dir = ctx.buildDirectory_(seed.contacts, seed.customers, seed.suppliers, ['sales@swagshop.example']);
const emails = fs.readFileSync(fixture('Sample_Gmail_100_Emails.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const verdicts = emails.map(m => ctx.classifyMessage_(m, dir));
const classified = emails.map((m, i) => Object.assign({}, m, {category: verdicts[i].category,
  company_id: verdicts[i].company_id, contact_id: verdicts[i].contact_id, reason: verdicts[i].reason}));

function contentFor(name) {
  if (name.endsWith('.pdf')) return pdf(name);
  if (name.endsWith('.xlsx')) return xlsx(name);
  const bytes = fs.readFileSync(fixture(name));
  return {filename: name, mimeType: 'image/png', image: Object.assign({bytes: bytes.length}, plain(ctx.pngSize_(bytes)))};
}
function parsedDocs(override = {}) {
  const docs = [];
  emails.forEach(m => String(m.attachment_filenames || '').split('|').filter(Boolean).forEach((name, i) => {
    const r = read(contentFor(name));
    docs.push({attachment_id: `ATT-${m.message_id}-${i + 1}`, message_id: m.message_id, filename: name,
      document_type: r.document_type, fields: Object.assign(r.fields, override[name] || {}), missing: r.missing});
  }));
  const orphan = read(pdf('Invoice_Dispute_Example.pdf'));
  docs.push({attachment_id: 'ATT-FILE-1', message_id: '', filename: 'Invoice_Dispute_Example.pdf',
    document_type: orphan.document_type, fields: orphan.fields, missing: orphan.missing});
  return docs;
}
const records = plain(ctx.deriveRecords_(classified, seed.customers, parsedDocs()));

test('order values now come from the PO documents and still total $16,175', () => {
  assert.equal(records.orders.length, 4);
  assert.equal(records.orders.every(o => o.status === 'Confirmed'), true, JSON.stringify(records.orders.map(o => o.review_reason)));
  assert.equal(records.orders.reduce((s, o) => s + o.confirmed_order_total, 0), 16175);
  assert.match(records.orders.find(o => o.po_number === 'PO-2501').amount_basis, /^PO document PO-2501_Purchase_Order\.pdf: line total \$3475\.00/);
});

test('supplier quotes are checked against their price sheets', () => {
  const tumbler = records.supplierQuotes.find(s => s.supplier_id === 'SUP-001');
  assert.equal(tumbler.moq, 250); // only on the PDF, not in the email
  assert.match(tumbler.doc_check, /^Matches Supplier_Quote_Tumblers\.pdf/);
  assert.match(records.supplierQuotes.find(s => s.supplier_id === 'SUP-003').doc_check, /sheet missing: moq/);
});

test('opportunity shows specs from the Excel request', () => {
  const opp = records.opportunities.find(o => o.opportunity_id === 'OPP-SWAG-TUMBLER-02');
  assert.equal(opp.specs, 'Color: Navy; Imprint: White, One side; Ship to: Denver, CO 80202; In-hand: 2026-12-08 (from Tumbler_Request.xlsx)');
});

test('attachments link to company, opportunity and current quote', () => {
  const link = name => {
    const d = parsedDocs().find(x => x.filename === name);
    return records.attachmentLinks.find(l => l.attachment_id === d.attachment_id);
  };
  assert.deepEqual(link('Northstar_Retail_Logo.png'), {attachment_id: 'ATT-SWAG-MSG-0008-2', company_id: 'A-002',
    opportunity_id: 'OPP-SWAG-TUMBLER-02', quote_id: 'Q-1002'});
  assert.equal(link('Supplier_Quote_Totes.pdf').quote_id, 'Q-1001-R1');
  assert.equal(link('PO-2503_Purchase_Order.pdf').opportunity_id, 'OPP-SWAG-GIFTS-07');
  assert.equal(link('Invoice_Dispute_Example.pdf').company_id, 'A-001');
});

test('a PO document that disagrees with the email sends the order to review', () => {
  const r = plain(ctx.deriveRecords_(classified, seed.customers,
    parsedDocs({'PO-2501_Purchase_Order.pdf': {quantity: 450, company: 'Harbor Technology'}})));
  const o = r.orders.find(x => x.po_number === 'PO-2501');
  assert.equal(o.status, 'Needs Review');
  assert.match(o.review_reason, /PO document quantity 450 differs from 500/);
  assert.match(o.review_reason, /names "Harbor Technology" but the sender belongs to Northstar Retail/);
});
