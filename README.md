# Strava GPX Mailer

A Pebble Time 2 watchapp that records running and cycling workouts with GPS and heart rate, then emails you the GPX file for import into Strava.

## How it works

1. Install the Android companion app (GPS fix for Android 10+)
2. Select sport on the watch — Running or Cycling
3. Workout records elapsed time, GPS distance + speed, heart rate
4. On stop, a GPX file with embedded HR data is POSTed to a Cloudflare Worker
5. The Worker emails the GPX to you via Resend
6. Open the email, import the `.gpx` into Strava — ~10 seconds

## Architecture

```
Watch (C)                        Android companion (Kotlin)
──────────────────────────────────────────────────────────────
Sport select + workout UI        ForegroundService + LocationManager GPS
Wall-clock elapsed tracking      Haversine distance accumulation
HRM poll every 5s → send HR  →  HR samples stored with timestamps
                             ←  GPS distance + speed + fix status
UP×2 → CMD_STOP              →  Build GPX with correlated HR data
                             →  POST to Cloudflare Worker
                             ←  UPLOAD_STATUS (success / error)

Phone (PebbleKit JS — config only)
───────────────────────────────────
Settings WebView (Worker URL + secret)
Credential relay: phone localStorage ↔ watch flash

Cloudflare Worker
─────────────────
GET  /ping              Bearer auth check (watch status indicator)
GET  /config            Settings page (pre-filled from query params)
POST /upload            Receive GPX → send email via Resend
```

## Requirements

- Pebble Time 2 (emery platform)
- Android phone with the official Pebble app
- **Pebble Strava companion APK** (required for GPS on Android 10+)
- A Cloudflare Worker (free tier) + Resend account (free tier, 3k emails/month)

## Setup

### 1. Deploy the Cloudflare Worker

```sh
cd worker
bun install
bunx wrangler secret put RESEND_API_KEY   # from resend.com → API Keys
bunx wrangler secret put UPLOAD_SECRET    # any random string: openssl rand -hex 16
bunx wrangler secret put USER_EMAIL       # your email address
bun run deploy
```

Note the Worker URL from wrangler output (e.g. `https://pebble-strava.xxx.workers.dev`).

### 2. Build and install the watchapp

