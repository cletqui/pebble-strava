# pebble-strava

A Pebble Time 2 app that records cycling and running workouts with GPS and heart rate, then uploads them directly to Strava.

## What it does

- Select Running or Cycling from the watch
- Records elapsed time, GPS distance, speed/pace (from phone GPS), and heart rate (from Pebble Time 2 HRM)
- On stop, builds a GPX file with embedded HR data and uploads it to Strava via the API
- Double-press BACK to stop avoids accidental termination

## Architecture

```
Watch (C)                        Phone (PebbleKit JS)
─────────────────────────────────────────────────────
Sport select + workout UI        GPS watchPosition (high accuracy)
1Hz timer → elapsed time         Haversine distance accumulation
HRM poll every 5s → send HR  →  HR samples stored with timestamps
                             ←  GPS distance + speed + fix status
BACK×2 → CMD_STOP            →  Build GPX with correlated HR + upload
                             ←  UPLOAD_STATUS (success / error)
```

**AppMessage keys** (defined in `package.json` → `messageKeys`):

| Key | Direction | Type | Description |
|-----|-----------|------|-------------|
| `CMD_ACTION` | watch→phone | int8 | 0=start, 1=stop, 2=pause, 3=resume |
| `CMD_SPORT` | watch→phone | int8 | 0=running, 1=cycling (sent with start) |
| `HR_BPM` | watch→phone | int16 | Heart rate in bpm |
| `GPS_DISTANCE` | phone→watch | int32 | Total distance in meters |
| `GPS_SPEED` | phone→watch | int32 | Current speed in cm/s |
| `GPS_HAS_FIX` | phone→watch | int8 | 1 if GPS fix acquired |
| `UPLOAD_STATUS` | phone→watch | int8 | 0=uploading, 1=success, 2=error |
| `UPLOAD_MSG` | phone→watch | cstring | Error message (on failure) |

## Watch UI

**Sport select screen**
- UP → Running, DOWN → Cycling
- SELECT → start workout

**Workout screen**
- Top bar (orange): heart rate + GPS fix status
- Large (white): elapsed time
- Medium (white): distance
- Medium (orange): speed (km/h for cycling) or pace (min/km for running)
- Bottom (gray): current hint or state
- SELECT → pause / resume
- UP → lap vibration
- BACK × 2 (within 3s) → stop and upload

## Strava setup (one time)

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an application.
   Set **Authorization Callback Domain** to `cletqui.github.io`.

2. In the Pebble app on your phone, long-press the app → **Settings**.
   The config page opens in your browser.

3. Enter your **Client ID** and **Client Secret**, then tap **Connect to Strava**.

4. After authorizing, tokens are saved to the companion app's `localStorage`.
   Access tokens auto-refresh when expired.

The config page source is in `config/index.html` — host it on GitHub Pages at
`https://cletqui.github.io/pebble-strava/config/`.

## Building & installing

```sh
pebble build

# Emulator (Pebble Time 2)
pebble install --emulator emery

# Real watch (enable LAN developer connection on watch first)
pebble install --phone <phone-ip>

# Via Rebble cloud (phone must be logged into Rebble)
pebble install --cloudpebble
```

## Target platform

Only **emery** (Pebble Time 2) — the app requires color display and HRM.

## Project layout

```
src/c/pebble-strava.c   Watch app: UI, HRM, state machine, AppMessage
src/pkjs/index.js       Phone companion: GPS, GPX builder, Strava API
config/index.html       OAuth config page (host on GitHub Pages)
package.json            App metadata, UUID, message keys
wscript                 Build rules
```

## Debugging

Watch logs stream via:
```sh
pebble logs --emulator emery   # emulator
pebble logs --phone <ip>       # real watch
```

Key `APP_LOG` entries: workout start/pause/resume/stop with elapsed time and distance,
upload success/error.

Phone companion logs appear in the Pebble app's developer console on the phone.
