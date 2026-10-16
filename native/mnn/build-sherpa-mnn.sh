#!/usr/bin/env bash
# 编 sherpa-mnn 的 Android JNI（arm64-v8a）：libsherpa-mnn-jni.so，语音识别用。
#
# - 源码：固定提交 MNN 的 apps/frameworks/sherpa-mnn（Apache-2.0，基于 sherpa-onnx 1.10.46）；源码目录由 build.sh 首次运行时下载。
# - 链接：我们自己编的 libMNN.so（sha256 见 MNN_SO_SHA256，必须与 build.sh 产出一致），JNI 动态依赖它，其余依赖静态并入。
# - 构建期依赖：sherpa-mnn 的 cmake 会在配置时下载 6 个源码包。这里先按固定地址 + sha256 取到本地缓存再放进构建目录
#   （各 cmake 的 possible_file_locations 会优先用它），cmake 自带的 URL_HASH 还会再校验一遍；没缓存才会联网，且仍受 hash 约束。
#
# 用法：native/mnn/build-sherpa-mnn.sh [输出目录]    默认输出到 native/mnn/out（只新增 libsherpa-mnn-jni.so，不动其它文件）
# 环境变量：ANDROID_HOME（NDK 28 与 SDK 自带 cmake/ninja）；SHERPA_MNN_SUBST_DRIVE（Windows 短路径盘符，默认 S）；MNN_SO（libMNN.so 路径，默认 out/libMNN.so）。
# 注意：Git Bash 下不要设 MSYS_NO_PATHCONV=1（M2 已发现会破坏 cmake 参数转换）。
set -euo pipefail

NDK_VERSION="28.2.13676358"
ANDROID_PLATFORM="android-26"
# 链接用的 libMNN.so 的 sha256（已发布在 release mnn-478c10e-v1/v2，不变）
MNN_SO_SHA256="9cc1ff8b8b039431913a37ad1853dfa51162b41ae8b90927507204397096a353"
# 16KB 页对齐（Android 15+ 要求）
LINK_FLAGS="-Wl,-z,max-page-size=16384"

# 构建期依赖：本地文件名|主地址|镜像地址|sha256（与 sherpa-mnn/cmake/*.cmake 里的一致，改版本时两边都要核对）
HF_MIRROR="https://hf-mirror.com/csukuangfj/sherpa-onnx-cmake-deps/resolve/main"
DEPS=(
  "eigen-3.4.0.tar.gz|https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz|$HF_MIRROR/eigen-3.4.0.tar.gz|8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72"
  "kaldi-decoder-0.2.6.tar.gz|https://github.com/k2-fsa/kaldi-decoder/archive/refs/tags/v0.2.6.tar.gz|$HF_MIRROR/kaldi-decoder-0.2.6.tar.gz|b13c78b37495cafc6ef3f8a7b661b349c55a51abbd7f7f42f389408dcf86a463"
  "kaldifst-1.7.11.tar.gz|https://github.com/k2-fsa/kaldifst/archive/refs/tags/v1.7.11.tar.gz|$HF_MIRROR/kaldifst-1.7.11.tar.gz|b43b3332faa2961edc730e47995a58cd4e22ead21905d55b0c4a41375b4a525f"
  "kaldi-native-fbank-1.21.1.tar.gz|https://github.com/csukuangfj/kaldi-native-fbank/archive/refs/tags/v1.21.1.tar.gz|$HF_MIRROR/kaldi-native-fbank-1.21.1.tar.gz|37c1aa230b00fe062791d800d8fc50aa3de215918d3dce6440699e67275d859e"
  "openfst-sherpa-onnx-2024-06-19.tar.gz|https://github.com/csukuangfj/openfst/archive/refs/tags/sherpa-onnx-2024-06-19.tar.gz|$HF_MIRROR/openfst-sherpa-onnx-2024-06-19.tar.gz|5c98e82cc509c5618502dde4860b8ea04d843850ed57e6d6b590b644b268853d"
  "simple-sentencepiece-0.7.tar.gz|https://github.com/pkufool/simple-sentencepiece/archive/refs/tags/v0.7.tar.gz|$HF_MIRROR/simple-sentencepiece-0.7.tar.gz|1748a822060a35baa9f6609f84efc8eb54dc0e74b9ece3d82367b7119fdc75af"
)

here="$(cd "$(dirname "$0")" && pwd)"
# 钉死的 MNN 提交与源码包校验、下载解压逻辑，和 build.sh 共用
source "$here/mnn-source.sh"
out="${1:-$here/out}"
work="$here/.work"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk" ] || { echo "请设置 ANDROID_HOME" >&2; exit 1; }
ndk="$sdk/ndk/$NDK_VERSION"
[ -d "$ndk" ] || { echo "找不到 NDK：$ndk" >&2; exit 1; }
cmake_bin="$(ls -d "$sdk"/cmake/*/bin | tail -n 1)"
exe=""; is_win=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe"; is_win=1 ;; esac
cmake="$cmake_bin/cmake$exe"; ninja="$cmake_bin/ninja$exe"
strip_tool="$(ls "$ndk"/toolchains/llvm/prebuilt/*/bin/llvm-strip$exe | head -n 1)"
mkdir -p "$work" "$out"
out="$(cd "$out" && pwd)"

# 取 sha256 的小工具
sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# 1) 链接用的 libMNN.so：必须是已发布的那一份
mnn_so="${MNN_SO:-$here/out/libMNN.so}"
[ -f "$mnn_so" ] || { echo "找不到 libMNN.so：$mnn_so（先运行 build.sh，或用 MNN_SO 指定）" >&2; exit 1; }
[ "$(sha_of "$mnn_so")" = "$MNN_SO_SHA256" ] || { echo "libMNN.so 的 sha256 不是 $MNN_SO_SHA256：$mnn_so" >&2; exit 1; }

