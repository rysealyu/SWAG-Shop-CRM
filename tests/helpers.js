/**
 * Shared test setup: loads the Apps Script source files into one VM context
 * (Apps Script files share a global scope) and builds the CRM tab data the
 * Sheet would hold after import -> classify -> build records.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixture = name => path.join(__dirname, 'fixtures', name);

/** Loads src files (in order) into a fresh VM context. */
function loadSources(files) {
  const ctx = vm.createContext({});
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, {filename: file});
  return ctx;
}

/**
 * Runs the pipeline on the sample data and returns tab-shaped rows.
 * @param {Object} ctx VM context with Classify.js, Attachments.js, Extract.js loaded.
 */
function sampleCrm(ctx) {
  const seed = JSON.parse(fs.readFileSync(fixture('seed_directory.json'), 'utf8'));
  const dir = ctx.buildDirectory_(seed.contacts, seed.customers, seed.suppliers, ['sales@swagshop.example']);
  const emails = fs.readFileSync(fixture('Sample_Gmail_100_Emails.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const verdicts = emails.map(m => ctx.classifyMessage_(m, dir));
  ctx.flagThreadMismatches_(verdicts);
  const messages = emails.map((m, i) => Object.assign({}, m, {category: verdicts[i].category,
    company_id: verdicts[i].company_id, contact_id: verdicts[i].contact_id, reason: verdicts[i].reason}));
  const records = ctx.deriveRecords_(messages, seed.customers, []);
  const optedOut = new Set(verdicts.filter(v => v.category === 'Marketing Opt-Out').map(v => v.counterparty));
  const historical = seed.historical_orders.map(o => ({order_id: o.order_id, company_id: o.company_id, product: o.product,
    quantity: o.quantity, confirmed_order_total: o.sales_value, order_date: o.order_date, status: 'Historical'}));
  return {
    seed: seed, messages: messages, records: records,
    tabs: {
      messages: messages,
      opportunities: records.opportunities,
      quotes: records.quotes,
      orders: records.orders.concat(historical),
      contacts: seed.contacts.map(c => Object.assign({}, c, {marketing_opt_out: optedOut.has(c.email)})),
      customers: seed.customers
    }
  };
}

module.exports = {loadSources, sampleCrm, fixture};
