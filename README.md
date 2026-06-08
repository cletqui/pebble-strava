# Strava GPX Mailer

A Pebble Time 2 watchapp that records running and cycling workouts with GPS and heart rate, then emails you the GPX file for import into Strava.

## How it works

1. Open the Android companion app, grant permissions and disable battery optimization
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
Live elapsed timer (1s tick)     Adaptive GPS rate: 1s/1m active, 5s/10m idle
HRM poll → send HR on change  →  HR samples stored with timestamps
                              ←  GPS distance + speed + fix status (on change only)
UP×2 → CMD_STOP               →  Build GPX with correlated HR data
                              →  POST to Cloudflare Worker
                              ←  UPLOAD_STATUS (success / error)

Phone (PebbleKit JS — config only)
───────────────────────────────────
Settings WebView (Worker URL + secret + HR interval)
Credential relay: phone localStorage ↔ watch flash
Worker status ping on JS ready
HR interval setting → watch persist

Cloudflare Worker
─────────────────
GET  /ping              Bearer auth check (watch status indicator)
GET  /config            Settings page (Worker URL, secret, HR interval)
POST /upload            Receive GPX → send email via Resend
```

### Companion SDK

The Android companion uses **PebbleKit2** (`io.rebble.pebblekit2:client:1.0.0` from JitPack), required for **Core Devices** (`coredevices.coreapp`) — the Rebble replacement for the classic Pebble Android app.

Core Devices binds to `PebbleListenerService` (a `BasePebbleListenerService`) when the watchapp is open, providing `onAppOpened`, `onMessageReceived`, `onAppClosed`. Outbound messages use `DefaultPebbleSender.sendDataToPebble()` (coroutine, returns `TransmissionResult`).

## Requirements

- Pebble Time 2 (emery platform)
- Android phone with **Core Devices** (`coredevices.coreapp`) — the Rebble Pebble app
- **Pebble Strava companion APK** (required for GPS)
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
```

Install via file manager — `pebble install --phone <ip>` does not work with Core Devices:

```sh
adb push build/pebble-strava.pbw /sdcard/Download/
# then open Files on phone → tap the PBW → open with Core Devices
```

### 3. Install the Android companion app

Build or download from [GitHub Releases](../../releases):

