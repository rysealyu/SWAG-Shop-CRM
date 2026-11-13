/**
 * Turns classified emails into CRM records: Opportunities, Quotes, Orders and
 * Supplier Quotes. Pure logic, no Google services, so it is tested in Node
 * alongside Classify.js. RecordsRunner.js writes the results to the Sheet.
 *
 * Money rules (05_REFERENCE/Data_Dictionary.md):
 *  - Every outgoing customer quote is its own Quotes row. Revisions share the
 *    opportunity; the older version is marked Superseded, never deleted.
 *  - Supplier pricing only ever lands in Supplier Quotes.
 *  - An order is Confirmed only when its PO links to a quote for the same
 *    company and quantity; otherwise Needs Review. Order value is the PO
 *    document's line total when the PDF has been parsed, else PO quantity x
 *    unit price. Setup and freight are not assumed.
 *  - Parsed attachments (Attachments.js) are cross-checked against the email:
 *    any disagreement sends the order or supplier quote to review.
 */

const QUOTE_STATUS = Object.freeze({SENT: 'Sent', SUPERSEDED: 'Superseded', ACCEPTED: 'Accepted'});
const ORDER_STATUS = Object.freeze({CONFIRMED: 'Confirmed', REVIEW: 'Needs Review'});
const STAGE = Object.freeze({QUOTED: 'Quoted', APPROVAL_PENDING: 'Approval Pending', WON: 'Won'});

