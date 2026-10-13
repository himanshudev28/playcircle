package com.playcircle.app

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Process
import android.util.Log
import androidx.annotation.RequiresApi
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

/**
 * The sound other apps are playing (a gallery video, a game, music), sent
 * as the share's audio. Android 10+ captures it on the same MediaProjection
 * as the screen; apps that opt out (Netflix and other DRM apps) stay silent,
 * and calls and notifications are never captured.
 *
 * WebRTC only records from the microphone, so this hooks its record path:
 * every 10 ms mic buffer is replaced with the captured app sound — or mixed
 * with it when "my voice" is on — just before it's encoded. The capture
 * runs on its own thread into a small ring buffer, so a late read never
 * stalls WebRTC's audio thread.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class AppAudioCapture(private val projection: MediaProjection) : JavaAudioDeviceModule.AudioBufferCallback {
    private companion object {
        const val TAG = "AppAudioCapture"
        /** Keep at most this much queued: older sound is dropped, not delayed. */
        const val MAX_LATENCY_MS = 120
    }

    @Volatile
    var includeVoice = false

    @Volatile
    private var closed = false
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile
    private var running = false

    // Ring buffer of 16-bit PCM, in the format WebRTC's mic uses.
    private val lock = Object()
    private var ring = ByteArray(0)
    private var readPos = 0
    private var size = 0
    private var rate = 0
    private var channels = 0
    private var scratch = ByteArray(0)

    /** Starts capturing in WebRTC's format, on first use. */
    @SuppressLint("MissingPermission") // RECORD_AUDIO is checked before a share starts
    private fun ensureStarted(sampleRate: Int, channelCount: Int): Boolean {
        if (closed) return false
        if (running && sampleRate == rate && channelCount == channels) return true
        stopRecord()
        return try {
            val config = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                // Not our own sound: the room's YouTube player would double up.
                .excludeUid(Process.myUid())
                .build()
            val mask = if (channelCount == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(mask)
                .build()
            val minBuf = AudioRecord.getMinBufferSize(sampleRate, mask, AudioFormat.ENCODING_PCM_16BIT)
            val chunk = sampleRate / 100 * channelCount * 2 // 10 ms
            val r = AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(max(minBuf, chunk * 4))
                .setAudioPlaybackCaptureConfig(config)
                .build()
            if (r.state != AudioRecord.STATE_INITIALIZED) {
                r.release()
                return false
            }
            rate = sampleRate
            channels = channelCount
            synchronized(lock) {
                ring = ByteArray(sampleRate * channelCount * 2 * MAX_LATENCY_MS / 1000 * 2)
                readPos = 0
                size = 0
            }
            r.startRecording()
            record = r
            running = true
            thread = Thread({ pump(r, chunk) }, "AppAudioCapture").apply {
                priority = Thread.MAX_PRIORITY
                start()
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "app audio capture unavailable", e)
            false
        }
    }

    private fun pump(r: AudioRecord, chunk: Int) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val buf = ByteArray(chunk)
        val maxQueued = rate * channels * 2 * MAX_LATENCY_MS / 1000
        while (running) {
            val n = r.read(buf, 0, buf.size)
            if (n <= 0) {
                if (n < 0) break
                continue
            }
            synchronized(lock) {
                // Running ahead of WebRTC: drop the oldest, keep it live.
                val overflow = size + n - maxQueued
                if (overflow > 0) {
                    readPos = (readPos + overflow) % ring.size
                    size -= overflow
                }
                var w = (readPos + size) % ring.size
                for (i in 0 until n) {
                    ring[w] = buf[i]
                    w = if (w + 1 == ring.size) 0 else w + 1
                }
                size += n
            }
        }
    }

    /** WebRTC's record hook: the mic buffer, about to be encoded. */
    override fun onBuffer(
        buffer: ByteBuffer,
        audioFormat: Int,
        channelCount: Int,
        sampleRate: Int,
        bytesRead: Int,
        captureTimeNs: Long,
    ): Long {
        if (audioFormat != AudioFormat.ENCODING_PCM_16BIT || bytesRead <= 0) return captureTimeNs
        if (!ensureStarted(sampleRate, channelCount)) return captureTimeNs
        if (scratch.size < bytesRead) scratch = ByteArray(bytesRead)
        val got: Int
        synchronized(lock) {
            got = min(size, bytesRead) and 1.inv() // whole samples
            var r = readPos
            for (i in 0 until got) {
                scratch[i] = ring[r]
                r = if (r + 1 == ring.size) 0 else r + 1
            }
            readPos = r
            size -= got
        }
        // Underrun: silence for the rest, never stale sound.
        for (i in got until bytesRead) scratch[i] = 0

        val start = buffer.position()
        if (includeVoice) {
            var i = 0
            while (i + 1 < bytesRead) {
                val mic = (buffer.get(start + i).toInt() and 0xFF) or (buffer.get(start + i + 1).toInt() shl 8)
                val app = (scratch[i].toInt() and 0xFF) or (scratch[i + 1].toInt() shl 8)
                val sum = (mic.toShort() + app.toShort()).coerceIn(-32768, 32767)
                buffer.put(start + i, sum.toByte())
                buffer.put(start + i + 1, (sum shr 8).toByte())
                i += 2
            }
        } else {
            for (i in 0 until bytesRead) buffer.put(start + i, scratch[i])
        }
        return captureTimeNs
    }

    /** For good: the share is over. */
    fun stop() {
        closed = true
        stopRecord()
    }

    private fun stopRecord() {
        running = false
        val r = record
        record = null
        try {
            r?.stop()
        } catch (_: Exception) {
        }
        thread?.join(500)
        thread = null
        r?.release()
    }
}
