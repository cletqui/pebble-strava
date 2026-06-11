/* Pebble companion — config page + credential management only.
 * GPS tracking, GPX building, and Worker upload are handled by the
 * Android companion app (android/). See README for setup. */

var _cfg          = (function() { try { return require('./config'); } catch(e) { return {}; } })();
var WORKER_URL    = _cfg.WORKER_URL    || '';
var WORKER_SECRET = _cfg.WORKER_SECRET || '';
var HR_CYCLING    = parseInt(_cfg.HR_CYCLING   || '5',  10);
var HR_RUNNING    = parseInt(_cfg.HR_RUNNING   || '5',  10);
var HR_WALKING    = parseInt(_cfg.HR_WALKING   || '15', 10);
var GPS_ACCURACY        = parseInt(_cfg.GPS_ACCURACY        || '25', 10);
var UNITS               = parseInt(_cfg.UNITS               || '0',  10);
var DOWNLOAD_SUBFOLDER  = _cfg.DOWNLOAD_SUBFOLDER || '';

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

function sendSettings() {
  sendToWatch({
    'SETTINGS_HR_INTERVAL_CYCLING': HR_CYCLING,
    'SETTINGS_HR_INTERVAL_RUNNING': HR_RUNNING,
    'SETTINGS_HR_INTERVAL_WALKING': HR_WALKING,
    'SETTINGS_GPS_ACCURACY':        GPS_ACCURACY,
    'SETTINGS_UNITS':               UNITS,
  });
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

  var stored;
  stored = parseInt(storageGet('hrCycling')  || '0', 10);
  if (stored >= 1 && stored <= 30) HR_CYCLING = stored;
  stored = parseInt(storageGet('hrRunning')  || '0', 10);
  if (stored >= 1 && stored <= 30) HR_RUNNING = stored;
  stored = parseInt(storageGet('hrWalking')  || '0', 10);
  if (stored >= 1 && stored <= 30) HR_WALKING = stored;
  stored = parseInt(storageGet('gpsAccuracy') || '0', 10);
  if (stored === 15 || stored === 25 || stored === 50) GPS_ACCURACY = stored;
  stored = parseInt(storageGet('units') || '-1', 10);
  if (stored === 0 || stored === 1) UNITS = stored;
  var storedSub = storageGet('downloadSubfolder');
  if (storedSub !== undefined) DOWNLOAD_SUBFOLDER = storedSub;

  sendSettings();
  if (WORKER_URL && WORKER_SECRET) {
    pingWorker();
  } else {
    sendToWatch({ 'CRED_REQUEST': 1 });
    sendToWatch({ 'WORKER_STATUS': 3 }); // WORKER_NONE — no worker, hides W status
  }
});

// === Config page ===

