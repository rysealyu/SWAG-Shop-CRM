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
  formula: col => {
    const q = name => "'Quotes'!$" + columnLetter_(HEADER_MAP['Quotes'].indexOf(name) + 1) + '$2:$' +
      columnLetter_(HEADER_MAP['Quotes'].indexOf(name) + 1) + '$5000';
    return '=SUMIFS(' + q('quoted_total') + ',' + q('sent_at') + ',">="&' + col + '$5,' +
      q('sent_at') + ',"<"&' + col + '$6,' + q('status') + ',"<>' + QUOTE_STATUS.SUPERSEDED + '")';
  }
}];

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
    sh.getRange(extra.formatFrom, 1, 1, 4).copyTo(sh.getRange(row, 1, 1, 4), {formatOnly: true});
  });
}

/** 1 -> A, 27 -> AA. */
function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
