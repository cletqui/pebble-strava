package re.clet.pebblestrava

import android.content.Context
import android.util.Log
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class PebbleMessenger(context: Context) {

    private val TAG = "PebbleMessenger"
    private val sender = DefaultPebbleSender(context)
    private val scope  = CoroutineScope(Dispatchers.IO + SupervisorJob())

    fun sendGpsFix(hasFix: Boolean) {
        scope.launch {
            val result = sender.sendDataToPebble(Constants.APP_UUID, mapOf(
                Constants.KEY_GPS_HAS_FIX.toUInt() to PebbleDictionaryItem.Int8(if (hasFix) 1 else 0),
            ))
            Log.d(TAG, "sendGpsFix hasFix=$hasFix result=$result")
        }
    }

    fun sendGps(hasFix: Boolean, distanceM: Int, speedCms: Int) {
        scope.launch {
            val result = sender.sendDataToPebble(Constants.APP_UUID, mapOf(
                Constants.KEY_GPS_HAS_FIX.toUInt()  to PebbleDictionaryItem.Int8(if (hasFix) 1 else 0),
                Constants.KEY_GPS_DISTANCE.toUInt() to PebbleDictionaryItem.Int32(distanceM),
                Constants.KEY_GPS_SPEED.toUInt()    to PebbleDictionaryItem.Int32(speedCms),
            ))
            Log.d(TAG, "sendGps dist=$distanceM speed=$speedCms result=$result")
        }
    }

    fun sendUploadStatus(status: Int, msg: String = "") {
        scope.launch {
            val dict = mutableMapOf(
                Constants.KEY_UPLOAD_STATUS.toUInt() to
                    (PebbleDictionaryItem.Int8(status.toByte()) as PebbleDictionaryItem)
            )
            if (msg.isNotEmpty()) dict[Constants.KEY_UPLOAD_MSG.toUInt()] =
                PebbleDictionaryItem.Text(msg.take(30))
            sender.sendDataToPebble(Constants.APP_UUID, dict)
        }
    }

    fun sendWorkerStatus(ok: Boolean) {
        scope.launch {
            sender.sendDataToPebble(Constants.APP_UUID, mapOf(
                Constants.KEY_WORKER_STATUS.toUInt() to
                    PebbleDictionaryItem.Int8(if (ok) Constants.WORKER_OK.toByte() else Constants.WORKER_ERROR.toByte()),
            ))
        }
    }

    fun sendCredRequest() {
        scope.launch {
            val result = sender.sendDataToPebble(Constants.APP_UUID, mapOf(
                Constants.KEY_CRED_REQUEST.toUInt() to PebbleDictionaryItem.Int8(1),
            ))
            Log.d(TAG, "sendCredRequest result=$result")
        }
    }

    fun close() {
        scope.cancel()
        sender.close()
    }
}