var CONFIG_HTML = '<!DOCTYPE html>' +
'<html lang="en"><head>' +
'<meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Strava GPX Mailer</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#eee;padding:24px 20px}' +
'h1{font-size:20px;color:#fc4c02;margin-bottom:4px}' +
'.sub{font-size:13px;color:#777;margin-bottom:28px}' +
'.section{background:#1a1a1a;border-radius:10px;padding:16px;margin-bottom:16px}' +
'.st{font-size:11px;color:#fc4c02;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;font-weight:600}' +
'label{display:block;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;margin-top:12px}' +
'label:first-of-type{margin-top:0}' +
'input[type=text],input[type=url]{width:100%;padding:11px 12px;background:#252525;border:1px solid #3a3a3a;border-radius:8px;color:#eee;font-size:15px;outline:none;-webkit-appearance:none}' +
'input[type=text]:focus,input[type=url]:focus{border-color:#fc4c02}' +
'select{width:100%;padding:11px 12px;background:#252525;border:1px solid #3a3a3a;border-radius:8px;color:#eee;font-size:15px;outline:none;-webkit-appearance:none}' +
'select:focus{border-color:#fc4c02}' +
'.slider-row{display:flex;align-items:center;gap:10px}' +
'.slider-row input[type=range]{flex:1;accent-color:#fc4c02;height:4px}' +
'.slider-val{min-width:42px;text-align:right;font-size:14px;color:#eee;white-space:nowrap}' +
'.hint{font-size:12px;color:#555;margin-top:8px;line-height:1.4}' +
'button{width:100%;padding:14px;background:#fc4c02;border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px;letter-spacing:.02em}' +
'button:active{background:#d94000}' +
'</style></head><body>' +
'<h1>Strava GPX Mailer</h1>' +
'<p class="sub">Setup &amp; Preferences</p>' +
'<div class="section">' +
'<p class="st">Worker <span style="font-size:10px;color:#555;text-transform:none;letter-spacing:0;font-weight:400">(optional — for email delivery)</span></p>' +
'<label>Worker URL</label>' +
'<input id="u" type="url" value="__URL__" placeholder="https://pebble-strava.xxx.workers.dev">' +
'<p class="hint">From <code>wrangler deploy</code> output. Leave blank to skip email — GPX will always be saved to your phone.</p>' +
'<label>Upload Secret</label>' +
'<input id="s" type="text" value="__SECRET__" placeholder="your_upload_secret">' +
'<p class="hint">The UPLOAD_SECRET set with <code>wrangler secret put</code>.</p>' +
'</div>' +
'<div class="section">' +
'<p class="st">Heart Rate Interval</p>' +
'<label>Cycling</label>' +
'<div class="slider-row"><input type="range" id="hr-c" min="1" max="30" step="1" oninput="document.getElementById(\'hr-c-v\').textContent=this.value+\' s\'"><span id="hr-c-v" class="slider-val">5 s</span></div>' +
'<label>Running</label>' +
'<div class="slider-row"><input type="range" id="hr-r" min="1" max="30" step="1" oninput="document.getElementById(\'hr-r-v\').textContent=this.value+\' s\'"><span id="hr-r-v" class="slider-val">5 s</span></div>' +
'<label>Walking</label>' +
'<div class="slider-row"><input type="range" id="hr-w" min="1" max="30" step="1" oninput="document.getElementById(\'hr-w-v\').textContent=this.value+\' s\'"><span id="hr-w-v" class="slider-val">15 s</span></div>' +
'<p class="hint">How often the watch reads &amp; sends HR. 1 s = most detail, 30 s = best battery.</p>' +
'</div>' +
'<div class="section">' +
'<p class="st">GPS</p>' +
'<label>Accuracy Filter</label>' +
'<select id="gps">' +
'<option value="15">Strict — 15 m (open terrain)</option>' +
'<option value="25">Default — 25 m</option>' +
'<option value="50">Lenient — 50 m (urban areas)</option>' +
'</select>' +
'<p class="hint">Fixes worse than this threshold are dropped when recording. Use lenient in urban canyons to keep more points.</p>' +
'</div>' +
'<div class="section">' +
'<p class="st">Display</p>' +
'<label>Units</label>' +
'<select id="units">' +
'<option value="0">Metric — km, km/h, min/km</option>' +
'<option value="1">Imperial — mi, mph, min/mi</option>' +
'</select>' +
'</div>' +
'<div class="section">' +
'<p class="st">Storage</p>' +
'<label>Download subfolder</label>' +
'<input id="subfolder" type="text" value="__SUBFOLDER__" placeholder="pebble-strava">' +
'<p class="hint">Subfolder inside Downloads/ to save GPX files. Leave blank to save directly to Downloads.</p>' +
'</div>' +
'<button onclick="save()">Save &amp; Close</button>' +
'<script>' +
'(function(){var c=__HR_CYCLING__,r=__HR_RUNNING__,w=__HR_WALKING__;' +
'document.getElementById("hr-c").value=c;document.getElementById("hr-c-v").textContent=c+" s";' +
'document.getElementById("hr-r").value=r;document.getElementById("hr-r-v").textContent=r+" s";' +
'document.getElementById("hr-w").value=w;document.getElementById("hr-w-v").textContent=w+" s";})();' +
'document.getElementById("gps").value="__GPS_ACCURACY__";' +
'document.getElementById("units").value="__UNITS__";' +
'function save(){' +
'  var d={' +
'    workerUrl:document.getElementById("u").value.trim(),' +
'    workerSecret:document.getElementById("s").value.trim(),' +
'    hrCycling:document.getElementById("hr-c").value,' +
'    hrRunning:document.getElementById("hr-r").value,' +
'    hrWalking:document.getElementById("hr-w").value,' +
'    gpsAccuracy:document.getElementById("gps").value,' +
'    units:document.getElementById("units").value,' +
'    downloadSubfolder:document.getElementById("subfolder").value.trim()' +
'  };' +
'  location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(d));' +
'}' +
'</script></body></html>';

