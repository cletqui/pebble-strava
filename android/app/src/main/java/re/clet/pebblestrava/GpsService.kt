package re.clet.pebblestrava

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.*

class GpsService : Service() {

    data class Trackpoint(val lat: Double, val lon: Double, val alt: Double, val time: Long)
    data class HrSample(val hr: Int, val ts: Long)

    private lateinit var locationManager: LocationManager
    private lateinit var messenger: PebbleMessenger
    private var gpsStarted    = false
    private var gpsRateActive = false          // true = active recording rate (1s/1m)
    private var lastGpsFix: Boolean? = null    // last fix state sent to watch; null = never sent

    companion object {
        private const val TAG = "GpsService"
        const val ACTION_PEBBLE_DATA = "re.clet.pebblestrava.PEBBLE_DATA"
        const val ACTION_STOP_SELF   = "re.clet.pebblestrava.STOP_SELF"
        const val EXTRA_CMD_ACTION   = "cmd_action"
        const val EXTRA_CMD_SPORT    = "cmd_sport"
        const val EXTRA_HR_BPM       = "hr_bpm"
        const val EXTRA_CRED_URL     = "cred_url"
        const val EXTRA_CRED_SECRET  = "cred_secret"
    }

    @Volatile private var isUploading = false

    // Credential retry — resends CRED_REQUEST every 5 s until creds arrive or service stops.
    // No retry cap: if the user opens the watch app late, the next send will succeed.
    private val credRetryHandler = Handler(Looper.getMainLooper())
    private val credRetryRunnable: Runnable = object : Runnable {
        override fun run() {
            if ((prefs().getString(Constants.PREF_WORKER_URL, "") ?: "").isNotEmpty()) return
            Log.d(TAG, "Credential request retry")
            messenger.sendCredRequest()
            credRetryHandler.postDelayed(this, 5000)
        }
    }

    private val trackpoints = mutableListOf<Trackpoint>()
    private val hrSamples   = mutableListOf<HrSample>()

