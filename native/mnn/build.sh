#!/usr/bin/env bash
# 编译本地文本模型的两个 so（arm64-v8a）：libMNN.so（钉死提交的 MNN）与 libarkli-mnn.so（JNI 封装）。
#
# 用法：native/mnn/build.sh [输出目录]    默认输出到 native/mnn/out
# 环境变量：ANDROID_HOME（或 ANDROID_SDK_ROOT）里要有 NDK 28 与 CMake 自带的 ninja。
# 产物的大小与 sha256 会打印出来，请同步到 app/build.gradle.kts 与 docs/research/qwen35-mnn-model.md。
set -euo pipefail

# 钉死的 MNN 提交（2026-10-15 的 master 头）。3.6.1 加载 Qwen3.5 权重会崩溃，所以不能用 release 版本，也不能用浮动的 master
MNN_COMMIT="478c10e8d2351c7a4ea6f6243b97841a1eb39190"
NDK_VERSION="28.2.13676358"
ANDROID_PLATFORM="android-26"

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/out}"
work="$here/.work"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk" ] || { echo "请设置 ANDROID_HOME" >&2; exit 1; }
ndk="$sdk/ndk/$NDK_VERSION"
[ -d "$ndk" ] || { echo "找不到 NDK：$ndk" >&2; exit 1; }
cmake_bin="$(ls -d "$sdk"/cmake/*/bin | tail -n 1)"
exe=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe" ;; esac
cmake="$cmake_bin/cmake$exe"; ninja="$cmake_bin/ninja$exe"
strip_tool="$(ls "$ndk"/toolchains/llvm/prebuilt/*/bin/llvm-strip$exe | head -n 1)"

mkdir -p "$work" "$out"
src="$work/MNN-$MNN_COMMIT"
if [ ! -d "$src" ]; then
    tarball="$work/mnn-$MNN_COMMIT.tar.gz"
    url="https://codeload.github.com/alibaba/MNN/tar.gz/$MNN_COMMIT"
    if command -v aria2c >/dev/null; then
        aria2c -q -x16 -s16 --continue=true -d "$work" -o "$(basename "$tarball")" "$url"
    else
        curl -fL -o "$tarball" "$url"
    fi
    mkdir -p "$src" && tar xzf "$tarball" -C "$src" --strip-components=1
fi

toolchain="$ndk/build/cmake/android.toolchain.cmake"

# 1) MNN 本体（带 LLM 引擎）。MNN_ARM82 关：这台目标机无 fp16，且开不开都与崩溃无关
"$cmake" -S "$src" -B "$work/build-mnn" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM="$ANDROID_PLATFORM" \
    -DCMAKE_BUILD_TYPE=Release -DMNN_BUILD_LLM=ON -DMNN_BUILD_FOR_ANDROID_COMMAND=ON \
    -DMNN_BUILD_SHARED_LIBS=ON -DMNN_SEP_BUILD=OFF -DMNN_ARM82=OFF -DMNN_USE_LOGCAT=ON \
    -DMNN_BUILD_TOOLS=OFF -DMNN_BUILD_DEMO=OFF -DMNN_BUILD_TEST=OFF -DMNN_BUILD_CONVERTER=OFF \
    -DMNN_BUILD_BENCHMARK=OFF -DMNN_OPENCL=OFF -DMNN_VULKAN=OFF
"$cmake" --build "$work/build-mnn" --target MNN

# 2) JNI 封装
"$cmake" -S "$here" -B "$work/build-jni" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
    -DCMAKE_TOOLCHAIN_FILE="$toolchain" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM="$ANDROID_PLATFORM" \
    -DCMAKE_BUILD_TYPE=Release -DMNN_SRC="$src" -DMNN_LIB="$work/build-mnn/libMNN.so"
"$cmake" --build "$work/build-jni"

cp "$work/build-mnn/libMNN.so" "$out/libMNN.so"
cp "$work/build-jni/libarkli-mnn.so" "$out/libarkli-mnn.so"
"$strip_tool" --strip-unneeded "$out/libMNN.so" "$out/libarkli-mnn.so"

echo "== 产物（MNN 提交 $MNN_COMMIT）"
for f in libMNN.so libarkli-mnn.so; do
    printf '%s  %s 字节  gzip-9 %s 字节\n' "$(sha256sum "$out/$f" | cut -d' ' -f1)" "$(wc -c < "$out/$f")" "$(gzip -9 -c "$out/$f" | wc -c)"
    echo "   ^ $f"
done
