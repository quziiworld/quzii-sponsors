/** qz_order.gs — CLEAN ORDER HANDLERS (Script-Properties driven)
 *
 * Script Properties required:
 *   SPREADSHEET_ID   = <sheet id>
 *   SHEET_REQUESTS   = Sponsorship Requests
 *   THANKYOU_URL     = https://quzii.com/thank-you-for-your-sponsorship.html
 *   CANCEL_URL       = https://quzii.com/canceled.html
 *
 * PayPal helpers come from qz_paypal.gs
 * PayFast helpers come from qz_payfast.gs
 */

/* ============== UTILITIES ============== */

function qz_prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d || ''; }

function qz_json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function qz_sheet_() {
  var id = qz_prop_('SPREADSHEET_ID');
  var name = qz_prop_('SHEET_REQUESTS', 'Sponsorship Requests');
  return SpreadsheetApp.openById(id).getSheetByName(name) || SpreadsheetApp.openById(id).insertSheet(name);
}

function qz_newOrderId() {
  return 'QZ-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}

function qz_round2(n) { return Math.round(Number(n) * 100) / 100; }

/** Ensure Requests sheet headers exist; add any missing columns we rely on */
function qz_ensureHeaders_(sh) {
  var headers = [
    'Timestamp', 'OrderID', 'Package', 'Plan', 'Currency',
    'BookID', 'Name', 'Email', 'Referral', 'TeamMember',
    'Status', 'Provider', 'Total', 'TxnID'
  ];
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    return;
  }
  var row1 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var have = {};
  for (var c = 0; c < row1.length; c++) have[row1[c]] = c + 1;
  var need = headers.filter(function (h) { return !have[h]; });
  if (need.length) {
    for (var i = 0; i < need.length; i++)
      sh.getRange(1, sh.getLastColumn() + 1, 1, 1).setValue(need[i]);
  }
}

/** Get column index by header name (1-based); returns 0 if not found */
function qz_col_(sh, name) {
  var row1 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  for (var i = 0; i < row1.length; i++) if (String(row1[i]).trim() === name) return i + 1;
  return 0;
}

/** Simple price table; tweak as needed */
function qz_unitPrice_(pkg, ccy) {
  var tbl = {
    USD: { single: 350, series: 1750, legacy: 2750 },
    GBP: { single: 275, series: 1390, legacy: 2190 },
    ZAR: { single: 6400, series: 31000, legacy: 49000 }
  };
  var p = (tbl[ccy] || tbl.USD);
  return p[String(pkg || 'single').toLowerCase()] || p.single;
}

/* ============== CREATE ORDER ============== */
/**
 * Expected payload:
 * {
 *   type:'createOrder',
 *   package:'single'|'series'|'legacy',
 *   plan:'onetime'|'3mo'|'6mo',
 *   currency:'USD'|'GBP'|'ZAR',
 *   provider:'paypal'|'payfast'|'eft',   // optional; defaults by currency
 *   books:[bookIds], name:'', email:'', referral:'', teamMember:''
 * }
 */
