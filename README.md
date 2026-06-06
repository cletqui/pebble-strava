# pebble-strava

A Pebble Time 2 app that records cycling and running workouts with GPS and heart rate, then emails you the GPX file so you can import it into Strava.

## How it works

1. Select sport on the watch (Running / Cycling)
2. Workout records elapsed time, GPS distance + speed (from phone), heart rate (from Pebble HRM)
3. On stop, a GPX file with embedded HR data is POSTed to a Cloudflare Worker
4. The Worker emails the GPX to you via Resend
5. You open the email and import the `.gpx` into Strava — takes ~10 seconds

## Architecture

```
Watch (C)                        Phone (PebbleKit JS)
─────────────────────────────────────────────────────
Sport select + workout UI        GPS watchPosition (high accuracy)
1Hz timer → elapsed time         Haversine distance accumulation
HRM poll every 5s → send HR  →  HR samples stored with timestamps
                             ←  GPS distance + speed + fix status
BACK×2 → CMD_STOP            →  Build GPX with correlated HR data
                             →  POST to Cloudflare Worker
                             ←  UPLOAD_STATUS (success / error)

Cloudflare Worker
─────────────────
Receive POST /upload { gpx, sport, name }
└── Send email via Resend with .gpx attachment
```

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
| `UPLOAD_MSG` | phone→watch | cstring | Error message on failure |

## Watch UI

**Sport select** — UP: Running, DOWN: Cycling, SELECT: start

**Workout screen**
- Large (white/gray): elapsed time — dims to gray when paused
- Medium (white): distance
- Medium (orange): speed km/h (cycling) or pace min/km (running)
- Medium (white): heart rate in bpm
- Small (gray): HRM ✓ / GPS ✓ status row
- SELECT: pause / resume — UP: lap vibration — BACK × 2 within 3s: stop

## Setup

### 1. Deploy the Cloudflare Worker

The Worker lives in `worker/`. See `worker/README.md` for deploy instructions.

After deploying, note your Worker URL (`https://pebble-strava.YOUR_SUBDOMAIN.workers.dev`).

### 2. Configure the companion

Build and install the app (step 3), then on your phone:

- Open the **Pebble** app → long-press **Strava Recorder** → tap the **gear icon**
- Enter your Worker URL and Upload Secret
- Tap **Save & Close**

Credentials are stored in phone localStorage — nothing is compiled into the `.pbw`.

### 3. Build and install

```sh
pebble build
pebble install --phone <phone-ip>   # or --emulator emery for testing
```

## Project layout

```
src/c/pebble-strava.c    Watch app: UI, HRM, state machine, AppMessage
src/pkjs/index.js        Phone companion: GPS, GPX builder, Worker upload
package.json             Pebble app metadata, UUID, message keys
wscript                  Pebble build rules
worker/
  src/index.js           Cloudflare Worker: receive GPX, send email via Resend
  wrangler.toml          Worker config and secrets reference
  package.json           Worker dependencies
  README.md              Worker deploy instructions
```

## Building & debugging

```sh
pebble build
pebble install --emulator emery
pebble logs --emulator emery        # watch APP_LOG output
pebble logs --phone <ip>            # on real watch
```

Key log entries: workout start/pause/resume/stop with elapsed time and distance,
upload success/error.

## Why this approach — alternatives considered

During design, several upload targets were evaluated. Notes kept here so future
decisions are informed.

### Strava API (direct upload)
**Rejected.** Strava now requires a paid subscription to access the upload API
(`activity:write` scope). Free accounts can only import manually via the web.

### Garmin Connect as hub (unofficial API)
**Rejected as too fragile.** The appeal: uploading to Garmin Connect would
auto-sync to Strava, Komoot, and GeoVelo (exactly how it worked with a Garmin
device). However, Garmin has no official public upload API. The unofficial
reverse-engineered flow requires:
- A 5-step auth chain: mobile SSO → service ticket → OAuth1 signed exchange →
  OAuth2 DI token → token refresh
- RFC 5849 OAuth1 HMAC-SHA1 signing (non-trivial in JS)
- Anti-bot delays of 10–20s between requests (problematic for CF Workers)
- Cloudflare bot detection that may block datacenter requests
- Consumer key fetched from a public S3 bucket (can change without notice)

This is 300+ lines of fragile code that could silently break at any Garmin
update. Rejected in favour of the simpler email approach.

### Runalyze
**Viable alternative if Strava stops mattering.** Runalyze is the only platform
with a free, documented public GPX upload API (Personal API, token-based, single
POST). Good cycling and running analysis. If you ever want to move off Strava,
switching the Worker to POST to Runalyze instead of sending an email is a
30-minute job.

### Komoot / GeoVelo
Neither has a public activity upload API. Garmin pushes to them via dedicated
integrations, not via Strava. Without Garmin, there is no automated path to
either platform. Both are primarily pre-ride route planning tools anyway; they
don't need to receive every workout.

### Self-hosted Runalyze
Open-source, full data ownership, identical API. Good option if you have a VPS
or home server. The Worker upload code would point at your own instance instead
of runalyze.com.

### Email + manual Strava import (chosen)
The simplest reliable path. The Worker is ~60 lines, the companion change is
minimal, no OAuth, no fragile reverse-engineering. One manual step per workout
(import GPX to Strava, ~10 seconds). If the Worker ever goes down, the GPX is
still in your email archive — no data loss.
