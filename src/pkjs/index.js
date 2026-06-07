/* Pebble companion — config page + credential management only.
 * GPS tracking, GPX building, and Worker upload are handled by the
 * Android companion app (android/). See README for setup. */

var _cfg          = (function() { try { return require('./config'); } catch(e) { return {}; } })();
var WORKER_URL    = _cfg.WORKER_URL    || '';
var WORKER_SECRET = _cfg.WORKER_SECRET || '';

function storageGet(key) {
  try { return Pebble.getLocalStorageItem(key) || ''; } catch(e) { return ''; }
}
function storageSet(key, val) {
  try { Pebble.setLocalStorageItem(key, val); } catch(e) {}
}

function sendToWatch(data) {
  Pebble.sendAppMessage(data,
    function() {},
    function(e) { console.log('sendAppMessage failed: ' + JSON.stringify(e)); }
  );
}

function pingWorker() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', WORKER_URL + '/ping');
  xhr.setRequestHeader('Authorization', 'Bearer ' + WORKER_SECRET);
  xhr.onload = function() {
    try {
      var ok = JSON.parse(xhr.responseText).ok === true;
      sendToWatch({ 'WORKER_STATUS': ok ? 1 : 2 });
    } catch(e) { sendToWatch({ 'WORKER_STATUS': 2 }); }
  };
  xhr.onerror = function() { sendToWatch({ 'WORKER_STATUS': 2 }); };
  xhr.send();
}

// === Lifecycle ===

Pebble.addEventListener('ready', function() {
  WORKER_URL    = storageGet('workerUrl')    || WORKER_URL;
  WORKER_SECRET = storageGet('workerSecret') || WORKER_SECRET;
  if (WORKER_URL && WORKER_SECRET) {
    pingWorker();
  } else {
    // Request credentials from watch flash so the config page can pre-fill on reopen.
    // The watch responds with CRED_URL/CRED_SECRET if credentials were previously saved.
    sendToWatch({ 'CRED_REQUEST': 1 });
    sendToWatch({ 'UPLOAD_MSG': 'Open Settings to configure' });
  }
});

// === Config page ===

var CONFIG_HTML = '<!DOCTYPE html>' +
'<html lang="en"><head>' +
'<meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Strava GPX Mailer — Setup</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,sans-serif;background:#111;color:#eee;padding:24px 20px}' +
'h1{font-size:20px;color:#ff6600;margin-bottom:6px}' +
'.sub{font-size:13px;color:#888;margin-bottom:28px}' +
'label{display:block;font-size:12px;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}' +
'input{width:100%;padding:12px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;font-size:15px;margin-bottom:6px;outline:none}' +
'input:focus{border-color:#ff6600}' +
'.hint{font-size:12px;color:#666;margin-bottom:20px}' +
'button{width:100%;padding:14px;background:#ff6600;border:none;border-radius:6px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px}' +
'button:active{background:#cc5200}' +
'</style></head><body>' +
'<h1>Strava GPX Mailer</h1>' +
'<p class="sub">Enter your Cloudflare Worker details.</p>' +
'<label>Worker URL</label>' +
'<input id="u" type="url" value="__URL__" placeholder="https://pebble-strava.xxx.workers.dev">' +
'<p class="hint">From wrangler deploy output.</p>' +
'<label>Upload Secret</label>' +
'<input id="s" type="text" value="__SECRET__" placeholder="your_upload_secret">' +
'<p class="hint">The UPLOAD_SECRET you set with wrangler secret put.</p>' +
'<button onclick="save()">Save &amp; Close</button>' +
'<script>' +
'function save(){' +
'  var d={workerUrl:document.getElementById("u").value.trim(),workerSecret:document.getElementById("s").value.trim()};' +
'  location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(d));' +
'}' +
'</script></body></html>';

function htmlEscape(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

Pebble.addEventListener('showConfiguration', function() {
  if (WORKER_URL) {
    Pebble.openURL(WORKER_URL + '/config' +
      '?url='    + encodeURIComponent(WORKER_URL) +
      '&secret=' + encodeURIComponent(WORKER_SECRET));
  } else {
    var html = CONFIG_HTML
      .replace('__URL__',    htmlEscape(WORKER_URL))
      .replace('__SECRET__', htmlEscape(WORKER_SECRET));
    Pebble.openURL('data:text/html,' + encodeURIComponent(html));
  }
});

Pebble.addEventListener('webviewclosed', function(e) {
  console.log('webviewclosed raw: ' + JSON.stringify(e.response));
  if (!e.response || e.response === 'CANCELLED') return;
  try {
    var raw = e.response;
    if (raw.charAt(0) === '#')        raw = raw.slice(1);
    if (raw.indexOf('?data=') === 0)  raw = raw.slice(6);
    var data = JSON.parse(decodeURIComponent(raw));
    if (data.workerUrl)    { WORKER_URL    = data.workerUrl;    storageSet('workerUrl',    data.workerUrl); }
    if (data.workerSecret) { WORKER_SECRET = data.workerSecret; storageSet('workerSecret', data.workerSecret); }

    if (WORKER_URL) {
      var creds = { 'CRED_URL': WORKER_URL };
      if (WORKER_SECRET) creds['CRED_SECRET'] = WORKER_SECRET;
      sendToWatch(creds);
    }

    if (WORKER_URL && WORKER_SECRET) {
      sendToWatch({ 'UPLOAD_MSG': 'Saved! Pinging...' });
      pingWorker();
    } else if (WORKER_URL) {
      sendToWatch({ 'UPLOAD_MSG': 'URL saved — add secret' });
    } else {
      sendToWatch({ 'UPLOAD_MSG': 'Open Settings to configure' });
    }
  } catch (err) {
    console.log('Config parse error: ' + err);
  }
});

// === Credential relay: watch flash ↔ phone localStorage ===

Pebble.addEventListener('appmessage', function(e) {
  var msg = e.payload;

  if (msg.CRED_URL) {
    WORKER_URL = msg.CRED_URL;
    storageSet('workerUrl', msg.CRED_URL);
  }
  if (msg.CRED_SECRET) {
    WORKER_SECRET = msg.CRED_SECRET;
    storageSet('workerSecret', msg.CRED_SECRET);
  }
  if ((msg.CRED_URL || msg.CRED_SECRET) && WORKER_URL && WORKER_SECRET) {
    pingWorker();
  }
});
