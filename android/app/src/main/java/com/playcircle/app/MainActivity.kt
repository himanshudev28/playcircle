package com.playcircle.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.PictureInPictureParams
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The app is the PlayCircle website in a WebView, so every room feature
 * (sync, chat, queue, polls, calls, camera and file sharing…) is the web
 * app's own and stays in step with it. What a phone browser can't do —
 * share the whole screen — the page hands to [ScreenShareService] through
 * [WebBridge].
 */
class MainActivity : ComponentActivity() {
    private companion object {
        const val PREFS = "playcircle"
        const val KEY_SERVER = "server"
        const val INK = 0xFF060505.toInt()
        const val BONE = 0xFFF5F1EA.toInt()
        const val SMOKE = 0xFFA49B93.toInt()

        // Phone browsers' gaps, filled by the app: clipboard and share sheet.
        const val POLYFILL = """
            (function () {
              var b = window.PlayCircleAndroid;
              if (!b) return;
              var write = function (t) { b.copyText(String(t)); return Promise.resolve(); };
              try {
                if (navigator.clipboard) navigator.clipboard.writeText = write;
                else Object.defineProperty(navigator, 'clipboard', { value: { writeText: write } });
              } catch (e) {}
              navigator.share = function (d) {
                d = d || {};
                b.shareText(d.title || '', d.text || '', d.url || '');
                return Promise.resolve();
              };
              navigator.canShare = function () { return true; };
            })();
        """
    }

    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var loading: View
    private lateinit var errorView: View
    private lateinit var errorText: TextView
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    private var server: String = BuildConfig.DEFAULT_SERVER
    private var pendingShare: String? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingPermission: PermissionRequest? = null
    /** The page is in a call: leaving the app goes picture-in-picture. */
    private var callPip = false
    /** We're opening another screen ourselves (link, picker, dialog): that's
        not the user leaving, so no PiP until we're back. */
    private var pipSuppressed = false