Requires the [Pebble SDK](https://developer.rebble.io/developer.pebble.com/sdk/install/index.html).

```sh
pebble build
pebble install --phone <phone-ip>   # enable Developer Mode in the Pebble app
```

### 3. Install the Android companion app

Download the latest `pebble-strava-companion-*.apk` from [GitHub Releases](../../releases).

1. Enable **Install unknown apps** for your browser or file manager in Android Settings → Apps
2. Open the APK and install
3. Open **Pebble Strava** → tap **Grant Location Permissions** → choose **Allow all the time**
4. Tap **Start GPS Service**

The foreground service starts automatically when your phone boots.

### 4. Configure credentials

Long-press **Strava GPX Mailer** in the Pebble app → tap the ⚙ gear icon → enter your Worker URL and Upload Secret → **Save & Close**.

Credentials are stored in watch persistent flash memory. The Android companion retrieves them automatically via AppMessage on first launch — no separate configuration needed.

## Watch UI

**Sport select screen** — UP: Running, DOWN: Cycling, SELECT: start.  
Status line at the bottom shows `W✓/!/? HRM✓/-- GPS✓/--` before starting.

**Workout screen**
- Large (white/gray): elapsed time — dims to gray when paused
- Medium (white): distance in km
- Medium (orange): speed km/h (cycling) or pace min/km (running)
- Medium (white): heart rate in bpm
- Small (gray): HRM ✓ / GPS ✓ status row
- SELECT: pause / resume
- UP × 2 within 3s: stop and upload
- BACK × 2 within 3s: cancel (discard workout)

After stopping, upload status is shown on the workout screen. A double vibration means the email was sent successfully.

## AppMessage keys

| Key | Direction | Type | Description |
|-----|-----------|------|-------------|
| `CMD_ACTION` | watch→companion | int8 | 0=start, 1=stop, 2=pause, 3=resume |
| `CMD_SPORT` | watch→companion | int8 | 0=running, 1=cycling |
| `HR_BPM` | watch→companion | int16 | Heart rate in bpm |
| `GPS_DISTANCE` | companion→watch | int32 | Total distance in meters |
| `GPS_SPEED` | companion→watch | int32 | Current speed in cm/s |
| `GPS_HAS_FIX` | companion→watch | int8 | 1 if GPS fix acquired |
| `UPLOAD_STATUS` | companion→watch | int8 | 0=uploading, 1=success, 2=error |
| `UPLOAD_MSG` | companion→watch | cstring | Status / error message |
| `CRED_REQUEST` | companion→watch | int8 | Companion requests credentials |
| `CRED_URL` | watch↔PKJS | cstring | Worker URL (persisted to watch flash) |
| `CRED_SECRET` | watch↔PKJS | cstring | Upload secret (persisted to watch flash) |
| `WORKER_STATUS` | companion→watch | int8 | 1=reachable, 2=error |

## Project layout

```
src/c/pebble-strava.c      Watch app: UI, HRM, state machine, AppMessage
src/pkjs/index.js          Phone JS: config page + credential relay only
resources/icons.ttf        Font subset: ▲ ▶ ▼ ✓ + ASCII (DejaVu Sans)
package.json               App metadata, UUID, capabilities, message keys
worker/src/index.js        Cloudflare Worker: /ping, /config, /upload → Resend
worker/wrangler.toml       Worker config
android/                   GPS companion Android app (Kotlin)
  app/src/main/java/re/clet/pebblestrava/
    GpsService.kt          Foreground service: GPS, GPX, upload
    MainActivity.kt        Permission setup, service control
    PebbleMessenger.kt     PebbleKit send helpers
    Constants.kt           AppMessage key indices + app UUID
```

## Building & debugging

```sh
# Watch app
pebble build
pebble install --emulator emery
pebble logs --emulator emery        # APP_LOG output
pebble logs --phone <ip>            # real watch

# Android companion
cd android
./gradlew assembleDebug             # outputs android/app/build/outputs/apk/debug/
./gradlew assembleRelease           # outputs release APK
```

### Emulator clean (if install fails)

```sh
kill -9 $(cat /tmp/pb-emulator.json 2>/dev/null | python3 -c \
  "import sys,json; d=json.load(sys.stdin); [print(p['qemu']['pid'], p['pypkjs']['pid']) \
  for p in d.values() if isinstance(p, dict) and '4.9.169' in p]" 2>/dev/null) 2>/dev/null
pkill -9 -f qemu-pebble; pkill -9 -f pypkjs
rm -f /tmp/pb-emulator.json
rm -rf ~/.local/share/pebble-sdk/4.9.169/emery/qemu_spi_flash.bin \
       ~/.local/share/pebble-sdk/4.9.169/emery/app_cache \
       ~/.local/share/pebble-sdk/4.9.169/emery/timeline.db
```

## Known limitations

### GPS on Android 10+ (solved by companion app)

`navigator.geolocation` in the official Pebble APK silently drops callbacks on Android 10+ because the old APK does not declare `ACCESS_BACKGROUND_LOCATION`. The Android companion app declares this permission and uses the native LocationManager in a foreground service, which works correctly on Android 10–16.

### Strava direct upload

Strava's upload API (`activity:write`) requires a paid subscription. The email + manual import approach is the only free path.

## Why email — alternatives considered

### Garmin Connect (unofficial API)
Attractive because Garmin auto-syncs to Strava, Komoot, and GeoVelo. Rejected: no official API, the reverse-engineered flow requires a 5-step OAuth1/OAuth2 chain, 10–20s anti-bot delays, and a consumer key fetched from a public S3 bucket that can change without notice.

### Runalyze
Viable alternative. Free documented public GPX upload API (Personal API, token-based, single POST). Switching the Worker from email to Runalyze POST is a ~30-minute job. Good option if Strava stops mattering or for self-hosted deployments.

### Gadgetbridge
[Gadgetbridge](https://gadgetbridge.org/) is an open-source replacement for the Pebble Android app that supports modern Android location APIs. GPS would work with Gadgetbridge without a companion app. However, Gadgetbridge is a full Pebble app replacement — pairing is not always reliable on Pebble Time 2 and it adds management overhead. The native companion app is the preferred path.

### Komoot / GeoVelo
No public activity upload API. Only reachable via Garmin integrations.