function qz_handleCreateOrder_(payload) {
  // Read inputs
  var pkg      = String(payload.package || 'single').toLowerCase();
  var plan     = String(payload.plan     || 'onetime').toLowerCase();
  var currency = String(payload.currency || 'USD').toUpperCase();
  var name     = String(payload.name     || '').trim();        // Sponsor Name
  var email    = String(payload.email    || '').trim();        // Sponsor Email

  // Books chosen (legacy = special)
  var books = (pkg === 'legacy') ? ['LEGACY'] : (Array.isArray(payload.books) ? payload.books : []);
  if (!books.length) return qz_json({ ok:false, error:'No books selected' });

  // Determine optional fields supplied from the client.  These values may be
  // undefined but will be written to our order log if provided.
  var referral    = String(payload.referral    || '').trim();
  var teamMember  = String(payload.teamMember  || '').trim();
  var planRaw     = String(payload.plan        || '').trim();
  var provider    = String(payload.provider    || (currency === 'ZAR' ? 'payfast' : 'paypal')).toLowerCase();

  // Standardise plan values (e.g. '3month'→'3month', '3mo'→'3month')
  var plan = planRaw.replace(/[^0-9a-z]/gi, '').toLowerCase();
  if (plan === '' || plan === 'onetime') plan = 'onetime';

  // Open the tracker and target ONLY "Sponsorship Requests" (Form sheet)
  var ss        = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  var sheetName = PropertiesService.getScriptProperties().getProperty('SHEET_REQUESTS') || 'Sponsorship Requests';
  var sh        = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);

  // Ensure the Form header exists (only if the sheet is truly empty)
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'Timestamp','Email Address','Sponsor Name','Sponsor Email',
      'Category','Tier','Book Title','Status','Date Confirmed','Sponsorship Type','Notes'
    ]);
  }

  // Build BookID -> Title map from Public_Catalogue (read-only)
  var titleByBook = (function () {
    var out = {};
    var cat = ss.getSheetByName('Public_Catalogue');
    if (!cat) return out;
    var vals = cat.getDataRange().getValues();
    if (!vals || vals.length < 2) return out;
    var H = vals.shift();
    var iId = H.indexOf('BookID') + 1;
    var iTi = H.indexOf('Book Title') + 1;
    if (!(iId && iTi)) return out;
    for (var r = 0; r < vals.length; r++) {
      var id = String(vals[r][iId - 1] || '').trim();
      var ti = String(vals[r][iTi - 1] || '').trim();
      if (id) out[id] = ti;
    }
    return out;
  })();

  // Map the existing Form columns by name (so order doesn’t matter)
  var header = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(function(h){return String(h || '').trim();});
  function idx(label){ var i = header.indexOf(label); return (i >= 0) ? (i+1) : 0; }

  var iTs      = idx('Timestamp');
  var iEmailA  = idx('Email Address');     // we leave this blank for web app
  var iSpName  = idx('Sponsor Name');
  var iSpEmail = idx('Sponsor Email');
  var iCat     = idx('Category');          // leave blank
  var iTier    = idx('Tier');              // leave blank
  var iTitle   = idx('Book Title');
  var iStatus  = idx('Status');
  var iDate    = idx('Date Confirmed');    // leave blank
  var iType    = idx('Sponsorship Type');  // leave blank
  var iNotes   = idx('Notes');             // leave blank

  var orderId = qz_newOrderId();
  var now     = new Date();

  /*
   * === Write to internal Sponsorship Requests sheet ===
   * We log each selected book along with the order metadata into a dedicated
   * tracking sheet defined by qz_sheet_().  This sheet has headers as defined
   * in qz_ensureHeaders_().  New columns (Referral, TeamMember, Provider,
   * Plan, Currency, Total) are handled automatically when absent.
   */
  try {
    var ordSheet = qz_sheet_();
    qz_ensureHeaders_(ordSheet);
    // Column indices after ensuring headers
    var Hrow   = ordSheet.getRange(1,1,1,ordSheet.getLastColumn()).getValues()[0];
    var colMap = {};
    for (var ci=0; ci<Hrow.length; ci++) colMap[String(Hrow[ci]).trim()] = ci + 1;
    // Pre-calculate total price per book (per-book or series/legacy) and overall total
    var qty   = books.length;
    var unit  = qz_unitPrice_(pkg, currency);
    var total = qz_round2(qty * unit);
    books.forEach(function(bid){
      var row = new Array(Hrow.length);
      if (colMap['Timestamp'])   row[colMap['Timestamp']-1]   = now;
      if (colMap['OrderID'])     row[colMap['OrderID']-1]     = orderId;
      if (colMap['Package'])     row[colMap['Package']-1]     = pkg;
      if (colMap['Plan'])        row[colMap['Plan']-1]        = plan;
      if (colMap['Currency'])    row[colMap['Currency']-1]    = currency;
      if (colMap['BookID'])      row[colMap['BookID']-1]      = bid;
      if (colMap['Name'])        row[colMap['Name']-1]        = name;
      if (colMap['Email'])       row[colMap['Email']-1]       = email;
      if (colMap['Referral'])    row[colMap['Referral']-1]    = referral;
      if (colMap['TeamMember'])  row[colMap['TeamMember']-1]  = teamMember;
      if (colMap['Status'])      row[colMap['Status']-1]      = 'Pending';
      if (colMap['Provider'])    row[colMap['Provider']-1]    = provider;
      if (colMap['Total'])       row[colMap['Total']-1]       = total;
      // TxnID left blank until payment success
      ordSheet.appendRow(row);
    });
  } catch (e) {
    // Logging to internal sheet is best-effort; don't block order creation
    console.error('Failed writing to order sheet', e);
  }

  // Append ONE row per book into the Form sheet
  books.forEach(function(bid){
    var title = (bid === 'LEGACY') ? 'LEGACY' : (titleByBook[bid] || '');

    // Build a row matching the sheet's column count
    var row = new Array(header.length);
    if (iTs)      row[iTs-1]      = now;
    if (iSpName)  row[iSpName-1]  = name;
    if (iSpEmail) row[iSpEmail-1] = email;
    if (iTitle)   row[iTitle-1]   = title;
    if (iStatus)  row[iStatus-1]  = 'Pending';
    // Attempt to populate referral/teamMember if headers exist in the form sheet
    var iRef = idx('Referral');
    var iTeam = idx('TeamMember');
    if (iRef)  row[iRef-1]  = referral;
    if (iTeam) row[iTeam-1] = teamMember;
    // Everything else stays undefined/blank so your formulas and manual columns are untouched
    sh.appendRow(row);
  });

  // Work out quantity and total for the payment redirect
  // Work out quantity and total for the payment redirect.  Note: legacy uses qty=1
  var qty   = books.length;
  var unit  = qz_unitPrice_(pkg, currency);
  var total = qz_round2(qty * unit);

  // Decide which gateway to use based on provider passed in (already lower‑cased)

  if (provider === 'paypal') {
    var approveUrl = qz_createPaypalOrder_(orderId, total, currency, qty, plan); // from qz_paypal.gs
    return qz_json({ ok: true, provider: 'paypal', orderId: orderId, redirectUrl: approveUrl });
  }

  if (provider === 'payfast') {
    if (currency !== 'ZAR') currency = 'ZAR'; // PayFast is ZAR only
    var pfUrl = qz_pfBuildRedirect_({
      orderId: orderId,
      total: total,
      qty: qty,
      email: email || ''
    }); // from qz_payfast.gs
    return qz_json({ ok: true, provider: 'payfast', orderId: orderId, redirectUrl: pfUrl });
  }

  if (provider === 'eft') {
    return qz_json({
      ok: true,
      provider: 'eft',
      orderId: orderId,
      message: 'Please pay via EFT using the reference below.',
      bank: {
        accountName: 'QuziiWorld',
        bankName: 'Your Bank',
        accountNumber: '123456789',
        branchCode: '250655',
        swift: 'ABSAZAJJ',
        reference: orderId
      },
      amount: total.toFixed(2),
      currency: currency
    });
  }

  // Fallback JSON
  return qz_json({ ok: true, orderId: orderId });
}



