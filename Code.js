/** Code.gs — web app router ONLY **/

function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    var type = (e && e.parameter && (e.parameter.type || e.parameter.mode)) || (body && body.type) || '';

    switch (type) {
      case 'createOrder':
        return qz_handleCreateOrder_(body);

      case 'finalizeOrder':
        return qz_finalizeOrder(body.orderId, body.meta || {});

      case 'paypalWebhook':
        return qz_paypalWebhook(e);

      case 'payfastItn':
        return qz_payfastItn(e);

      default:
        return qz_json({ ok: false, error: 'Unknown type: ' + type });
    }
  } catch (err) {
    return qz_json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    // Determine mode/type from query parameters.  Consolidate all known parameter names
    var mode = String(e && e.parameter && (e.parameter.mode || e.parameter.type || '')).toLowerCase();

    // JSON mode: return full catalogue and team list as JSON
    if (mode === 'json') {
      var ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
      var ss   = SpreadsheetApp.openById(ssId);
      var sh   = ss.getSheetByName('Public_Catalogue');
      if (!sh) return qz_json({ ok:false, error:'Missing sheet: Public_Catalogue' });

      var rows = sh.getDataRange().getValues();
      if (!rows || rows.length < 2) return qz_json({ records: [] });

      // Grab header names and build objects with all columns intact
      var headers = rows.shift().map(function(h){ return String(h).trim(); });
      var records = rows.map(function(r) {
        var obj = {};
        for (var i = 0; i < headers.length; i++) {
          obj[headers[i]] = String(r[i] || '').trim();
        }
        return obj;
      });
      // Fetch team members from the payout summary sheet (name + email)
      var teamList = [];
      try {
        var tm = getTeamMembers_();
        // Each entry is [Name, Email]
        teamList = tm.map(function(row){
          return { name: String(row[0]).trim(), email: String(row[1]).trim() };
        });
      } catch (_err) {
        // ignore if function is missing
      }
      return qz_json({ records: records, teamList: teamList });
    }

    var type = String(e && e.parameter && (e.parameter.type || e.parameter.mode) || '');
    if (type === 'paypalReturn') return qz_paypalReturn(e);
    // Default response for GET
    return qz_json({ ok: true, service: 'Quzii Sponsor API', ts: new Date().toISOString() });
  } catch (err) {
    return qz_json({ ok: false, error: String(err) });
  }
}

