/**
 * Follow-up recommendations and draft emails - pure logic, no Google services.
 * FollowUpsRunner.js reads the CRM tabs, calls buildFollowUps_ and writes the
 * Follow Ups tab. Nothing here sends email: every task is Open, unapproved.
 *
 * Candidates (one per company; a second need is folded into the same draft):
 *   Approval pending  90 + quote value / 500   ("looks good", "need approval")
 *   Open quote        80 + quote value / 500   (no customer reply since sent)
 *   Unanswered request 50 + 15 past buyer + 15 bought this product before
 *                     + days waiting / 3 (max 10)
 *   Dormant buyer     40 + lifetime order value / 1000 (max 20)
 * Excluded: marketing opt-outs, suppliers, unclear identities, products the
 * customer said are on hold, and companies who replied to a quote (the
 * sequence stops on reply; a person answers them). Someone we emailed in the
 * last 2 days gets a due date 3 days after that email instead of today.
 */

const FOLLOW_UP = Object.freeze({LIMIT: 10, RECENT_TOUCH_DAYS: 2, WAIT_AFTER_TOUCH_DAYS: 3,
  DORMANT_ORDER_DAYS: 180, DORMANT_QUIET_DAYS: 60});
const TASK_STATUS = Object.freeze({OPEN: 'Open', WITHDRAWN: 'Withdrawn'});
const KIND = Object.freeze({APPROVAL: 'Approval pending', QUOTE: 'Open quote', REQUEST: 'Unanswered request',
  DORMANT: 'Dormant buyer'});
const DAY_MS = 24 * 60 * 60 * 1000;
const IDENTITY_FLAGS = /Thread mixes different companies|not a known customer contact/;
const NUMBER_WORDS = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30};

/**
 * Ranks follow-up needs and drafts one email per company.
 * @param {Object} data {messages, opportunities, quotes, orders, contacts, customers}: CRM tab rows.
 *     messages are Email Log rows with category/company_id/reason/body.
 * @param {Object} options {now: Date|string, businessName: string, limit?: number}.
 * @return {{tasks: Object[], excluded: Object[]}} Up to `limit` Follow Ups rows, plus companies left out and why.
 */
function buildFollowUps_(data, options) {
  const now = toTime_(options.now);
  const ctx = followUpContext_(data, now);
  const byCompany = {};
  const excluded = [];
  const add = c => (byCompany[c.company_id] = byCompany[c.company_id] || []).push(c);

  quoteCandidates_(ctx).forEach(add);
  requestCandidates_(ctx, excluded).forEach(add);
  dormantCandidates_(ctx).forEach(add);

  Object.keys(ctx.replied).forEach(companyId => {
    const reply = ctx.replied[companyId];
    excluded.push({company_id: companyId, company_name: (ctx.customers[companyId] || {}).company_name || companyId,
      reason: 'Customer replied on ' + longDate_(reply.time) + ' (' + reply.message_id + '); answer personally, no automated follow-up'});
  });

  const tasks = [];
  Object.keys(byCompany).forEach(companyId => {
    if (ctx.replied[companyId]) return;
    const list = byCompany[companyId].sort((a, b) => b.score - a.score);
    const primary = list[0];
    const extra = list.find(c => c !== primary && c.kind === KIND.REQUEST && primary.kind !== KIND.REQUEST);
    const contact = recipient_(ctx, companyId, primary.contact_email);
    const name = (ctx.customers[companyId] || {}).company_name || companyId;
    if (!contact) {
      excluded.push({company_id: companyId, company_name: name, reason: 'Contact opted out of marketing'});
      return;
    }
    const evidence = list.filter(c => c === primary || c === extra).map(c => c.evidence).join(', ');
    const draft = draftFollowUp_(primary, extra, contact, options.businessName || 'SWAG Shop', now);
    tasks.push({
      task_id: 'FU-' + companyId,
      company_id: companyId,
      contact_email: contact.email,
      due_date: dueDate_(ctx, contact.email, now),
      reason: primary.reason + (extra ? '; also ' + lowerFirst_(extra.reason) : '') +
        '. Score ' + (primary.score + (extra ? 5 : 0)).toFixed(1),
      priority: 0,
      status: TASK_STATUS.OPEN,
      source_thread_id: primary.thread_id || '',
      draft_subject: draft.subject,
      draft_body: draft.body,
      approved: false,
      evidence_message_ids: evidence,
      _score: primary.score + (extra ? 5 : 0),
      _kind: primary.kind
    });
  });

  tasks.sort((a, b) => b._score - a._score);
  const limit = options.limit || FOLLOW_UP.LIMIT;
  tasks.slice(limit).forEach(t => excluded.push({company_id: t.company_id,
    company_name: (ctx.customers[t.company_id] || {}).company_name || t.company_id, reason: 'Ranked below the top ' + limit}));
  const top = tasks.slice(0, limit);
  top.forEach((t, i) => { t.priority = i + 1; });
  ctx.optedOut.forEach(email => excluded.push({company_id: '', company_name: email, reason: 'Opted out: never drafted'}));
  return {tasks: top, excluded: excluded};
}

