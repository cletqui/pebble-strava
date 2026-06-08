package re.clet.pebblestrava

import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import java.util.UUID

/**
 * Bound service — Core app (coredevices.coreapp) binds here when our watchapp is open.
 * Receives AppMessages from the watch and forwards them to GpsService via Intent.
 */
class PebbleListenerService : BasePebbleListenerService() {

    private val TAG = "PebbleListenerSvc"

    override suspend fun onMessageReceived(
        watchappUUID: UUID,
        data: PebbleDictionary,
        watch: WatchIdentifier,
    ): ReceiveResult {
        Log.d(TAG, "onMessageReceived uuid=$watchappUUID keys=${data.keys}")
        if (watchappUUID != Constants.APP_UUID) return ReceiveResult.Ack

        val intent = Intent(this, GpsService::class.java).apply {
            action = GpsService.ACTION_PEBBLE_DATA
            getInt(data, Constants.KEY_CMD_ACTION)?.let {
                putExtra(GpsService.EXTRA_CMD_ACTION, it)
                getInt(data, Constants.KEY_CMD_SPORT)?.let { s ->
                    putExtra(GpsService.EXTRA_CMD_SPORT, s)
                }
            }
            getInt(data, Constants.KEY_HR_BPM)?.let { if (it > 0) putExtra(GpsService.EXTRA_HR_BPM, it) }
            getText(data, Constants.KEY_CRED_URL)?.let    { putExtra(GpsService.EXTRA_CRED_URL,    it) }
            getText(data, Constants.KEY_CRED_SECRET)?.let { putExtra(GpsService.EXTRA_CRED_SECRET, it) }
        }

        try {
            ContextCompat.startForegroundService(this, intent)
        } catch (e: Exception) {
            // Service may not be running yet; it will be started by onAppOpened
        }

        return ReceiveResult.Ack
    }

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        Log.d(TAG, "onAppOpened uuid=$watchappUUID")
        if (watchappUUID != Constants.APP_UUID) return
        try {
            ContextCompat.startForegroundService(this, Intent(this, GpsService::class.java))
            Log.d(TAG, "startForegroundService(GpsService) sent")
        } catch (e: Exception) {
            Log.e(TAG, "startForegroundService failed: $e")
        }
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
        Log.d(TAG, "onAppClosed uuid=$watchappUUID")
    }

    private fun getInt(data: PebbleDictionary, key: Int): Int? =
        when (val item = data[key.toUInt()]) {
            is PebbleDictionaryItem.Int8   -> item.value.toInt()
            is PebbleDictionaryItem.UInt8  -> item.value.toInt()
            is PebbleDictionaryItem.Int16  -> item.value.toInt()
            is PebbleDictionaryItem.UInt16 -> item.value.toInt()
            is PebbleDictionaryItem.Int32  -> item.value
            is PebbleDictionaryItem.UInt32 -> item.value.toInt()
            else -> null
        }

    private fun getText(data: PebbleDictionary, key: Int): String? =
        (data[key.toUInt()] as? PebbleDictionaryItem.Text)?.value
}
