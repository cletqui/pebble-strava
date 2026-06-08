export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'pebble-strava-worker' });
    }

    if (request.method === 'GET' && url.pathname === '/config') {
      return serveConfig(url);
    }

    if (request.method === 'GET' && url.pathname === '/ping') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.UPLOAD_SECRET}`) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/upload') {
      return handleUpload(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

function serveConfig(url) {
  const workerUrl    = url.searchParams.get('url')         || '';
  const workerSecret = url.searchParams.get('secret')      || '';
  const hrCycling    = url.searchParams.get('hrCycling')   || '5';
  const hrRunning    = url.searchParams.get('hrRunning')   || '5';
  const hrWalking    = url.searchParams.get('hrWalking')   || '15';
  const gpsAccuracy  = url.searchParams.get('gpsAccuracy') || '25';
  const units        = url.searchParams.get('units')       || '0';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strava GPX Mailer</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#eee;padding:24px 20px;min-height:100vh}
  h1{font-size:20px;color:#fc4c02;margin-bottom:4px}
  .sub{font-size:13px;color:#777;margin-bottom:28px}
  .section{background:#1a1a1a;border-radius:10px;padding:16px;margin-bottom:16px}
  .section-title{font-size:11px;color:#fc4c02;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;font-weight:600}
  label{display:block;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;margin-top:12px}
  label:first-of-type{margin-top:0}
  input,select{width:100%;padding:11px 12px;background:#252525;border:1px solid #3a3a3a;border-radius:8px;color:#eee;font-size:15px;outline:none;-webkit-appearance:none}
  input:focus,select:focus{border-color:#fc4c02}
  .hint{font-size:12px;color:#555;margin-top:8px;line-height:1.4}
  button{width:100%;padding:14px;background:#fc4c02;border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px;letter-spacing:.02em}
  button:active{background:#d94000}
</style>
</head>
<body>
<h1>Strava GPX Mailer</h1>
<p class="sub">Setup &amp; Preferences</p>

<div class="section">
<p class="section-title">Worker</p>
<label>Worker URL</label>
<input id="url" type="url" placeholder="https://pebble-strava.xxx.workers.dev" value="${workerUrl}">
<p class="hint">From <code>wrangler deploy</code> output.</p>
<label>Upload Secret</label>
<input id="secret" type="text" placeholder="your_upload_secret" value="${workerSecret}">
<p class="hint">The UPLOAD_SECRET set with <code>wrangler secret put</code>.</p>
</div>

<div class="section">
<p class="section-title">Heart Rate Interval</p>
<label>Cycling</label>
<select id="hr-c">
<option value="5">5 s — most responsive</option>
<option value="10">10 s</option>
<option value="15">15 s</option>
<option value="30">30 s — best battery</option>
</select>
<label>Running</label>
<select id="hr-r">
<option value="5">5 s — most responsive</option>
<option value="10">10 s</option>
<option value="15">15 s</option>
<option value="30">30 s — best battery</option>
</select>
<label>Walking</label>
<select id="hr-w">
<option value="5">5 s</option>
<option value="10">10 s</option>
<option value="15">15 s — recommended</option>
<option value="30">30 s — best battery</option>
</select>
<p class="hint">How often the watch reads &amp; sends HR to the companion. Lower = smoother data, higher = longer battery.</p>
</div>

<div class="section">
<p class="section-title">GPS</p>
<label>Accuracy Filter</label>
<select id="gps">
<option value="15">Strict — 15 m (open terrain)</option>
<option value="25">Default — 25 m</option>
<option value="50">Lenient — 50 m (urban areas)</option>
</select>
<p class="hint">Fixes worse than this threshold are dropped when recording. Use lenient in urban canyons to keep more points.</p>
</div>

<div class="section">
<p class="section-title">Display</p>
<label>Units</label>
<select id="units">
<option value="0">Metric — km, km/h, min/km</option>
<option value="1">Imperial — mi, mph, min/mi</option>
</select>
</div>

<button onclick="save()">Save &amp; Close</button>
<script>
document.getElementById('hr-c').value = '${hrCycling}';
document.getElementById('hr-r').value = '${hrRunning}';
document.getElementById('hr-w').value = '${hrWalking}';
document.getElementById('gps').value  = '${gpsAccuracy}';
document.getElementById('units').value = '${units}';
function save() {
  var data = {
    workerUrl:    document.getElementById('url').value.trim(),
    workerSecret: document.getElementById('secret').value.trim(),
    hrCycling:    document.getElementById('hr-c').value,
    hrRunning:    document.getElementById('hr-r').value,
    hrWalking:    document.getElementById('hr-w').value,
    gpsAccuracy:  document.getElementById('gps').value,
    units:        document.getElementById('units').value,
  };
  location.href = 'pebblejs://close#' + encodeURIComponent(JSON.stringify(data));
}
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=utf-8' },
  });
}

async function handleUpload(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.UPLOAD_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { gpx, sport, name, desc } = body;
  if (!gpx) return json({ ok: false, error: 'Missing gpx field' }, 400);

  const activityName = name || (sport === 'ride' ? 'Cycling' : 'Running') + ' - Pebble';
  const filename     = activityName.replace(/[^a-z0-9 _-]/gi, '').trim().replace(/ /g, '_') + '.gpx';

  const result = await sendEmail(env, activityName, filename, gpx, sport, desc);
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 500);
  }

  return json({ ok: true });
}

async function sendEmail(env, activityName, filename, gpx, sport, desc) {
  const typeLabel = sport === 'ride' ? 'cycling' : sport === 'walk' ? 'walking' : 'running';

  const lines = [
    `Your ${typeLabel} activity is attached as a GPX file.`,
  ];
  if (desc) lines.push('', desc);
  lines.push(
    '',
    'Import to Strava:',
    'https://www.strava.com/upload/select',
    '',
    '— Pebble Time 2',
  );

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'Pebble <onboarding@resend.dev>',
      to:      env.USER_EMAIL,
      subject: activityName,
      text:    lines.join('\n'),
      attachments: [{
        filename: filename,
        content:  btoa(gpx),
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', res.status, err);
    return { ok: false, error: `Email failed: ${res.status}` };
  }

  return { ok: true };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