function htmlEscape(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

Pebble.addEventListener('showConfiguration', function() {
  var html = CONFIG_HTML
    .replace('__URL__',          htmlEscape(WORKER_URL))
    .replace('__SECRET__',       htmlEscape(WORKER_SECRET))
    .replace('__HR_CYCLING__',   String(HR_CYCLING))
    .replace('__HR_RUNNING__',   String(HR_RUNNING))
    .replace('__HR_WALKING__',   String(HR_WALKING))
    .replace('__GPS_ACCURACY__', String(GPS_ACCURACY))
    .replace('__UNITS__',        String(UNITS))
    .replace('__SUBFOLDER__',    htmlEscape(DOWNLOAD_SUBFOLDER));
  Pebble.openURL('data:text/html,' + encodeURIComponent(html));
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

    var iv;
    iv = parseInt(data.hrCycling  || '0', 10);
    if (iv >= 1 && iv <= 30) { HR_CYCLING = iv; storageSet('hrCycling', String(iv)); }
    iv = parseInt(data.hrRunning  || '0', 10);
    if (iv >= 1 && iv <= 30) { HR_RUNNING = iv; storageSet('hrRunning', String(iv)); }
    iv = parseInt(data.hrWalking  || '0', 10);
    if (iv >= 1 && iv <= 30) { HR_WALKING = iv; storageSet('hrWalking', String(iv)); }
    iv = parseInt(data.gpsAccuracy || '0', 10);
    if (iv === 15 || iv === 25 || iv === 50) { GPS_ACCURACY = iv; storageSet('gpsAccuracy', String(iv)); }
    iv = parseInt(data.units || '-1', 10);
    if (iv === 0 || iv === 1) { UNITS = iv; storageSet('units', String(iv)); }
    if (data.downloadSubfolder !== undefined) {
      DOWNLOAD_SUBFOLDER = data.downloadSubfolder;
      storageSet('downloadSubfolder', data.downloadSubfolder);
      sendToWatch({ 'SETTINGS_DOWNLOAD_SUBFOLDER': data.downloadSubfolder });
    }

    if (WORKER_URL) {
      var creds = { 'CRED_URL': WORKER_URL };
      if (WORKER_SECRET) creds['CRED_SECRET'] = WORKER_SECRET;
      sendToWatch(creds);
    }

    sendSettings();

    if (WORKER_URL && WORKER_SECRET) {
      sendToWatch({ 'UPLOAD_MSG': 'Saved! Pinging...' });
      pingWorker();
    } else if (WORKER_URL) {
      sendToWatch({ 'CRED_REQUEST': 1 });
      sendToWatch({ 'WORKER_STATUS': 3 });
      sendToWatch({ 'UPLOAD_MSG': 'URL saved — add secret' });
    } else {
      sendToWatch({ 'CRED_REQUEST': 1 });
      sendToWatch({ 'WORKER_STATUS': 3 });
    }
  } catch (err) {
    console.log('Config parse error: ' + err);
  }
});

// === Credential relay: watch flash ⇔ phone localStorage ===

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
    sendSettings();
  }
});
