/**
 * Demo reset: empties the CRM data tabs so the whole import can be shown live.
 * Keeps header rows, the Dashboard (its formulas recalculate to zero), Settings,
 * Sync Log (audit trail; a Reset row is added), Script Properties, triggers and
 * the Drive files. Asks for confirmation first. Nothing in Gmail is touched.
 */

/** Tabs emptied by the reset. A function, not a top-level const: other files' constants may not be loaded yet. */
function resetTabs_() {
  return [EMAIL_TAB, 'Customers', 'Contacts', SUPPLIER_TAB, 'Opportunities', 'Quotes', 'Orders',
    'Supplier Quotes', ATTACHMENT_TAB, FOLLOW_UP_TAB];
}

/** Menu action: clear all CRM data rows after a Yes/No confirmation. */
function resetDemoData() {
  const RESET_TABS = resetTabs_();
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert('Reset demo data?',
    'This deletes every row (headers kept) in: ' + RESET_TABS.join(', ') + '.\n\n' +
    'Kept: Dashboard, Settings, Sync Log, Script Properties, the daily trigger and Drive files.\n' +
    'Hand edits in these tabs (e.g. a demo contact you added) are lost.\n\n' +
    'Afterwards run: Import seed workbook > Import 100 sample emails > Classify emails > ' +
    'Process attachments > Generate follow-up drafts.',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another import or classification is running');
  const start = new Date();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cleared = RESET_TABS.map(name => {
      const sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() < 2) return name + ' 0';
      const rows = sh.getLastRow() - 1;
      // Clear values and checkboxes; deleting every non-frozen row is not allowed by Sheets.
      sh.getRange(2, 1, rows, Math.max(sh.getLastColumn(), 1)).clearContent().clearDataValidations();
      return name + ' ' + rows;
    });
    const detail = 'Demo reset. Rows cleared: ' + cleared.join(', ') + '.';
    writeLog_(start, 'Reset', 0, 0, 0, detail);
    ss.toast('CRM data cleared. Start with "Import seed workbook".', 'SWAG CRM', 8);
  } catch (e) {
    writeLog_(start, 'Failed', 0, 0, 1, 'Reset: ' + String(e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}
