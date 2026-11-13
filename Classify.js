/**
 * Email classification rules - pure logic, no Google services.
 *
 * Kept free of SpreadsheetApp/GmailApp so the same file runs in Node for
 * tests (tests/classify.test.js). ClassifyRunner.js applies it to Email Log.
 *
 * Decision order (it matters):
 *   1. Who is the other party? us / customer / supplier / unknown.
 *   2. Outbound mail: quote (ID + total) > follow-up > quote details > order status.
 *   3. Supplier mail: pricing > production/shipping status.
 *   4. Customer mail: opt-out > PO > ambiguous approval > on hold > order status
 *      > vague inquiry > quote request. Stop phrases are checked BEFORE a PO
 *      can count, so "looks good, do not start production" never becomes an order.
 *   5. Nothing matched: Uncertain, sent to human review. Never guess.
 */

/** Category labels written to Email Log (the 10 categories in Functional_Requirements.md). */
const CATEGORY = Object.freeze({
  NEW_INQUIRY: 'New Inquiry',
  QUOTE_REQUEST: 'Quote Request',
  CUSTOMER_QUOTE: 'Customer Quote Sent',
  SUPPLIER_QUOTE: 'Supplier Quote Received',
  CONFIRMED_PO: 'Confirmed Customer PO',
  ORDER_STATUS: 'Order Status',
  FOLLOW_UP: 'Follow-Up',
  OPT_OUT: 'Marketing Opt-Out',
  UNRELATED: 'Unrelated',
  UNCERTAIN: 'Uncertain'
});

/** Categories that feed money KPIs; these need a known customer or they go to review. */
const MONEY_CATEGORIES = [CATEGORY.CUSTOMER_QUOTE, CATEGORY.CONFIRMED_PO];

/** Shared mailbox domains: never used to guess a company from a domain. */
const FREE_MAIL_DOMAINS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com'];