const EXTRACT = Object.freeze({
  // A count: not part of "$4.60", "Q-1001" or "PO-2501", and not "20 oz" / "12 business days".
  quantity: /(?:^|[^\w$.\-])(\d{1,3}(?:,\d{3})+|\d+)(?![\d,]|\.\d|\s*(?:oz|%|business|days?|inch|in\b))/gi,
  productAfterQty: /^\s*([a-z0-9][a-z0-9 \-]*?)(?=\s+(?:at|is|for|with|under|from|per|plus|in|to|instead)\b|\s*[,.:;!?(]|\s*$)/i,
  genericProduct: /^(?:units?|pcs|pieces|items|qty)$/i,
  unitPrice: /\$\s?([\d,]+(?:\.\d+)?)\s*(?:\/\s*(?:unit|ea)\b|(?:net\s+)?each\b|per unit\b)/i,
  setup: /\$\s?([\d,]+(?:\.\d+)?)\s*(?:one-time\s+)?setup\b|\bsetup\s*(?:fee\s*)?(?:of\s*)?\$\s?([\d,]+(?:\.\d+)?)/i,
  freight: /\$\s?([\d,]+(?:\.\d+)?)\s*(?:estimated\s+)?(?:freight|delivery|shipping)\b|\b(?:freight|delivery|shipping)\s*(?:cost\s*)?\$\s?([\d,]+(?:\.\d+)?)/i,
  moq: /\bMOQ\s*:?\s*([\d,]+)|minimum (?:order|quantity)\s*:?\s*([\d,]+)/i,
  leadTime: /\d+(?:\s*-\s*\d+)?\s+business days?/i
});

/**
 * Builds all derived records from classified Email Log rows.
 * @param {Object[]} messages Rows with {message_id, thread_id, date_time, direction, subject, body,
 *     attachment_filenames, category, company_id, contact_id, reason}.
 * @param {Object[]} companies Customers rows ({company_id, company_name}), used to link supplier quotes.
 * @param {Object[]=} attachments Parsed attachments ({attachment_id, message_id, filename, document_type, fields}).
 * @return {{opportunities: Object[], quotes: Object[], orders: Object[], supplierQuotes: Object[],
 *     attachmentLinks: Object[]}}
 */
function deriveRecords_(messages, companies, attachments) {
  // Sort by time: CSV row order is not date order, and some replies predate what they answer.
  const msgs = messages.map(m => Object.assign({}, m, {time: toTime_(m.date_time)}))
    .sort((a, b) => a.time - b.time);
  const byThread = {};
  msgs.forEach(m => { (byThread[m.thread_id] = byThread[m.thread_id] || []).push(m); });
  const docs = attachments || [];
  const names = {};
  (companies || []).forEach(c => { names[c.company_id] = c.company_name; });

  const quotes = buildQuotes_(msgs, byThread);
  const orders = buildOrders_(msgs, quotes, docs, names);
  const opportunities = buildOpportunities_(quotes, orders, byThread, docs);
  const supplierQuotes = buildSupplierQuotes_(msgs, opportunities, companies || [], docs);
  const attachmentLinks = linkAttachments_(docs, msgs, quotes, opportunities, supplierQuotes, companies || []);
  return {opportunities: opportunities, quotes: quotes, orders: orders, supplierQuotes: supplierQuotes,
    attachmentLinks: attachmentLinks};
}

function buildQuotes_(msgs, byThread) {
  const quotes = msgs.filter(m => m.category === CATEGORY.CUSTOMER_QUOTE).map(m => {
    const p = parseCommercial_(m.body);
    const quoteId = (firstMatch_(RULES.quoteId, m.body) || firstMatch_(RULES.quoteId, m.subject)).toUpperCase();
    return {
      quote_id: quoteId || 'Q-UNKNOWN-' + m.message_id,
      opportunity_id: 'OPP-' + m.thread_id,
      company_id: m.company_id,
      sent_at: m.date_time,
      product: p.product || requestProduct_(byThread[m.thread_id], m.time) || subjectProduct_(m.subject),
      quantity: p.quantity,
      unit_price: p.unit_price,
      setup_fee: p.setup,
      freight: p.freight,
      quoted_total: p.total,
      status: QUOTE_STATUS.SENT,
      source_message_id: m.message_id,
      supersedes: '',
      math_check: mathCheck_(p),
      _time: m.time, _thread: m.thread_id, _contact: m.contact_id
    };
  });
  // Revisions: Q-1001 then Q-1001-R1. Later versions supersede earlier ones and join their opportunity.
  const byBase = {};
  quotes.forEach(q => { (byBase[baseQuoteId_(q.quote_id)] = byBase[baseQuoteId_(q.quote_id)] || []).push(q); });
  Object.keys(byBase).forEach(base => {
    const versions = byBase[base].sort((a, b) => a._time - b._time);
    versions.forEach((q, i) => {
      q.opportunity_id = versions[0].opportunity_id;
      if (i > 0) q.supersedes = versions[i - 1].quote_id;
      if (i < versions.length - 1) q.status = QUOTE_STATUS.SUPERSEDED;
    });
  });
  return quotes;
}

function buildOrders_(msgs, quotes, docs, companyNames) {
  return msgs.filter(m => m.category === CATEGORY.CONFIRMED_PO).map(m => {
    const p = parseCommercial_(m.body);
    const po = (firstMatch_(RULES.poNumber, m.body) || firstMatch_(RULES.poNumber, m.subject)).toUpperCase();
    const link = linkQuote_(m, p, quotes);
    const quote = link.quote;
    const doc = docFor_(docs, m.message_id, DOC_TYPE.PO);
    const f = doc ? doc.fields : {};
    const quantity = firstKnown_(p.quantity, f.quantity, quote && quote.quantity);
    const unitPrice = firstKnown_(p.unit_price, f.unit_price, quote && quote.unit_price);

    const problems = [];
    if (!quote) {
      problems.push('No matching customer quote found');
    } else {
      if (quote.company_id !== m.company_id) problems.push(quote.quote_id + ' belongs to ' + quote.company_id);
      if (quantity !== null && quote.quantity !== null && quantity !== quote.quantity) {
        problems.push('PO quantity ' + quantity + ' differs from quoted ' + quote.quantity);
      }
      if (unitPrice !== null && quote.unit_price !== null && unitPrice !== quote.unit_price) {
        problems.push('PO unit price $' + unitPrice + ' differs from quoted $' + quote.unit_price);
      }
    }
    if (quantity === null || unitPrice === null) problems.push('Quantity or unit price missing');

    let total = quantity !== null && unitPrice !== null ? round2_(quantity * unitPrice) : null;
    let amountBasis = total === null ? 'Cannot compute: quantity or unit price missing'
      : quantity + ' x $' + unitPrice.toFixed(2) + ' (' + (p.unit_price !== null ? 'PO email' : 'quoted') +
        ' unit price). Setup/freight not included. PO document not parsed yet.';
    if (doc) {
      problems.push.apply(problems, poDocumentProblems_(doc, po, quantity, unitPrice, companyNames[m.company_id]));
      if (typeof f.line_total === 'number') {
        total = f.line_total;
        amountBasis = 'PO document ' + doc.filename + ': line total $' + total.toFixed(2) +
          '. Setup/freight are not on the PO and are not included.';
      }
    }
    if (quote && !problems.length) quote.status = QUOTE_STATUS.ACCEPTED;

    return {
      order_id: 'ORD-' + (po || m.message_id),
      company_id: m.company_id,
      quote_id: quote ? quote.quote_id : '',
      order_date: m.date_time,
      po_number: po,
      product: p.product || (quote ? quote.product : '') || f.product || '',
      quantity: quantity,
      unit_price: unitPrice,
      freight: null,
      confirmed_order_total: total,
      status: problems.length ? ORDER_STATUS.REVIEW : ORDER_STATUS.CONFIRMED,
      source_message_id: m.message_id,
      quote_link_basis: link.basis,
      amount_basis: amountBasis,
      review_reason: problems.join('; '),
      _opportunity: quote ? quote.opportunity_id : ''
    };
  });
}

/** Disagreements between a parsed PO document and what the email/quote say. */
function poDocumentProblems_(doc, po, quantity, unitPrice, companyName) {
  const f = doc.fields, problems = [];
  if (f.po_number && po && f.po_number !== po) problems.push('PO document number ' + f.po_number + ' differs from email ' + po);
  if (typeof f.quantity === 'number' && quantity !== null && f.quantity !== quantity) {
    problems.push('PO document quantity ' + f.quantity + ' differs from ' + quantity);
  }
  if (typeof f.unit_price === 'number' && unitPrice !== null && f.unit_price !== unitPrice) {
    problems.push('PO document unit price $' + f.unit_price + ' differs from $' + unitPrice);
  }
  if (typeof f.line_total === 'number' && quantity !== null && unitPrice !== null &&
      Math.abs(f.line_total - quantity * unitPrice) > 0.01) {
    problems.push('PO document line total $' + f.line_total + ' differs from ' + quantity + ' x $' + unitPrice);
  }
  if (f.company && companyName && !sameName_(f.company, companyName)) {
    problems.push('PO document names "' + f.company + '" but the sender belongs to ' + companyName);
  }
  if (doc.missing && doc.missing.length) problems.push('PO document missing: ' + doc.missing.join(', '));
  return problems;
}

function buildOpportunities_(quotes, orders, byThread, docs) {
  const byOpp = {};
  quotes.forEach(q => { (byOpp[q.opportunity_id] = byOpp[q.opportunity_id] || []).push(q); });
  return Object.keys(byOpp).map(id => {
    const versions = byOpp[id].sort((a, b) => a._time - b._time);
    const latest = versions[versions.length - 1];
    const thread = byThread[latest._thread] || [];
    const order = orders.find(o => o._opportunity === id && o.status === ORDER_STATUS.CONFIRMED);
    const pending = thread.filter(m => m.time > latest._time && m.category === CATEGORY.UNCERTAIN);
    const last = thread[thread.length - 1];

    let stage = STAGE.QUOTED, nextAction = 'Follow up on ' + latest.quote_id + '; no customer reply since it was sent';
    if (order) {
      stage = STAGE.WON;
      nextAction = 'Send production proof; confirm freight and in-hand date (' + order.po_number + ')';
    } else if (pending.length) {
      stage = STAGE.APPROVAL_PENDING;
      nextAction = 'Confirm approval before production (' + (pending[pending.length - 1].reason || 'ambiguous reply') + ')';
    }
    return {
      opportunity_id: id,
      company_id: latest.company_id,
      contact_id: latest._contact || '',
      product: latest.product,
      quantity: latest.quantity,
      stage: stage,
      estimated_value: order ? order.confirmed_order_total : latest.quoted_total,
      last_activity: last ? last.date_time : latest.sent_at,
      next_action: nextAction,
      source_thread_id: latest._thread,
      specs: specSummary_(thread, docs),
      _product: latest.product, _quantity: latest.quantity
    };
  });
}

/** One-line product spec from customer request documents in the thread (Excel request, product brief). */
function specSummary_(thread, docs) {
  const ids = new Set(thread.map(m => m.message_id));
  const requests = docs.filter(d => ids.has(d.message_id) && d.document_type === DOC_TYPE.REQUEST)
    .sort((a, b) => Object.keys(b.fields).length - Object.keys(a.fields).length);
  if (!requests.length) return '';
  const f = requests[0].fields;
  const parts = [['Color', f.product_color], ['Imprint', [f.imprint_color, f.imprint_method, f.imprint_location].filter(Boolean).join(', ')],
    ['Size', f.size], ['Ship to', f.ship_to], ['In-hand', f.in_hand_date]].filter(x => x[1]);
  return parts.map(x => x[0] + ': ' + x[1]).join('; ') + ' (from ' + requests[0].filename + ')';
}

function buildSupplierQuotes_(msgs, opportunities, companies, docs) {
  return msgs.filter(m => m.category === CATEGORY.SUPPLIER_QUOTE).map(m => {
    const p = parseCommercial_(m.body);
    const link = linkSupplierQuote_(m, p, opportunities, companies);
    const doc = docFor_(docs, m.message_id, DOC_TYPE.SUPPLIER);
    const f = doc ? doc.fields : {};
    return {
      supplier_quote_id: 'SQ-' + m.message_id,
      supplier_id: m.company_id,
      customer_opportunity_id: link.id,
      received_at: m.date_time,
      product: p.product || f.product || '',
      quantity: firstKnown_(p.quantity, f.quantity),
      unit_cost: firstKnown_(p.unit_price, f.unit_cost),
      setup_cost: firstKnown_(p.setup, f.setup_cost),
      freight_cost: firstKnown_(p.freight, f.freight_cost),
      moq: firstKnown_(p.moq, f.moq),
      lead_time: p.lead_time || f.lead_time || '',
      source_message_id: m.message_id,
      link_basis: link.basis,
      doc_check: supplierDocCheck_(doc, p)
    };
  });
}

/** Compares the supplier's email numbers with its attached price sheet. */
function supplierDocCheck_(doc, p) {
  if (!doc) return 'No price sheet parsed';
  const pairs = [['quantity', p.quantity, doc.fields.quantity], ['unit cost', p.unit_price, doc.fields.unit_cost],
    ['setup', p.setup, doc.fields.setup_cost], ['freight', p.freight, doc.fields.freight_cost]];
  const diffs = pairs.filter(x => typeof x[1] === 'number' && typeof x[2] === 'number' && x[1] !== x[2])
    .map(x => x[0] + ' email ' + x[1] + ' vs sheet ' + x[2]);
  if (diffs.length) return 'Differs from ' + doc.filename + ': ' + diffs.join('; ');
  return 'Matches ' + doc.filename + (doc.missing && doc.missing.length ? ' (sheet missing: ' + doc.missing.join(', ') + ')' : '');
}

/**
 * Links each parsed attachment to its company, opportunity and current quote,
 * e.g. the Northstar logo -> OPP-SWAG-TUMBLER-02 -> Q-1002. Files not attached
 * to any email are matched by the company named inside them, if any.
 */
function linkAttachments_(docs, msgs, quotes, opportunities, supplierQuotes, companies) {
  const msgById = {};
  msgs.forEach(m => { msgById[m.message_id] = m; });
  const currentQuote = oppId => {
    const live = quotes.filter(q => q.opportunity_id === oppId && q.status !== QUOTE_STATUS.SUPERSEDED);
    return live.length ? live.sort((a, b) => a._time - b._time)[live.length - 1].quote_id : '';
  };
  return docs.map(d => {
    const m = msgById[d.message_id];
    let companyId = m ? m.company_id : '', oppId = '';
    if (m) {
      const sq = supplierQuotes.find(s => s.source_message_id === m.message_id);
      const opp = opportunities.find(o => o.source_thread_id === m.thread_id);
      oppId = sq ? sq.customer_opportunity_id : (opp ? opp.opportunity_id : '');
    } else {
      const named = String(d.fields.company || d.fields.customer || d.fields.account || '');
      const c = companies.find(x => named && sameName_(named, x.company_name));
      companyId = c ? c.company_id : '';
    }
    return {attachment_id: d.attachment_id, company_id: companyId, opportunity_id: oppId,
      quote_id: oppId ? currentQuote(oppId) : ''};
  });
}

function docFor_(docs, messageId, type) {
  return docs.find(d => d.message_id === messageId && d.document_type === type) || null;
}

function firstKnown_() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== null && v !== undefined && v !== '' && v !== false) return v;
  }
  return null;
}

