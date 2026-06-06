# worker

Cloudflare Worker that receives a GPX workout from the Pebble companion app and
emails it to you via Resend, so you can import it into Strava.

## Setup

### 1. Resend account

1. Create a free account at [resend.com](https://resend.com)
2. Go to **API Keys** → **Create API Key**
3. Keep the key — you'll need it in step 3

On the free tier you can send from `onboarding@resend.dev` to your own account
email only. That's all this Worker needs.

### 2. Install dependencies

```sh
bun install   # or: npm install
```

### 3. Set secrets

```sh
bunx wrangler secret put RESEND_API_KEY   # your Resend API key
bunx wrangler secret put UPLOAD_SECRET    # any random string, e.g. openssl rand -hex 16
bunx wrangler secret put USER_EMAIL       # the email address to send GPX files to
```

`UPLOAD_SECRET` is a shared secret between the Worker and the Pebble companion app.
You will enter it in the in-app settings page after installing the watch app.

### 4. Deploy

```sh
bun run deploy   # or: npm run deploy
```

Wrangler will print your Worker URL:
```
https://pebble-strava.YOUR_SUBDOMAIN.workers.dev
```

Note this URL — you will enter it in the in-app settings page after installing the watch app.

### 5. Verify

```sh
curl https://pebble-strava.YOUR_SUBDOMAIN.workers.dev/
# → {"ok":true,"service":"pebble-strava-worker"}
```

## Endpoints

### `GET /`
Health check. Returns `{ ok: true }`.

### `GET /config`
Serves the in-app configuration page (opened by the Pebble companion when you
tap the Settings gear). Accepts `?url=...&secret=...` query params to pre-fill
current values.

### `POST /upload`

**Headers:**
```
Authorization: Bearer <UPLOAD_SECRET>
Content-Type: application/json
```

**Body:**
```json
{
  "gpx":   "<GPX file content>",
  "sport": "ride",
  "name":  "Cycling 2026-06-06"
}
```

**Response:**
```json
{ "ok": true }
```
or
```json
{ "ok": false, "error": "..." }
```

## Local development

```sh
bun run dev   # or: npm run dev
```

Then test with:
```sh
curl -X POST http://localhost:8787/upload \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"gpx":"<gpx>...</gpx>","sport":"ride","name":"Test ride"}'
```
