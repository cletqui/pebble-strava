package re.clet.pebblestrava

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getpebble.android.kit.PebbleKit
import com.getpebble.android.kit.util.PebbleDictionary

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var tvWorker: TextView
    private lateinit var tvGps: TextView
    private lateinit var btnService: Button
    private lateinit var btnPermissions: Button

    private var pebbleReceiver: PebbleKit.PebbleDataReceiver? = null

    companion object {
        private const val REQ_PERMS = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus       = findViewById(R.id.tv_status)
        tvWorker       = findViewById(R.id.tv_worker)
        tvGps          = findViewById(R.id.tv_gps)
        btnService     = findViewById(R.id.btn_service)
        btnPermissions = findViewById(R.id.btn_permissions)

        btnService.setOnClickListener {
            if (isServiceRunning()) stopGpsService() else startGpsService()
            updateUi()
        }

        btnPermissions.setOnClickListener {
            if (allPermissionsGranted()) {
                openAppSettings()
            } else {
                requestPermissions()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        registerPebbleReceiver()
        updateUi()
    }

    override fun onPause() {
        super.onPause()
        pebbleReceiver?.let { PebbleKit.unregisterPebbleKit(this, it) }
        pebbleReceiver = null
    }

    private fun updateUi() {
        val serviceRunning = isServiceRunning()
        val permsOk = allPermissionsGranted()
        val pebbleConnected = PebbleKit.isWatchConnected(this)

        tvStatus.text = buildString {
            append("Pebble: ${if (pebbleConnected) "connected ✓" else "not connected"}\n")
            append("Permissions: ${if (permsOk) "granted ✓" else "missing — tap button below"}\n")
            append("GPS service: ${if (serviceRunning) "running ✓" else "stopped"}")
        }

        val workerUrl = prefs().getString(Constants.PREF_WORKER_URL, "") ?: ""
        tvWorker.text = if (workerUrl.isNotEmpty()) "Worker: $workerUrl" else "Worker: not configured — open Settings on the watch"
        tvGps.text    = "GPS data is sent to the watch by this service.\nKeep the app installed; the service auto-starts when the Pebble app opens your watchapp."

        btnService.text = if (serviceRunning) "Stop GPS Service" else "Start GPS Service"
        btnService.isEnabled = permsOk

        btnPermissions.text = if (permsOk) "App Permissions (all granted)" else "Grant Location Permissions"
        btnPermissions.isEnabled = !permsOk
    }

    // === GPS service lifecycle ===

    private fun startGpsService() {
        val intent = Intent(this, GpsService::class.java)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun stopGpsService() {
        stopService(Intent(this, GpsService::class.java))
    }

    private fun isServiceRunning(): Boolean {
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        @Suppress("DEPRECATION")
        return manager.getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == GpsService::class.java.name }
    }

    // === Permissions ===

    private fun allPermissionsGranted(): Boolean {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                   PackageManager.PERMISSION_GRANTED
        val background = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        } else true
        val notif = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        } else true
        return fine && background && notif
    }

    private fun requestPermissions() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        ActivityCompat.requestPermissions(this, perms.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == REQ_PERMS) {
            val fineGranted = results.getOrNull(0) == PackageManager.PERMISSION_GRANTED
            // On API 29+ background location must be requested separately after fine is granted
            if (fineGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
                    REQ_PERMS + 1
                )
            }
            updateUi()
        } else if (requestCode == REQ_PERMS + 1) {
            updateUi()
        }
    }

    private fun openAppSettings() {
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
        })
    }

    // === Pebble status receiver (for live UI updates) ===

    private fun registerPebbleReceiver() {
        val receiver = object : PebbleKit.PebbleDataReceiver(Constants.APP_UUID) {
            override fun receiveData(ctx: Context, txId: Int, data: PebbleDictionary) {
                PebbleKit.sendAckToPebble(ctx, txId)
                runOnUiThread { updateUi() }
            }
        }
        pebbleReceiver = PebbleKit.registerReceivedDataHandler(this, receiver)
    }

    private fun prefs() = getSharedPreferences(Constants.PREFS_NAME, Context.MODE_PRIVATE)
}
