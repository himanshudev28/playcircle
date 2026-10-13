package com.playcircle.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.IntentCompat

/**
 * Keeps the screen share alive while you use other apps. Android requires a
 * foreground service of type mediaProjection for capture (and on 14+ it
 * must be running before the projection token is used), plus an ongoing
 * notification — which doubles as the Stop button.
 */
class ScreenShareService : Service() {
    companion object {
        private const val ACTION_START = "com.playcircle.app.START"
        private const val ACTION_STOP = "com.playcircle.app.STOP"
        private const val ACTION_CAP = "com.playcircle.app.CAP"
        private const val ACTION_VOICE = "com.playcircle.app.VOICE"
        private const val EXTRA_VOICE = "voice"
        private const val EXTRA_DATA = "data"
        private const val EXTRA_REQUEST = "request"
        private const val EXTRA_CAP = "cap"
        private const val CHANNEL = "screen_share"
        private const val NOTIFICATION_ID = 7

        @Volatile
        var running = false
            private set

        fun start(ctx: Context, projectionData: Intent, requestJson: String) {
            val i = Intent(ctx, ScreenShareService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_DATA, projectionData)
                .putExtra(EXTRA_REQUEST, requestJson)
            ctx.startForegroundService(i)
        }

        fun stop(ctx: Context) {
            if (!running) {
                ShareState.update(ShareState.IDLE, force = true)
                return
            }
            ctx.startService(Intent(ctx, ScreenShareService::class.java).setAction(ACTION_STOP))
        }

        fun setVoice(ctx: Context, on: Boolean) {
            if (!running) return
            ctx.startService(
                Intent(ctx, ScreenShareService::class.java)
                    .setAction(ACTION_VOICE)
                    .putExtra(EXTRA_VOICE, on)
            )
        }

        fun setCap(ctx: Context, level: String) {
            if (!running) return
            ctx.startService(
                Intent(ctx, ScreenShareService::class.java)
                    .setAction(ACTION_CAP)
                    .putExtra(EXTRA_CAP, level)
            )
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var presenter: StagePresenter? = null
    private var roomCode = ""

    private val onState: (ShareState.Snapshot, String?) -> Unit = { s, _ ->
        if (presenter != null) notify(s)
    }

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Shown while your screen is shared to a room" }
        )
        ShareState.listen(onState)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> begin(intent)
            ACTION_STOP -> presenter?.stop() ?: finish()
            ACTION_CAP -> intent.getStringExtra(EXTRA_CAP)?.let { presenter?.setCap(it) }
            ACTION_VOICE -> presenter?.setVoice(intent.getBooleanExtra(EXTRA_VOICE, false))
            else -> if (presenter == null) finish()
        }
        return START_NOT_STICKY
    }

    private fun begin(intent: Intent) {
        val req = intent.getStringExtra(EXTRA_REQUEST)?.let { ShareRequest.parse(it) }
        if (presenter == null && req != null) roomCode = req.code
        // Foreground first: Android 14+ refuses the projection otherwise.
        val starting = ShareState.Snapshot(ShareState.Phase.STARTING, null, 0)
        // With sound, WebRTC records (and we replace) the microphone, which
        // Android 14+ only allows in the background for a "microphone" service.
        val withSound = checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        var type = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        }
        if (withSound && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(starting), type)
        running = true
        if (presenter != null) return // already sharing

        val data = IntentCompat.getParcelableExtra(intent, EXTRA_DATA, Intent::class.java)
        if (data == null || req == null) {
            ShareState.update(ShareState.IDLE, "Couldn't start screen sharing")
            finish()
            return
        }
        presenter = StagePresenter(applicationContext, req, data, withSound) {
            main.post {
                presenter = null
                finish()
            }
        }.also { it.start() }
    }

    // Swiped away from recents: the room page is gone, so the share goes too.
    override fun onTaskRemoved(rootIntent: Intent?) {
        presenter?.stop("Screen sharing stopped")
        super.onTaskRemoved(rootIntent)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        presenter?.onDisplayChanged()
    }

    private fun finish() {
        running = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        ShareState.unlisten(onState)
        presenter?.stop()
        presenter = null
        running = false
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /* ------------------------------------------------------ notification */

    private fun notify(s: ShareState.Snapshot) {
        if (s.phase == ShareState.Phase.IDLE) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(s))
    }

    private fun build(s: ShareState.Snapshot): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, ScreenShareService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = when (s.phase) {
            ShareState.Phase.LIVE ->
                if (s.viewers == 1) "1 person watching" else "${s.viewers} people watching"
            else -> "Connecting…"
        }
        val room = if (roomCode.isNotEmpty()) " to room $roomCode" else ""
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle("Sharing your screen$room")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(open)
            .addAction(0, "Stop sharing", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}