function sameName_(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b);
}

/** Finds the customer quote a PO answers: quote ID in the email, else same thread, else same company + quantity. */
function linkQuote_(m, parsed, quotes) {
  const earlier = quotes.filter(q => q._time <= m.time);
  const latest = list => list.sort((a, b) => a._time - b._time)[list.length - 1];
  const named = (firstMatch_(RULES.quoteId, m.body) || firstMatch_(RULES.quoteId, m.subject)).toUpperCase();
  if (named) {
    const exact = earlier.filter(q => q.quote_id === named);
    if (exact.length) return {quote: latest(exact), basis: named + ' named in PO email'};
    const family = earlier.filter(q => baseQuoteId_(q.quote_id) === baseQuoteId_(named));
    if (family.length) return {quote: latest(family), basis: 'Latest version of ' + named + ' named in PO email'};
  }
  const sameThread = earlier.filter(q => q._thread === m.thread_id);
  if (sameThread.length) return {quote: latest(sameThread), basis: 'Same email thread'};
  const sameDeal = earlier.filter(q => q.company_id === m.company_id && q.quantity === parsed.quantity &&
    q.status !== QUOTE_STATUS.SUPERSEDED);
  if (sameDeal.length === 1) return {quote: sameDeal[0], basis: 'Same company and quantity'};
  return {quote: null, basis: ''};
}