/** Indexes the CRM rows once. */
function followUpContext_(data, now) {
  const customers = {};
  (data.customers || []).forEach(c => { customers[c.company_id] = c; });
  const messages = (data.messages || []).map(m => Object.assign({}, m, {time: toTime_(m.date_time)}))
    .sort((a, b) => a.time - b.time);
  const byId = {}, byThread = {};
  messages.forEach(m => {
    byId[m.message_id] = m;
    (byThread[m.thread_id] = byThread[m.thread_id] || []).push(m);
  });
  const contacts = (data.contacts || []).map(c => Object.assign({}, c, {email: normalizeEmail_(c.email)}));
  return {
    now: now, customers: customers, messages: messages, byId: byId, byThread: byThread, contacts: contacts, replied: {},
    optedOut: contacts.filter(c => isTrue_(c.marketing_opt_out)).map(c => c.email),
    opportunities: data.opportunities || [], quotes: data.quotes || [],
    orders: (data.orders || []).filter(o => o.status === ORDER_STATUS.CONFIRMED || o.status === ORDER_STATUS.HISTORICAL)
  };
}

/** Open quotes and ambiguous approvals, from the Opportunities tab. */
function quoteCandidates_(ctx) {
  const out = [];
  ctx.opportunities.forEach(opp => {
    if (opp.stage !== STAGE.QUOTED && opp.stage !== STAGE.APPROVAL_PENDING) return;
    if (!ctx.customers[opp.company_id]) return;
    const quote = ctx.quotes.filter(q => q.opportunity_id === opp.opportunity_id && q.status !== QUOTE_STATUS.SUPERSEDED)
      .sort((a, b) => toTime_(a.sent_at) - toTime_(b.sent_at)).pop();
    if (!quote) return;
    const quoteMsg = ctx.byId[quote.source_message_id] || {};
    const thread = ctx.byThread[opp.source_thread_id] || [];
    const sent = toTime_(quote.sent_at);
    const value = Number(quote.quoted_total) || 0;
    const facts = {quote: quote, quoteMsg: quoteMsg, thread: thread, sent: sent,
      revised: Boolean(quote.supersedes), event: eventPhrase_(thread), artworkPending: artworkPending_(thread),
      validDays: validityDays_(quoteMsg.body)};
    if (opp.stage === STAGE.APPROVAL_PENDING) {
      const pending = thread.filter(m => m.time > sent && m.category === CATEGORY.UNCERTAIN).pop();
      if (!pending || IDENTITY_FLAGS.test(pending.reason || '')) return;
      out.push(candidate_(KIND.APPROVAL, opp.company_id, 90 + value / 500, pending.from_email, opp.source_thread_id,
        [quote.source_message_id, pending.message_id].join(', '),
        'Quote ' + quote.quote_id + ' (' + money_(value) + '): customer replied "' + approvalWords_(pending.body) +
        '" on ' + longDate_(pending.time) + ' but has not confirmed',
        Object.assign(facts, {pending: pending})));
    } else {
      // Stop the sequence on reply: a customer who answered needs a personal response, not a nudge.
      const reply = thread.filter(m => m.time > sent && String(m.direction).toUpperCase() === 'IN' &&
        m.company_id === opp.company_id).pop();
      if (reply) {
        ctx.replied[opp.company_id] = reply;
        return;
      }
      const days = Math.floor((ctx.now - sent) / DAY_MS);
      out.push(candidate_(KIND.QUOTE, opp.company_id, 80 + value / 500, quoteMsg.to_email, opp.source_thread_id,
        quote.source_message_id,
        'Quote ' + quote.quote_id + ' (' + money_(value) + ') sent ' + longDate_(sent) +
          (days < 2 ? ', no reply yet' : ', no reply in ' + days + ' days'),
        facts));
    }
  });
  return out;
}

