package com.playcircle.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.ThreadUtils
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink

/**
 * The phone screen as a WebRTC video source — org.webrtc's
 * ScreenCapturerAndroid, except a size change (rotation, a new quality cap)
 * resizes the virtual display in place. The library's version releases it
 * and creates a second one, which Android 14+ forbids for one
 * MediaProjection: the stream would silently freeze.
 */
class ScreenCapturer(
    private val permissionData: Intent,
    private val callback: MediaProjection.Callback,
) : VideoCapturer, VideoSink {
    private companion object {
        const val DPI = 400
        const val FLAGS =
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION
    }

    private var helper: SurfaceTextureHelper? = null
    private var context: Context? = null
    private var observer: CapturerObserver? = null
    /** Set once capture starts; app sound is captured on the same one. */
    var projection: MediaProjection? = null
        private set
    private var display: VirtualDisplay? = null
    private var width = 0
    private var height = 0

    override fun initialize(helper: SurfaceTextureHelper, context: Context, observer: CapturerObserver) {
        this.helper = helper
        this.context = context
        this.observer = observer
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        val helper = checkNotNull(helper) { "not initialized" }
        this.width = width
        this.height = height
        val mpm = checkNotNull(context).getSystemService(MediaProjectionManager::class.java)
        val p = mpm.getMediaProjection(Activity.RESULT_OK, permissionData)
            ?: error("screen capture permission was not granted")
        projection = p
        // Android 14+: the callback must be registered before the display.
        p.registerCallback(callback, helper.handler)
        ThreadUtils.invokeAtFrontUninterruptibly(helper.handler) {
            helper.setTextureSize(width, height)
            display = p.createVirtualDisplay(
                "PlayCircle", width, height, DPI, FLAGS,
                Surface(helper.surfaceTexture), null, null
            )
        }
        observer?.onCapturerStarted(true)
        helper.startListening(this)
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        val helper = helper ?: return
        if (width == this.width && height == this.height) return
        this.width = width
        this.height = height
        ThreadUtils.invokeAtFrontUninterruptibly(helper.handler) {
            val d = display ?: return@invokeAtFrontUninterruptibly
            helper.setTextureSize(width, height)
            d.resize(width, height, DPI)
        }
    }

    override fun stopCapture() {
        val helper = helper ?: return
        ThreadUtils.invokeAtFrontUninterruptibly(helper.handler) {
            helper.stopListening()
            observer?.onCapturerStopped()
            display?.release()
            display = null
            projection?.let {
                it.unregisterCallback(callback)
                it.stop()
            }
            projection = null
        }
    }

    override fun dispose() {}

    override fun isScreencast() = true

    override fun onFrame(frame: VideoFrame) {
        observer?.onFrameCaptured(frame)
    }
}
