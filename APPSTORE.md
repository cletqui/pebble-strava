# Pebble App Store — Strava GPX

## Short description (140 chars)

Record runs, rides and walks on your Pebble Time 2. GPS + heart rate saved as GPX on your phone — import into Strava in seconds.

---

## Full description

**Strava GPX** turns your Pebble Time 2 into a standalone GPX workout recorder for cycling, running, and walking. It captures GPS distance, speed/pace, and heart rate, and saves a GPX file directly to your phone's Downloads folder when you stop. No account, no subscription, no cloud dependency — the file is yours immediately.

Import the `.gpx` into Strava, Komoot, Garmin Connect, or any platform that accepts the format. For users who want automatic delivery, an optional Cloudflare Worker can email the file to you the moment the workout ends.

### What it records

- **Elapsed time** — wall-clock accurate, pause/resume supported; active time only in the summary (pauses excluded)
- **Distance** — GPS from your phone, filtered to ignore signal jumps
- **Speed / pace** — km/h or mph for cycling; min/km or min/mi for running and walking
- **Heart rate** — from the Pebble Time 2 built-in HRM, sampled at a configurable interval (1–30 s per sport) and correlated to each GPS track point in the GPX

### Watch UI

**Sport select screen** — choose Cycling, Running, or Walking with UP/DOWN, press SELECT to start. A status line at the bottom shows HRM and GPS fix status (and worker reachability if configured) so you know the sensors are ready before you go.

**Workout screen** — elapsed time (dims gray when paused), distance, speed or pace, heart rate, and a small HRM ✓ / GPS ✓ row. Press SELECT to pause/resume, UP twice within 3 seconds to stop and save, BACK twice to cancel.

### After the workout

When you stop, the app reverse-geocodes your start position and names the activity after the place and time of day (e.g. "Paris Morning Ride"). A GPX file — with full heart rate data embedded at every track point — is saved to `Downloads/` on your phone (or a subfolder of your choice). The watch confirms with a double vibration and auto-returns to the sport select screen.

From there, import the `.gpx` into Strava, Komoot, or any GPX-compatible platform in about 10 seconds. If a Cloudflare Worker is configured, the file is also emailed to you automatically.

### Settings

Accessible via long-press → gear icon in Core Devices:

- **Worker URL + secret** — optional; for automatic email delivery via Cloudflare + Resend
- **Heart rate interval** — 1–30 s slider per sport (cycling / running / walking)
- **GPS accuracy filter** — 15 m strict / 25 m default / 50 m lenient
- **Units** — Metric or Imperial
- **Download subfolder** — save GPX files to a named subfolder inside Downloads/

---

## Requirements and setup

### What you need

- **Core Devices** (`coredevices.coreapp`) — the Rebble Pebble companion app for Android
- **Pebble Strava APK** — the companion app (available on GitHub Releases) that runs the GPS service
- *(Optional)* A **Cloudflare account** (free tier) + **Resend account** (free tier) — only needed for email delivery

### Setup steps

**1. Install the Android companion**

Download the APK from [GitHub Releases](https://github.com/cletqui/pebble-strava/releases) and install it.

Open the app and:
1. Tap **Grant Location Permissions** → choose **Allow all the time**
2. Tap **Disable Battery Optimization** → choose **Allow**

⚠️ Step 2 is required on Android 12+. Without it, Android blocks GPS for background-started services and the app will never get a fix.

**2. Build and install the watch app**

```sh
pebble build
adb push build/pebble-strava.pbw /sdcard/Download/
# Open Files on phone → tap the PBW → open with Core Devices
```

**3. (Optional) Deploy the Cloudflare Worker for email**

```sh
cd worker
bun install
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put UPLOAD_SECRET
bunx wrangler secret put USER_EMAIL
bun run deploy
```

**4. Configure settings**

Long-press **Strava GPX Mailer** in Core Devices → tap the ⚙ gear icon → fill in your Worker URL and secret (if using email), adjust HR intervals, units, and optionally set a download subfolder → Save & Close.

---

## Release notes

### v1.9.0

- **Download subfolder** — new setting to save GPX files into a named subfolder inside Downloads/ (e.g. `pebble-strava/`), keeping workouts organised
- **Status bar cleanup** — the `W` worker indicator is now hidden when no worker is configured; it only appears as `W✓` or `W!` when a worker URL is set
- Android version bump to match watch app (1.9.0)

### v1.8.0

- GPX is now **always saved to phone Downloads** before any upload attempt — no data loss if the worker is unreachable
- Worker URL and secret are now **optional** — the `W` status indicator is hidden when unconfigured
- Heart rate interval changed to **1–30 s sliders** per sport (was fixed presets)
- GPX filename now includes the date: `ActivityName_YYYY-MM-DD.gpx`
- Watch **auto-quits 2.5 s** after a successful save
- MIT LICENSE added

### v1.7.0

- Full settings page with Worker URL, secret, HR intervals (per sport), GPS accuracy filter, and units
- Credential relay: settings stored in watch flash, synced to Android automatically

### v1.6.0 – v1.6.1

- GPS accuracy filter (15 / 25 / 50 m)
- Walking sport added with pace display and 10 s GPS send rate
- Imperial units support (mi, mph, min/mi)

---

## Source code

https://github.com/cletqui/pebble-strava
