/* Pebble companion: GPS tracking + Strava upload */

var trackpoints = [];
var hrSamples   = [];
var watchId     = null;
var sport       = 'run';      // 'run' or 'ride'
var isActive    = false;
var totalDist   = 0;          // meters
var lastPos     = null;       // { lat, lon }

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

    sendToWatch({
      'GPS_DISTANCE': Math.round(totalDist),
      'GPS_SPEED':    Math.round(spd * 100),  // cm/s
      'GPS_HAS_FIX':  1
    });
  }
}

function onPositionError(err) {
  console.log('GPS error: ' + err.message);
  sendToWatch({ 'GPS_HAS_FIX': 0 });
}

function startGPS() {
  if (!navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge:         2000,
    timeout:            15000
  });
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// Build a GPX string with embedded HR data
function buildGPX() {
  var actName = sport === 'ride' ? 'Cycling' : 'Running';
  var date    = trackpoints.length > 0
    ? trackpoints[0].time.split('T')[0]
    : new Date().toISOString().split('T')[0];

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Pebble Strava Recorder"\n' +
    '  xmlns="http://www.topografix.com/GPX/1/1"\n' +
    '  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n' +
    '<trk>\n' +
    '<name>' + actName + ' ' + date + '</name>\n' +
    '<type>' + (sport === 'ride' ? '1' : '9') + '</type>\n' +
    '<trkseg>\n';

  for (var i = 0; i < trackpoints.length; i++) {
    var tp    = trackpoints[i];
    var tpMs  = new Date(tp.time).getTime();

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

// Refresh an expired access token, then call cb(newAccessToken) or cb(null)
function refreshAccessToken(cb) {
  var clientId     = localStorage.getItem('strava_client_id');
  var clientSecret = localStorage.getItem('strava_client_secret');
  var refreshToken = localStorage.getItem('strava_refresh_token');

  if (!clientId || !clientSecret || !refreshToken) { cb(null); return; }

  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://www.strava.com/oauth/token');
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.onload = function() {
    if (xhr.status === 200) {
      var data = JSON.parse(xhr.responseText);
      localStorage.setItem('strava_access_token',  data.access_token);
      localStorage.setItem('strava_refresh_token', data.refresh_token);
      localStorage.setItem('strava_expires_at',    String(data.expires_at));
      cb(data.access_token);
    } else {
      cb(null);
    }
  };
  xhr.onerror = function() { cb(null); };
  xhr.send(
    'client_id='     + encodeURIComponent(clientId) +
    '&client_secret='+ encodeURIComponent(clientSecret) +
    '&refresh_token='+ encodeURIComponent(refreshToken) +
    '&grant_type=refresh_token'
  );
}

// Upload GPX to Strava, send result to watch
function uploadGPX(gpxData) {
  var accessToken  = localStorage.getItem('strava_access_token');
  var expiresAt    = parseInt(localStorage.getItem('strava_expires_at') || '0', 10);
  var nowSec       = Math.floor(Date.now() / 1000);

  if (!accessToken) {
    sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Not authenticated' });
    return;
  }

  if (expiresAt && expiresAt < nowSec) {
    refreshAccessToken(function(token) {
      if (token) doUpload(gpxData, token);
      else sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Auth expired' });
    });
  } else {
    doUpload(gpxData, accessToken);
  }
}

function doUpload(gpxData, accessToken) {
  sendToWatch({ 'UPLOAD_STATUS': 0 });  // uploading

  var boundary = 'PebbleStrava' + Date.now();
  var CRLF     = '\r\n';

  var body =
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="activity_type"' + CRLF + CRLF +
    sport + CRLF +
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="data_type"' + CRLF + CRLF +
    'gpx' + CRLF +
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="name"' + CRLF + CRLF +
    (sport === 'ride' ? 'Cycling' : 'Running') + ' — Pebble' + CRLF +
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="file"; filename="workout.gpx"' + CRLF +
    'Content-Type: application/gpx+xml' + CRLF + CRLF +
    gpxData + CRLF +
    '--' + boundary + '--' + CRLF;

  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://www.strava.com/api/v3/uploads');
  xhr.setRequestHeader('Authorization',  'Bearer ' + accessToken);
  xhr.setRequestHeader('Content-Type',   'multipart/form-data; boundary=' + boundary);
  xhr.onload = function() {
    if (xhr.status === 201) {
      var res = JSON.parse(xhr.responseText);
      setTimeout(function() { pollUpload(res.id, accessToken, 0); }, 2000);
    } else {
      var msg = xhr.status.toString();
      try { msg = JSON.parse(xhr.responseText).message || msg; } catch(e) {}
      sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': msg.substring(0, 30) });
    }
  };
  xhr.onerror = function() {
    sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Network error' });
  };
  xhr.send(body);
}

function pollUpload(uploadId, accessToken, attempts) {
  if (attempts >= 12) {
    sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Timeout' });
    return;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://www.strava.com/api/v3/uploads/' + uploadId);
  xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
  xhr.onload = function() {
    if (xhr.status === 200) {
      var res = JSON.parse(xhr.responseText);
      if (res.activity_id) {
        sendToWatch({ 'UPLOAD_STATUS': 1 });  // success
      } else if (res.error) {
        sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': res.error.substring(0, 30) });
      } else {
        setTimeout(function() { pollUpload(uploadId, accessToken, attempts + 1); }, 3000);
      }
    } else {
      sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Poll failed' });
    }
  };
  xhr.onerror = function() {
    sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'Network error' });
  };
  xhr.send();
}

// === Pebble event listeners ===

Pebble.addEventListener('ready', function() {
  console.log('Pebble Strava companion ready');
});

Pebble.addEventListener('appmessage', function(e) {
  var msg = e.payload;
  console.log('From watch: ' + JSON.stringify(msg));

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
      isActive    = true;
      startGPS();
      console.log('Workout started: ' + sport);

    } else if (action === 1) {  // STOP
      isActive = false;
      stopGPS();
      if (trackpoints.length === 0) {
        sendToWatch({ 'UPLOAD_STATUS': 2, 'UPLOAD_MSG': 'No GPS data' });
        return;
      }
      var gpx = buildGPX();
      uploadGPX(gpx);

    } else if (action === 2) {  // PAUSE
      isActive = false;
      // Keep GPS watch running but don't accumulate distance; reset lastPos so
      // the first fix after resume doesn't add a teleport jump.
      lastPos = null;

    } else if (action === 3) {  // RESUME
      isActive = true;
    }
  }
});

// Config page: save tokens returned from OAuth flow
Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL('https://cletqui.github.io/pebble-strava/config/');
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response || e.response === 'CANCELLED') return;
  try {
    var cfg = JSON.parse(decodeURIComponent(e.response));
    if (cfg.access_token) {
      localStorage.setItem('strava_access_token',  cfg.access_token);
      localStorage.setItem('strava_refresh_token', cfg.refresh_token);
      localStorage.setItem('strava_expires_at',    String(cfg.expires_at));
      localStorage.setItem('strava_client_id',     cfg.client_id);
      localStorage.setItem('strava_client_secret', cfg.client_secret);
      console.log('Strava tokens saved');
    }
  } catch (e) {
    console.log('Config parse error: ' + e);
  }
});