# 2) MNN 源码（含 apps/frameworks/sherpa-mnn）：没有就按 build.sh 的做法下载
src="$work/MNN-$MNN_COMMIT"
ensure_mnn_source "$work"
[ -d "$src/apps/frameworks/sherpa-mnn" ] || { echo "MNN 源码里没有 apps/frameworks/sherpa-mnn：$src" >&2; exit 1; }

# 3) 构建期依赖缓存：下载 + 校验 sha256（校验不过就删掉停止）
cache="$work/sherpa-mnn-deps"
mkdir -p "$cache"
fetch_dep() {
    local name="$1" url="$2" mirror="$3" sha="$4" f="$cache/$1" u
    if [ -f "$f" ] && [ "$(sha_of "$f")" = "$sha" ]; then return 0; fi
    rm -f "$f"
    for u in "$url" "$mirror"; do
        echo "下载 $name <- $u"
        if command -v aria2c >/dev/null; then
            aria2c -q -x16 -s16 --continue=true --max-tries=3 --retry-wait=3 -d "$cache" -o "$name" "$u" || true
        else
            curl -fL --retry 3 -o "$f" "$u" || true
        fi
        if [ -f "$f" ] && [ "$(sha_of "$f")" = "$sha" ]; then return 0; fi
        rm -f "$f"
    done
    echo "依赖 $name 下载失败或 sha256 不符（期望 $sha）" >&2
    return 1
}
for d in "${DEPS[@]}"; do
    IFS='|' read -r name url mirror sha <<<"$d"
    fetch_dep "$name" "$url" "$mirror" "$sha"
done

# 4) Windows：构建树路径太深（openfst 等）会超 260 字符，把 .work 映射成短盘符再构建
root="$work"
if [ "$is_win" = 1 ]; then
    drive="${SHERPA_MNN_SUBST_DRIVE:-S}"
    win_work="$(cygpath -w "$work")"
    # MSYS 会把 /d 当路径改写，这里关闭参数转换
    if MSYS2_ARG_CONV_EXCL='*' subst | grep -qi "^$drive:\\\\"; then
        echo "盘符 $drive: 已被占用，请用 SHERPA_MNN_SUBST_DRIVE 换一个" >&2; exit 1
    fi
    MSYS2_ARG_CONV_EXCL='*' subst "$drive:" "$win_work"
    root="$drive:/"
    trap 'MSYS2_ARG_CONV_EXCL="*" subst "$drive:" /d >/dev/null 2>&1 || true' EXIT
fi
rsrc="$root/MNN-$MNN_COMMIT/apps/frameworks/sherpa-mnn"
[ "$is_win" = 1 ] || rsrc="$src/apps/frameworks/sherpa-mnn"
build="$root/build-sherpa-mnn"
[ "$is_win" = 1 ] || build="$work/build-sherpa-mnn"

# 5) MNN_LIB_DIR 的约定：<dir>/include 与 <dir>/lib/libMNN.so
mnn_dir="$work/sherpa-mnn-mnnlib"
rm -rf "$mnn_dir"; mkdir -p "$mnn_dir/lib"
cp -r "$src/include" "$mnn_dir/include"
cp "$mnn_so" "$mnn_dir/lib/libMNN.so"
rmnn="$mnn_dir"
[ "$is_win" = 1 ] && rmnn="$root/sherpa-mnn-mnnlib"

# 依赖包放进构建目录：各 cmake 会优先找 ${CMAKE_BINARY_DIR}/<文件名>
mkdir -p "$work/build-sherpa-mnn"
cp "$cache"/*.tar.gz "$work/build-sherpa-mnn/"

"$cmake" -S "$rsrc" -B "$build" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
    -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM="$ANDROID_PLATFORM" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DMNN_LIB_DIR="$rmnn" \
    -DSHERPA_MNN_ENABLE_TTS=OFF -DSHERPA_MNN_ENABLE_SPEAKER_DIARIZATION=OFF -DSHERPA_MNN_ENABLE_BINARY=OFF \
    -DSHERPA_MNN_ENABLE_PYTHON=OFF -DSHERPA_MNN_ENABLE_TESTS=OFF -DSHERPA_MNN_ENABLE_CHECK=OFF \
    -DSHERPA_MNN_ENABLE_PORTAUDIO=OFF -DSHERPA_MNN_ENABLE_WEBSOCKET=OFF -DSHERPA_MNN_ENABLE_JNI=ON \
    -DSHERPA_MNN_ENABLE_C_API=OFF -DSHERPA_MNN_LINK_LIBSTDCPP_STATICALLY=OFF \
    -DCMAKE_SHARED_LINKER_FLAGS="$LINK_FLAGS"
"$cmake" --build "$build" --target sherpa-mnn-jni -j "${JOBS:-8}"

so="$(find "$work/build-sherpa-mnn" -name libsherpa-mnn-jni.so | head -n 1)"
[ -n "$so" ] || { echo "没有产出 libsherpa-mnn-jni.so" >&2; exit 1; }
cp "$so" "$out/libsherpa-mnn-jni.so"
"$strip_tool" --strip-unneeded "$out/libsherpa-mnn-jni.so"

echo "== 产物（MNN 提交 $MNN_COMMIT，sherpa-mnn 1.10.46）"
f="$out/libsherpa-mnn-jni.so"
printf '%s  %s 字节  gzip-9 %s 字节\n   ^ libsherpa-mnn-jni.so\n' "$(sha_of "$f")" "$(wc -c < "$f")" "$(gzip -9 -c "$f" | wc -c)"
"$ndk/toolchains/llvm/prebuilt/"*/bin/llvm-readelf$exe -d "$f" | grep NEEDED || true
