# Pebble App Store — Strava Recorder

## Short description (140 chars)

Record runs and rides on your Pebble Time 2. GPS + heart rate logged to GPX, emailed to you for Strava import.

---

## Full description

**Strava Recorder** turns your Pebble Time 2 into a standalone workout tracker for running and cycling. It captures GPS distance, speed/pace, and heart rate, then sends you a GPX file by email so you can import it into Strava (or any platform that accepts GPX).

### What it records

- **Elapsed time** — wall-clock accurate, pause/resume supported
- **Distance** — GPS from your phone, Haversine-filtered to ignore signal jumps
- **Speed / pace** — km/h for cycling, min/km for running
- **Heart rate** — from the Pebble Time 2 built-in HRM, sampled every 5 seconds and correlated to each GPS track point in the GPX

### Watch UI

**Sport select screen** — choose Running or Cycling with UP/DOWN, press SELECT to start. Live HRM and GPS fix status shown at the bottom so you know the sensors are ready before you go.

**Workout screen** — elapsed time (dims gray when paused), distance, speed or pace, heart rate, and a small HRM ✓ / GPS ✓ status line. Press SELECT to pause/resume, BACK twice within 3 seconds to stop.

### After the workout

When you stop, the companion app reverse-geocodes your start location and builds an activity name like "Paris Morning Run". The GPX file — with full HR data at every track point — is emailed to you. Open the email on any device, attach the `.gpx` to Strava's manual import page, and you're done in about 10 seconds.

---

## Requirements and setup

This app requires a small self-hosted backend. The setup is a one-time process.

### What you need

- A **Cloudflare account** (free tier) to deploy the Worker that sends the email
- A **Resend account** (free tier) for the email delivery — free tier allows sending to your own address
- The **Pebble SDK** to build the app from source

### Setup steps

**1. Deploy the Cloudflare Worker**

The Worker is included in the source repository (`worker/`). Deploy it with:

```sh
cd worker
bun install
bunx wrangler secret put RESEND_API_KEY   # from resend.com
bunx wrangler secret put UPLOAD_SECRET    # any random string
bunx wrangler secret put USER_EMAIL       # where to send GPX files
bun run deploy
```

**2. Build and install the watch app**

```sh
pebble build
pebble install --phone <your-phone-ip>
```

**3. Enter your credentials in the app**

Long-press **Strava Recorder** in the Pebble app → tap the gear icon → enter your Worker URL and Upload Secret → Save & Close.

That's it. No credentials are compiled into the app binary — everything is stored on your phone and can be updated at any time through the same settings screen.

---

## Source code

https://github.com/cletqui/pebble-strava
