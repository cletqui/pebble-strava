# Strava GPX Mailer

A Pebble Time 2 watchapp that records running and cycling workouts with GPS and heart rate, then emails you the GPX file for import into Strava.

## How it works

1. Select sport on the watch (Running / Cycling)
2. Workout records elapsed time, GPS distance + speed (from phone), heart rate (from Pebble HRM)
3. On stop, a GPX file with embedded HR data is POSTed to a Cloudflare Worker
4. The Worker emails the GPX to you via Resend
5. Open the email, import the `.gpx` into Strava — ~10 seconds

## Architecture

```
Watch (C)                        Phone (PebbleKit JS)
─────────────────────────────────────────────────────
Sport select + workout UI        GPS watchPosition (high accuracy)
Wall-clock elapsed tracking      Haversine distance accumulation
HRM poll every 5s → send HR  →  HR samples stored with timestamps
                             ←  GPS distance + speed + fix status
BACK×2 → CMD_STOP            →  Build GPX with correlated HR data
                             →  POST to Cloudflare Worker
                             ←  UPLOAD_STATUS (success / error)

Cloudflare Worker
─────────────────
GET  /ping              Bearer auth check (watch status indicator)
GET  /config            Settings page (pre-filled from query params)
POST /upload            Receive GPX → send email via Resend
```

## Watch UI

**Sport select screen** — UP: Running, DOWN: Cycling, SELECT: start.  
Status line at the bottom shows `W✓/!/? HRM✓/-- GPS✓/--` before starting.

**Workout screen**
- Large (white/gray): elapsed time — dims to gray when paused
- Medium (white): distance in km
- Medium (orange): speed km/h (cycling) or pace min/km (running)
- Medium (white): heart rate in bpm
- Small (gray): HRM ✓ / GPS ✓ status row
- SELECT: pause / resume — UP: lap vibration — BACK × 2 within 3s: stop

After stopping, upload status and any error are shown on the workout screen.

## AppMessage keys

| Key | Direction | Type | Description |
|-----|-----------|------|-------------|
| `CMD_ACTION` | watch→phone | int8 | 0=start, 1=stop, 2=pause, 3=resume |
| `CMD_SPORT` | watch→phone | int8 | 0=running, 1=cycling |
| `HR_BPM` | watch→phone | int16 | Heart rate in bpm |
| `GPS_DISTANCE` | phone→watch | int32 | Total distance in meters |
| `GPS_SPEED` | phone→watch | int32 | Current speed in cm/s |
| `GPS_HAS_FIX` | phone→watch | int8 | 1 if GPS fix acquired |
| `UPLOAD_STATUS` | phone→watch | int8 | 0=uploading, 1=success, 2=error |
| `UPLOAD_MSG` | phone→watch | cstring | Status / error message |
| `CRED_REQUEST` | watch→phone | int8 | Watch requests credentials from phone |
| `CRED_URL` | phone→watch | cstring | Worker URL (persisted to watch flash) |
| `CRED_SECRET` | phone→watch | cstring | Upload secret (persisted to watch flash) |
| `WORKER_STATUS` | phone→watch | int8 | 1=reachable, 2=error |

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

Note the Worker URL from wrangler output.

### 2. Build and install

Requires the [Pebble SDK](https://developer.rebble.io/developer.pebble.com/sdk/install/index.html).

```sh
pebble build
pebble install --phone <phone-ip>   # enable Developer Mode in the Pebble app
```

### 3. Configure credentials

Long-press **Strava GPX Mailer** in the Pebble app → tap the ⚙ gear icon → enter your Worker URL and Upload Secret → **Save & Close**.

Credentials are stored in watch persistent flash memory and survive reinstalls. The settings page is hosted by the Worker itself (pre-filled on reopen).

## Project layout

```
src/c/pebble-strava.c      Watch app: UI, HRM, state machine, AppMessage
src/pkjs/index.js          Phone companion: GPS, GPX builder, Worker upload
src/pkjs/config.example.js Template for local credential override (gitignored config.js)
resources/icons.ttf        Font subset: ▲ ▶ ▼ ✓ + ASCII (DejaVu Sans)
package.json               App metadata, UUID, capabilities, message keys
worker/src/index.js        Cloudflare Worker: /ping, /config, /upload → Resend email
worker/wrangler.toml       Worker config
```

## Building & debugging

```sh
pebble build
pebble install --emulator emery
pebble logs --emulator emery        # APP_LOG output
pebble logs --phone <ip>            # real watch
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

## Roadmap

### Next — Android companion app (GPS fix)

`navigator.geolocation.watchPosition` in the official Pebble Android app silently drops callbacks on Android 10+. The old APK does not declare `ACCESS_BACKGROUND_LOCATION`, which Android 10+ requires for location callbacks from background services. The GPS request reaches Android (location indicator appears) but the result is never returned to JS.

**Fix:** build a small PebbleKit Android companion app (`android/`) — a foreground service that gets GPS via modern Android location APIs and sends coordinates to the watch via PebbleKit intents. PKJS stays for config and GPX upload; the companion handles GPS only. Distributable as an APK via GitHub Releases, F-Droid-compatible (PebbleKit uses Android Intents, not Google Play Services).

### Secondary — Gadgetbridge

[Gadgetbridge](https://gadgetbridge.org/) is an open-source replacement for the Pebble Android app that supports modern Android location APIs. GPS would work with Gadgetbridge without any code changes. Useful fallback if the companion app approach is not desired.

### Known limitation — Strava direct upload

Strava's upload API (`activity:write`) requires a paid subscription. The email + manual import approach is the only free path.

## Why email — alternatives considered

### Garmin Connect (unofficial API)
Attractive because Garmin auto-syncs to Strava, Komoot, and GeoVelo. Rejected: no official API, the reverse-engineered flow requires a 5-step OAuth1/OAuth2 chain, 10–20s anti-bot delays, and a consumer key fetched from a public S3 bucket that can change without notice. ~300 lines of fragile code.

### Runalyze
Viable alternative. Free documented public GPX upload API (Personal API, token-based, single POST). Switching the Worker from email to Runalyze POST is a ~30-minute job. Good option if Strava stops mattering or for self-hosted deployments.

### Komoot / GeoVelo
No public activity upload API. Only reachable via Garmin integrations.

### Email + manual import (chosen)
Worker is ~60 lines, no OAuth, no fragile reverse-engineering. One manual step per workout (~10 seconds to import). GPX stays in your email archive as a backup.
