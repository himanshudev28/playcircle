package com.playcircle.app

import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.PeerConnection

/** What the room page asked for when it tapped Share → Entire screen. */
data class ShareRequest(
    /** Realtime (Socket.IO) server, e.g. https://playcircle-174u.onrender.com */
    val server: String,
    val code: String,
    val name: String,
    /** The page's own clientId: the share connection borrows its rights. */
    val clientId: String,
    val title: String,
    val cap: String,
    val iceServers: List<PeerConnection.IceServer>,
) {
    companion object {
        private val CAPS = setOf("auto", "1080", "720", "480")

        fun parse(json: String): ShareRequest? = try {
            val o = JSONObject(json)
            val server = o.getString("server").trimEnd('/')
            require(server.startsWith("https://") || server.startsWith("http://"))
            ShareRequest(
                server = server,
                code = o.getString("code").take(20),
                name = o.optString("name", "Guest").take(24),
                clientId = o.getString("clientId").take(64),
                title = o.optString("title", "Phone screen").take(80),
                cap = o.optString("cap", "auto").takeIf { it in CAPS } ?: "auto",
                iceServers = parseIce(o.optJSONArray("iceServers")),
            )
        } catch (_: Exception) {
            null
        }

        /** RTCIceServer[] from the page (`urls` is a string or a list). */
        private fun parseIce(list: JSONArray?): List<PeerConnection.IceServer> {
            val out = mutableListOf<PeerConnection.IceServer>()
            if (list != null) {
                for (i in 0 until list.length()) {
                    val s = list.optJSONObject(i) ?: continue
                    val urls = when (val u = s.opt("urls")) {
                        is String -> listOf(u)
                        is JSONArray -> (0 until u.length()).map { u.optString(it) }
                        else -> emptyList()
                    }.filter { it.isNotBlank() }
                    if (urls.isEmpty()) continue
                    val b = PeerConnection.IceServer.builder(urls)
                    s.optString("username").takeIf { it.isNotEmpty() }?.let { b.setUsername(it) }
                    s.optString("credential").takeIf { it.isNotEmpty() }?.let { b.setPassword(it) }
                    out += b.createIceServer()
                }
            }
            if (out.isEmpty()) {
                out += PeerConnection.IceServer.builder("stun:stun.l.google.com:19302")
                    .createIceServer()
            }
            return out
        }
    }
}
