import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.zip.ZipFile

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
    // 二维码扫码与原生相机：CameraX 取景 + 拍照 + 录像 + zxing-cpp 解码
    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.camerax.video)
    implementation(libs.zxing.cpp)

    testImplementation(libs.junit)
    // JVM 单测里 Android 自带的 org.json 是桩，换成真实实现
    testImplementation(libs.org.json)
    testImplementation(libs.kotlinx.coroutines.test)
}

// ---------------------------------------------------------------------------
// ONNX Runtime 动态库 + sherpa-onnx 的 Kotlin/JNI 接口（识物、语音转文字等本地模型用）
// 全部取自同一个 sherpa-onnx v1.13.8 AAR（只取 arm64-v8a）：
//  - jni/arm64-v8a/libonnxruntime.so（ORT 1.28.2，约 22MB）：Rust 的 ort（load-dynamic）按裸名 dlopen 它，
//    sherpa 的 JNI 也动态链接它，两边共用这一份；
//  - jni/arm64-v8a/libsherpa-onnx-jni.so：sherpa 的 JNI（只依赖 libonnxruntime.so，不依赖 c-api so）；
//  - classes.jar：com.k2fsa.sherpa.onnx 的 Kotlin API，作为本地 jar 依赖编译。
// 不能再依赖 onnxruntime-android AAR：同名 so 会冲突，符号版本标签也对不上。
// 构建时下载并校验 sha256，缓存在 <仓库>/.gradle/arkli-ort/（已被 .gitignore 忽略，clean 不会清掉）。
// 已有 AAR 时设环境变量 ARKLI_SHERPA_AAR 指向它即可免下载（大文件可先用 aria2c 下载）。
// ---------------------------------------------------------------------------

/** sherpa-onnx AAR 的下载地址 */
val ortAarUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar"

/** AAR 的 sha256（50,129,134 字节） */
val ortAarSha256 = "633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96"

/**
 * 从 AAR 提取的一个文件。
 *
 * @property entry AAR 内路径
 * @property cacheName 缓存目录里的文件名
 * @property sha256 期望的 sha256
 * @property outName 作为 jniLibs 输出时的文件名；null 表示不进 jniLibs（如 jar）
 */
data class AarPart(val entry: String, val cacheName: String, val sha256: String, val outName: String?)

/** 需要提取的三个文件 */
val sherpaParts = listOf(
    AarPart("jni/arm64-v8a/libonnxruntime.so", "libonnxruntime-1.28.2-arm64-v8a.so", "33847ad43bffe204699fd4a27f7f3603452a8cdaf2f9a44983a0bc31ffcf2da1", "libonnxruntime.so"),
    AarPart("jni/arm64-v8a/libsherpa-onnx-jni.so", "libsherpa-onnx-jni-1.13.8-arm64-v8a.so", "3c6492ea91ea68fd3b72b9495efdde6dd913f6b58c387e3b07389cf335f4d26f", "libsherpa-onnx-jni.so"),
    AarPart("classes.jar", "sherpa-onnx-1.13.8-classes.jar", "8af5aa647494ec9cb6596959d6d20864377cf4a9dedf1c1b178d936bfb7cea95", null),
)

/** 缓存目录：AAR 与解出的文件 */
val ortCacheDir = rootProject.layout.projectDirectory.dir(".gradle/arkli-ort").asFile

/** 输出目录，作为额外的 jniLibs 源目录 */
val ortOutDir = layout.buildDirectory.dir("generated/ort/jniLibs")

/** sherpa Kotlin API 的 jar（缓存里的那份，由 fetchOrtRuntime 产出） */
val sherpaJar = File(ortCacheDir, sherpaParts.first { it.entry == "classes.jar" }.cacheName)

/** 计算文件 sha256（小写十六进制） */
fun sha256Of(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { ins ->
        val buf = ByteArray(1 shl 16)
        while (true) {
            val n = ins.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
}

/** 下载 url 到 dst，失败重试 3 次；先写 .part 再改名 */
fun downloadTo(url: String, dst: File) {
    dst.parentFile.mkdirs()
    var last: Exception? = null
    repeat(3) { attempt ->
        try {
            val part = File(dst.path + ".part")
            val conn = URI(url).toURL().openConnection() as HttpURLConnection
            conn.connectTimeout = 30_000
            conn.readTimeout = 120_000
            conn.instanceFollowRedirects = true
            conn.inputStream.use { ins -> part.outputStream().use { ins.copyTo(it) } }
            check(part.renameTo(dst) || (dst.delete() && part.renameTo(dst))) { "无法写入 ${dst.path}" }
            return
        } catch (e: Exception) {
            last = e
            logger.warn("下载失败（第 ${attempt + 1} 次）：${e.message}")
        }
    }
    throw GradleException("下载 $url 失败：${last?.message}。可手动下载后放到 ${dst.path}，或设置 ARKLI_SHERPA_AAR", last)
}

val fetchOrtRuntime = tasks.register("fetchOrtRuntime") {
    group = "arkli"
    description = "取得并校验 libonnxruntime.so / libsherpa-onnx-jni.so / sherpa classes.jar（sherpa-onnx 1.13.8，arm64-v8a）"
    inputs.property("aarSha256", ortAarSha256)
    inputs.property("partSha256", sherpaParts.joinToString(",") { it.sha256 })
    outputs.dir(ortOutDir)
    outputs.file(sherpaJar)
    doLast {
        val cached = sherpaParts.associateWith { File(ortCacheDir, it.cacheName) }
        if (!cached.all { (p, f) -> f.isFile && sha256Of(f) == p.sha256 }) {
            val aar = System.getenv("ARKLI_SHERPA_AAR")?.let { File(it) } ?: File(ortCacheDir, "sherpa-onnx-1.13.8.aar")
            if (!(aar.isFile && sha256Of(aar) == ortAarSha256)) {
                check(System.getenv("ARKLI_SHERPA_AAR") == null) { "ARKLI_SHERPA_AAR 指向的文件不存在或 sha256 不符：${aar.path}" }
                logger.lifecycle("下载 sherpa-onnx AAR（约 50MB）：$ortAarUrl")
                downloadTo(ortAarUrl, aar)
                val got = sha256Of(aar)
                if (got != ortAarSha256) {
                    aar.delete()
                    throw GradleException("AAR sha256 不符：期望 $ortAarSha256，实际 $got")
                }
            }
            ZipFile(aar).use { zip ->
                cached.forEach { (p, f) ->
                    val entry = zip.getEntry(p.entry) ?: throw GradleException("AAR 里没有 ${p.entry}")
                    f.parentFile.mkdirs()
                    zip.getInputStream(entry).use { ins -> f.outputStream().use { ins.copyTo(it) } }
                    val got = sha256Of(f)
                    if (got != p.sha256) {
                        f.delete()
                        throw GradleException("${p.entry} sha256 不符：期望 ${p.sha256}，实际 $got")
                    }
                }
            }
        }
        cached.forEach { (p, f) ->
            val outName = p.outName ?: return@forEach
            val dst = File(ortOutDir.get().asFile, "arm64-v8a/$outName")
            dst.parentFile.mkdirs()
            f.copyTo(dst, overwrite = true)
        }
    }
}

android.sourceSets.getByName("main").jniLibs.srcDir(ortOutDir)
tasks.named("preBuild") { dependsOn(fetchOrtRuntime) }

// sherpa-onnx 的 Kotlin API（语音转文字等）：本地 jar，随 fetchOrtRuntime 产出
dependencies {
    implementation(files(sherpaJar).builtBy(fetchOrtRuntime))
}
