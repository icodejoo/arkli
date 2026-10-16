#!/usr/bin/env bash
# 把 PC 上的本地模型库复制进真机 App 私有目录并触发校验（设备无网、每次重装后都要跑）。
# 用法：scripts/device-push-models.sh [模型库目录，默认 E:/workspaces/arkli-models] [模型 id ...]
# 依赖：debug 包（run-as 与调试广播）；不带 id 则推送库内全部模型。
set -euo pipefail
export MSYS_NO_PATHCONV=1
LIB="${1:-E:/workspaces/arkli-models}"; shift || true
PKG=com.let188.arkli
LIBU="$(cygpath -u "$LIB")"
IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=($(ls "$LIBU"))
for id in "${IDS[@]}"; do
  adb shell "mkdir -p /data/local/tmp/mm/$id; run-as $PKG mkdir -p files/models/$id" </dev/null
  for f in "$LIBU/$id"/*; do
    n=$(basename "$f")
    adb push "$(cygpath -m "$f")" "/data/local/tmp/mm/$id/$n" </dev/null >/dev/null
    adb shell "run-as $PKG cp /data/local/tmp/mm/$id/$n files/models/$id/$n" </dev/null
  done
  adb shell am broadcast -a $PKG.debug.CMD --es cmd rpc --es method native.model.verify --es params "{\"id\":\"$id\"}" </dev/null >/dev/null
  echo "已推送并触发校验：$id"
done
