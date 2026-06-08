package re.clet.pebblestrava

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// GpsService is started by PebbleListenerService.onAppOpened when the watch app opens.
// No need to start it on boot.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {}
}
