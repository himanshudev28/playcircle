plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val defaultServer = (findProperty("playcircleServer") as String?) ?: "https://playcircle-174u.onrender.com"

android {
    namespace = "com.playcircle.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.playcircle.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "DEFAULT_SERVER", "\"$defaultServer\"")
        // Real phones only: WebRTC's native library is big, x86 builds
        // (emulators) would double the APK for nothing.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Personal sideloaded app: signed with the local debug key so
            // `assembleRelease` gives an installable APK without a keystore.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    // Google stopped publishing WebRTC for Android; this is LiveKit's
    // maintained build of the same org.webrtc API. Its audio record hook
    // (AudioBufferCallback) is what lets a share carry other apps' sound.
    implementation("io.github.webrtc-sdk:android:144.7559.15")
    // Socket.IO v4 server ↔ Java client 2.x. Android already ships org.json.
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude(group = "org.json", module = "json")
    }
}