    private val onShareState: (ShareState.Snapshot, String?) -> Unit = { s, msg ->
        updatePipParams() // no call pop-up over your own screen share
        val json = ShareState.toJson(s, msg)
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('playcircle-native',{detail:$json}))",
            null
        )
    }

    /* ---------------------------------------------------------- launchers */

    private val projectionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val json = pendingShare
            pendingShare = null
            val data = result.data
            if (result.resultCode == Activity.RESULT_OK && data != null && json != null) {
                ScreenShareService.start(this, data, json)
            } else {
                ShareState.update(ShareState.IDLE, "Screen sharing was cancelled", force = true)
            }
        }

    // Notifications show (and stop) the share; the microphone permission is
    // what Android files capturing other apps' sound under. A "no" to
    // either still shares the picture.
    private val sharePermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.RECORD_AUDIO] == false) {
                ShareState.message("Sharing without sound — allow the microphone to include it")
            }
            askForProjection()
        }

    private val mediaPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            pendingPermission?.let { grantWhatWeCan(it) }
            pendingPermission = null
        }

    private val fileLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            fileCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            )
            fileCallback = null
        }

    /* ---------------------------------------------------------- lifecycle */

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        server = getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(KEY_SERVER, null) ?: BuildConfig.DEFAULT_SERVER

        root = FrameLayout(this).apply { setBackgroundColor(INK) }
        webView = WebView(this)
        root.addView(webView, matchParent())
        loading = buildLoading()
        root.addView(loading, matchParent())
        errorView = buildError()
        errorView.visibility = View.GONE
        root.addView(errorView, matchParent())
        setContentView(root)

        // Edge to edge (forced on Android 15): keep the page clear of the
        // status bar, navigation bar and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            if (fullscreenView == null) {
                val bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() or
                        WindowInsetsCompat.Type.displayCutout() or
                        WindowInsetsCompat.Type.ime()
                )
                v.updatePadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                v.updatePadding(0, 0, 0, 0)
            }
            WindowInsetsCompat.CONSUMED
        }

        setUpWebView()
        ShareState.listen(onShareState)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    fullscreenView != null -> fullscreenCallback?.onCustomViewHidden()
                    // Sharing: keep the room open behind other apps — going
                    // back would leave the room and end the share.
                    ShareState.current.phase != ShareState.Phase.IDLE -> moveTaskToBack(true)
                    webView.canGoBack() -> webView.goBack()
                    else -> finish()
                }
            }
        })

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else webView.loadUrl(server)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        pipSuppressed = false
        updatePipParams()
    }

    // Swiping the PiP window away only stops the activity; the call would
    // carry on with Android cutting the camera. Tell the page to hang up.
    override fun onStop() {
        if (isInPictureInPictureMode) {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('playcircle-pip',{detail:{on:false,closed:true}}))",
                null
            )
        }
        super.onStop()
    }

    override fun onDestroy() {
        ShareState.unlisten(onShareState)
        webView.destroy()
        super.onDestroy()
    }

    /* ------------------------------------------------------------ WebView */

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.setBackgroundColor(INK)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            setSupportMultipleWindows(false)
            // Look like Chrome: YouTube refuses to play embeds ("An error
            // occurred") for user agents marked as an Android WebView. The
            // page spots the app by window.PlayCircleAndroid, not the UA.
            userAgentString = userAgentString
                .replace("; wv)", ")")
                .replace(" Version/4.0", "")
        }
        // Keep the page's renderer important while other apps are in front:
        // during a screen share the room page should stay connected.
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        // YouTube's embedded player needs its cookies.
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        webView.addJavascriptInterface(WebBridge(this), "PlayCircleAndroid")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, POLYFILL, setOf(origin(server)))
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                if (isOurs(request.url.toString())) return false
                // Links to elsewhere (YouTube, GitHub…) open outside the app.
                openExternal(request.url)
                return true
            }

            // A new page (reload, navigation) starts with no call: whatever
            // the old page said about PiP no longer holds.
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                callPip = false
                updatePipParams()
            }

            override fun onPageFinished(view: WebView, url: String) {
                loading.visibility = View.GONE
                // Older WebViews without document-start scripts.
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    view.evaluateJavascript(POLYFILL, null)
                }
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                showError("Couldn't open $server\n(${error.description})")
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { handlePermission(request) }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    suppressPip()
                    fileLauncher.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                enterFullscreen(view, callback)
            }

            override fun onHideCustomView() {
                exitFullscreen()
            }
        }
    }

    private fun origin(url: String): String {
        val u = Uri.parse(url)
        val port = if (u.port != -1) ":${u.port}" else ""
        return "${u.scheme}://${u.host}$port"
    }

    private fun isOurs(url: String?): Boolean =
        url != null && Uri.parse(url).let { it.scheme in setOf("http", "https") && origin(url) == origin(server) }

    private fun openExternal(uri: Uri) {
        try {
            suppressPip()
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show()
        }
    }

    /* -------------------------------------------------------- permissions */

    // Camera / microphone for calls and camera sharing. Only our own pages
    // get them, and only once Android has granted them to the app.
    private fun handlePermission(request: PermissionRequest) {
        if (!isOurs(request.origin.toString())) {
            request.deny()
            return
        }
        val needed = request.resources.mapNotNull {
            when (it) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                else -> null
            }
        }.filter { !granted(it) }
        if (needed.isEmpty()) {
            grantWhatWeCan(request)
        } else {
            pendingPermission?.deny()
            pendingPermission = request
            suppressPip()
            mediaPermissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun grantWhatWeCan(request: PermissionRequest) {
        val ok = request.resources.filter {
            when (it) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(Manifest.permission.CAMERA)
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(Manifest.permission.RECORD_AUDIO)
                else -> false
            }
        }
        if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
    }

    private fun granted(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    /* ------------------------------------------------------- screen share */

    fun startScreenShare(json: String) {
        if (!isOurs(webView.url)) {
            ShareState.update(ShareState.IDLE, force = true)
            return
        }
        if (ScreenShareService.running) {
            ShareState.message("You're already sharing your screen")
            return
        }
        val req = ShareRequest.parse(json)
        // Only ever to the server this app is set up for.
        if (req == null || origin(req.server) != origin(server)) {
            ShareState.update(ShareState.IDLE, "Couldn't start screen sharing", force = true)
            return
        }
        pendingShare = json
        ShareState.update(ShareState.Snapshot(ShareState.Phase.STARTING, null, 0))
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(Manifest.permission.RECORD_AUDIO)
        }.filter { !granted(it) }
        if (wanted.isEmpty()) askForProjection()
        else {
            suppressPip()
            sharePermissionLauncher.launch(wanted.toTypedArray())
        }
    }

    private fun askForProjection() {
        val mpm = getSystemService(MediaProjectionManager::class.java)
        // The whole screen, not "a single app": sharing has to keep going
        // when you switch apps.
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            mpm.createScreenCaptureIntent()
        }
        try {
            suppressPip()
            projectionLauncher.launch(intent)
        } catch (_: ActivityNotFoundException) {
            pendingShare = null
            ShareState.update(ShareState.IDLE, "This phone can't share its screen")
        }
    }

    /* -------------------------------------------- picture-in-picture */

    fun setCallPip(on: Boolean) {
        // Turning it off is always allowed, whichever page asks.
        if (on && !isOurs(webView.url)) return
        callPip = on
        updatePipParams()
    }

    /** In a call, not sharing your screen (the camera window would be in
        the share), and not opening a screen of our own. */
    private fun pipWanted() =
        callPip && !pipSuppressed && ShareState.current.phase == ShareState.Phase.IDLE

    private fun suppressPip() {
        pipSuppressed = true
        updatePipParams()
    }

    private fun pipSupported() =
        packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipParams(): PictureInPictureParams =
        PictureInPictureParams.Builder()
            // Portrait-ish: faces, not a movie frame.
            .setAspectRatio(Rational(3, 4))
            .apply {
                // Android 12+: swipe home goes straight into PiP.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    setAutoEnterEnabled(pipWanted())
                    setSeamlessResizeEnabled(false)
                }
            }
            .build()

    private fun updatePipParams() {
        if (!pipSupported()) return
        try {
            setPictureInPictureParams(pipParams())
        } catch (_: IllegalStateException) {
            /* PiP turned off for the app in system settings */
        }
    }

    // Android 8–11 (12+ enters on its own via setAutoEnterEnabled).
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!pipWanted() || !pipSupported() || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
        try {
            enterPictureInPictureMode(pipParams())
        } catch (_: IllegalStateException) {
            /* PiP turned off for the app in system settings */
        }
    }

    // The page swaps to a cameras-only layout while the window is small.
    override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(inPip, newConfig)
        // A video in full screen would fill the window instead of the cameras.
        if (inPip) fullscreenCallback?.onCustomViewHidden()
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('playcircle-pip',{detail:{on:$inPip}}))",
            null
        )
    }

    fun stopScreenShare() {
        if (!isOurs(webView.url)) return
        ScreenShareService.stop(this)
    }

    fun setShareVoice(on: Boolean) {
        if (!isOurs(webView.url)) return
        ScreenShareService.setVoice(this, on)
    }

    fun setShareCap(level: String) {
        if (!isOurs(webView.url)) return
        ScreenShareService.setCap(this, level)
    }

    fun copyText(text: String) {
        if (!isOurs(webView.url)) return
        getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("PlayCircle", text))
        // Android 13+ shows its own "Copied" confirmation.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
        }
    }

    fun shareText(title: String, text: String, url: String) {
        if (!isOurs(webView.url)) return
        val body = listOf(text, url).filter { it.isNotBlank() }.joinToString(" ")
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, body)
            .apply { if (title.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, title) }
        suppressPip()
        startActivity(Intent.createChooser(send, title.ifBlank { "Share" }))
    }

    /* --------------------------------------------------------- fullscreen */

    private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        root.addView(view, matchParent())
        WindowInsetsControllerCompat(window, root).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        ViewCompat.requestApplyInsets(root)
    }

    private fun exitFullscreen() {
        val view = fullscreenView ?: return
        root.removeView(view)
        fullscreenView = null
        fullscreenCallback = null
        WindowInsetsControllerCompat(window, root).show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(root)
    }

    /* ---------------------------------------------------- server settings */

    fun askForServer(cancelable: Boolean) {
        val input = EditText(this).apply {
            setText(server)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
        }
        val box = FrameLayout(this).apply {
            val pad = dp(20)
            setPadding(pad, dp(8), pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("PlayCircle server")
            .setMessage("The address of your PlayCircle site, e.g. https://playcircle-in.onrender.com")
            .setView(box)
            .setCancelable(cancelable)
            .setPositiveButton("Open") { _, _ ->
                var url = input.text.toString().trim().trimEnd('/')
                if (url.isEmpty()) return@setPositiveButton
                if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
                server = url
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply()
                // Restart so the bridge's origin rules follow the new server.
                recreateForServer()
            }
            .apply { if (cancelable) setNegativeButton("Cancel", null) }
            .show()
    }

    private fun recreateForServer() {
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        )
        finish()
    }

    /* ------------------------------------------------------------- views */

    private fun showError(message: String) {
        loading.visibility = View.GONE
        errorText.text = message
        errorView.visibility = View.VISIBLE
    }

    private fun buildLoading(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(INK)
        addView(ProgressBar(this@MainActivity))
        addView(TextView(this@MainActivity).apply {
            text = "Opening PlayCircle…\nThe free server can take up to a minute to wake up."
            setTextColor(SMOKE)
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(16), dp(32), 0)
        })
    }

    private fun buildError(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(INK)
        setPadding(dp(32), 0, dp(32), 0)
        errorText = TextView(this@MainActivity).apply {
            setTextColor(BONE)
            gravity = Gravity.CENTER
            textSize = 16f
        }
        addView(errorText)
        addView(Button(this@MainActivity).apply {
            text = "Try again"
            setOnClickListener {
                errorView.visibility = View.GONE
                loading.visibility = View.VISIBLE
                webView.loadUrl(server)
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(24)
        })
        addView(Button(this@MainActivity).apply {
            text = "Change server"
            setTextColor(Color.WHITE)
            setOnClickListener { askForServer(cancelable = true) }
        })
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
    )

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