/** Customer requests (inquiries, quote requests) we never answered. */
function requestCandidates_(ctx, excluded) {
  const out = [];
  ctx.messages.forEach(m => {
    if (String(m.direction).toUpperCase() !== 'IN') return;
    if (m.category !== CATEGORY.NEW_INQUIRY && m.category !== CATEGORY.QUOTE_REQUEST) return;
    const customer = ctx.customers[m.company_id];
    if (!customer || IDENTITY_FLAGS.test(m.reason || '')) return;
    const thread = ctx.byThread[m.thread_id] || [];
    const answered = thread.some(x => x.time > m.time && String(x.direction).toUpperCase() === 'OUT');
    if (answered) return;
    const p = parseCommercial_(m.body);
    const onHold = onHoldMessage_(ctx, m.company_id, p.product);
    if (onHold) {
      excluded.push({company_id: m.company_id, company_name: customer.company_name,
        reason: 'Request for ' + p.product + ' skipped: customer said it is on hold (' + onHold.message_id + ')'});
      return;
    }
    const past = ctx.orders.filter(o => o.company_id === m.company_id).sort((a, b) => toTime_(b.order_date) - toTime_(a.order_date));
    const same = past.find(o => sameProduct_(o.product, p.product));
    const waited = Math.floor((ctx.now - m.time) / DAY_MS);
    const score = 50 + (past.length ? 15 : 0) + (same ? 15 : 0) + Math.min(waited / 3, 10) + (p.product ? 0 : -10);
    const what = p.product ? (p.quantity ? formatCount_(p.quantity) + ' ' : '') + p.product : 'a general product question';
    out.push(candidate_(KIND.REQUEST, m.company_id, score, m.from_email, m.thread_id, m.message_id,
      'Unanswered request for ' + what + ' since ' + longDate_(m.time) + (same ? ' (bought ' + same.product.toLowerCase() + ' before)' : ''),
      {msg: m, parsed: p, past: past, same: same, waited: waited}));
  });
  return out;
}

/** Past buyers with no orders in 180 days and no email either way in 60 days. */
function dormantCandidates_(ctx) {
  const out = [];
  Object.keys(ctx.customers).forEach(id => {
    const past = ctx.orders.filter(o => o.company_id === id).sort((a, b) => toTime_(b.order_date) - toTime_(a.order_date));
    if (!past.length || ctx.now - toTime_(past[0].order_date) < FOLLOW_UP.DORMANT_ORDER_DAYS * DAY_MS) return;
    const recent = ctx.messages.some(m => m.company_id === id && ctx.now - m.time < FOLLOW_UP.DORMANT_QUIET_DAYS * DAY_MS);
    if (recent) return;
    const lifetime = past.reduce((s, o) => s + (Number(o.confirmed_order_total) || 0), 0);
    const contact = ctx.contacts.find(c => c.company_id === id);
    out.push(candidate_(KIND.DORMANT, id, 40 + Math.min(lifetime / 1000, 20), contact ? contact.email : '', '',
      past[0].order_id, 'Past buyer (' + past[0].product + ', ' + monthYear_(toTime_(past[0].order_date)) + '), no contact in 60+ days',
      {past: past}));
  });
  return out;
}

function candidate_(kind, companyId, score, contactEmail, threadId, evidence, reason, facts) {
  return {kind: kind, company_id: companyId, score: Math.round(score * 10) / 10, contact_email: normalizeEmail_(contactEmail),
    thread_id: threadId, evidence: evidence, reason: reason, facts: facts};
}

/** The person to write to: the one in the evidence if not opted out, else no one (marketing suppression). */
function recipient_(ctx, companyId, preferredEmail) {
  const contact = ctx.contacts.find(c => c.email === preferredEmail) ||
    ctx.contacts.find(c => c.company_id === companyId);
  if (!contact || isTrue_(contact.marketing_opt_out)) return null;
  return contact;
}

