# JNA 通过反射访问 Structure 字段与 Callback 方法，混淆/裁剪会导致原生调用失败
-dontwarn java.awt.*
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }

# UniFFI 生成的绑定：Structure / Callback / Library 接口依赖名字与字段反射，整包保留
-keep class uniffi.** { *; }

# sherpa-mnn（语音识别，M7）：同上，JNI 按名字回调 Kotlin 类与字段
-keep class com.k2fsa.sherpa.mnn.** { *; }

# MNN 本地文本模型的 JNI 入口：原生函数名按类名与方法名解析，不能被混淆或裁剪
-keep class com.let188.arkli.ai.MnnNative { *; }
