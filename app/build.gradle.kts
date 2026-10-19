import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest

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

    // 三种构建各用不同的 applicationId 与应用名，可同机并存、互不覆盖（数据目录、模型也各自独立）：
    //   debug   com.let188.arkli.debug    「Arkli Debug」  调试包，带调试广播与探针
    //   profile com.let188.arkli.profile  「Arkli Profile」 release 同款混淆，可被 profiler 抓取，用于性能与体积评估
    //   release com.let188.arkli          「Arkli」         正式包
    // 应用名放在各自源集的 strings.xml（src/debug、src/profile，release 用 main 的）。
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 仅为本机装机验证：用 debug keystore（AGP 自动生成于 ~/.android，不在仓库内）签名
            signingConfig = signingConfigs.getByName("debug")
        }
        // profile：沿用 release 的混淆与签名，不可调试，清单里声明 profileable 以便 profiler 与 simpleperf 抓取
        create("profile") {
            initWith(getByName("release"))
            applicationIdSuffix = ".profile"
            versionNameSuffix = "-profile"
            matchingFallbacks += "release"
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
            // 压缩 APK 里的 .so：安装包更小（下载更省流量），代价是安装时把 .so 解压到 nativeLibraryDir、占更多存储
            useLegacyPackaging = true
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
    throw GradleException("下载 $url 失败：${last?.message}。可手动下载后放到 ${dst.path}", last)
}

// ---------------------------------------------------------------------------
// MNN 运行库（Qwen3.5 / 识物 / 翻译 / 语音共用）：libMNN.so + 我们的 JNI 封装 libarkli-mnn.so + sherpa-mnn 的 JNI（arm64-v8a）。
// 两个 so 由 native/mnn/build.sh 从钉死的 MNN 提交编出；libMNN.so 已发布在 release mnn-478c10e-v1，
// libarkli-mnn.so 在 M2 加了 C ABI（arkli_mnn_capi），新版放在 release mnn-478c10e-v2。
// M7：语音识别改用 sherpa-mnn，它的 JNI（libsherpa-mnn-jni.so，由 native/mnn/build-sherpa-mnn.sh 编出）也并入 v2，
// 所以 v2 release 要放三个文件：libMNN.so、libarkli-mnn.so、libsherpa-mnn-jni.so。
// v2 release 由用户上传，上传前本地靠 .gradle 缓存构建（缓存文件名 <sha256>-<库名>，已被 .gitignore 忽略）。
// 这里构建时按需下载并校验 sha256。改了 so 就要同步改下面的 sha256，并更新 docs/research/qwen35-mnn-model.md。
// ---------------------------------------------------------------------------

/**
 * MNN 运行库 release 的下载前缀。
 * 注意：v4 是新 so（ABI 2，C 接口加了 power）的版本号，尚未上传 release，当前靠 .gradle 缓存构建；
 * 上传 v4 时三个 so 都要放（libMNN.so、libsherpa-mnn-jni.so 不变，但下载前缀相同）。
 */
val mnnReleaseBase = "https://github.com/icodejoo/arkli/releases/download/mnn-478c10e-v4/"

/** MNN 运行库的文件名与 sha256 */
val mnnLibs = mapOf(
    "libMNN.so" to "9cc1ff8b8b039431913a37ad1853dfa51162b41ae8b90927507204397096a353",
    "libarkli-mnn.so" to "accbe024d2a56b09ab34b2edaefdfe9b8a07f0eedee688d49b2473ea8b026bc2",
    "libsherpa-mnn-jni.so" to "aa79262fa17431bf513c7c4ac9855df02d09c1fe364396c0d8032df652a0c339",
)

/** MNN 运行库缓存目录 */
val mnnCacheDir = rootProject.layout.projectDirectory.dir(".gradle/arkli-mnn").asFile

/** MNN 运行库输出目录，作为额外的 jniLibs 源目录 */
val mnnOutDir = layout.buildDirectory.dir("generated/mnn/jniLibs")

val fetchMnnRuntime = tasks.register("fetchMnnRuntime") {
    group = "arkli"
    description = "取得并校验 libMNN.so / libarkli-mnn.so / libsherpa-mnn-jni.so（MNN 提交 478c10e，arm64-v8a）"
    inputs.property("libSha256", mnnLibs.entries.joinToString(",") { "${it.key}=${it.value}" })
    outputs.dir(mnnOutDir)
    doLast {
        mnnLibs.forEach { (name, sha) ->
            val cached = File(mnnCacheDir, "$sha-$name")
            if (!(cached.isFile && sha256Of(cached) == sha)) {
                logger.lifecycle("下载 $name：$mnnReleaseBase$name")
                downloadTo(mnnReleaseBase + name, cached)
                val got = sha256Of(cached)
                if (got != sha) {
                    cached.delete()
                    throw GradleException("$name sha256 不符：期望 $sha，实际 $got")
                }
            }
            val dst = File(mnnOutDir.get().asFile, "arm64-v8a/$name")
            dst.parentFile.mkdirs()
            cached.copyTo(dst, overwrite = true)
        }
    }
}

android.sourceSets.getByName("main").jniLibs.srcDir(mnnOutDir)
tasks.named("preBuild") { dependsOn(fetchMnnRuntime) }