/** Today, or 3 days after our last email to this person if that was within the last 2 days. */
function dueDate_(ctx, email, now) {
  const lastOut = ctx.messages.filter(m => String(m.direction).toUpperCase() === 'OUT' && normalizeEmail_(m.to_email) === email).pop();
  let due = now;
  if (lastOut && now - lastOut.time < FOLLOW_UP.RECENT_TOUCH_DAYS * DAY_MS) due = lastOut.time + FOLLOW_UP.WAIT_AFTER_TOUCH_DAYS * DAY_MS;
  const d = new Date(due);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** A message from this company saying the given product's project is on hold. */
function onHoldMessage_(ctx, companyId, product) {
  const noun = headNoun_(product);
  if (!noun) return null;
  return ctx.messages.find(m => m.company_id === companyId && String(m.direction).toUpperCase() === 'IN' &&
    RULES.onHold.test(m.body || '') && String(m.body || '').toLowerCase().indexOf(noun) >= 0) || null;
}

// ---- Draft writing ----

/** Subject and body for one company. Uses only customer-facing facts; never supplier costs. */
function draftFollowUp_(primary, extra, contact, businessName, now) {
  const first = String(contact.full_name || '').split(/\s+/)[0] || 'there';
  const lines = [];
  let subject;
  const f = primary.facts;
  if (primary.kind === KIND.QUOTE || primary.kind === KIND.APPROVAL) {
    const q = f.quote;
    const item = formatCount_(q.quantity) + ' ' + q.product;
    subject = (primary.kind === KIND.APPROVAL ? 'Checking in on quote ' : 'Following up on ' + (f.revised ? 'your revised quote ' : 'quote ')) +
      q.quote_id + ': ' + q.product;
    if (primary.kind === KIND.APPROVAL) {
      lines.push('Thanks for your reply on ' + longDate_(f.pending.time) + ' about quote ' + q.quote_id + ' for ' + item +
        ' (' + money_(q.quoted_total) + ' total). ' + approvalContext_(f.pending.body) +
        ' We have not started production and will not until you confirm in writing.');
    } else {
      lines.push('I wanted to follow up on ' + (f.revised ? 'the revised ' : '') + 'quote ' + q.quote_id + ' for ' + item +
        ' (' + money_(q.quoted_total) + ' total), sent ' + longDate_(f.sent) + (f.event ? ' for your ' + f.event : '') + '.');
    }
    if (f.artworkPending) lines.push('We are still waiting on your final logo; once it arrives I can confirm the production schedule.');
    if (f.validDays && f.sent + f.validDays * DAY_MS < now) {
      lines.push('The original pricing was valid for ' + f.validDays + ' days, so I will reconfirm it before you approve.');
    }
    if (extra) lines.push(extraRequestLine_(extra));
    lines.push(primary.kind === KIND.APPROVAL ? 'Is there anything I can answer to help with the decision?'
      : 'Does the ' + (f.revised ? 'updated quantity and ' : '') + 'pricing still work for you, or would a different quantity or timeline help?');
  } else if (primary.kind === KIND.REQUEST) {
    const p = f.parsed;
    const item = p.product ? (p.quantity ? formatCount_(p.quantity) + ' ' : '') + p.product : '';
    subject = item ? 'Your request for ' + item : 'Your question about colors and samples';
    lines.push(item
      ? 'Thank you for your request on ' + longDate_(f.msg.time) + ' for ' + item + (f.waited > 2 ? ', and I am sorry for the slow reply.' : '.')
      : 'Thank you for your question on ' + longDate_(f.msg.time) + ' about color options and samples' +
        (f.waited > 2 ? ', and I am sorry for the slow reply.' : '.'));
    if (f.same) {
      lines.push('We produced ' + formatCount_(f.same.quantity) + ' ' + f.same.product.toLowerCase() + ' for you in ' +
        monthYear_(toTime_(f.same.order_date)) + ', so I can match that order or suggest updates.');
    } else if (f.past.length) {
      lines.push('Thanks again for your ' + f.past[0].product.toLowerCase() + ' order' +
        (f.past[0].po_number ? ' (' + f.past[0].po_number + ')' : '') + '.');
    }
    lines.push(item
      ? 'To prepare an accurate quote, could you confirm ' + missingDetails_(f.msg.body) + '?'
      : 'I would be glad to share available colors and check sample options. Which product are you considering, and roughly how many?');
  } else {
    const last = f.past[0];
    subject = 'Planning your next ' + last.product.toLowerCase() + ' order';
    lines.push('It has been a while since your ' + last.product.toLowerCase() + ' order in ' + monthYear_(toTime_(last.order_date)) +
      '. If you have events or gifts coming up, I would be glad to put together options or a quick quote.');
  }
  const body = 'Hi ' + first + ',\n\n' + lines.join(' ') + '\n\nBest regards,\n' + businessName + ' Sales';
  return {subject: subject, body: body};
}

function extraRequestLine_(extra) {
  const p = extra.facts.parsed;
  const item = p.product ? (p.quantity ? formatCount_(p.quantity) + ' ' : '') + p.product : 'colors and samples';
  return 'I also saw your ' + longDate_(extra.facts.msg.time) + ' question about ' + item + ' and would be glad to help with that too.';
}

/** What the customer said, restated politely, from an ambiguous-approval email. */
function approvalContext_(body) {
  const t = String(body || '');
  const parts = [];
  if (/looks good/i.test(t)) parts.push('Glad the quote looked good.');
  const from = /approval from (\w+)/i.exec(t);
  if (from) parts.push('I know you are waiting on approval from ' + from[1] + '.');
  else if (/check with (?:the|my) team/i.test(t)) parts.push('I know you were checking with your team.');
  if (/invoice/i.test(t)) parts.push('Once it is approved, I can send the invoice right away.');
  return parts.join(' ') || 'I know you were not ready to move ahead yet.';
}

function approvalWords_(body) {
  return firstMatch_(RULES.stopPhrase, body) || firstMatch_(RULES.softApproval, body) || 'not yet';
}

/** Details still needed to quote, based on what the request says is unknown. */
function missingDetails_(body) {
  const t = String(body || '').toLowerCase();
  const asks = [];
  if (/delivery location|ship|zip/.test(t) || !/\b\d{5}\b/.test(t)) asks.push('the delivery ZIP code');
  if (!/navy|black|white|teal|natural|red|blue|green|colou?r/.test(t)) asks.push('item and imprint colors');
  if (!/need(?:ed)? by|in-hand|deadline|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d/.test(t)) asks.push('your in-hand date');
  return asks.length ? listJoin_(asks) : 'your artwork file and final quantity';
}

/** "for a December conference" -> "December conference". */
function eventPhrase_(thread) {
  for (const m of thread) {
    const hit = /for (?:a|an|our|the) ((?:[A-Z][a-z]+ )?(?:conference|event|member event|trade show|fundraiser|meeting|onboarding))/.exec(m.body || '');
    if (hit && String(m.direction).toUpperCase() === 'IN') return hit[1];
  }
  return '';
}

function artworkPending_(thread) {
  return thread.some(m => String(m.direction).toUpperCase() === 'IN' &&
    /(?:waiting on|send) (?:the |our )?(?:final )?(?:logo|artwork)|logo later/i.test(m.body || ''));
}

/** "Price valid for seven days" / "Valid 7 days" -> 7. */
function validityDays_(body) {
  const m = /valid (?:for )?(\w+) days/i.exec(String(body || ''));
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()] || null;
}

function money_(n) {
  return '$' + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatCount_(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function longDate_(time) {
  const d = new Date(time);
  return capitalize_(MONTHS[d.getMonth()]) + ' ' + d.getDate();
}

function monthYear_(time) {
  const d = new Date(time);
  return capitalize_(MONTHS[d.getMonth()]) + ' ' + d.getFullYear();
}

function capitalize_(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst_(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function listJoin_(items) {
  if (items.length < 3) return items.join(' and ');
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
}

/**
 * Same product for "you bought this before": the last two words must match
 * ("travel mugs" = "Travel mugs"), so "cooler bags" is not "canvas tote bags".
 */
function sameProduct_(a, b) {
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => w.replace(/s$/, '')).slice(-2).join(' ');
  return Boolean(key(a)) && key(a) === key(b);
}
