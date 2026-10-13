package com.playcircle.app

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import io.socket.client.AckWithTimeout
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Streams the phone screen to everyone in a room: the presenter half of
 * components/room/useLiveStage.ts, ported to org.webrtc + socket.io-java.
 *
 * It joins the room as a "companion" of the room page (same clientId, so
 * the same rights; hidden from the people list), claims the stage with
 * stage:start, then makes one sendonly RTCPeerConnection per viewer:
 *  - every offer/candidate carries a negotiation number `n`, and anything
 *    echoed back with a stale `n` is dropped;
 *  - a repeated stage:viewer means that viewer is retrying: rebuild it;
 *  - one video + one audio transceiver up front, as the web does;
 *  - per-viewer quality = min(cap, their stage:quality), applied with
 *    scaleResolutionDownBy + maxBitrate.
 *
 * Everything runs on one thread ([exec]); socket and WebRTC callbacks hop
 * onto it, so no state is touched concurrently.
 */
class StagePresenter(
    private val context: Context,
    private val req: ShareRequest,
    private val projectionData: Intent,
    /** Called once, after everything is torn down. */
    private val onEnded: () -> Unit,
) {
    private companion object {
        const val TAG = "StagePresenter"
        const val MAX_VIEWERS = 8
        const val FPS = 30
        const val ACK_TIMEOUT_MS = 8_000L
        /** Give up on a dropped connection after this long. */
        const val RECONNECT_GIVE_UP_MS = 45_000L

        /** Short side of the picture for each level. Phones upload once per
            viewer, so "auto" means 720p here rather than full resolution. */
        fun heightOf(level: String): Int = when (level) {
            "1080" -> 1080
            "720" -> 720
            "480" -> 480
            else -> 720
        }

        fun bitrateFor(height: Int): Int = when {
            height <= 480 -> 1_200_000
            height <= 720 -> 2_500_000
            else -> 4_500_000
        }

        val RANK = mapOf("auto" to 4, "1080" to 3, "720" to 2, "480" to 1)
        fun lowerOf(a: String, b: String) = if ((RANK[a] ?: 4) <= (RANK[b] ?: 4)) a else b
    }

    private class Peer(val n: Int) {
        lateinit var pc: PeerConnection
        lateinit var videoTx: RtpTransceiver
        val queued = mutableListOf<IceCandidate>()
        var remoteSet = false
        var connected = false
    }

    private val exec = Executors.newSingleThreadScheduledExecutor()

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    private var captureShort = 720

    private var socket: Socket? = null
    private var streamId: String? = null
    private var starting = false
    private var everStarted = false
    private var giveUp: ScheduledFuture<*>? = null

    private val peers = HashMap<String, Peer>()
    private val prefs = HashMap<String, String>()
    private var negotiation = 0
    private var cap = req.cap
    private var warnedFull = false
    private var ended = false

    /* ------------------------------------------------------------ public */

    fun start() = onThread {
        ShareState.update(ShareState.Snapshot(ShareState.Phase.STARTING, null, 0))
        try {
            startCapture()
        } catch (e: Exception) {
            Log.e(TAG, "capture failed", e)
            end("Couldn't capture the screen", tellServer = false)
            return@onThread
        }
        connect()
    }

    /** Stop sharing (the Stop button, the notification, the page). */
    fun stop(message: String? = null) = onThread { end(message, tellServer = true) }

    fun setCap(level: String) = onThread {
        if (level !in RANK) return@onThread
        cap = level
        resizeCapture()
        for (id in peers.keys) applyParams(id)
    }

    /** The screen rotated or changed size: keep the picture undistorted. */
    fun onDisplayChanged() = onThread { resizeCapture() }

    private fun onThread(block: () -> Unit) {
        if (exec.isShutdown) return
        try {
            exec.execute {
                if (ended) return@execute
                try {
                    block()
                } catch (e: Exception) {
                    Log.e(TAG, "presenter error", e)
                }
            }
        } catch (_: Exception) {
            /* shut down meanwhile */
        }
    }

    /* ----------------------------------------------------------- capture */

    private fun startCapture() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .createInitializationOptions()
        )
        val egl = EglBase.create().also { this.egl = it }
        val factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
            .also { this.factory = it }

        val capturer = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
            // The system ended it: the status-bar chip, the screen locking,
            // another app taking the projection.
            override fun onStop() {
                onThread { end("Screen sharing stopped", tellServer = true) }
            }
        }).also { this.capturer = it }

        val helper = SurfaceTextureHelper.create("ScreenCapture", egl.eglBaseContext)
            .also { textureHelper = it }
        val source = factory.createVideoSource(/* isScreencast = */ true).also { this.source = it }
        capturer.initialize(helper, context, source.capturerObserver)
        val (w, h) = captureSize()
        capturer.startCapture(w, h, FPS)
        track = factory.createVideoTrack("screen", source)
    }

    /** The real screen, scaled so its short side fits the cap. */
    private fun captureSize(): Pair<Int, Int> {
        val dm = context.getSystemService(DisplayManager::class.java)
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        dm.getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(metrics)
        val w = metrics.widthPixels
        val h = metrics.heightPixels
        val short = min(w, h)
        val target = min(short, heightOf(cap))
        val scale = target.toDouble() / short
        captureShort = target
        // Encoders want even dimensions.
        fun even(v: Double) = max(2, (v.roundToInt() / 2) * 2)
        return even(w * scale) to even(h * scale)
    }

    private fun resizeCapture() {
        val c = capturer ?: return
        val (w, h) = captureSize()
        try {
            c.changeCaptureFormat(w, h, FPS)
        } catch (e: Exception) {
            Log.w(TAG, "resize failed", e)
        }
    }

    /* ------------------------------------------------------------ socket */

    private fun connect() {
        val opts = IO.Options.builder()
            .setTransports(arrayOf(WebSocket.NAME))
            .setReconnection(true)
            .setReconnectionDelay(1_000)
            .setReconnectionDelayMax(5_000)
            .build()
        val s = IO.socket(URI.create(req.server), opts).also { socket = it }

        s.on(Socket.EVENT_CONNECT) { onThread { onConnect() } }
        s.on(Socket.EVENT_DISCONNECT) { onThread { onDisconnect() } }
        s.on(Socket.EVENT_CONNECT_ERROR) { onThread { onConnectError() } }
        s.on("room:state") { a -> onThread { onState(a.firstOrNull() as? JSONObject) } }
        s.on("room:denied") { a -> onThread { onDenied(a.firstOrNull() as? JSONObject) } }
        s.on("room:notice") { a -> (a.firstOrNull() as? String)?.let { ShareState.message(it) } }
        s.on("player:action") { a -> onThread { onAction(a.firstOrNull() as? JSONObject) } }
        s.on("stage:viewer") { a -> onThread { onViewer(a.firstOrNull() as? JSONObject) } }
        s.on("stage:viewer-left") { a -> onThread { onViewerLeft(a.firstOrNull() as? JSONObject) } }
        s.on("stage:quality") { a -> onThread { onQuality(a.firstOrNull() as? JSONObject) } }
        s.on("stage:signal") { a -> onThread { onSignal(a.firstOrNull() as? JSONObject) } }
        s.connect()
        armGiveUp()
    }

    private fun onConnect() {
        giveUp?.cancel(false)
        giveUp = null
        socket?.emit("room:join", JSONObject().apply {
            put("code", req.code)
            put("name", req.name)
            put("clientId", req.clientId)
            put("companion", true)
        })
    }

    private fun onConnectError() {
        if (!everStarted && giveUp == null) armGiveUp()
    }

    // The server ends a share whose presenter drops; we start a fresh one
    // when we're back (see onState).
    private fun onDisconnect() {
        closeAllPeers()
        if (streamId != null || starting) {
            streamId = null
            starting = false
            ShareState.update(
                ShareState.Snapshot(ShareState.Phase.STARTING, null, 0),
                "Connection lost — reconnecting your screen share…"
            )
        }
        armGiveUp()
    }

    private fun armGiveUp() {
        giveUp?.cancel(false)
        giveUp = exec.schedule({
            if (!ended && socket?.connected() != true) {
                end("Couldn't reach the server — screen sharing stopped", tellServer = false)
            }
        }, RECONNECT_GIVE_UP_MS, TimeUnit.MILLISECONDS)
    }

    private fun onState(snap: JSONObject?) {
        val media = snap?.optJSONObject("media")
        val onStage = media?.optString("streamId")?.takeIf { media.optString("kind") == "live" }
        val mine = streamId
        if (mine != null && onStage == mine) return // a re-sent snapshot
        if (mine != null) {
            // Ours is gone (we dropped and came back).
            streamId = null
            closeAllPeers()
        }
        if (starting) return
        // Coming back after a drop: only take the stage back if nobody else
        // has put something on it meanwhile.
        if (everStarted && media != null && !media.isNull("kind")) {
            end("Your screen share ended — the room moved on", tellServer = false)
            return
        }
        claimStage()
    }

    private fun claimStage() {
        val s = socket ?: return
        starting = true
        val payload = JSONObject().apply {
            put("source", "screen")
            put("title", req.title)
        }
        s.emit("stage:start", arrayOf(payload), object : AckWithTimeout(ACK_TIMEOUT_MS) {
            override fun onSuccess(vararg args: Any?) {
                onThread {
                    starting = false
                    val reply = args.firstOrNull() as? JSONObject
                    if (reply?.optBoolean("ok") == true) {
                        everStarted = true
                        streamId = reply.optString("streamId")
                        publish()
                    } else {
                        val err = reply?.optString("error")?.takeIf { it.isNotEmpty() }
                        end(err ?: "Couldn't start sharing", tellServer = false)
                    }
                }
            }

            override fun onTimeout() {
                onThread {
                    starting = false
                    end("The server didn't answer — try sharing again", tellServer = false)
                }
            }
        })
    }

    private fun onDenied(d: JSONObject?) {
        val msg = when (d?.optString("reason")) {
            "missing" -> "Open the room first, then share from it"
            "removed" -> "You were removed from the room"
            "ended" -> "The room has ended"
            "locked" -> "The room is locked"
            "password" -> "This room needs its password — join it first"
            "full" -> "The room is full"
            else -> "Couldn't join the room"
        }
        // The server already dropped us (and our share).
        streamId = null
        end(msg, tellServer = false)
    }

    // Something else went on stage (an admin stopped us, we lost video
    // control, the host loaded a video): end locally.
    private fun onAction(a: JSONObject?) {
        if (a?.optString("type") != "load") return
        val mine = streamId ?: return
        val media = a.optJSONObject("media")
        if (media?.optString("kind") == "live" && media.optString("streamId") == mine) return
        streamId = null
        end("Your screen share has ended", tellServer = false)
    }

    /* ------------------------------------------------------------ viewers */

    private fun onViewer(p: JSONObject?) {
        val id = p?.optString("id")?.takeIf { it.isNotEmpty() } ?: return
        if (streamId == null || p.optString("streamId") != streamId) return
        offerTo(id)
    }

    private fun onViewerLeft(p: JSONObject?) {
        val id = p?.optString("id") ?: return
        if (p.optString("streamId") != streamId) return
        prefs.remove(id)
        closePeer(id)
    }

    private fun onQuality(p: JSONObject?) {
        val id = p?.optString("id") ?: return
        val level = p.optString("level")
        if (p.optString("streamId") != streamId || level !in RANK) return
        prefs[id] = level
        applyParams(id)
    }

    private fun offerTo(id: String) {
        val factory = factory ?: return
        val track = track ?: return
        val sid = streamId ?: return
        val existing = peers[id]
        if (existing == null && peers.size >= MAX_VIEWERS) {
            if (!warnedFull) {
                warnedFull = true
                ShareState.message("More than $MAX_VIEWERS viewers — some may not see your screen")
            }
            return
        }
        if (existing != null) closePeer(id)

        val peer = Peer(++negotiation)
        val config = PeerConnection.RTCConfiguration(req.iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val pc = factory.createPeerConnection(config, object : PcObserver() {
            override fun onIceCandidate(c: IceCandidate) {
                onThread {
                    if (peers[id] !== peer) return@onThread
                    signal(id, sid, JSONObject().apply {
                        put("candidate", JSONObject().apply {
                            put("candidate", c.sdp)
                            put("sdpMid", c.sdpMid)
                            put("sdpMLineIndex", c.sdpMLineIndex)
                        })
                        put("n", peer.n)
                    })
                }
            }

            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                onThread {
                    if (peers[id] !== peer) return@onThread
                    peer.connected = state == PeerConnection.PeerConnectionState.CONNECTED
                    if (peer.connected) applyParams(id)
                    // A failed link is the viewer's to retry (it re-sends stage:want).
                    if (state == PeerConnection.PeerConnectionState.FAILED ||
                        state == PeerConnection.PeerConnectionState.CLOSED
                    ) {
                        closePeer(id)
                    } else {
                        publish()
                    }
                }
            }
        }) ?: return
        peer.pc = pc
        peer.videoTx = pc.addTransceiver(
            track,
            RtpTransceiver.RtpTransceiverInit(
                RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                listOf("screen")
            )
        )
        // Audio slot up front, like the web presenter: adding sound later is
        // a track swap, never a renegotiation.
        pc.addTransceiver(
            MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
            RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY)
        )
        peers[id] = peer

        pc.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(sdp: SessionDescription) {
                onThread {
                    if (peers[id] !== peer) return@onThread
                    pc.setLocalDescription(object : SdpAdapter() {
                        override fun onSetSuccess() {
                            onThread {
                                if (peers[id] !== peer) return@onThread
                                val local = pc.localDescription ?: return@onThread
                                signal(id, sid, JSONObject().apply {
                                    put("sdp", JSONObject().apply {
                                        put("type", "offer")
                                        put("sdp", local.description)
                                    })
                                    put("n", peer.n)
                                })
                            }
                        }

                        override fun onSetFailure(error: String?) {
                            onThread { if (peers[id] === peer) closePeer(id) }
                        }
                    }, sdp)
                }
            }

            override fun onCreateFailure(error: String?) {
                onThread { if (peers[id] === peer) closePeer(id) }
            }
        }, MediaConstraints())
    }

    private fun onSignal(msg: JSONObject?) {
        val from = msg?.optString("from") ?: return
        if (msg.optString("streamId") != streamId) return
        val data = msg.optJSONObject("data") ?: return
        val peer = peers[from] ?: return
        // Meant for a connection we've since replaced.
        if (data.has("n") && data.optInt("n") != peer.n) return
        val pc = peer.pc

        val sdp = data.optJSONObject("sdp")
        if (sdp != null && sdp.optString("type") == "answer") {
            if (pc.signalingState() != PeerConnection.SignalingState.HAVE_LOCAL_OFFER) return
            val answer = SessionDescription(SessionDescription.Type.ANSWER, sdp.optString("sdp"))
            pc.setRemoteDescription(object : SdpAdapter() {
                override fun onSetSuccess() {
                    onThread {
                        if (peers[from] !== peer) return@onThread
                        peer.remoteSet = true
                        for (c in peer.queued) pc.addIceCandidate(c)
                        peer.queued.clear()
                        applyParams(from)
                    }
                }
            }, answer)
            return
        }

        val c = data.optJSONObject("candidate") ?: return
        val line = c.optString("candidate")
        if (line.isEmpty()) return // end-of-candidates
        val candidate = IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), line)
        if (peer.remoteSet) pc.addIceCandidate(candidate) else peer.queued += candidate
    }

    /** Bitrate / scale for one viewer: the lower of the cap and their pick. */
    private fun applyParams(id: String) {
        val peer = peers[id] ?: return
        val sender = peer.videoTx.sender
        val params = sender.parameters
        if (params.encodings.isEmpty()) return // not negotiated yet
        val target = min(captureShort, heightOf(lowerOf(cap, prefs[id] ?: "auto")))
        val enc = params.encodings[0]
        enc.scaleResolutionDownBy = if (captureShort > target) captureShort.toDouble() / target else 1.0
        enc.maxBitrateBps = bitrateFor(target)
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
        sender.setParameters(params)
    }

    private fun signal(to: String, sid: String, data: JSONObject) {
        socket?.emit("stage:signal", JSONObject().apply {
            put("to", to)
            put("streamId", sid)
            put("data", data)
        })
    }

    private fun closePeer(id: String) {
        val peer = peers.remove(id) ?: return
        try {
            peer.pc.dispose()
        } catch (e: Exception) {
            Log.w(TAG, "dispose failed", e)
        }
        publish()
    }

    private fun closeAllPeers() {
        for (id in peers.keys.toList()) closePeer(id)
    }

    private fun publish() {
        val sid = streamId ?: return
        val viewers = peers.values.count { it.connected }
        ShareState.update(ShareState.Snapshot(ShareState.Phase.LIVE, sid, viewers))
    }

    /* ----------------------------------------------------------- teardown */

    private fun end(message: String?, tellServer: Boolean) {
        if (ended) return
        ended = true
        giveUp?.cancel(false)
        val s = socket
        val sid = streamId
        if (tellServer && sid != null && s?.connected() == true) {
            s.emit("stage:stop", JSONObject().put("streamId", sid))
        }
        streamId = null
        for (peer in peers.values) {
            try {
                peer.pc.dispose()
            } catch (_: Exception) {
            }
        }
        peers.clear()
        s?.off()
        s?.disconnect()
        socket = null
        try {
            capturer?.stopCapture()
        } catch (_: Exception) {
        }
        capturer?.dispose()
        track?.dispose()
        source?.dispose()
        textureHelper?.dispose()
        factory?.dispose()
        egl?.release()
        capturer = null
        track = null
        source = null
        textureHelper = null
        factory = null
        egl = null
        ShareState.update(ShareState.IDLE, message)
        exec.shutdown()
        onEnded()
    }
}

/** PeerConnection.Observer with no-op defaults. */
private abstract class PcObserver : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
    override fun onAddStream(stream: org.webrtc.MediaStream?) {}
    override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
    override fun onDataChannel(channel: org.webrtc.DataChannel?) {}
    override fun onRenegotiationNeeded() {}
}

/** SdpObserver with no-op defaults. */
private open class SdpAdapter : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {}
    override fun onSetFailure(error: String?) {}
}
