/**
 * Subscribe a sponsor to AcyMailing List (server-side).
 * Reads: ACY_URL, ACY_API_KEY, ACY_LIST_ID from Script Properties.
 * Safe to call multiple times for the same email (Acy will upsert).
 */
function qz_subscribeSponsorToAcy_(email, name, meta) {
  try {
    if (!email) return { ok: false, reason: 'no-email' };

    const props   = PropertiesService.getScriptProperties();
    const url     = props.getProperty('ACY_URL');
    const apiKey  = props.getProperty('ACY_API_KEY');
    const listId  = Number(props.getProperty('ACY_LIST_ID') || 2);

    if (!url || !apiKey) return { ok: false, reason: 'missing-config' };

    // Build payload per AcyMailing v7 API
    var payload = {
      users: [{
        email: String(email).trim(),
        name:  String(name || '').trim(),
        // Optional custom fields you may have defined in Acy (safe to ignore if not present)
        fields: {
          source: meta && meta.source ? meta.source : 'Sponsor',
          orderId: meta && meta.orderId ? meta.orderId : ''
        }
      }],
      listIds: [listId],
      status: 1 // 1=subscribe, 0=unsubscribe
    };

    // First try token header (v7). If 401, fall back to body apiKey (some setups require it).
    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: { 'X-Acy-Token': apiKey },
      muteHttpExceptions: true
    };

    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var body = res.getContentText() || '';

    if (code === 401 || code === 403) {
      // Fallback: send apiKey in body (older gateways)
      payload.apiKey = apiKey;
      var res2 = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      code = res2.getResponseCode();
      body = res2.getContentText() || '';
    }

    // Consider 2xx success
    if (String(code).charAt(0) === '2') {
      return { ok: true, code: code, body: body };
    } else {
      console.error('ACY subscribe error', code, body);
      return { ok: false, code: code, body: body };
    }
  } catch (err) {
    console.error('ACY subscribe exception', err);
    return { ok: false, error: String(err) };
  }
}
