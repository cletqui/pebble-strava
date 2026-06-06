/* Pebble companion: GPS tracking + GPX upload via CF Worker */

// Credentials are never compiled in — they live in phone localStorage,
// set by the in-app config page (long-press app → Settings).
var _cfg          = (function() { try { return require('./config'); } catch(e) { return {}; } })();
var WORKER_URL    = _cfg.WORKER_URL    || '';
var WORKER_SECRET = _cfg.WORKER_SECRET || '';

var workerOk      = false;

var trackpoints   = [];
var hrSamples     = [];
var watchId       = null;
var sport         = 'run';    // 'run' or 'ride'
var isActive      = false;
var totalDist     = 0;        // meters
var lastPos       = null;     // { lat, lon }
var gpsTick        = 0;
var GPS_SEND_EVERY = 10;      // send AppMessage every N fixes (~10 s at 1 Hz GPS)
var preWarmFix     = false;   // tracks whether we've notified the watch of a pre-warm fix

// Haversine distance in meters between two lat/lon pairs
function haversine(lat1, lon1, lat2, lon2) {
  var R    = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a    = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

// GPS position callback
function onPosition(pos) {
  var lat = pos.coords.latitude;
  var lon = pos.coords.longitude;
  var alt = pos.coords.altitude || 0;
  var spd = pos.coords.speed   || 0;   // m/s
  var ts  = new Date(pos.timestamp).toISOString();

  if (isActive) {
    if (lastPos) {
      var d = haversine(lastPos.lat, lastPos.lon, lat, lon);
      if (d < 150) totalDist += d;  // ignore GPS jumps > 150 m
    }
    lastPos = { lat: lat, lon: lon };

    trackpoints.push({ lat: lat, lon: lon, alt: alt, time: ts });

    gpsTick++;
    // Always send on first fix so the watch shows GPS ✓ immediately;
    // after that, throttle to every GPS_SEND_EVERY fixes to reduce BLE traffic.
    if (gpsTick === 1 || gpsTick >= GPS_SEND_EVERY) {
      if (gpsTick >= GPS_SEND_EVERY) gpsTick = 0;
      sendToWatch({
        'GPS_DISTANCE': Math.round(totalDist),
        'GPS_SPEED':    Math.round(spd * 100),  // cm/s
        'GPS_HAS_FIX':  1
      });
    }
  } else if (!preWarmFix) {
    // Pre-warm phase: first fix acquired — notify the select screen once
    preWarmFix = true;
    sendToWatch({ 'GPS_HAS_FIX': 1 });
  }
}

function onPositionError(err) {
  // err.code: 1=PERMISSION_DENIED 2=POSITION_UNAVAILABLE 3=TIMEOUT
  console.log('GPS error ' + err.code + ': ' + err.message);
  if (err.code === 3) {
    stopGPS();
    startGPS();  // GPS-- label already shows searching; silent retry
  } else if (err.code === 1) {
    sendToWatch({ 'GPS_HAS_FIX': 0, 'UPLOAD_MSG': 'GPS: no permission' });
  } else {
    sendToWatch({ 'GPS_HAS_FIX': 0, 'UPLOAD_MSG': 'GPS unavailable' });
  }
}

function pingWorker() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', WORKER_URL + '/ping');
  xhr.setRequestHeader('Authorization', 'Bearer ' + WORKER_SECRET);
  xhr.onload = function() {
    try {
      var data = JSON.parse(xhr.responseText);
      workerOk = data.ok === true;
    } catch(e) { workerOk = false; }
    sendToWatch({ 'WORKER_STATUS': workerOk ? 1 : 2 });
    console.log('Worker ping: ' + (workerOk ? 'OK' : 'failed'));
  };
  xhr.onerror = function() {
    workerOk = false;
    sendToWatch({ 'WORKER_STATUS': 2 });
    console.log('Worker ping: unreachable');
  };
  xhr.send();
}

function startGPS() {
  if (!navigator.geolocation) {
    sendToWatch({ 'GPS_HAS_FIX': 0, 'UPLOAD_MSG': 'No geoloc API' });
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge:         5000,
    timeout:            60000
  });
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function timeOfDay(date) {
  var h = date.getHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}