/* ============== FINALIZE (manual/admin) ============== */

function qz_finalizeOrder(orderId, meta) {
  if (!orderId) return qz_json({ ok:false, error:'Missing orderId' });

  var ss  = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  var sheetName = PropertiesService.getScriptProperties().getProperty('SHEET_REQUESTS') || 'Sponsorship Requests';
  var sr  = ss.getSheetByName(sheetName);
  if (!sr) return qz_json({ ok:false, error:'Missing "Sponsorship Requests" sheet' });

  // Optional: Look up BookID → Title for matching
  var cat = ss.getSheetByName('Public_Catalogue');
  var titleByBook = {};
  if (cat) {
    var cAll = cat.getDataRange().getValues();
    var CH   = cAll.shift();
    var cBook = CH.indexOf('BookID')+1;
    var cTitle = CH.indexOf('Book Title')+1;
    if (cBook > 0 && cTitle > 0) {
      for (var i=0; i<cAll.length; i++) {
        titleByBook[String(cAll[i][cBook-1]).trim()] = String(cAll[i][cTitle-1] || '').trim();
      }
    }
  }

  // meta is expected to contain { email:'', books:[bookIds] }
  var email = meta && meta.email ? String(meta.email).trim().toLowerCase() : '';
  var paidBooks = Array.isArray(meta && meta.books) ? meta.books.slice() : [];

  var rows = sr.getDataRange().getValues();
  var H = rows.shift();
  var cBookTitle = H.indexOf('Book Title')+1;
  var cEmail     = H.indexOf('Sponsor Email')+1;
  var cStatus    = H.indexOf('Status')+1;
  var cDate      = H.indexOf('Date Confirmed')+1;
  if (!(cBookTitle && cEmail && cStatus && cDate)) {
    return qz_json({ ok:false, error:'Missing expected headers in "Sponsorship Requests"' });
  }

  var now = new Date();
  paidBooks.forEach(function(bid){
    var title = (titleByBook[bid] || '').trim();
    if (!title || !email) return;
    for (var r=0; r<rows.length; r++) {
      var rowTitle  = String(rows[r][cBookTitle-1] || '').trim();
      var rowEmail  = String(rows[r][cEmail-1] || '').trim().toLowerCase();
      if (rowTitle === title && rowEmail === email) {
        var statusVal = String(rows[r][cStatus-1] || '').toLowerCase();
        if (statusVal !== 'paid') {
          sr.getRange(r+2, cStatus).setValue('Paid');
          sr.getRange(r+2, cDate).setValue(now);
        }
        break;
      }
    }
  });

  return qz_json({ ok:true, orderId: orderId, books: paidBooks });
}
function getTeamMembers_() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  var sh = ss.getSheetByName('VA Payout Summary');
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last-1, 2).getValues(); // [ [Name, Email], ... ]
  return vals.filter(function(r){ return r[0] && r[1]; });
}


/* helper to avoid issues if paidBooks is not an array */
function payedBooksLength(arr) { return (Array.isArray(arr) ? arr.length : 0); }
