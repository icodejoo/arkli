#!/usr/bin/env bash
# MNN 源码获取的公共部分：由 build.sh 与 build-sherpa-mnn.sh 用 source 引入（不要单独运行）。
# 钉死的提交与源码包 sha256 只在这里写一份。

# 钉死的 MNN 提交（2026-10-15 的 master 头）。3.6.1 加载 Qwen3.5 权重会崩溃，所以不能用 release 版本，也不能用浮动的 master
MNN_COMMIT="478c10e8d2351c7a4ea6f6243b97841a1eb39190"
# 该提交的 codeload 源码包（tar.gz）sha256，2026-10-16 在本机下载后现场算出；下载下来不是这个值就当作损坏，删掉重来
MNN_TARBALL_SHA256="8cf260b380bc12d28820fc42ad2adf1c96a4e7942fa93897608d6b70053487be"

# 确保 MNN 源码目录存在且完整。
# 用法：ensure_mnn_source <work 目录>；成功后源码在 "$work/MNN-$MNN_COMMIT"。
# 做法：下载 -> 校验 sha256 -> 解压到临时目录 -> 成功后再改名。解压中断只会留下临时目录，下次自动清掉重来，
# 不会留下“目录在但内容残缺”的源码树。
ensure_mnn_source() {
    local work="$1" src tarball url tmp got
    src="$work/MNN-$MNN_COMMIT"
    [ -d "$src" ] && return 0
    tarball="$work/mnn-$MNN_COMMIT.tar.gz"
    url="https://codeload.github.com/alibaba/MNN/tar.gz/$MNN_COMMIT"
    got=""
    [ -f "$tarball" ] && got="$(sha256sum "$tarball" | cut -d' ' -f1)"
    if [ "$got" != "$MNN_TARBALL_SHA256" ]; then
        rm -f "$tarball"
        if command -v aria2c >/dev/null; then
            aria2c -q -x16 -s16 --continue=true -d "$work" -o "$(basename "$tarball")" "$url"
        else
            curl -fL -o "$tarball" "$url"
        fi
        got="$(sha256sum "$tarball" | cut -d' ' -f1)"
        if [ "$got" != "$MNN_TARBALL_SHA256" ]; then
            rm -f "$tarball"
            echo "MNN 源码包 sha256 不符：期望 $MNN_TARBALL_SHA256，实际 $got" >&2
            return 1
        fi
    fi
    tmp="$work/.MNN-$MNN_COMMIT.partial"
    rm -rf "$tmp"
    mkdir -p "$tmp"
    tar xzf "$tarball" -C "$tmp" --strip-components=1 || { rm -rf "$tmp"; echo "MNN 源码包解压失败" >&2; return 1; }
    mv "$tmp" "$src"
}
