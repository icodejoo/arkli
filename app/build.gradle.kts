plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.let188.arkli"
    // 35 = 本机已装的稳定平台，AGP 8.10 官方支持上限
    compileSdk = 35

    defaultConfig {
        applicationId = "com.let188.arkli"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // 只发 arm64-v8a
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 仅为本机装机验证：用 debug keystore（AGP 自动生成于 ~/.android，不在仓库内）签名
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { compose = true }

    packaging {
        resources {
            // 用不到的元数据与许可证文件
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "/META-INF/*.version",
                "/META-INF/LICENSE*",
                "/META-INF/NOTICE*",
                "/META-INF/DEPENDENCIES",
                "/META-INF/androidx/**",
                "/kotlin/**",
                "/DebugProbesKt.bin",
                "/**/*.kotlin_builtins",
                "/**/*.kotlin_module",
                "/**/*.kotlin_metadata",
            )
        }
        jniLibs {
            // 即便依赖带了别的 ABI 也不打包
            excludes += setOf("**/armeabi-v7a/**", "**/x86/**", "**/x86_64/**", "**/mips/**", "**/mips64/**", "**/armeabi/**")
        }
    }
}

// Kotlin 2.3 起 kotlinOptions 已移除，改用 compilerOptions
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.webkit)
    // UniFFI 绑定依赖 JNA，用 AAR 形式（内含各 ABI 的 libjnidispatch，由 abiFilters 裁成 arm64）
    implementation("${libs.jna.get()}@aar")
    implementation(libs.kotlinx.coroutines.android)
    // 二维码扫码：CameraX 取景 + zxing-cpp 解码
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.zxing.cpp)

    testImplementation(libs.junit)
    // JVM 单测里 Android 自带的 org.json 是桩，换成真实实现
    testImplementation(libs.org.json)
    testImplementation(libs.kotlinx.coroutines.test)
}
