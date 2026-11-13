/**
 * Attachment interpretation - pure logic, no Google services.
 *
 * AttachmentsRunner.js turns each file into plain content (PDF/DOCX text via a
 * temporary Google Doc, spreadsheet rows via a temporary Google Sheet, image
 * size from the file header). This file turns that content into typed fields:
 * it finds label/value pairs ("Unit cost" -> "$5.40"), maps them to fields per
 * document type, and lists required fields that are missing instead of
 * guessing them. Images are never treated as print-ready artwork.
 */

const DOC_TYPE = Object.freeze({
  PO: 'Purchase Order',
  SUPPLIER: 'Supplier Quote',
  REQUEST: 'Customer Request',
  ARTWORK: 'Artwork / Image',
  BILLING: 'Invoice / Billing',
  OTHER: 'Other',
  UNSUPPORTED: 'Unsupported'
});

/** Per document type: field -> label synonyms (as printed on the document), and required fields. */
const DOC_FIELDS = Object.freeze({
  [DOC_TYPE.PO]: {
    required: ['company', 'po_number', 'product', 'quantity', 'unit_price', 'line_total', 'delivery_date'],
    labels: {
      company: ['Company', 'Customer', 'Bill to'], po_number: ['PO Number', 'PO #', 'PO No', 'Purchase Order Number'],
      product: ['Product', 'Item', 'Description'], quantity: ['Quantity', 'Qty'],
      unit_price: ['Unit Price (USD)', 'Unit Price'], line_total: ['Line Total (USD)', 'Line Total', 'Total'],
      delivery_date: ['Delivery Needed', 'Delivery Date', 'In-hand date', 'Need By'],
      ship_to: ['Shipping destination', 'Ship to'], approval: ['Approval']
    }
  },
  [DOC_TYPE.SUPPLIER]: {
    required: ['supplier', 'product', 'quantity', 'unit_cost', 'setup_cost', 'freight_cost', 'lead_time', 'moq'],
    labels: {
      supplier: ['Supplier', 'Vendor'], product: ['Product', 'Item'], quantity: ['Quantity', 'Qty'],
      unit_cost: ['Net unit cost', 'Unit cost'], setup_cost: ['One-time setup', 'Setup'],
      freight_cost: ['Freight to Denver', 'Estimated freight', 'Freight', 'Shipping'],
      lead_time: ['Production lead time', 'Lead time', 'Production'], moq: ['Minimum order', 'MOQ'],
      price_validity: ['Price validity'], alternative_pricing: ['Alternative quantity'], notes: ['Notes']
    }
  },
  [DOC_TYPE.REQUEST]: {
    required: ['customer', 'product', 'quantity', 'product_color', 'imprint_color', 'imprint_location', 'ship_to', 'in_hand_date'],
    labels: {
      customer: ['Customer', 'Company'], product: ['Product'], quantity: ['Quantity', 'Qty'],
      product_color: ['Product Color', 'Item Color', 'Color'], imprint_color: ['Imprint Color', 'Ink Color'],
      imprint_location: ['Imprint Location'], imprint_method: ['Imprint Method', 'Imprint'], logo: ['Logo'],
      size: ['Size'], in_hand_date: ['In-Hand Date', 'In-hand date', 'Need By', 'Delivery Date'],
      ship_to: ['Ship To', 'Shipping destination', 'Destination'], notes: ['Notes']
    }
  },
  [DOC_TYPE.BILLING]: {
    required: [],
    labels: {
      account: ['Account', 'Company', 'Customer'], product: ['Product'], quoted_quantity: ['Quoted quantity'],
      po_quantity: ['Purchase order quantity', 'PO quantity'], setup_charge: ['Previous setup charge', 'Setup charge'],
      customer_question: ['Customer question'], required_decision: ['Required decision']
    }
  }
});

const NUMERIC_FIELDS = ['quantity', 'unit_price', 'line_total', 'unit_cost', 'setup_cost', 'freight_cost', 'moq',
  'quoted_quantity', 'po_quantity', 'setup_charge'];
const DATE_FIELDS = ['delivery_date', 'in_hand_date'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];
const VECTOR_ART = /\.(ai|eps|svg|pdf)$/i;

