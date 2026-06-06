/* Pebble companion: GPS tracking + GPX upload via CF Worker */

// --- Configuration (fill in after deploying the Worker) ---
var WORKER_URL    = 'https://pebble-strava.YOUR_SUBDOMAIN.workers.dev';
var WORKER_SECRET = 'YOUR_SECRET_HERE';  // must match UPLOAD_SECRET in Worker
// ----------------------------------------------------------

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
function buildGPX(activityName) {
  var date = trackpoints.length > 0
    ? trackpoints[0].time.split('T')[0]
    : new Date().toISOString().split('T')[0];

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Pebble Strava Recorder"\n' +
    '  xmlns="http://www.topografix.com/GPX/1/1"\n' +
    '  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n' +
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
      var date         = new Date().toISOString().split('T')[0];
      var activityName = (sport === 'ride' ? 'Cycling' : 'Running') + ' ' + date;
      var gpx          = buildGPX(activityName);
      uploadToWorker(gpx, activityName);

    } else if (action === 2) {  // PAUSE
      isActive = false;
      // Reset lastPos so the first fix after resume doesn't add a jump
      lastPos = null;

    } else if (action === 3) {  // RESUME
      isActive = true;
    }
  }
});