```sh
cd android
# Requires Java 21 (SDKMAN: sdk use java 21.0.5-tem) and Android SDK
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

First-time setup (do this **before** opening the watchapp):

1. Open **Pebble Strava** on your phone
2. Tap **Grant Location Permissions** → choose **Allow all the time**
3. Tap **Disable Battery Optimization** → choose **Allow**  
   ⚠ Required on Android 12+. Without it, Android blocks GPS for foreground services started from a background context (Core Devices binding). The app will register GPS but never receive fixes.
4. The GPS service starts automatically once both steps are done.

The service auto-starts on device reboot.

### 4. Configure credentials

Long-press **Strava GPX Mailer** in Core Devices → tap the ⚙ gear icon → enter your Worker URL and Upload Secret → **Save & Close**.

You can also adjust the **Heart Rate Send Interval** (5 / 10 / 15 / 30s) here. Lower values give smoother HR data; higher values extend watch battery life.

Credentials are stored in watch persistent flash memory and relayed to the Android companion automatically — no separate Android configuration needed.

## Usage

1. Open the **Pebble Strava** companion app on your phone first (ensures GPS starts from foreground)
2. Open the watchapp on your Pebble
3. Wait for `W✓ HRM✓ GPS✓` on the select screen — all three within ~30s outdoors
4. Press SELECT to start a workout
5. UP × 2 within 3s: stop and upload; BACK × 2: cancel

## Watch UI

**Sport select screen** — UP: Running, DOWN: Cycling, SELECT: start.

Status line at the bottom:
- `Open companion app` — shown when the companion hasn't responded yet
- `W✓/!/? HRM✓/-- GPS✓/--` — once connected: Worker reachable, HRM available, GPS fix

**Workout screen**
- Large (white): elapsed time, ticking every second — dims to gray when paused
- Medium (white): distance in km
- Medium (orange): speed km/h (cycling) or pace min/km (running)
- Medium (white): heart rate in bpm
- Small (gray): `HRM ✓ GPS ✓` status row
- SELECT: pause / resume
- UP × 2 within 3s: stop and upload
- BACK × 2 within 3s: cancel (discard workout)

After stopping, upload status is shown on the workout screen. Double vibration = email sent.

## AppMessage keys

Auto-generated by the Pebble SDK starting at base **10000** (array format in `package.json`).

| Key | Value | Direction | Type | Description |
|-----|-------|-----------|------|-------------|
| `CMD_ACTION` | 10000 | watch→companion | int8 | 0=start 1=stop 2=pause 3=resume |
| `CMD_SPORT` | 10001 | watch→companion | int8 | 0=running 1=cycling |
| `HR_BPM` | 10002 | watch→companion | int16 | Heart rate in bpm |
| `GPS_DISTANCE` | 10003 | companion→watch | int32 | Total distance in meters |
| `GPS_SPEED` | 10004 | companion→watch | int32 | Speed in cm/s |
| `GPS_HAS_FIX` | 10005 | companion→watch | int8 | 1=fix acquired |
| `UPLOAD_STATUS` | 10006 | companion→watch | int8 | 0=pending 1=success 2=error |
| `UPLOAD_MSG` | 10007 | companion→watch | cstring | Status/error text |
| `CRED_REQUEST` | 10008 | companion→watch | int8 | Request credentials from watch |
| `CRED_URL` | 10009 | watch↔PKJS | cstring | Worker URL |
| `CRED_SECRET` | 10010 | watch↔PKJS | cstring | Upload secret |
| `WORKER_STATUS` | 10011 | companion→watch | int8 | 1=ok 2=error |
| `SETTINGS_HR_INTERVAL` | 10012 | PKJS→watch | int8 | HR send interval in seconds (5/10/15/30) |

> `Constants.kt` must use 10000–10012. `DefaultPebbleSender` passes keys verbatim — no offset is applied by the library. After any `messageKeys` change in `package.json`, run `pebble clean && pebble build` (incremental build won't regenerate `message_keys.auto.c`).

## Project layout

```
src/c/pebble-strava.c      Watch app: UI, HRM, state machine, AppMessage
src/pkjs/index.js          Phone JS: config page + credential relay + worker ping + HR interval
resources/icons.ttf        Font subset: ▲ ▶ ▼ ✓ ◀ ■ + ASCII
package.json               App metadata, UUID, capabilities, messageKeys, companionApp
worker/src/index.js        Cloudflare Worker: /ping, /config, /upload → Resend
worker/wrangler.toml       Worker config
android/                   GPS companion Android app (Kotlin)
  app/src/main/java/re/clet/pebblestrava/
    GpsService.kt          Foreground service: adaptive GPS, trackpoints, GPX build, upload
    PebbleListenerService.kt  BasePebbleListenerService: receives watch commands
    PebbleMessenger.kt     DefaultPebbleSender wrapper: sends GPS/status/creds to watch
    MainActivity.kt        Permission setup, battery opt, GPS status display
    BootReceiver.kt        Auto-start service after reboot
    Constants.kt           AppMessage keys (10000–10012) + prefs keys + app UUID
```

## Building & debugging

```sh
# Watch app
pebble build
pebble logs --phone <ip>            # real watch logs

# After any package.json messageKeys change:
pebble clean && pebble build

# Android companion
cd android
# Requires: Java 21 (SDKMAN), Android SDK
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat | grep -E "(GpsService|PebbleListener|PebbleMessenger)"
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

### `pebble install --phone` doesn't work with Core Devices

Core Devices does not open port 9000. Install via file manager only.

### Battery optimization must be disabled (Android 12+)

Android 12 blocks location for foreground services started from the background. Core Devices binding to `PebbleListenerService` is a background context — without the battery optimization exemption, GPS registers but delivers at most 1–2 cached fixes then stops permanently.

Logcat signature: `W ActivityManager: Foreground service started from background can not have location/camera/microphone access`.

### Strava direct upload

Strava's upload API (`activity:write`) requires a paid subscription. The email + manual import approach is the only free path.

## Why email — alternatives considered

### Garmin Connect (unofficial API)
Attractive because Garmin auto-syncs to Strava, Komoot, and GeoVelo. Rejected: no official API, the reverse-engineered flow requires a 5-step OAuth1/OAuth2 chain, 10–20s anti-bot delays, and a consumer key fetched from a public S3 bucket that can change without notice.

### Runalyze
Viable alternative. Free documented public GPX upload API (Personal API, token-based, single POST). Switching the Worker from email to Runalyze POST is a ~30-minute job.

### Gadgetbridge
[Gadgetbridge](https://gadgetbridge.org/) supports modern Android location APIs natively and doesn't need a companion app. However, pairing reliability on Pebble Time 2 varies and it adds management overhead.