/** Links supplier pricing to the customer deal it was requested for. */
function linkSupplierQuote_(m, parsed, opportunities, companies) {
  const text = String(m.subject || '') + '\n' + String(m.body || '');
  const noun = headNoun_(parsed.product);
  const named = companies.filter(c => c.company_name && text.toLowerCase().indexOf(String(c.company_name).toLowerCase()) >= 0);
  if (named.length === 1) {
    const theirs = opportunities.filter(o => o.company_id === named[0].company_id);
    const fit = theirs.length > 1 ? theirs.filter(o => headNoun_(o._product) === noun) : theirs;
    if (fit.length === 1) return {id: fit[0].opportunity_id, basis: 'Customer ' + named[0].company_name + ' named in email'};
  }
  const sameItem = opportunities.filter(o => noun && headNoun_(o._product) === noun && o._quantity === parsed.quantity);
  if (sameItem.length === 1) return {id: sameItem[0].opportunity_id, basis: 'Same product and quantity'};
  return {id: '', basis: 'No single matching customer opportunity; review'};
}

/**
 * Pulls quantity, product and money fields from free text. Missing fields are null, never guessed.
 * @param {string} text Email body.
 * @return {Object} {quantity, product, unit_price, setup, freight, total, moq, lead_time}.
 */
function parseCommercial_(text) {
  const t = String(text || '');
  const qty = firstQuantity_(t);
  return {
    quantity: qty ? qty.value : null,
    product: qty ? productAfter_(t, qty.end) : '',
    unit_price: numberMatch_(EXTRACT.unitPrice, t),
    setup: numberMatch_(EXTRACT.setup, t),
    freight: numberMatch_(EXTRACT.freight, t),
    total: parseTotal_(t),
    moq: numberMatch_(EXTRACT.moq, t),
    lead_time: firstMatch_(EXTRACT.leadTime, t)
  };
}

