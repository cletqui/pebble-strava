package re.clet.pebblestrava

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.getpebble.android.kit.PebbleKit
import com.getpebble.android.kit.util.PebbleDictionary
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
    private var pebbleReceiver: PebbleKit.PebbleDataReceiver? = null

    private val trackpoints = mutableListOf<Trackpoint>()
    private val hrSamples   = mutableListOf<HrSample>()

    private var isActive    = false
    private var sport       = Constants.SPORT_RUNNING
    private var totalDistM  = 0.0
    private var lastLat     = Double.NaN
    private var lastLon     = Double.NaN
    private var gpsTick     = 0
    private var lastLocation: Location? = null

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) = handleLocation(loc)
        @Deprecated("Deprecated in API 29") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
        override fun onProviderEnabled(provider: String)  {}
        override fun onProviderDisabled(provider: String) {
            PebbleMessenger.sendGpsFix(this@GpsService, false)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        createNotificationChannel()
        startForeground(Constants.NOTIF_ID, buildNotification("Waiting for Pebble…"))
        registerPebbleReceiver()
        requestCredentials()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startGps()
        return START_STICKY
    }

    override fun onDestroy() {
        stopGps()
        pebbleReceiver?.let { PebbleKit.unregisterPebbleKit(this, it) }
        super.onDestroy()
    }

    // === GPS ===

    @SuppressLint("MissingPermission")
    private fun startGps() {
        val hasGps = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
        if (!hasGps) {
            PebbleMessenger.sendGpsFix(this, false)
            return
        }
        locationManager.requestLocationUpdates(
            LocationManager.GPS_PROVIDER,
            1000L,   // min interval ms
            1f,      // min distance m
            locationListener,
            Looper.getMainLooper()
        )
    }

    private fun stopGps() {
        locationManager.removeUpdates(locationListener)
    }

    private fun handleLocation(loc: Location) {
        lastLocation = loc
        val lat = loc.latitude
        val lon = loc.longitude
        val alt = loc.altitude
        val spd = if (loc.hasSpeed()) loc.speed else 0f  // m/s

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
                PebbleMessenger.sendGps(this,
                    hasFix     = true,
                    distanceM  = totalDistM.toInt(),
                    speedCms   = (spd * 100).toInt()
                )
            }
        } else {
            // Pre-workout: keep GPS status current on the watch select screen
            gpsTick++
            if (gpsTick == 1) {
                PebbleMessenger.sendGpsFix(this, true)
            } else if (gpsTick >= Constants.GPS_SEND_EVERY) {
                gpsTick = 0
                PebbleMessenger.sendGpsFix(this, true)
            }
        }
    }

    // === Pebble AppMessage receiver ===

    private fun registerPebbleReceiver() {
        val receiver = object : PebbleKit.PebbleDataReceiver(Constants.APP_UUID) {
            override fun receiveData(ctx: Context, txId: Int, data: PebbleDictionary) {
                PebbleKit.sendAckToPebble(ctx, txId)
                handlePebbleMessage(data)
            }
        }
        pebbleReceiver = PebbleKit.registerReceivedDataHandler(this, receiver)
    }

    private fun handlePebbleMessage(data: PebbleDictionary) {
        data.getUnsignedIntegerAsLong(Constants.KEY_CRED_URL)?.let { /* handled as string below */ }
        data.getString(Constants.KEY_CRED_URL)?.let { url ->
            prefs().edit().putString(Constants.PREF_WORKER_URL, url).apply()
        }
        data.getString(Constants.KEY_CRED_SECRET)?.let { secret ->
            prefs().edit().putString(Constants.PREF_WORKER_SECRET, secret).apply()
            pingWorker()
        }

        data.getUnsignedIntegerAsLong(Constants.KEY_HR_BPM)?.let { hr ->
            if (hr > 0) hrSamples.add(HrSample(hr.toInt(), System.currentTimeMillis()))
        }

        data.getUnsignedIntegerAsLong(Constants.KEY_CMD_ACTION)?.let { action ->
            val sportVal = data.getUnsignedIntegerAsLong(Constants.KEY_CMD_SPORT)?.toInt()
                           ?: Constants.SPORT_RUNNING
            handleCmd(action.toInt(), sportVal)
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
                updateNotification("Recording ${if (sport == Constants.SPORT_CYCLING) "ride" else "run"}…")
            }
            Constants.CMD_STOP -> {
                isActive = false
                updateNotification("Uploading GPX…")
                if (trackpoints.isEmpty()) {
                    PebbleMessenger.sendUploadStatus(this, Constants.UPLOAD_ERROR, "No GPS data")
                    updateNotification("No GPS data")
                    return
                }
                uploadAsync()
            }
            Constants.CMD_PAUSE -> {
                isActive = false
                lastLat  = Double.NaN
                lastLon  = Double.NaN
                updateNotification("Paused")
            }
            Constants.CMD_RESUME -> {
                isActive = true
                updateNotification("Recording ${if (sport == Constants.SPORT_CYCLING) "ride" else "run"}…")
            }
        }
    }

    // === Credentials ===

    private fun requestCredentials() {
        val url = prefs().getString(Constants.PREF_WORKER_URL, "") ?: ""
        if (url.isNotEmpty()) {
            pingWorker()
        } else {
            PebbleMessenger.sendCredRequest(this)
        }
    }

    private fun pingWorker() {
        val url    = prefs().getString(Constants.PREF_WORKER_URL, "") ?: ""
        val secret = prefs().getString(Constants.PREF_WORKER_SECRET, "") ?: ""
        if (url.isEmpty() || secret.isEmpty()) return
        Thread {
            try {
                val conn = URL("$url/ping").openConnection() as HttpURLConnection
                conn.setRequestProperty("Authorization", "Bearer $secret")
                conn.connectTimeout = 8000
                conn.readTimeout    = 8000
                val ok = conn.responseCode == 200
                conn.disconnect()
                PebbleMessenger.sendWorkerStatus(this, ok)
            } catch (e: Exception) {
                PebbleMessenger.sendWorkerStatus(this, false)
            }
        }.start()
    }

    // === Upload ===

    private fun uploadAsync() {
        val url    = prefs().getString(Constants.PREF_WORKER_URL, "") ?: ""
        val secret = prefs().getString(Constants.PREF_WORKER_SECRET, "") ?: ""
        if (url.isEmpty() || secret.isEmpty()) {
            PebbleMessenger.sendUploadStatus(this, Constants.UPLOAD_ERROR, "No credentials")
            return
        }
        PebbleMessenger.sendUploadStatus(this, Constants.UPLOAD_PENDING)
        Thread {
            try {
                val activityName = buildActivityName()
                val gpx = buildGpx(activityName)
                val body = JSONObject().apply {
                    put("gpx",   gpx)
                    put("sport", if (sport == Constants.SPORT_CYCLING) "ride" else "run")
                    put("name",  activityName)
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
                    PebbleMessenger.sendUploadStatus(this, Constants.UPLOAD_SUCCESS)
                    updateNotification("GPX sent ✓")
                } else {
                    PebbleMessenger.sendUploadStatus(this, Constants.UPLOAD_ERROR, "HTTP ${conn.responseCode}")
                    updateNotification("Upload failed")
                }
                conn.disconnect()
            } catch (e: Exception) {
                PebbleMessenger.sendUploadStatus(this, Constants.UPLOAD_ERROR, "Network error")
                updateNotification("Upload failed")
            }
        }.start()
    }

    // === GPX builder ===

    private fun buildActivityName(): String {
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        val tod  = when { hour < 12 -> "Morning"; hour < 17 -> "Afternoon"; else -> "Evening" }
        val type = if (sport == Constants.SPORT_CYCLING) "Ride" else "Run"
        val city = if (!lastLat.isNaN()) reverseGeocode(lastLat, lastLon) else null
        return "${if (city != null) "$city " else ""}$tod $type"
    }

    private fun reverseGeocode(lat: Double, lon: Double): String? {
        return try {
            @Suppress("DEPRECATION")
            val addrs = android.location.Geocoder(this, Locale.ENGLISH)
                .getFromLocation(lat, lon, 1)
            addrs?.firstOrNull()?.locality
        } catch (e: Exception) { null }
    }

    private fun buildGpx(name: String): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).also {
            it.timeZone = TimeZone.getTimeZone("UTC")
        }
        val startTime = if (trackpoints.isNotEmpty()) fmt.format(Date(trackpoints[0].time)) else fmt.format(Date())
        val trackType = if (sport == Constants.SPORT_CYCLING) "1" else "9"

        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
        sb.append("<gpx version=\"1.1\" creator=\"Pebble Time 2\"\n")
        sb.append("  xmlns=\"http://www.topografix.com/GPX/1/1\"\n")
        sb.append("  xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">\n")
        sb.append("<metadata><name>$name</name><time>$startTime</time></metadata>\n")
        sb.append("<trk><name>$name</name><type>$trackType</type><trkseg>\n")

        for (tp in trackpoints) {
            val tpTime = fmt.format(Date(tp.time))
            val bestHr  = hrSamples.minByOrNull { abs(it.ts - tp.time) }
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
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(Constants.NOTIF_ID, buildNotification(text))
    }

    private fun prefs() = getSharedPreferences(Constants.PREFS_NAME, Context.MODE_PRIVATE)
}
