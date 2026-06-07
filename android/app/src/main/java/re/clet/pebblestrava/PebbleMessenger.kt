package re.clet.pebblestrava

import android.content.Context
import com.getpebble.android.kit.PebbleKit
import com.getpebble.android.kit.util.PebbleDictionary

object PebbleMessenger {

    fun sendGps(ctx: Context, hasFix: Boolean, distanceM: Int, speedCms: Int) {
        val dict = PebbleDictionary()
        dict.addInt8(Constants.KEY_GPS_HAS_FIX, if (hasFix) 1.toByte() else 0.toByte())
        dict.addInt32(Constants.KEY_GPS_DISTANCE, distanceM)
        dict.addInt32(Constants.KEY_GPS_SPEED, speedCms)
        PebbleKit.sendDataToPebble(ctx, Constants.APP_UUID, dict)
    }

    fun sendGpsFix(ctx: Context, hasFix: Boolean) {
        val dict = PebbleDictionary()
        dict.addInt8(Constants.KEY_GPS_HAS_FIX, if (hasFix) 1.toByte() else 0.toByte())
        PebbleKit.sendDataToPebble(ctx, Constants.APP_UUID, dict)
    }

    fun sendUploadStatus(ctx: Context, status: Int, msg: String? = null) {
        val dict = PebbleDictionary()
        dict.addInt8(Constants.KEY_UPLOAD_STATUS, status.toByte())
        if (msg != null) dict.addString(Constants.KEY_UPLOAD_MSG, msg.take(30))
        PebbleKit.sendDataToPebble(ctx, Constants.APP_UUID, dict)
    }

    fun sendUploadMsg(ctx: Context, msg: String) {
        val dict = PebbleDictionary()
        dict.addString(Constants.KEY_UPLOAD_MSG, msg.take(30))
        PebbleKit.sendDataToPebble(ctx, Constants.APP_UUID, dict)
    }

    fun sendWorkerStatus(ctx: Context, ok: Boolean) {
        val dict = PebbleDictionary()
        dict.addInt8(Constants.KEY_WORKER_STATUS, if (ok) Constants.WORKER_OK.toByte() else Constants.WORKER_ERROR.toByte())
        PebbleKit.sendDataToPebble(ctx, Constants.APP_UUID, dict)
    }

    fun sendCredRequest(ctx: Context) {
        val dict = PebbleDictionary()
        dict.addInt8(Constants.KEY_CRED_REQUEST, 1.toByte())
        PebbleKit.sendDataToPebble(ctx, Constants.APP_UUID, dict)
    }
}
