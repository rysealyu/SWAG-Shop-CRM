/**
 * Extra Dashboard rows added by code (not by hand) so they exist on any fresh
 * copy of the template. Each row is found by its label in column A and its
 * formulas are rewritten on every run, so this is safe to call repeatedly.
 */

const DASHBOARD_TAB = 'Dashboard';
const DASHBOARD_FIRST_FREE_ROW = 19; // Template uses rows 1-18 for KPIs and row 21 for a note.

/**
 * Quote value counting each deal once: the template's "Customer quote value"
 * sums every quote event, so a revised quote (Q-1001 + Q-1001-R1) counts twice.
 */
const DASHBOARD_EXTRAS = [{
  label: 'Quote value (latest version only)',
  formatFrom: 14, // copy number format from "Customer quote value"
  formula: col => '=SUMIFS(' + tabColumn_('Quotes', 'quoted_total') + ',' + tabColumn_('Quotes', 'sent_at') + ',">="&' +
    col + '$5,' + tabColumn_('Quotes', 'sent_at') + ',"<"&' + col + '$6,' + tabColumn_('Quotes', 'status') +
    ',"<>' + QUOTE_STATUS.SUPERSEDED + '")'
}, {
  label: 'Last successful Gmail sync',
  numberFormat: 'yyyy-mm-dd hh:mm',
  formula: col => col !== 'B' ? '' : '=IF(COUNTIF(' + tabColumn_(SYNC_TAB, 'status') + ',"Success")=0,"never",MAXIFS(' +
    tabColumn_(SYNC_TAB, 'finished_at') + ',' + tabColumn_(SYNC_TAB, 'status') + ',"Success"))'
}, {
  label: 'Emails waiting to process (retry queue)',
  numberFormat: '0',
  formula: col => col !== 'B' ? '' : '=COUNTIFS(' + tabColumn_(EMAIL_TAB, 'message_id') + ',"<>",' +
    tabColumn_(EMAIL_TAB, 'processed_at') + ',"")'
}];

/** "'Quotes'!$J$2:$J$5000" for a named column of a tab defined in HEADER_MAP. */
function tabColumn_(tab, column) {
  const letter = columnLetter_(HEADER_MAP[tab].indexOf(column) + 1);
  return "'" + tab + "'!$" + letter + '$2:$' + letter + '$5000';
}

/** Adds or refreshes the extra Dashboard rows. */
function ensureDashboardExtras_(ss) {
  const sh = ss.getSheetByName(DASHBOARD_TAB);
  if (!sh) return;
  const labels = sh.getRange(1, 1, Math.max(sh.getLastRow(), DASHBOARD_FIRST_FREE_ROW), 1).getValues().map(r => String(r[0]));
  DASHBOARD_EXTRAS.forEach(extra => {
    let row = labels.indexOf(extra.label) + 1;
    if (!row) {
      row = DASHBOARD_FIRST_FREE_ROW;
      while (sh.getRange(row, 1, 1, 4).getValues()[0].some(v => v !== '')) row++;
      labels[row - 1] = extra.label;
    }
    sh.getRange(row, 1).setValue(extra.label);
    sh.getRange(row, 2, 1, 3).setFormulas([['B', 'C', 'D'].map(extra.formula)]);
    sh.getRange(extra.formatFrom || 14, 1, 1, 4).copyTo(sh.getRange(row, 1, 1, 4), {formatOnly: true});
    if (extra.numberFormat) sh.getRange(row, 2, 1, 3).setNumberFormat(extra.numberFormat);
  });
}

/** 1 -> A, 27 -> AA. */
function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
