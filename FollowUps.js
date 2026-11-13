/**
 * Follow-up recommendations and outreach drafts - pure logic, no Google services,
 * so it runs in Node next to Classify.js and Extract.js. FollowUpsRunner.js
 * reads the Sheet, calls buildFollowUps_ and writes the Follow Ups tab.
 *
 * Rules (05_REFERENCE/Example_Outreach_Prompts.md, Agent_SKILL.md):
 *  - Customers only. Suppliers and companies not on the Customers tab are never drafted.
 *  - Skip marketing opt-outs (Contacts flag OR an opt-out email from that address).
 *  - Skip unclear identities: no contact on file for the company.
 *  - Skip active conversations: any message with the customer in the last few days,
 *    or the customer's latest reply asks us to check back later.
 *  - Evidence comes only from messages whose identity is clean (not flagged for
 *    a thread that mixes companies). Flagged messages still count as activity,
 *    so they can suppress a follow-up but never justify one.
 *  - An unanswered customer request is served before anything promotional.
 *  - Drafts never mention supplier costs. Nothing is sent: approved = FALSE.
 */

const FOLLOW_UP = Object.freeze({
  MAX_TASKS: 10,
  ACTIVE_DAYS: 3,        // a message within this many days = active conversation, leave it alone
  HOLD_DAYS: 60,         // "on hold, check back later" suppresses follow-ups for this long
  QUOTE_WAIT_DAYS: 3,    // follow up on an unanswered quote this long after sending it
  APPROVAL_WAIT_DAYS: 3, // and on a "checking with the team" reply this long after it
  REQUEST_WAIT_DAYS: 1,  // an unanswered customer request is due the next day
  MIXED_THREAD: 'Thread mixes different companies',
  STATUS: Object.freeze({OPEN: 'Open', NOT_NEEDED: 'Not Needed'}),
  KIND: Object.freeze({APPROVAL: 'approval', QUOTE: 'quote', REQUEST: 'request'})
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ranks customers who need a follow-up and drafts one message for each.
 * @param {Object} input {messages, customers, contacts, opportunities, quotes, orders}: rows read from
 *     the Email Log (with classification), Customers, Contacts, Opportunities, Quotes and Orders tabs.
 * @param {Date|number} now Reference time; day counts and the active window are measured from it.
 * @param {Object=} options {maxTasks, signature}.
 * @return {{tasks: Object[], skipped: Object[]}} tasks are Follow Ups rows (due_date as a Date at local
 *     midnight); skipped lists {company_id, reason} for every customer left out, for the run log.
 */
function buildFollowUps_(input, now, options) {
  const opts = options || {};
  const nowTime = toTime_(now);
  const signature = opts.signature || 'SWAG Shop Sales';
  const msgs = (input.messages || []).map(m => Object.assign({}, m, {time: toTime_(m.date_time)}))
    .filter(m => !isNaN(m.time)).sort((a, b) => a.time - b.time);
  const byThread = groupBy_(msgs, m => m.thread_id);
  const byCompany = groupBy_(msgs, m => m.company_id);

  const candidates = [], skipped = [];
  (input.customers || []).forEach(customer => {
    const id = String(customer.company_id || '').trim();
    if (!id) return;
    const ctx = {
      customer: customer, id: id, nowTime: nowTime, byThread: byThread,
      msgs: byCompany[id] || [],
      contact: pickContact_(id, input.contacts || [], byCompany[id] || []),
      quotes: (input.quotes || []).filter(q => q.company_id === id),
      opportunities: (input.opportunities || []).filter(o => o.company_id === id),
      orders: (input.orders || []).filter(o => o.company_id === id && o.status === ORDER_STATUS.CONFIRMED)
    };
    const skip = skipReason_(ctx, msgs);
    if (skip) { skipped.push({company_id: id, reason: skip}); return; }
    const items = openQuoteItems_(ctx).concat(unansweredRequestItems_(ctx));
    if (!items.length) { skipped.push({company_id: id, reason: 'Nothing open: no unanswered quote or request'}); return; }
    items.sort((a, b) => b.score - a.score);
    candidates.push(toTask_(ctx, items, signature));
  });

  candidates.sort((a, b) => b._score - a._score || a.company_id.localeCompare(b.company_id));
  const max = opts.maxTasks || FOLLOW_UP.MAX_TASKS;
  candidates.slice(max).forEach((t, i) => {
    skipped.push({company_id: t.company_id, reason: 'Ranked ' + (max + i + 1) + ' (score ' + t._score + '): ' + t.reason});
  });
  return {tasks: candidates.slice(0, max), skipped: skipped};
}

/** Why this customer gets no follow-up, or '' if it is eligible. */
function skipReason_(ctx, allMsgs) {
  const c = ctx.contact;
  if (!c || !normalizeEmail_(c.email)) return 'Unclear identity: no contact email on file';
  const email = normalizeEmail_(c.email);
  if (isTrue_(c.marketing_opt_out)) return 'Marketing opt-out (' + email + ')';
  const optOut = allMsgs.find(m => m.category === CATEGORY.OPT_OUT &&
    (m.company_id === ctx.id || normalizeEmail_(m.from_email) === email));
  if (optOut) return 'Marketing opt-out email ' + optOut.message_id;
  if (!ctx.msgs.length) return 'No email history';

  const last = ctx.msgs[ctx.msgs.length - 1];
  const sinceLast = daysBetween_(last.time, ctx.nowTime);
  if (sinceLast < FOLLOW_UP.ACTIVE_DAYS) {
    return 'Active conversation: ' + last.message_id + ' (' + last.direction + ') ' + sinceLast + ' day(s) ago';
  }
  const lastIn = lastWhere_(ctx.msgs, m => isInbound_(m));
  if (lastIn && RULES.onHold.test(String(lastIn.body || '')) &&
      daysBetween_(lastIn.time, ctx.nowTime) < FOLLOW_UP.HOLD_DAYS) {
    return 'Customer asked us to check back later (' + lastIn.message_id + ')';
  }
  return '';
}

/**
 * Open customer quotes: the live (not superseded, not accepted) version per opportunity,
 * with the customer's reply status taken from clean messages in its thread.
 */
function openQuoteItems_(ctx) {
  const won = new Set(ctx.orders.map(o => o.quote_id).filter(Boolean));
  const stageOf = {};
  ctx.opportunities.forEach(o => { stageOf[o.opportunity_id] = o.stage; });
  const live = ctx.quotes.filter(q => q.status === QUOTE_STATUS.SENT && !won.has(q.quote_id) &&
    stageOf[q.opportunity_id] !== STAGE.WON);
  return live.map(q => {
    const sent = toTime_(q.sent_at);
    const sourceMsg = ctx.msgs.find(m => m.message_id === String(q.source_message_id));
    const thread = sourceMsg ? (ctx.byThread[sourceMsg.thread_id] || []) : [];
    const reply = lastWhere_(thread, m => m.time > sent && isInbound_(m) && isClean_(m));
    const evidence = [String(q.source_message_id)].concat(reply ? [reply.message_id] : []);
    const quote = {id: q.quote_id, product: q.product, quantity: q.quantity, total: q.quoted_total,
      sent: sent, thread: sourceMsg ? sourceMsg.thread_id : ''};
    const value = Math.min((Number(q.quoted_total) || 0) / 1000, 10);
    if (reply) {
      const waited = daysBetween_(reply.time, ctx.nowTime);
      return {kind: FOLLOW_UP.KIND.APPROVAL, quote: quote, reply: reply, thread: quote.thread, evidence: evidence,
        due: reply.time + FOLLOW_UP.APPROVAL_WAIT_DAYS * DAY_MS, score: 60 + Math.min(waited, 30) + value,
        reason: q.quote_id + ' (' + money_(q.quoted_total) + ') sent ' + monthDay_(sent) + '; customer replied ' +
          monthDay_(reply.time) + ' without approving ("' + approvalHold_(reply.body) + '"), nothing since'};
    }
    const waited = daysBetween_(sent, ctx.nowTime);
    return {kind: FOLLOW_UP.KIND.QUOTE, quote: quote, thread: quote.thread, evidence: evidence,
      due: sent + FOLLOW_UP.QUOTE_WAIT_DAYS * DAY_MS, score: 50 + Math.min(waited, 30) + value,
      reason: q.quote_id + ' (' + money_(q.quoted_total) + ') sent ' + monthDay_(sent) + ', no reply in ' + waited + ' days'};
  });
}

/** Customer requests (new inquiry / quote request) with no later reply from us in the same thread. */
function unansweredRequestItems_(ctx) {
  const quotedThreads = new Set(ctx.quotes.map(q => {
    const m = ctx.msgs.find(x => x.message_id === String(q.source_message_id));
    return m ? m.thread_id : '';
  }));
  const requests = ctx.msgs.filter(m => isInbound_(m) && isClean_(m) && !quotedThreads.has(m.thread_id) &&
    (m.category === CATEGORY.NEW_INQUIRY || m.category === CATEGORY.QUOTE_REQUEST));
  return requests.filter(m => !(ctx.byThread[m.thread_id] || []).some(x => x.time > m.time && !isInbound_(x)))
    .map(m => {
      const p = parseCommercial_(m.body);
      const specific = p.quantity !== null && !!p.product;
      const waited = daysBetween_(m.time, ctx.nowTime);
      const what = specific ? fmtQty_(p.quantity) + ' ' + p.product : '"' + m.subject + '"';
      return {kind: FOLLOW_UP.KIND.REQUEST, request: m, parsed: specific ? p : null, thread: m.thread_id,
        evidence: [m.message_id], due: m.time + FOLLOW_UP.REQUEST_WAIT_DAYS * DAY_MS,
        score: 40 + (specific ? 10 : 0) + Math.min(waited, 30),
        reason: 'Request for ' + what + ' on ' + monthDay_(m.time) + ' has no reply from us (' + waited + ' days)'};
    });
}

/** Builds the Follow Ups row from the customer's highest-scoring item. */
function toTask_(ctx, items, signature) {
  const top = items[0];
  const history = purchaseHistory_(ctx);
  const score = Math.round(top.score + (history ? 10 : 0));
  const others = items.slice(1).map(i => i.reason);
  const reason = [top.reason].concat(history ? [history.reason] : [])
    .concat(others.length ? ['Also open: ' + others.join('; ')] : []).join('. ');
  const draft = draftFor_(top, ctx, history, signature);
  const evidence = [];
  items.forEach(i => i.evidence.forEach(id => { if (evidence.indexOf(id) < 0) evidence.push(id); }));
  return {
    task_id: 'FU-' + ctx.id + '-' + top.thread,
    company_id: ctx.id,
    contact_email: normalizeEmail_(ctx.contact.email),
    due_date: startOfDay_(top.due),
    reason: reason,
    priority: score >= 75 ? 'High' : score >= 60 ? 'Medium' : 'Low',
    status: FOLLOW_UP.STATUS.OPEN,
    source_thread_id: top.thread,
    draft_subject: draft.subject,
    draft_body: draft.body,
    approved: false,
    evidence_message_ids: evidence.join(', '),
    _score: score
  };
}

/** Prior purchases: confirmed orders in the CRM, else historical orders on the Customers row. */
function purchaseHistory_(ctx) {
  const latest = ctx.orders.slice().sort((a, b) => toTime_(a.order_date) - toTime_(b.order_date)).pop();
  if (latest) {
    return {order: latest, reason: 'Existing customer: ' + latest.po_number + ' confirmed ' + monthDay_(toTime_(latest.order_date))};
  }
  const count = Number(ctx.customer.order_count) || 0;
  if (!count) return null;
  const last = ctx.customer.last_order_at ? toTime_(ctx.customer.last_order_at) : NaN;
  return {order: null, reason: 'Past customer: ' + count + ' earlier order' + (count > 1 ? 's' : '') +
    (isNaN(last) ? '' : ', last ' + monthDay_(last, true))};
}

/** One short, specific email asking for a single next step. Never mentions supplier cost. */
function draftFor_(item, ctx, history, signature) {
  const first = firstName_(ctx.contact.full_name);
  const hello = 'Hi ' + first + ',';
  const thanks = !history ? '' : history.order
    ? 'Thanks again for ' + history.order.po_number + (history.order.product ? ' (' + history.order.product + ')' : '') +
      '; that order is in our queue.'
    : 'Thanks again for ordering with us before.';
  const sign = 'Best regards,\n' + signature;
  let subject, lines;

  if (item.kind === FOLLOW_UP.KIND.APPROVAL) {
    const q = item.quote;
    subject = 'Checking in on quote ' + q.id + describe_(q, ' for ');
    lines = ['When we last spoke on ' + monthDay_(item.reply.time) + ', you were getting internal approval for quote ' +
      q.id + describe_(q, ' for ') + '. Has your team had a chance to review it?',
      'If it would help, I can send a virtual proof or a sample, or adjust the quantity. Nothing will go into ' +
      'production until you confirm in writing.'];
  } else if (item.kind === FOLLOW_UP.KIND.QUOTE) {
    const q = item.quote;
    subject = 'Following up on quote ' + q.id + describe_(q, ' for ');
    lines = ['I wanted to follow up on quote ' + q.id + describe_(q, ' for ') + ' (' + money_(q.total) +
      ' total), which I sent on ' + monthDay_(q.sent) + '.',
      'Would you like to move ahead, or is there anything you would like changed first, such as the quantity, ' +
      'colors or delivery date? I am happy to re-confirm pricing and timing before you decide.'];
  } else {
    const m = item.request, p = item.parsed;
    subject = /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject;
    lines = p
      ? ['Thank you for your request on ' + monthDay_(m.time) + ' for ' + fmtQty_(p.quantity) + ' ' + p.product +
        ', and I am sorry for the slow reply.',
        'So I can send accurate pricing and production timing, could you confirm the item color, imprint colors ' +
        'and location, the delivery ZIP code and your in-hand date? A logo file would help too, if you have one ready.']
      : ['Thank you for your message on ' + monthDay_(m.time) + ', and I am sorry for the slow reply.',
        'I would be glad to help. Could you share the product, quantity and in-hand date you have in mind? ' +
        'I can then send color options and arrange a sample.'];
  }
  if (thanks) lines.push(thanks);
  return {subject: subject, body: [hello].concat(lines).concat([sign]).join('\n\n')};
}

/** The contact the company's messages refer to most, else the first Contacts row for the company. */
function pickContact_(companyId, contacts, msgs) {
  const mine = contacts.filter(c => c.company_id === companyId && normalizeEmail_(c.email));
  if (!mine.length) return null;
  const counts = {};
  msgs.forEach(m => { if (m.contact_id) counts[m.contact_id] = (counts[m.contact_id] || 0) + 1; });
  return mine.slice().sort((a, b) => (counts[b.contact_id] || 0) - (counts[a.contact_id] || 0))[0];
}

/** The phrase that kept a reply from being an approval, e.g. "check with the team". */
function approvalHold_(body) {
  return firstMatch_(RULES.stopPhrase, body) || firstMatch_(RULES.softApproval, body) || 'no decision';
}

function describe_(q, joiner) {
  const parts = [q.quantity ? fmtQty_(q.quantity) : '', q.product || ''].filter(Boolean).join(' ');
  return parts ? joiner + parts : '';
}

function isInbound_(m) {
  return String(m.direction || '').toUpperCase() === 'IN';
}

function isClean_(m) {
  return String(m.reason || m.classification_reason || '').indexOf(FOLLOW_UP.MIXED_THREAD) < 0;
}

function lastWhere_(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return list[i];
  return null;
}

function groupBy_(list, keyFn) {
  const out = {};
  list.forEach(x => { const k = keyFn(x); if (k) (out[k] = out[k] || []).push(x); });
  return out;
}

/** Whole calendar days from a to b (both epoch ms), never negative. */
function daysBetween_(a, b) {
  return Math.max(0, Math.floor((startOfDay_(b).getTime() - startOfDay_(a).getTime()) / DAY_MS + 0.5));
}

/** Local midnight (the script time zone in Apps Script). */
function startOfDay_(time) {
  const d = new Date(time);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function monthDay_(time, withYear) {
  const d = new Date(time);
  return MONTHS[d.getMonth()].replace(/^./, c => c.toUpperCase()) + ' ' + d.getDate() +
    (withYear ? ', ' + d.getFullYear() : '');
}

function firstName_(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first || 'there';
}

function fmtQty_(n) {
  return Number(n).toLocaleString('en-US');
}

function money_(n) {
  const v = Number(n);
  return isNaN(v) || n === '' || n === null ? 'amount not stated'
    : '$' + v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
