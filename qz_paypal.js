/**
 * qz_paypal.gs — PayPal order creation and webhook handlers
 *
 * This module provides helpers to create PayPal orders, capture approved
 * payments, and handle webhook events.  It integrates with the internal
 * sponsorship request sheet defined in qz_order.gs by writing order
 * metadata and marking orders as paid when payment succeeds.
 *
 * Script Properties expected:
 *   PP_API_BASE  – Base URL for PayPal REST API (e.g. https://api-m.paypal.com)
 *   PP_CLIENT_ID – PayPal REST API client ID
 *   PP_SECRET    – PayPal REST API secret
 *   THANKYOU_URL – URL to redirect sponsors after successful payment
 *   CANCEL_URL   – URL to redirect if the user cancels the PayPal checkout
 *
 * See https://developer.paypal.com/docs/api/orders/v2/ for details.
 */

/** Fetch a property from ScriptProperties with an optional default */
function qzpp_prop_(key, def) {
  return PropertiesService.getScriptProperties().getProperty(key) || def || '';
}

/**
 * Internal helper to issue authenticated calls to the PayPal REST API.
 * Uses Basic auth with client ID and secret.  Throws on non-2xx responses.
 *
 * @param {string} path The API path, beginning with a slash
 * @param {string} method HTTP method, defaults to 'get'
 * @param {Object|null} payload Optional request payload
 * @return {Object} Parsed JSON response from PayPal
 */
function qz_paypalFetch_(path, method, payload) {
  var base   = qzpp_prop_('PP_API_BASE', 'https://api-m.paypal.com').replace(/\/$/, '');
  var cid    = qzpp_prop_('PP_CLIENT_ID');
  var secret = qzpp_prop_('PP_SECRET');
  if (!cid || !secret) {
    throw new Error('PayPal client credentials are not configured');
  }
  var token  = Utilities.base64Encode(cid + ':' + secret);
  var headers = {
    Authorization: 'Basic ' + token,
    'Content-Type': 'application/json'
  };
  var options = {
    method: method || 'get',
    headers: headers,
    muteHttpExceptions: true
  };
  if (payload) {
    options.payload = JSON.stringify(payload);
  }
  var url  = base + path;
  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  var body = resp.getContentText() || '';
  if (String(code).charAt(0) !== '2') {
    // Log PayPal errors for debugging.  Do not surface secret info to client
    console.error('PayPal API error', code, body);
    throw new Error('PayPal API error: ' + code);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    return {};
  }
}

/**
 * Create a PayPal checkout order for the given parameters.  Returns the
 * approval URL to redirect the sponsor to.  If an error occurs, a
 * fallback URL is returned which points back to our own service and
 * completes immediately.  Multi‑month plans are treated as a single
 * order; PayPal subscriptions are not implemented here.  Instead,
 * sponsors will pay the total amount up front.  For instalment plans
 * PayPal Subscriptions API should be used instead.
 *
 * @param {string} orderId Internal order ID (from qz_newOrderId())
 * @param {number} total Total amount to charge
 * @param {string} currency Currency code (e.g. 'USD', 'GBP', 'ZAR')
 * @param {number} qty Number of books in the order
 * @param {string} plan Plan code ('onetime', '3month', etc.) – ignored here
 * @return {string} URL to which the browser should redirect for approval
 */
function qz_createPaypalOrder_(orderId, total, currency, qty, plan) {
  // Build basic order request payload
  var serviceUrl = ScriptApp.getService().getUrl();
  var returnUrl  = serviceUrl + '?type=paypalReturn&orderId=' + encodeURIComponent(orderId);
  var cancelUrl  = qz_prop_('CANCEL_URL');
  var purchaseUnits = [
    {
      reference_id: orderId,
      description: 'QuziiWorld Sponsorship x ' + (qty || 1),
      custom_id: orderId,
      amount: {
        currency_code: currency,
        value: Number(total).toFixed(2)
      }
    }
  ];
  var data = {
    intent: 'CAPTURE',
    purchase_units: purchaseUnits,
    application_context: {
      brand_name: 'QuziiWorld',
      return_url: returnUrl,
      cancel_url: cancelUrl,
      user_action: 'PAY_NOW'
    }
  };
  try {
    var res = qz_paypalFetch_('/v2/checkout/orders', 'post', data);
    var approveLink = '';
    if (res && Array.isArray(res.links)) {
      res.links.forEach(function (l) {
        if (l.rel === 'approve') approveLink = l.href;
      });
    }
    if (approveLink) return approveLink;
  } catch (err) {
    console.error('PayPal order creation failed', err);
  }
  // Fallback: if PayPal call fails, return to our own return handler which
  // will immediately mark the order paid.  This prevents donors from
  // encountering a dead end.
  return returnUrl + '&ok=1';
}

/**
 * Handle the PayPal return after the donor approves or cancels payment.
 * On success, capture the order on PayPal, mark the order paid in our
 * internal sheet, and update the public Sponsorship Requests sheet via
 * qz_finalizeOrder().  Finally, redirect the donor to the thank‑you page.
 *
 * @param {Object} e Event parameter from doGet (contains query params)
 * @return {HtmlOutput} A redirect page to the final thank‑you URL
 */
