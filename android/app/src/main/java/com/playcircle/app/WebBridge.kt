package com.playcircle.app

import android.webkit.JavascriptInterface

/**
 * `window.PlayCircleAndroid` in the room page (see lib/nativeApp.ts).
 * Calls arrive on a WebView binder thread; anything that acts hops to the
 * main thread, where the activity also checks the page is our server's.
 */
class WebBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun startScreenShare(json: String) {
        activity.runOnUiThread { activity.startScreenShare(json) }
    }

    @JavascriptInterface
    fun stopScreenShare() {
        activity.runOnUiThread { activity.stopScreenShare() }
    }

    @JavascriptInterface
    fun setShareCap(level: String) {
        activity.runOnUiThread { activity.setShareCap(level) }
    }

    @JavascriptInterface
    fun getShareState(): String = ShareState.toJson(ShareState.current)

    /** navigator.clipboard.writeText, which WebViews don't always allow. */
    @JavascriptInterface
    fun copyText(text: String) {
        activity.runOnUiThread { activity.copyText(text) }
    }

    /** navigator.share → the Android share sheet. */
    @JavascriptInterface
    fun shareText(title: String, text: String, url: String) {
        activity.runOnUiThread { activity.shareText(title, text, url) }
    }

    @JavascriptInterface
    fun openSettings() {
        activity.runOnUiThread { activity.askForServer(cancelable = true) }
    }
}