/**
 * Interprets one attachment's extracted content.
 * @param {Object} doc {filename, mimeType, text, tables: string[][][], image: {width, height, bytes}}.
 * @return {Object} {document_type, fields, missing, needs_review, review_reason, strategy}.
 */
function interpretAttachment_(doc) {
  const type = detectDocType_(doc.filename, doc.mimeType, doc.text);
  if (type === DOC_TYPE.ARTWORK) return interpretArtwork_(doc);
  if (type === DOC_TYPE.UNSUPPORTED) {
    return result_(type, {}, [], 'Unsupported file type ' + (doc.mimeType || '?') + '; open and review manually', 'none');
  }
  const spec = DOC_FIELDS[type] || {required: [], labels: {}};
  const labels = labelList_(spec.labels);
  let strategy = 'tables', pairs = pairsFromTables_(doc.tables, labels);
  if (pairs.length < 3) { strategy = 'lines'; pairs = pairs.concat(pairsFromLines_(doc.text, labels)); }
  if (pairs.length < 3) { strategy = 'inline'; pairs = pairs.concat(pairsFromInline_(doc.text, labels)); }

  const fields = {};
  pairs.forEach(p => { if (!(p.field in fields) && p.value !== '') fields[p.field] = normalizeField_(p.field, p.value); });
  if (fields.ship_to) {
    const zip = /\b\d{5}(?:-\d{4})?\b/.exec(String(fields.ship_to));
    if (zip) fields.ship_to_zip = zip[0];
  }
  const missing = spec.required.filter(f => fields[f] === undefined || fields[f] === null || fields[f] === '');
  const reasons = [];
  if (missing.length) reasons.push('Missing: ' + missing.join(', '));
  if (!Object.keys(fields).length) reasons.push('No labeled fields found; review the original file');
  if (type === DOC_TYPE.BILLING) {
    reasons.push('Billing question; never counts as an order' +
      (fields.quoted_quantity && fields.po_quantity && fields.quoted_quantity !== fields.po_quantity
        ? '. Quoted quantity ' + fields.quoted_quantity + ' differs from PO quantity ' + fields.po_quantity : ''));
  }
  if (type === DOC_TYPE.OTHER) reasons.push('Unrecognized document type');
  return result_(type, fields, missing, reasons.join('; '), strategy);
}

/** Decides the document type from the file name and the document's title line only. */
function detectDocType_(filename, mimeType, text) {
  if (/^image\//i.test(mimeType || '')) return DOC_TYPE.ARTWORK;
  const supported = /pdf|spreadsheet|excel|csv|word|document|text\/plain/i;
  if (mimeType && !supported.test(mimeType)) return DOC_TYPE.UNSUPPORTED;
  const title = String(text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  const head = (String(filename || '').replace(/[_-]+/g, ' ') + '\n' + title).toLowerCase();
  if (/supplier (pricing|quote)|vendor quote/.test(head)) return DOC_TYPE.SUPPLIER;
  if (/invoice/.test(head)) return DOC_TYPE.BILLING;
  if (/purchase order|\bpo \d/.test(head)) return DOC_TYPE.PO;
  if (/request|brief|spec/.test(head)) return DOC_TYPE.REQUEST;
  return DOC_TYPE.OTHER;
}

function interpretArtwork_(doc) {
  const img = doc.image || {};
  const fields = {file_bytes: img.bytes || null, width_px: img.width || null, height_px: img.height || null};
  const vector = VECTOR_ART.test(doc.filename || '') || /svg|postscript|illustrator/i.test(doc.mimeType || '');
  const size = img.width ? ' (' + img.width + 'x' + img.height + ' px)' : '';
  const reason = vector
    ? 'Vector artwork received; still needs a virtual proof approved by the customer'
    : 'Logo image' + size + ' is a reference only, not manufacturer-ready artwork. Request a vector file ' +
      '(AI/EPS/SVG/PDF) and get proof approval before production';
  return result_(DOC_TYPE.ARTWORK, fields, [], reason, 'image header');
}

function result_(type, fields, missing, reason, strategy) {
  return {document_type: type, fields: fields, missing: missing, needs_review: Boolean(reason),
    review_reason: reason, strategy: strategy};
}

/** [{label, field}] sorted longest label first, so "Unit Price (USD)" wins over "Unit Price". */
function labelList_(labelsByField) {
  const list = [];
  Object.keys(labelsByField).forEach(field => labelsByField[field].forEach(label => list.push({label: label, field: field})));
  return list.sort((a, b) => b.label.length - a.label.length);
}

function normLabel_(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim();
}

/** Rows with a label in the first cell and a value in the second (Doc tables, spreadsheet rows). */
function pairsFromTables_(tables, labels) {
  const pairs = [];
  (tables || []).forEach(table => (table || []).forEach(row => {
    const cells = (row || []).map(c => (c === null || c === undefined ? '' : c));
    if (cells.length < 2) return;
    const hit = labels.find(l => normLabel_(l.label) === normLabel_(cells[0]));
    if (hit && String(cells[1]).trim() !== '') pairs.push({field: hit.field, value: cells[1]});
  }));
  return pairs;
}

/**
 * Text where each label starts a line: either "Label  value" on one line or the
 * value on the next line. The first line is the document title and is skipped.
 */
function pairsFromLines_(text, labels) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(1);
  const exactLabel = line => labels.some(l => normLabel_(l.label) === normLabel_(line));
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit = labels.find(l => startsWithLabel_(line, l.label));
    if (!hit) continue;
    const rest = line.slice(hit.label.length).replace(/^[\s:\t-]+/, '').trim();
    if (rest) {
      pairs.push({field: hit.field, value: rest});
    } else if (i + 1 < lines.length && !exactLabel(lines[i + 1])) {
      pairs.push({field: hit.field, value: lines[i + 1]});
      i++;
    }
  }
  return pairs;
}

