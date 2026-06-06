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
  const workerUrl    = url.searchParams.get('url')    || '';
  const workerSecret = url.searchParams.get('secret') || '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strava GPX Mailer — Setup</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;background:#111;color:#eee;padding:24px 20px;min-height:100vh}
  h1{font-size:20px;color:#ff6600;margin-bottom:6px}
  .sub{font-size:13px;color:#888;margin-bottom:28px}
  label{display:block;font-size:12px;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  input{width:100%;padding:12px;background:#222;border:1px solid #444;border-radius:6px;color:#eee;font-size:15px;margin-bottom:20px;outline:none}
  input:focus{border-color:#ff6600}
  .hint{font-size:12px;color:#666;margin-top:-16px;margin-bottom:20px}
  button{width:100%;padding:14px;background:#ff6600;border:none;border-radius:6px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px}
  button:active{background:#cc5200}
</style>
</head>
<body>
<h1>Strava GPX Mailer</h1>
<p class="sub">Pebble companion setup — settings are stored on your phone.</p>
<label>Cloudflare Worker URL</label>
<input id="url" type="url" placeholder="https://pebble-strava.xxx.workers.dev" value="${workerUrl}">
<p class="hint">Deploy the included worker/ directory to get this URL.</p>
<label>Upload Secret</label>
<input id="secret" type="text" placeholder="your_upload_secret" value="${workerSecret}">
<p class="hint">The UPLOAD_SECRET you set with <code>wrangler secret put</code>.</p>
<button onclick="save()">Save &amp; Close</button>
<script>
function save() {
  var data = {
    workerUrl:    document.getElementById('url').value.trim(),
    workerSecret: document.getElementById('secret').value.trim()
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
  // Shared secret auth — prevents anyone else from sending emails via this Worker
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

  const { gpx, sport, name } = body;
  if (!gpx) return json({ ok: false, error: 'Missing gpx field' }, 400);

  const activityName = name || (sport === 'ride' ? 'Cycling' : 'Running') + ' - Pebble';
  const filename     = activityName.replace(/[^a-z0-9 _-]/gi, '').trim().replace(/ /g, '_') + '.gpx';

  const result = await sendEmail(env, activityName, filename, gpx, sport);
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 500);
  }

  return json({ ok: true });
}

async function sendEmail(env, activityName, filename, gpx, sport) {
  const typeLabel = sport === 'ride' ? 'cycling' : 'running';

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
      text: [
        `Your ${typeLabel} workout is attached as a GPX file.`,
        '',
        'Import to Strava:',
        'https://www.strava.com/upload/select',
        '',
        '— Strava GPX Mailer',
      ].join('\n'),
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
