export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'pebble-strava-worker' });
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

  const { gpx, sport, name, desc, startDate, email } = body;
  if (!gpx)   return json({ ok: false, error: 'Missing gpx field' }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return json({ ok: false, error: 'Missing or invalid email' }, 400);

  const activityName = name || (sport === 'ride' ? 'Cycling' : 'Running') + ' - Pebble';
  const dateSuffix   = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? `_${startDate}` : '';
  const filename     = activityName.replace(/[^a-z0-9 _-]/gi, '').trim().replace(/ /g, '_') + dateSuffix + '.gpx';

  const result = await sendEmail(env, email, activityName, filename, gpx, sport, desc);
  if (!result.ok) {
    return json({ ok: false, error: result.error }, 500);
  }

  return json({ ok: true });
}

async function sendEmail(env, email, activityName, filename, gpx, sport, desc) {
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
      from:    env.RESEND_FROM || 'Pebble <onboarding@resend.dev>',
      to:      email,
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