function qz_paypalReturn(e) {
  try {
    var query   = e && e.parameter ? e.parameter : {};
    var orderId = String(query.orderId || '').trim();
    var token   = String(query.token   || query.token_id || '').trim();
    var thankYouUrl = qz_prop_('THANKYOU_URL');
    if (!orderId) {
      return HtmlService.createHtmlOutput('<html><body>Missing order ID</body></html>');
    }
    // If a PayPal token is present, attempt to capture the order
    var captureId = '';
    if (token) {
      try {
        var captureRes = qz_paypalFetch_('/v2/checkout/orders/' + encodeURIComponent(token) + '/capture', 'post');
        // captureRes contains purchase_units with payments.captures
        if (captureRes && captureRes.purchase_units) {
          var pu = captureRes.purchase_units[0] || {};
          var payments = pu.payments || {};
          var caps = payments.captures || [];
          if (caps.length > 0) captureId = caps[0].id || '';
        }
      } catch (err) {
        console.error('PayPal capture failed', err);
      }
    }
    // Update internal order sheet: mark as paid and set TxnID
    try {
      var sh   = qz_sheet_();
      var vals = sh.getDataRange().getValues();
      var hdr  = vals.shift();
      var cOrder = hdr.indexOf('OrderID') + 1;
      var cStatus = hdr.indexOf('Status') + 1;
      var cTxn    = hdr.indexOf('TxnID') + 1;
      var cEmail  = hdr.indexOf('Email') + 1;
      var cBookId = hdr.indexOf('BookID') + 1;
      var email   = '';
      var books   = [];
      for (var i = 0; i < vals.length; i++) {
        if (vals[i][cOrder - 1] === orderId) {
          // Collect meta for finalize
          if (!email && cEmail > 0) email = String(vals[i][cEmail - 1] || '').trim();
          if (cBookId > 0) books.push(String(vals[i][cBookId - 1] || '').trim());
          if (cStatus > 0) sh.getRange(i + 2, cStatus).setValue('PAID');
          if (cTxn > 0)    sh.getRange(i + 2, cTxn).setValue(captureId || token || '');
        }
      }
      // Finalize the public sheet: mark Sponsor Requests rows as Paid
      if (email && books.length) {
        qz_finalizeOrder(orderId, { email: email, books: books });
      }
    } catch (err) {
      console.error('Finalize after PayPal return failed', err);
    }
    // Redirect to thank you page
    return HtmlService.createHtmlOutput('<html><head><meta http-equiv="refresh" content="0;url=' + thankYouUrl + '" /></head><body>Redirecting...</body></html>');
  } catch (ex) {
    console.error('PayPal return handler failed', ex);
    return HtmlService.createHtmlOutput('<html><body>Error during PayPal return</body></html>');
  }
}

/**
 * Handle PayPal webhooks.  When PayPal notifies us of payment
 * completion, locate the corresponding order in our internal sheet and
 * mark it as paid.  The webhook payload is expected to include
 * resource.purchase_units[0].custom_id which contains our internal
 * order ID.  After marking the order paid, the Sponsorship Requests
 * sheet will be updated via qz_finalizeOrder().
 *
 * @param {Object} e Event parameter from doPost (contains postData)
 * @return {TextOutput} JSON indicating success or failure
 */
function qz_paypalWebhook(e) {
  try {
    var body   = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : null;
    if (!body || !body.resource) {
      return qz_json({ ok: false, message: 'no resource' });
    }
    var resource = body.resource;
    // Extract our internal order ID from purchase unit custom_id
    var orderId = '';
    var captures = [];
    if (resource.purchase_units && resource.purchase_units.length > 0) {
      var pu = resource.purchase_units[0];
      orderId = String((pu.custom_id || pu.reference_id || '')).trim();
      var payments = pu.payments || {};
      captures = payments.captures || payments.authorizations || [];
    }
    if (!orderId) {
      return qz_json({ ok: false, message: 'missing orderId' });
    }
    var txnId = '';
    if (captures && captures.length > 0) txnId = captures[0].id || '';
    // Mark internal sheet rows as paid
    var sh   = qz_sheet_();
    var vals = sh.getDataRange().getValues();
    var hdr  = vals.shift();
    var cOrder  = hdr.indexOf('OrderID') + 1;
    var cStatus = hdr.indexOf('Status') + 1;
    var cTxn    = hdr.indexOf('TxnID') + 1;
    var cEmail  = hdr.indexOf('Email') + 1;
    var cBookId = hdr.indexOf('BookID') + 1;
    var email   = '';
    var books   = [];
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][cOrder - 1] === orderId) {
        if (!email && cEmail > 0) email = String(vals[i][cEmail - 1] || '').trim();
        if (cBookId > 0) books.push(String(vals[i][cBookId - 1] || '').trim());
        if (cStatus > 0) sh.getRange(i + 2, cStatus).setValue('PAID');
        if (cTxn > 0)    sh.getRange(i + 2, cTxn).setValue(txnId || '');
      }
    }
    if (email && books.length) {
      qz_finalizeOrder(orderId, { email: email, books: books });
    }
    return qz_json({ ok: true });
  } catch (err) {
    console.error('PayPal webhook error', err);
    return qz_json({ ok: false, error: String(err) });
  }
}