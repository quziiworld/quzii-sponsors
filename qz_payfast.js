/** qz_payfast.gs — PayFast redirect + ITN (webhook) **/

function qzpf_prop_(k, d) { return PropertiesService.getScriptProperties().getProperty(k) || d || ''; }

function qz_pfEndpoints_() {
  var mode = String(qzpf_prop_('PF_MODE', 'live')).toLowerCase();
  return (mode === 'sandbox')
    ? { process: 'https://sandbox.payfast.co.za/eng/process', validate: 'https://sandbox.payfast.co.za/eng/query/validate' }
    : { process: 'https://www.payfast.co.za/eng/process',     validate: 'https://www.payfast.co.za/eng/query/validate'   };
}

function qz_pfBuildRedirect_(o) {
  var ep = qz_pfEndpoints_();
  var serviceUrl = ScriptApp.getService().getUrl();

  var params = {
    merchant_id:   qzpf_prop_('PF_MERCHANT_ID'),
    merchant_key:  qzpf_prop_('PF_MERCHANT_KEY'),
    return_url:    qz_prop_('THANKYOU_URL'),
    cancel_url:    qz_prop_('CANCEL_URL'),
    notify_url:    serviceUrl + '?type=payfastItn',
    amount:        Number(o.total).toFixed(2),
    item_name:     'QuziiWorld Sponsorship x ' + (o.qty || 1),
    m_payment_id:  o.orderId,
    email_address: o.email || ''
  };

  var sigBase = Object.keys(params).sort().map(function(k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');

  var passphrase = qzpf_prop_('PF_PASSPHRASE', '');
  if (passphrase) sigBase += '&passphrase=' + encodeURIComponent(passphrase);

  var md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sigBase)
    .map(function(b){ b=(b+256)%256; return b.toString(16).padStart(2,'0'); }).join('');

  return ep.process + '?' + sigBase + '&signature=' + md5;
}

// PayFast ITN (server-to-server webhook)
function qz_payfastItn(e) {
  var ep = qz_pfEndpoints_();
  if (!e.postData) return qz_json({ ok:false, message:'no body' });
  var raw = e.postData.contents || '';

  // Parse URL-encoded body
  var pairs = {};
  raw.split('&').forEach(function(s){
    if (!s) return;
    var i = s.indexOf('=');
    var k = decodeURIComponent(s.slice(0, i));
    var v = decodeURIComponent(s.slice(i+1));
    pairs[k] = v;
  });

  // Verify signature
  var sigGiven = pairs.signature;
  delete pairs.signature;

  var sigBase = Object.keys(pairs).sort().map(function(k){
    return k + '=' + encodeURIComponent(pairs[k]);
  }).join('&');

  var passphrase = qzpf_prop_('PF_PASSPHRASE', '');
  if (passphrase) sigBase += '&passphrase=' + encodeURIComponent(passphrase);

  var md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, sigBase)
    .map(function(b){ b=(b+256)%256; return b.toString(16).padStart(2,'0'); }).join('');

  if (md5 !== sigGiven) return qz_json({ ok:false, message:'bad signature' });

  // (Recommended) Validate with PayFast
  try {
    var resp = UrlFetchApp.fetch(ep.validate, { method:'post', payload: raw, muteHttpExceptions:true });
    if (!/VALID/i.test(resp.getContentText() || '')) return qz_json({ ok:false, message:'validate failed' });
  } catch (err) {
    console.error('PF validate error', err);
  }

  var orderId = pairs.m_payment_id;
  var status  = String(pairs.payment_status || '').toUpperCase();
  var amount  = Number(pairs.amount_gross || pairs.amount || 0);

  // Cross-check expected amount from our sheet
  var sh = qz_sheet_();
  var values = sh.getDataRange().getValues();
  var headers = values.shift();
  var cOrder = headers.indexOf('OrderID') + 1;
  var cTotal = headers.indexOf('Total') + 1;
  var cStatus = headers.indexOf('Status') + 1;
  var cTxn = headers.indexOf('TxnID') + 1;

  var expected = null;
  var orderRows = [];
  for (var i = 0; i < values.length; i++) {
    if (values[i][cOrder-1] === orderId) {
      orderRows.push(i + 2);
      if (expected == null && cTotal > 0) expected = Number(values[i][cTotal-1]);
    }
  }

  if (expected != null && Math.abs((expected || 0) - amount) > 0.01) {
    return qz_json({ ok:false, message:'amount mismatch' });
  }

  if (status === 'COMPLETE') {
    orderRows.forEach(function(r){
      if (cStatus > 0) sh.getRange(r, cStatus).setValue('PAID');
      if (cTxn > 0)    sh.getRange(r, cTxn).setValue(pairs.pf_payment_id || pairs.token || '');
    });
  }

  return qz_json({ ok:true });
}