function firstQuantity_(text) {
  const re = new RegExp(EXTRACT.quantity.source, 'gi');
  let m;
  while ((m = re.exec(text))) {
    const value = Number(m[1].replace(/,/g, ''));
    if (value >= 10) return {value: value, end: m.index + m[0].length};
  }
  return null;
}

function productAfter_(text, end) {
  const m = EXTRACT.productAfterQty.exec(text.slice(end));
  const product = m ? m[1].trim() : '';
  return EXTRACT.genericProduct.test(product) ? '' : product;
}

/** Product named in the customer's original request, for quotes that only say "500 units". */
function requestProduct_(thread, beforeTime) {
  const request = (thread || []).find(m => m.time <= beforeTime && m.category === CATEGORY.QUOTE_REQUEST &&
    String(m.direction).toUpperCase() === 'IN' && parseCommercial_(m.body).product);
  return request ? parseCommercial_(request.body).product : '';
}

function subjectProduct_(subject) {
  const parts = String(subject || '').split(':');
  return parts[parts.length - 1].trim();
}

/** "OK" when total = qty x unit + setup + freight; otherwise says what is off. */
function mathCheck_(p) {
  const missing = ['quantity', 'unit_price', 'total'].filter(k => p[k] === null);
  if (missing.length) return 'Incomplete: missing ' + missing.join(', ');
  const diff = round2_(p.total - (p.quantity * p.unit_price + (p.setup || 0) + (p.freight || 0)));
  return Math.abs(diff) < 0.01 ? 'OK' : 'Total differs from qty x unit + setup + freight by $' + diff;
}

function numberMatch_(re, text) {
  const m = re.exec(text);
  if (!m) return null;
  const raw = m.slice(1).find(g => g !== undefined);
  return raw === undefined ? null : Number(raw.replace(/,/g, ''));
}

function baseQuoteId_(id) {
  return String(id || '').toUpperCase().replace(/-R\d+$/, '');
}

function headNoun_(product) {
  const words = String(product || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? words[words.length - 1].replace(/s$/, '') : '';
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/** Sheet dates arrive as Date objects, test fixtures as "yyyy-MM-dd HH:mm:ss" strings. */
function toTime_(value) {
  if (value && typeof value.getTime === 'function') return value.getTime();
  return Date.parse(String(value || '').replace(' ', 'T'));
}
