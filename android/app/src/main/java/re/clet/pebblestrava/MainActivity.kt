package re.clet.pebblestrava

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var tvWorker: TextView
    private lateinit var tvLastGps: TextView
    private lateinit var btnService: Button
    private lateinit var btnPermissions: Button
    private lateinit var btnBattery: Button

    companion object {
        private const val REQ_PERMS = 1001

        private val GREEN  = Color.parseColor("#4CAF50")
        private val ORANGE = Color.parseColor("#FC4C02")
        private val RED    = Color.parseColor("#EF5350")
        private val GRAY   = Color.parseColor("#666666")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus    = findViewById(R.id.tv_status)
        tvWorker    = findViewById(R.id.tv_worker)
        tvLastGps   = findViewById(R.id.tv_last_gps)
        btnService  = findViewById(R.id.btn_service)
        btnPermissions = findViewById(R.id.btn_permissions)
        btnBattery  = findViewById(R.id.btn_battery)

        btnService.setOnClickListener {
            if (isServiceRunning()) stopGpsService() else startGpsService()
            updateUi()
        }

        btnPermissions.setOnClickListener {
            if (allPermissionsGranted()) openAppSettings() else requestPermissions()
        }

        btnBattery.setOnClickListener {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            })
        }
    }

    override fun onResume() {
        super.onResume()
        if (allPermissionsGranted() && isBatteryOptimizationExempted()) {
            if (!isServiceRunning()) startGpsService()
        }
        updateUi()
    }

    private fun updateUi() {
        val serviceRunning = isServiceRunning()
        val permsOk        = allPermissionsGranted()
        val batteryOk      = isBatteryOptimizationExempted()
        val coreInstalled  = isCoreAppInstalled()

        // Colored status rows
        val sb = SpannableStringBuilder()
        fun row(label: String, ok: Boolean, okText: String, failText: String) {
            sb.append("$label  ")
            val start = sb.length
            sb.append(if (ok) okText else failText)
            sb.setSpan(ForegroundColorSpan(if (ok) GREEN else ORANGE), start, sb.length, 0)
            sb.append("\n")
        }
        row("Pebble app", coreInstalled, "installed", "not found")
        row("Permissions", permsOk, "granted", "tap button below")
        row("Battery opt", batteryOk, "exempted", "tap button below")
        row("GPS service", serviceRunning, "running", "stopped")
        tvStatus.text = sb

        // Worker info
        val workerUrl = prefs().getString(Constants.PREF_WORKER_URL, "") ?: ""
        tvWorker.text = if (workerUrl.isNotEmpty()) "Worker: $workerUrl"
                        else "Worker: not configured — open Settings on the watch"

        // Last GPS fix
        val lastGpsTime = prefs().getLong(Constants.PREF_LAST_GPS_TIME, 0L)
        val lastGpsAcc  = prefs().getFloat(Constants.PREF_LAST_GPS_ACC, -1f)
        tvLastGps.text = if (lastGpsTime > 0L) {
            val age = (System.currentTimeMillis() - lastGpsTime) / 1000
            val ts  = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastGpsTime))
            val acc = if (lastGpsAcc >= 0) " · ±${lastGpsAcc.toInt()}m" else ""
            "Last GPS fix: $ts (${age}s ago)$acc"
        } else {
            "Last GPS fix: none yet"
        }

        // Service button
        btnService.text = if (serviceRunning) "Stop GPS Service" else "Start GPS Service"
        btnService.isEnabled = permsOk
        btnService.backgroundTintList = ColorStateList.valueOf(
            when {
                !permsOk       -> Color.parseColor("#1A1A1A")
                serviceRunning -> Color.parseColor("#1E3A1E")
                else           -> ORANGE
            }
        )

        // Permissions button
        btnPermissions.text = if (permsOk) "Location Permissions  ✓" else "Grant Location Permissions"
        btnPermissions.isEnabled = !permsOk
        btnPermissions.backgroundTintList = ColorStateList.valueOf(
            if (permsOk) Color.parseColor("#1A1A1A") else Color.parseColor("#2A2A2A")
        )

        // Battery button
        btnBattery.text = if (batteryOk) "Battery Optimization  ✓" else "Disable Battery Optimization"
        btnBattery.isEnabled = !batteryOk
        btnBattery.backgroundTintList = ColorStateList.valueOf(
            if (batteryOk) Color.parseColor("#1A1A1A") else Color.parseColor("#2A2A2A")
        )
    }

    // === GPS service lifecycle ===

    private fun startGpsService() {
        ContextCompat.startForegroundService(this, Intent(this, GpsService::class.java))
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

    // === Battery optimization ===

    private fun isBatteryOptimizationExempted(): Boolean {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    // === Pebble app detection ===

    private fun isCoreAppInstalled(): Boolean = try {
        packageManager.getPackageInfo("coredevices.coreapp", 0)
        true
    } catch (e: PackageManager.NameNotFoundException) { false }

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

    private fun prefs() = getSharedPreferences(Constants.PREFS_NAME, Context.MODE_PRIVATE)
}