function activityLabel(city) {
  var tod  = timeOfDay(new Date());
  var type = sport === 'ride' ? 'Ride' : 'Run';
  return (city ? city + ' ' : '') + tod + ' ' + type;
}

// Reverse geocode lat/lon to city name via BigDataCloud (free, no key required).
// Calls back with the city string or null on any failure.
function reverseGeocode(lat, lon, cb) {
  var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client' +
            '?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=en';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url);
  xhr.onload = function() {
    try {
      var data = JSON.parse(xhr.responseText);
      cb(data.city || data.locality || null);
    } catch (e) { cb(null); }
  };
  xhr.onerror = function() { cb(null); };
  xhr.send();
}

// Build a GPX string with embedded HR data
function buildGPX(activityName) {
  var startTime = trackpoints.length > 0
    ? trackpoints[0].time
    : new Date().toISOString();

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Pebble Time 2"\n' +
    '  xmlns="http://www.topografix.com/GPX/1/1"\n' +
    '  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n' +
    '<metadata>\n' +
    '  <name>' + activityName + '</name>\n' +
    '  <time>' + startTime + '</time>\n' +
    '  <link href="https://www.pebble.com"><text>Pebble Time 2</text></link>\n' +
    '</metadata>\n' +
    '<trk>\n' +
    '<name>' + activityName + '</name>\n' +
    '<type>' + (sport === 'ride' ? '1' : '9') + '</type>\n' +
    '<trkseg>\n';

  for (var i = 0; i < trackpoints.length; i++) {
    var tp   = trackpoints[i];
    var tpMs = new Date(tp.time).getTime();

    // Find the HR sample closest in time to this trackpoint
    var bestHr   = 0;
    var bestDiff = Infinity;
    for (var j = 0; j < hrSamples.length; j++) {
      var diff = Math.abs(hrSamples[j].ts - tpMs);
      if (diff < bestDiff) { bestDiff = diff; bestHr = hrSamples[j].hr; }
    }

    xml += '<trkpt lat="' + tp.lat.toFixed(7) + '" lon="' + tp.lon.toFixed(7) + '">\n' +
           '<ele>' + tp.alt.toFixed(1) + '</ele>\n' +
           '<time>' + tp.time + '</time>\n';

    if (bestHr > 0 && bestDiff < 30000) {  // within 30 s
      xml += '<extensions>\n' +
             '<gpxtpx:TrackPointExtension>\n' +
             '<gpxtpx:hr>' + bestHr + '</gpxtpx:hr>\n' +
             '</gpxtpx:TrackPointExtension>\n' +
             '</extensions>\n';
    }

    xml += '</trkpt>\n';
  }

  xml += '</trkseg>\n</trk>\n</gpx>';
  return xml;
}

// Post GPX to the Cloudflare Worker, which emails it to you
function uploadToWorker(gpxData, activityName) {
  if (!WORKER_URL || !WORKER_SECRET) {
    sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Open Settings to configure' });
    return;
  }
  sendToWatch({ 'UPLOAD_STATUS': 0 });

  var xhr = new XMLHttpRequest();
  xhr.open('POST', WORKER_URL + '/upload');
  xhr.setRequestHeader('Content-Type',   'application/json');
  xhr.setRequestHeader('Authorization',  'Bearer ' + WORKER_SECRET);
  xhr.onload = function() {
    try {
      var data = JSON.parse(xhr.responseText);
      if (data.ok) {
        sendToWatch({ 'UPLOAD_STATUS': 1 });
      } else {
        var msg = (data.error || 'Worker error').substring(0, 30);
        sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': msg });
      }
    } catch (e) {
      sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Bad response' });
    }
  };
  xhr.onerror = function() {
    sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Network error' });
  };
  xhr.send(JSON.stringify({
    gpx:   gpxData,
    sport: sport,
    name:  activityName,
  }));
}

// === Pebble event listeners ===

