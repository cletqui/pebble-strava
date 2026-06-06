export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'pebble-strava-worker' });
    }

    if (request.method === 'POST' && url.pathname === '/upload') {
      return handleUpload(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

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
        '— Pebble Strava Recorder',
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