/** Last resort for text flattened onto one line: split on known labels wherever they occur. */
function pairsFromInline_(text, labels) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const re = new RegExp('(?:^|[\\s|/])(' + labels.map(l => escapeRegExp_(l.label)).join('|') + ')(?=[\\s:])', 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(flat))) hits.push({label: m[1], start: m.index + m[0].length - m[1].length, end: m.index + m[0].length});
  return hits.map((h, i) => {
    const value = flat.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : flat.length).replace(/^[\s:]+|[\s|/]+$/g, '');
    const label = labels.find(l => normLabel_(l.label) === normLabel_(h.label));
    return {field: label.field, value: value};
  });
}

function startsWithLabel_(line, label) {
  const l = String(line).toLowerCase(), lab = label.toLowerCase();
  return l.indexOf(lab) === 0 && (l.length === lab.length || /[\s:\t]/.test(l.charAt(lab.length)));
}

function normalizeField_(field, value) {
  if (NUMERIC_FIELDS.indexOf(field) >= 0) {
    const n = parseNumber_(value);
    return n === null ? String(value).trim() : n;
  }
  if (DATE_FIELDS.indexOf(field) >= 0) return parseDateValue_(value);
  if (field === 'po_number') return String(value).trim().toUpperCase();
  return typeof value === 'string' ? value.trim() : value;
}

function parseNumber_(value) {
  if (typeof value === 'number') return value;
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(value || ''));
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

/** Date object, "2026-12-08", "December 8, 2026" or "12/8/2026" -> "2026-12-08"; otherwise the text as given. */
function parseDateValue_(value) {
  if (value && typeof value.getFullYear === 'function') return isoDate_(value.getFullYear(), value.getMonth() + 1, value.getDate());
  const s = String(value || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return isoDate_(+m[1], +m[2], +m[3]);
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s);
  if (m) {
    const month = MONTHS.findIndex(name => name.indexOf(m[1].toLowerCase().slice(0, 3)) === 0) + 1;
    if (month) return isoDate_(+m[3], month, +m[2]);
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return isoDate_(+m[3], +m[1], +m[2]);
  return s;
}

function isoDate_(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/** Width/height from a PNG header, or null. Accepts signed bytes as Apps Script returns them. */
function pngSize_(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const b = i => bytes[i] & 255;
  if (b(0) !== 137 || b(1) !== 80 || b(2) !== 78 || b(3) !== 71) return null;
  const u32 = i => ((b(i) << 24) >>> 0) + (b(i + 1) << 16) + (b(i + 2) << 8) + b(i + 3);
  return {width: u32(16), height: u32(20)};
}

function escapeRegExp_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
