package re.clet.pebblestrava

import java.util.UUID

object Constants {
    val APP_UUID: UUID = UUID.fromString("2d64ac7d-a175-4bb0-ba11-8c1997cff52d")

    // AppMessage key indices — must match package.json messageKeys order
    const val KEY_CMD_ACTION    = 0
    const val KEY_CMD_SPORT     = 1
    const val KEY_HR_BPM        = 2
    const val KEY_GPS_DISTANCE  = 3
    const val KEY_GPS_SPEED     = 4
    const val KEY_GPS_HAS_FIX   = 5
    const val KEY_UPLOAD_STATUS = 6
    const val KEY_UPLOAD_MSG    = 7
    const val KEY_CRED_REQUEST  = 8
    const val KEY_CRED_URL      = 9
    const val KEY_CRED_SECRET   = 10
    const val KEY_WORKER_STATUS = 11

    // CMD_ACTION values
    const val CMD_START  = 0
    const val CMD_STOP   = 1
    const val CMD_PAUSE  = 2
    const val CMD_RESUME = 3

    // CMD_SPORT values
    const val SPORT_RUNNING = 0
    const val SPORT_CYCLING = 1

    // UPLOAD_STATUS values
    const val UPLOAD_PENDING = 0
    const val UPLOAD_SUCCESS = 1
    const val UPLOAD_ERROR   = 2

    // WORKER_STATUS values
    const val WORKER_OK    = 1
    const val WORKER_ERROR = 2

    const val PREFS_NAME       = "pebble_strava_prefs"
    const val PREF_WORKER_URL  = "worker_url"
    const val PREF_WORKER_SECRET = "worker_secret"

    const val NOTIF_CHANNEL_ID = "gps_tracking"
    const val NOTIF_ID         = 1

    // GPS send throttle — send every N fixes to reduce BLE traffic
    const val GPS_SEND_EVERY = 10
}