    private var isActive   = false
    private var sport      = Constants.SPORT_RUNNING
    private var totalDistM = 0.0
    private var lastLat    = Double.NaN
    private var lastLon    = Double.NaN
    private var gpsTick    = 0

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) = handleLocation(loc)
        @Deprecated("Deprecated in API 29") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {
            sendGpsFixIfChanged(false)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "onCreate")
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        messenger = PebbleMessenger(this)
        createNotificationChannel()
        ServiceCompat.startForeground(
            this,
            Constants.NOTIF_ID,
            buildNotification("Waiting for Pebble…"),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
        )
        requestCredentials()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand action=${intent?.action} gpsStarted=$gpsStarted")

        if (intent?.action == ACTION_STOP_SELF) {
            if (!isUploading) stopSelf()
            // If uploading, the finally block in uploadAsync() will call stopSelf() when done.
            return START_NOT_STICKY
        }

        if (!gpsStarted) startGps()

        if (intent?.action == ACTION_PEBBLE_DATA) {
            val cmdAction = intent.getIntExtra(EXTRA_CMD_ACTION, -1)
            if (cmdAction >= 0) {
                val sportVal = intent.getIntExtra(EXTRA_CMD_SPORT, Constants.SPORT_RUNNING)
                handleCmd(cmdAction, sportVal)
            }
            val hr = intent.getIntExtra(EXTRA_HR_BPM, 0)
            if (hr > 0) hrSamples.add(HrSample(hr, System.currentTimeMillis()))

            val url    = intent.getStringExtra(EXTRA_CRED_URL)
            val secret = intent.getStringExtra(EXTRA_CRED_SECRET)
            if (url != null || secret != null) {
                // Credentials received from watch — cancel any pending retry
                credRetryHandler.removeCallbacks(credRetryRunnable)
                if (url    != null) prefs().edit().putString(Constants.PREF_WORKER_URL,    url).apply()
                if (secret != null) prefs().edit().putString(Constants.PREF_WORKER_SECRET, secret).apply()
                val u = url    ?: prefs().getString(Constants.PREF_WORKER_URL,    "") ?: ""
                val s = secret ?: prefs().getString(Constants.PREF_WORKER_SECRET, "") ?: ""
                if (u.isNotEmpty() && s.isNotEmpty()) pingWorker(u, s)
            }
        } else {
            // Started by onAppOpened or MainActivity — (re-)request credentials.
            // This fires every time the watch app opens, ensuring we request creds even
            // when the service was already running from a previous MainActivity start.
            requestCredentials()
        }

        return START_STICKY
    }

    override fun onDestroy() {
        credRetryHandler.removeCallbacks(credRetryRunnable)
        stopGps()
        messenger.close()
        super.onDestroy()
    }

    // === GPS rate management ===
    // activeMode=true  → 1s / 1m  (accurate tracking while recording)
    // activeMode=false → 5s / 10m (idle: just need fix-status indication)

    @SuppressLint("MissingPermission")
    private fun setGpsRate(activeMode: Boolean) {
        if (activeMode == gpsRateActive && gpsStarted) return
        locationManager.removeUpdates(locationListener)
        val minTime = if (activeMode) 1000L else 5000L
        val minDist = if (activeMode) 1f    else 10f
        Log.d(TAG, "setGpsRate active=$activeMode (${minTime}ms/${minDist}m)")
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, minTime, minDist, locationListener, Looper.getMainLooper()
                )
            } else {
                Log.w(TAG, "GPS_PROVIDER disabled")
                sendGpsFixIfChanged(false)
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER, minTime, minDist, locationListener, Looper.getMainLooper()
                )
            }
            gpsStarted    = true
            gpsRateActive = activeMode
        } catch (e: Exception) {
            Log.e(TAG, "setGpsRate failed: $e")
        }
    }

    private fun startGps() = setGpsRate(false)   // start at idle rate; switches to active on CMD_START

    private fun stopGps() {
        locationManager.removeUpdates(locationListener)
        gpsStarted    = false
        gpsRateActive = false
    }

    // Only sends to watch when fix state actually changes — avoids redundant BLE traffic
    private fun sendGpsFixIfChanged(hasFix: Boolean) {
        if (hasFix == lastGpsFix) return
        lastGpsFix = hasFix
        messenger.sendGpsFix(hasFix)
    }

    private fun handleLocation(loc: Location) {
        Log.d(TAG, "location provider=${loc.provider} lat=${loc.latitude} lon=${loc.longitude} acc=${loc.accuracy}")
        val lat = loc.latitude
        val lon = loc.longitude
        val alt = loc.altitude
        val spd = if (loc.hasSpeed()) loc.speed else 0f  // m/s

        // Record last fix time and accuracy for the companion UI
        prefs().edit()
            .putLong(Constants.PREF_LAST_GPS_TIME, System.currentTimeMillis())
            .putFloat(Constants.PREF_LAST_GPS_ACC, loc.accuracy)
            .apply()

        if (isActive) {
            if (!lastLat.isNaN()) {
                val d = haversine(lastLat, lastLon, lat, lon)
                if (d < 150) totalDistM += d   // ignore GPS jumps > 150 m
            }
            lastLat = lat
            lastLon = lon
            trackpoints.add(Trackpoint(lat, lon, alt, System.currentTimeMillis()))

            gpsTick++
            if (gpsTick == 1 || gpsTick >= Constants.GPS_SEND_EVERY) {
                if (gpsTick >= Constants.GPS_SEND_EVERY) gpsTick = 0
                messenger.sendGps(
                    hasFix    = true,
                    distanceM = totalDistM.toInt(),
                    speedCms  = (spd * 100).toInt()
                )
                lastGpsFix = true   // sendGps bundles GPS_HAS_FIX=true
            }
        } else {
            // Pre/post-workout: only notify watch when fix status changes
            sendGpsFixIfChanged(true)
        }
    }

    private fun handleCmd(action: Int, sportVal: Int) {
        when (action) {
            Constants.CMD_START -> {
                sport      = sportVal
                isActive   = true
                totalDistM = 0.0
                lastLat    = Double.NaN
                lastLon    = Double.NaN
                gpsTick    = 0
                trackpoints.clear()
                hrSamples.clear()
                setGpsRate(true)   // switch to high-rate GPS
                updateNotification("Recording ${if (sport == Constants.SPORT_CYCLING) "ride" else "run"}…")
            }
            Constants.CMD_STOP -> {
                isActive = false
                setGpsRate(false)  // back to idle rate
                updateNotification("Uploading GPX…")
                if (trackpoints.isEmpty()) {
                    messenger.sendUploadStatus(Constants.UPLOAD_ERROR, "No GPS data")
                    updateNotification("No GPS data")
                    return
                }
                uploadAsync()
            }
            Constants.CMD_PAUSE -> {
                isActive = false
                lastLat  = Double.NaN
                lastLon  = Double.NaN
                setGpsRate(false)  // conserve battery while paused
                updateNotification("Paused")
            }
            Constants.CMD_RESUME -> {
                isActive = true
                gpsTick  = 0
                setGpsRate(true)   // full rate again
                updateNotification("Recording ${if (sport == Constants.SPORT_CYCLING) "ride" else "run"}…")
            }
        }
    }

    // === Credentials ===

    private fun requestCredentials() {
        val url    = prefs().getString(Constants.PREF_WORKER_URL,    "") ?: ""
        val secret = prefs().getString(Constants.PREF_WORKER_SECRET, "") ?: ""
        if (url.isNotEmpty() && secret.isNotEmpty()) {
            credRetryHandler.removeCallbacks(credRetryRunnable)
            pingWorker(url, secret)
        } else {
            // Send initial request and keep retrying every 5 s until the watch responds.
            // The loop stops itself when prefs contain a URL, or is cancelled on service destroy.
            credRetryHandler.removeCallbacks(credRetryRunnable)
            messenger.sendCredRequest()
            credRetryHandler.postDelayed(credRetryRunnable, 5000)
        }
    }

    private fun pingWorker(url: String, secret: String) {
        Thread {
            try {
                val conn = URL("$url/ping").openConnection() as HttpURLConnection
                conn.setRequestProperty("Authorization", "Bearer $secret")
                conn.connectTimeout = 8000
                conn.readTimeout    = 8000
                val ok = conn.responseCode == 200
                conn.disconnect()
                messenger.sendWorkerStatus(ok)
            } catch (e: Exception) {
                messenger.sendWorkerStatus(false)
            }
        }.start()
    }

    // === Upload ===

    private fun uploadAsync() {
        val url    = prefs().getString(Constants.PREF_WORKER_URL,    "") ?: ""
        val secret = prefs().getString(Constants.PREF_WORKER_SECRET, "") ?: ""
        if (url.isEmpty() || secret.isEmpty()) {
            messenger.sendUploadStatus(Constants.UPLOAD_ERROR, "No credentials")
            return
        }
        messenger.sendUploadStatus(Constants.UPLOAD_PENDING)
        isUploading = true
        Thread {
            try {
                val activityName = buildActivityName()
                val desc = buildDesc()
                val gpx  = buildGpx(activityName)
                val body = JSONObject().apply {
                    put("gpx",   gpx)
                    put("sport", if (sport == Constants.SPORT_CYCLING) "ride" else "run")
                    put("name",  activityName)
                    put("desc",  desc)
                }.toString()

                val conn = URL("$url/upload").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput      = true
                conn.setRequestProperty("Content-Type",  "application/json")
                conn.setRequestProperty("Authorization", "Bearer $secret")
                conn.connectTimeout = 15000
                conn.readTimeout    = 15000
                conn.outputStream.write(body.toByteArray(Charsets.UTF_8))

                if (conn.responseCode == 200) {
                    messenger.sendUploadStatus(Constants.UPLOAD_SUCCESS)
                    updateNotification("GPX sent ✓")
                } else {
                    messenger.sendUploadStatus(Constants.UPLOAD_ERROR, "HTTP ${conn.responseCode}")
                    updateNotification("Upload failed")
                }
                conn.disconnect()
            } catch (e: Exception) {
                messenger.sendUploadStatus(Constants.UPLOAD_ERROR, "Network error")
                updateNotification("Upload failed")
            } finally {
                isUploading = false
                // Give the messenger's coroutine 500 ms to deliver the status before stopping.
                Handler(Looper.getMainLooper()).postDelayed({ stopSelf() }, 500)
            }
        }.start()
    }

    // === GPX builder ===

    private fun buildDesc(): String {
        val durationS = if (trackpoints.size >= 2)
            (trackpoints.last().time - trackpoints.first().time) / 1000 else 0L
        val distKm = totalDistM / 1000.0
        val avgHr = if (hrSamples.isNotEmpty()) hrSamples.map { it.hr }.average().toInt() else 0
        val parts = mutableListOf<String>()
        if (distKm >= 0.01) parts.add("${"%.2f".format(distKm)} km")
        val h = durationS / 3600; val m = (durationS % 3600) / 60; val s = durationS % 60
        parts.add(if (h > 0) "${h}h ${"%02d".format(m)}min" else "${m}min ${"%02d".format(s)}s")
        if (avgHr > 0) parts.add("avg HR ${avgHr} bpm")
        return parts.joinToString(" · ")
    }

    private fun buildActivityName(): String {
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        val tod  = when { hour < 12 -> "Morning"; hour < 17 -> "Afternoon"; else -> "Evening" }
        val type = if (sport == Constants.SPORT_CYCLING) "Ride" else "Run"
        val first = trackpoints.firstOrNull()
        val city  = if (first != null) reverseGeocode(first.lat, first.lon) else null
        return "${if (city != null) "$city " else ""}$tod $type"
    }

    private fun reverseGeocode(lat: Double, lon: Double): String? {
        return try {
            @Suppress("DEPRECATION")
            android.location.Geocoder(this, Locale.ENGLISH)
                .getFromLocation(lat, lon, 1)
                ?.firstOrNull()?.locality
        } catch (e: Exception) { null }
    }

    private fun buildGpx(name: String): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).also {
            it.timeZone = TimeZone.getTimeZone("UTC")
        }
        val startTime = fmt.format(Date(trackpoints.first().time))
        // Strava recognises the string form; numeric codes ("9"/"1") import as "workout"
        val trackType = if (sport == Constants.SPORT_CYCLING) "cycling" else "running"
        val desc = buildDesc()

        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
        sb.append("<gpx version=\"1.1\" creator=\"Pebble Time 2\"\n")
        sb.append("  xmlns=\"http://www.topografix.com/GPX/1/1\"\n")
        sb.append("  xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"\n")
        sb.append("  xsi:schemaLocation=\"http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd\"\n")
        sb.append("  xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">\n")
        sb.append("<metadata><name>$name</name><time>$startTime</time><desc>$desc</desc></metadata>\n")
        sb.append("<trk><name>$name</name><type>$trackType</type><desc>$desc</desc><trkseg>\n")

        for (tp in trackpoints) {
            val tpTime = fmt.format(Date(tp.time))
            val bestHr = hrSamples.minByOrNull { abs(it.ts - tp.time) }
                ?.takeIf { abs(it.ts - tp.time) < 30_000 }?.hr ?: 0

            sb.append("<trkpt lat=\"${"%.7f".format(tp.lat)}\" lon=\"${"%.7f".format(tp.lon)}\">\n")
            sb.append("<ele>${"%.1f".format(tp.alt)}</ele>\n")
            sb.append("<time>$tpTime</time>\n")
            if (bestHr > 0) {
                sb.append("<extensions><gpxtpx:TrackPointExtension>")
                sb.append("<gpxtpx:hr>$bestHr</gpxtpx:hr>")
                sb.append("</gpxtpx:TrackPointExtension></extensions>\n")
            }
            sb.append("</trkpt>\n")
        }
        sb.append("</trkseg></trk></gpx>")
        return sb.toString()
    }

    // === Haversine ===

    private fun haversine(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val R    = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a    = sin(dLat / 2).pow(2) +
                   cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).pow(2)
        return R * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    // === Notification ===

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                Constants.NOTIF_CHANNEL_ID,
                "GPS Tracking",
                NotificationManager.IMPORTANCE_LOW
            ).also { it.description = "Pebble Strava GPS companion" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val intent = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, Constants.NOTIF_CHANNEL_ID)
            .setContentTitle("Pebble Strava")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(Constants.NOTIF_ID, buildNotification(text))
    }

    private fun prefs() = getSharedPreferences(Constants.PREFS_NAME, Context.MODE_PRIVATE)
}
