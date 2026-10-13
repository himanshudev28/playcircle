package com.playcircle.app

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * The screen share's state, shared by the service that runs it and the
 * activity that mirrors it into the room page (as a "playcircle-native"
 * window event — see lib/nativeApp.ts). Listeners run on the main thread.
 */
object ShareState {
    enum class Phase(val wire: String) { IDLE("idle"), STARTING("starting"), LIVE("live") }

    data class Snapshot(val phase: Phase, val streamId: String?, val viewers: Int)

    val IDLE = Snapshot(Phase.IDLE, null, 0)

    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableSetOf<(Snapshot, String?) -> Unit>()

    @Volatile
    var current: Snapshot = IDLE
        private set

    /** Set the state; `message` is shown to the person as a toast. */
    fun update(next: Snapshot, message: String? = null) {
        main.post {
            if (next == current && message == null) return@post
            current = next
            for (fn in listeners.toList()) fn(next, message)
        }
    }

    fun message(text: String) {
        main.post { for (fn in listeners.toList()) fn(current, text) }
    }

    fun listen(fn: (Snapshot, String?) -> Unit) {
        listeners += fn
    }

    fun unlisten(fn: (Snapshot, String?) -> Unit) {
        listeners -= fn
    }

    fun toJson(s: Snapshot, message: String? = null): String =
        JSONObject().apply {
            put("phase", s.phase.wire)
            put("streamId", s.streamId ?: JSONObject.NULL)
            put("viewers", s.viewers)
            if (message != null) put("message", message)
        }.toString()
}