Pebble.addEventListener('ready', function() {
  console.log('Pebble Strava companion ready');
  WORKER_URL    = storageGet('workerUrl')    || WORKER_URL;
  WORKER_SECRET = storageGet('workerSecret') || WORKER_SECRET;
  if (!WORKER_URL) {
    sendToWatch({ 'CRED_REQUEST': 1 });  // ask watch, localStorage may have been cleared
  } else {
    pingWorker();
  }
  startGPS();
});

// === Config page (shown when user long-presses app → Settings) ===

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
'<p class="sub">Enter your Cloudflare Worker details. Settings are stored on your phone only.</p>' +
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
'  location.href="pebblejs://close?data="+encodeURIComponent(JSON.stringify(d));' +
'}' +
'</script></body></html>';

function htmlEscape(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

Pebble.addEventListener('showConfiguration', function() {
  if (WORKER_URL) {
    // Use the worker-hosted config page — no data URI size/encoding issues,
    // and values are always pre-filled via query params.
    Pebble.openURL(WORKER_URL + '/config' +
      '?url='    + encodeURIComponent(WORKER_URL) +
      '&secret=' + encodeURIComponent(WORKER_SECRET));
  } else {
    // First-time setup: worker URL not yet known, fall back to embedded page.
    var html = CONFIG_HTML
      .replace('__URL__',    htmlEscape(WORKER_URL))
      .replace('__SECRET__', htmlEscape(WORKER_SECRET));
    Pebble.openURL('data:text/html,' + encodeURIComponent(html));
  }
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response || e.response === 'CANCELLED') return;
  try {
    var data = JSON.parse(decodeURIComponent(e.response));
    if (data.workerUrl)    { WORKER_URL    = data.workerUrl;    storageSet('workerUrl',    data.workerUrl); }
    if (data.workerSecret) { WORKER_SECRET = data.workerSecret; storageSet('workerSecret', data.workerSecret); }
    // Also push to watch persistent storage so credentials survive phone-side reinstalls
    if (WORKER_URL && WORKER_SECRET) {
      sendToWatch({ 'CRED_URL': WORKER_URL, 'CRED_SECRET': WORKER_SECRET });
    }
    console.log('Config saved: ' + WORKER_URL);
  } catch (err) {
    console.log('Config parse error: ' + err);
  }
});

Pebble.addEventListener('appmessage', function(e) {
  var msg = e.payload;
  console.log('From watch: ' + JSON.stringify(msg));

  if (msg.CRED_URL) {
    WORKER_URL = msg.CRED_URL;
    storageSet('workerUrl', msg.CRED_URL);
    console.log('Credentials restored from watch: ' + WORKER_URL);
  }
  if (msg.CRED_SECRET) {
    WORKER_SECRET = msg.CRED_SECRET;
    storageSet('workerSecret', msg.CRED_SECRET);
  }
  if ((msg.CRED_URL || msg.CRED_SECRET) && WORKER_URL && WORKER_SECRET) {
    pingWorker();  // verify restored credentials immediately
  }

  if (msg.HR_BPM !== undefined && msg.HR_BPM > 0) {
    hrSamples.push({ hr: msg.HR_BPM, ts: Date.now() });
  }

  if (msg.CMD_ACTION !== undefined) {
    var action = msg.CMD_ACTION;

    if (action === 0) {  // START
      sport       = (msg.CMD_SPORT === 1) ? 'ride' : 'run';
      trackpoints = [];
      hrSamples   = [];
      totalDist   = 0;
      lastPos     = null;
      gpsTick     = 0;
      preWarmFix  = false;
      isActive    = true;
      if (!watchId) startGPS();  // already running if pre-warmed on ready
      console.log('Workout started: ' + sport);

    } else if (action === 1) {  // STOP
      isActive = false;
      stopGPS();
      if (trackpoints.length === 0) {
        sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'No GPS data' });
        return;
      }
      var first = trackpoints[0];
      reverseGeocode(first.lat, first.lon, function(city) {
        var activityName = activityLabel(city);
        var gpx          = buildGPX(activityName);
        uploadToWorker(gpx, activityName);
      });

    } else if (action === 2) {  // PAUSE
      isActive = false;
      // Reset lastPos so the first fix after resume doesn't add a jump
      lastPos = null;

    } else if (action === 3) {  // RESUME
      isActive = true;
    }
  }
});