const RULES = Object.freeze({
  quoteId: /\bQ-\d{3,}(?:-R\d+)?\b/i,
  poNumber: /\bPO-\d{3,}\b/i,
  total: /\btotal\b[^$\n]{0,25}\$\s?([\d,]+(?:\.\d{1,2})?)/i,
  money: /\$\s?\d/,
  // Inbound customer mail
  optOut: /remove me from|do not wish to receive|(?:please )?unsubscribe me|stop (?:sending|emailing) me|opt me out/i,
  stopPhrase: /(?:do not|don't)\s+(?:start|begin|book|proceed)|still need[^.]{0,40}approval|need[^.]{0,20}approval from|(?:pending|awaiting) approval|check with (?:the|my) team|hold off|not (?:yet )?approved|before this becomes an order/i,
  softApproval: /looks good|sounds good|send (?:the|an|us an?) invoice|go ahead|good to go/i,
  approval: /\bapproved\b|\bwe approve\b|\bwe confirm (?:the )?order\b|\bconfirm(?:ed)? (?:the |our )?order\b/i,
  poDocument: /\bPO\b|purchase[\s_-]?order/i,
  onHold: /on hold|check back later|not moving forward|no longer (?:need|interested)/i,
  orderStatusIn: /virtual proof|pantone|artwork proof|proof timeline|imprint color is|tracking|shipment status|where is (?:my|our) order/i,
  vagueInquiry: /initial question|before requesting a quote|still confirming|just (?:a|an) (?:quick )?question/i,
  quoteAsk: /please quote|(?:could|can) you (?:quote|price)|quote request|request pricing|send (?:us )?(?:a |the )?(?:price|quote|quotation)|budgetary quote|provide an estimate|revise (?:this|the quote)|quotation for/i,
  productInterest: /pric(?:e|ing)|quote|interested in|looking for|samples?\b|do you (?:offer|carry|make)/i,
  unrelated: /newsletter|no-?reply|webinar|receipt for your|your order has shipped|unsubscribe/i,
  // Inbound supplier mail
  supplierPrice: /cost|per unit|\beach\b|\/ea\b|\bnet\b|pricing|quote|setup|freight/i,
  supplierStatus: /production|shipping|tracking|inspection|shipped|delivery|factory/i,
  // Outbound mail
  followUpOut: /following up|checking in|circling back|follow up on/i,
  quoteDetailsOut: /quote accurately|i can quote|before (?:we|i) can quote|once we have these/i,
  orderStatusOut: /received PO|PO-\d+|proof|artwork|production|shipped|tracking|delivery window/i,
  inquiryReplyOut: /thank(?:s| you) for contacting|sample options|available colors/i
});

/**
 * Builds the lookup tables used to identify the other party on each email.
 * @param {Object[]} contacts Contacts rows ({contact_id, company_id, email, marketing_opt_out}).
 * @param {Object[]} customers Customers rows ({company_id, domain}).
 * @param {Object[]} suppliers Suppliers rows ({supplier_id, email}).
 * @param {string[]} businessEmails SWAG Shop's own addresses (excluded when picking a recipient).
 * @return {Object} Directory consumed by classifyMessage_.
 */
function buildDirectory_(contacts, customers, suppliers, businessEmails) {
  const dir = {contactByEmail: {}, companyByDomain: {}, supplierByEmail: {}, supplierByDomain: {},
    business: (businessEmails || []).map(normalizeEmail_).filter(Boolean)};
  (suppliers || []).forEach(s => {
    const email = normalizeEmail_(s.email);
    if (!email || !s.supplier_id) return;
    dir.supplierByEmail[email] = s.supplier_id;
    const domain = companyDomain_(email);
    if (domain) dir.supplierByDomain[domain] = s.supplier_id;
  });
  (customers || []).forEach(c => {
    const domain = String(c.domain || '').trim().toLowerCase().replace(/^@/, '');
    if (domain && c.company_id && FREE_MAIL_DOMAINS.indexOf(domain) < 0) dir.companyByDomain[domain] = c.company_id;
  });
  (contacts || []).forEach(c => {
    const email = normalizeEmail_(c.email);
    if (!email) return;
    dir.contactByEmail[email] = {contact_id: c.contact_id || '', company_id: c.company_id || '',
      opt_out: isTrue_(c.marketing_opt_out)};
    const domain = companyDomain_(email);
    if (domain && c.company_id && !dir.companyByDomain[domain]) dir.companyByDomain[domain] = c.company_id;
  });
  return dir;
}

/**
 * Classifies one email.
 * @param {Object} msg {message_id, thread_id, direction, from_email, to_email, subject, body, attachment_filenames}.
 * @param {Object} dir Directory from buildDirectory_.
 * @return {Object} {category, confidence, needsReview, reason, counterparty, role, company_id, contact_id, quote_id, po_number, amount}.
 */
function classifyMessage_(msg, dir) {
  const text = String(msg.subject || '') + '\n' + String(msg.body || '');
  const outbound = String(msg.direction || '').toUpperCase() === 'OUT';
  const counterparty = outbound ? firstExternalAddress_(msg.to_email, dir) : normalizeEmail_(msg.from_email);
  const party = identifyParty_(counterparty, dir);

  let verdict;
  if (outbound) verdict = classifyOutbound_(text, party);
  else if (party.role === 'supplier') verdict = classifySupplierInbound_(text);
  else verdict = classifyCustomerInbound_(text, msg.attachment_filenames, party);

  const reasons = [verdict.reason];
  let needsReview = verdict.category === CATEGORY.UNCERTAIN || verdict.confidence < 0.7;
  if (party.role === 'unknown' && MONEY_CATEGORIES.indexOf(verdict.category) >= 0) {
    needsReview = true;
    reasons.push((counterparty || 'Other party') + ' is not a known customer contact');
  }
  if (party.matchedBy === 'company domain' || party.matchedBy === 'supplier domain') {
    reasons.push('Matched by email domain only (new contact)');
  }

  return {
    message_id: String(msg.message_id || ''),
    thread_id: String(msg.thread_id || ''),
    category: verdict.category,
    confidence: verdict.confidence,
    needsReview: needsReview,
    reason: reasons.join('; '),
    counterparty: counterparty,
    role: party.role,
    company_id: party.company_id || party.supplier_id || '',
    contact_id: party.contact_id || '',
    quote_id: firstMatch_(RULES.quoteId, text).toUpperCase(),
    po_number: firstMatch_(RULES.poNumber, text).toUpperCase(),
    amount: parseTotal_(text)
  };
}

/**
 * Flags threads whose messages involve more than one company. The sample data
 * has replies arriving from a different company than the one we emailed, so
 * identity comes from each sender's address and the thread goes to review.
 * Mutates the results in place.
 * @param {Object[]} results Output of classifyMessage_ for a batch of messages.
 * @return {Set<string>} Thread IDs that were flagged.
 */
function flagThreadMismatches_(results) {
  const partiesByThread = {};
  results.forEach(r => {
    const party = r.company_id || r.counterparty;
    if (!r.thread_id || !party) return;
    (partiesByThread[r.thread_id] = partiesByThread[r.thread_id] || new Set()).add(party);
  });
  const flagged = new Set();
  results.forEach(r => {
    const parties = partiesByThread[r.thread_id];
    if (!parties || parties.size < 2) return;
    r.needsReview = true;
    r.reason += '; Thread mixes different companies (' + Array.from(parties).join(', ') +
      '): account taken from this sender, verify';
    flagged.add(r.thread_id);
  });
  return flagged;
}

function classifyOutbound_(text, party) {
  const quoteId = firstMatch_(RULES.quoteId, text);
  if (quoteId && RULES.total.test(text)) {
    if (party.role === 'supplier') {
      return verdict_(CATEGORY.UNCERTAIN, 0.5, quoteId + ' was sent to a supplier; customer quotes go to customers');
    }
    return verdict_(CATEGORY.CUSTOMER_QUOTE, 0.95, 'Outgoing ' + quoteId + ' with a stated total');
  }
  if (RULES.followUpOut.test(text)) return verdict_(CATEGORY.FOLLOW_UP, 0.9, 'Outgoing follow-up');
  if (RULES.quoteDetailsOut.test(text)) {
    return verdict_(CATEGORY.QUOTE_REQUEST, 0.8, 'We asked for details needed to quote');
  }
  if (RULES.orderStatusOut.test(text)) {
    return verdict_(CATEGORY.ORDER_STATUS, 0.85, 'Outgoing proof/PO/production update');
  }
  if (quoteId) return verdict_(CATEGORY.UNCERTAIN, 0.5, 'Mentions ' + quoteId + ' but no stated total');
  if (RULES.inquiryReplyOut.test(text)) {
    return verdict_(CATEGORY.NEW_INQUIRY, 0.75, 'Our reply to a general product question');
  }
  return verdict_(CATEGORY.UNCERTAIN, 0.4, 'Outgoing message matched no rule');
}

function classifySupplierInbound_(text) {
  if (RULES.money.test(text) && RULES.supplierPrice.test(text)) {
    return verdict_(CATEGORY.SUPPLIER_QUOTE, 0.95, 'Supplier pricing: our cost, not a customer quote');
  }
  if (RULES.supplierStatus.test(text)) {
    return verdict_(CATEGORY.ORDER_STATUS, 0.85, 'Supplier production/shipping update');
  }
  return verdict_(CATEGORY.UNCERTAIN, 0.4, 'Supplier message matched no pricing or status rule');
}

function classifyCustomerInbound_(text, attachmentNames, party) {
  const optOut = firstMatch_(RULES.optOut, text);
  if (optOut) return verdict_(CATEGORY.OPT_OUT, 0.95, 'Asked to stop marketing: "' + optOut + '"');
  if (party.role === 'unknown' && RULES.unrelated.test(text)) {
    return verdict_(CATEGORY.UNRELATED, 0.7, 'Unknown sender with newsletter/automated wording');
  }

  const po = firstMatch_(RULES.poNumber, text);
  const stop = firstMatch_(RULES.stopPhrase, text);
  if (po) {
    if (stop) return verdict_(CATEGORY.UNCERTAIN, 0.5, 'Mentions ' + po + ' but also says "' + stop + '"');
    const hasPoDocument = splitAttachments_(attachmentNames).some(name => RULES.poDocument.test(name));
    const approval = firstMatch_(RULES.approval, text);
    if (approval && hasPoDocument) {
      return verdict_(CATEGORY.CONFIRMED_PO, 0.95, po + ' attached with approval wording "' + approval + '"');
    }
    return verdict_(CATEGORY.UNCERTAIN, 0.55, 'Mentions ' + po + ' but ' +
      (hasPoDocument ? 'no explicit approval wording' : 'no purchase order document attached'));
  }

  const soft = firstMatch_(RULES.softApproval, text);
  if (stop || soft) {
    return verdict_(CATEGORY.UNCERTAIN, 0.5, 'Ambiguous approval, not an order: "' + (stop || soft) + '"');
  }
  const onHold = firstMatch_(RULES.onHold, text);
  if (onHold) return verdict_(CATEGORY.FOLLOW_UP, 0.85, 'Customer paused the project: "' + onHold + '"');
  if (RULES.orderStatusIn.test(text)) {
    return verdict_(CATEGORY.ORDER_STATUS, 0.85, 'Question about proof/artwork/delivery on an active job');
  }
  const vague = firstMatch_(RULES.vagueInquiry, text);
  if (vague) return verdict_(CATEGORY.NEW_INQUIRY, 0.85, 'Early-stage inquiry: "' + vague + '"');
  const ask = firstMatch_(RULES.quoteAsk, text);
  if (ask) return verdict_(CATEGORY.QUOTE_REQUEST, 0.85, 'Asked for pricing on a specific project: "' + ask + '"');
  if (RULES.productInterest.test(text)) {
    return verdict_(CATEGORY.NEW_INQUIRY, 0.65, 'General product or pricing interest');
  }
  if (party.role === 'unknown') return verdict_(CATEGORY.UNRELATED, 0.6, 'Unknown sender, no business wording');
  return verdict_(CATEGORY.UNCERTAIN, 0.4, 'Customer message matched no rule');
}

function identifyParty_(email, dir) {
  if (!email) return {role: 'unknown'};
  if (dir.supplierByEmail[email]) {
    return {role: 'supplier', supplier_id: dir.supplierByEmail[email], matchedBy: 'supplier email'};
  }
  const contact = dir.contactByEmail[email];
  if (contact) {
    return {role: 'customer', company_id: contact.company_id, contact_id: contact.contact_id, matchedBy: 'contact email'};
  }
  const domain = companyDomain_(email);
  if (domain && dir.supplierByDomain[domain]) {
    return {role: 'supplier', supplier_id: dir.supplierByDomain[domain], matchedBy: 'supplier domain'};
  }
  if (domain && dir.companyByDomain[domain]) {
    return {role: 'customer', company_id: dir.companyByDomain[domain], matchedBy: 'company domain'};
  }
  return {role: 'unknown'};
}

function verdict_(category, confidence, reason) {
  return {category: category, confidence: confidence, reason: reason};
}

function firstMatch_(re, text) {
  const m = re.exec(String(text || ''));
  return m ? m[0] : '';
}

function parseTotal_(text) {
  const m = RULES.total.exec(String(text || ''));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** "Name <a@b.com>" or "a@b.com" -> "a@b.com". */
function normalizeEmail_(raw) {
  const s = String(raw || '');
  const angle = s.match(/<([^>]+)>/);
  return (angle ? angle[1] : s).trim().toLowerCase();
}

/** First address in a To/Cc list that is not one of SWAG Shop's own. */
function firstExternalAddress_(field, dir) {
  const addresses = String(field || '').split(/[,;]/).map(normalizeEmail_).filter(Boolean);
  return addresses.find(a => dir.business.indexOf(a) < 0) || '';
}

/** Domain of an address, or '' for shared mailbox providers like gmail.com. */
function companyDomain_(email) {
  const domain = String(email || '').split('@')[1] || '';
  return FREE_MAIL_DOMAINS.indexOf(domain) >= 0 ? '' : domain;
}

function splitAttachments_(names) {
  return String(names || '').split('|').map(n => n.trim()).filter(Boolean);
}

function isTrue_(value) {
  return value === true || /^(true|yes|y|1)$/i.test(String(value || '').trim());
}
