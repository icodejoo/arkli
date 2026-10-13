# JNA 通过反射访问 Structure 字段与 Callback 方法，混淆/裁剪会导致原生调用失败
-dontwarn java.awt.*
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }

# UniFFI 生成的绑定：Structure / Callback / Library 接口依赖名字与字段反射，整包保留
-keep class uniffi.** { *; }
