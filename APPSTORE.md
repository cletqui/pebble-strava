# Pebble App Store — Strava GPX Mailer

## Short description (140 chars)

Record runs and rides on your Pebble Time 2. GPS + heart rate logged to GPX, emailed to you for Strava import.

---

## Full description

**Strava GPX Mailer** turns your Pebble Time 2 into a standalone workout tracker for running and cycling. It captures GPS distance, speed/pace, and heart rate, then sends you a GPX file by email so you can import it into Strava (or any platform that accepts GPX).

⚠️ **This app requires self-hosted infrastructure to work** — a free Cloudflare Worker and a free Resend email account. See the Setup section below.

### What it records

- **Elapsed time** — wall-clock accurate, pause/resume supported
- **Distance** — GPS from your phone, filtered to ignore signal jumps
- **Speed / pace** — km/h for cycling, min/km for running
- **Heart rate** — from the Pebble Time 2 built-in HRM, sampled every 5 seconds and correlated to each GPS track point in the GPX

### Watch UI

**Sport select screen** — choose Running or Cycling with UP/DOWN, press SELECT to start. Live HRM and GPS fix status shown at the bottom so you know the sensors are ready before you go.

**Workout screen** — elapsed time (dims gray when paused), distance, speed or pace, heart rate, and a small HRM ✓ / GPS ✓ status row. Press SELECT to pause/resume, BACK twice within 3 seconds to stop.

### After the workout

When you stop, the app reverse-geocodes your start location and names the activity after the place and time of day (e.g. "Paris Morning Run"). The GPX file — with full heart rate data at every track point — is emailed to you. Open the email on any device, import the `.gpx` into Strava, and you're done in about 10 seconds.

---

## Requirements and setup

### What you need

- A **Cloudflare account** (free tier) — hosts the Worker that sends the email
- A **Resend account** (free tier) — delivers the email with the GPX attachment; free tier allows sending to your own address
- The **Pebble SDK** to build the app from source

### Setup steps

**1. Deploy the Cloudflare Worker**

Clone the repository and deploy the Worker:

```sh
cd worker
bun install
bunx wrangler secret put RESEND_API_KEY   # from resend.com → API Keys
bunx wrangler secret put UPLOAD_SECRET    # any random string, e.g. openssl rand -hex 16
bunx wrangler secret put USER_EMAIL       # your email address
bun run deploy
```

Note the Worker URL printed by wrangler (`https://pebble-strava.YOUR_SUBDOMAIN.workers.dev`).

**2. Build and install the watch app**

```sh
pebble build
pebble install --phone <your-phone-ip>
```

Enable Developer Mode in the Pebble app to find your phone's IP address.

**3. Enter your credentials in the app**

Long-press **Strava GPX Mailer** in the Pebble app → tap the ⚙ gear icon → enter your Worker URL and Upload Secret → Save & Close.

No credentials are compiled into the app — everything is stored on your phone and can be updated at any time via the same settings screen.

---

## Source code

https://github.com/cletqui/pebble-strava
