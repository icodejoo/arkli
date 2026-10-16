#!/usr/bin/env bash
# 把 PC 上的本地模型库复制进真机 App 私有目录并触发校验（设备无网、每次重装后都要跑）。
# 用法：scripts/device-push-models.sh [模型库目录，默认 E:/workspaces/arkli-models] [模型 id ...]
# 依赖：debug 包（run-as 与调试广播）；不带 id 则推送库内全部模型。
set -euo pipefail
export MSYS_NO_PATHCONV=1
LIB="${1:-E:/workspaces/arkli-models}"; shift || true
# 目标包：默认 debug 包（带 run-as 与调试广播）；可用环境变量 PKG 改成别的包名（release/profile 不可调试，没有 run-as）
PKG=${PKG:-com.let188.arkli.debug}
# 调试广播的 action 是固定字符串，不随包名变
ACTION=com.let188.arkli.debug.CMD
LIBU="$(cygpath -u "$LIB")"
# 校验用调试广播，需要目标包在运行；没运行就先拉起（带 LAUNCHER 分类，别用 am start -n）
if [ -z "$(adb shell pidof "$PKG" </dev/null | tr -d '')" ]; then
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 </dev/null >/dev/null 2>&1; sleep 6
fi
IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=($(ls "$LIBU" | grep -v "^_"))  # 跳过 _src 等暂存目录
for id in "${IDS[@]}"; do
  adb shell "mkdir -p /data/local/tmp/mm/$id; run-as $PKG mkdir -p files/models/$id" </dev/null
  for f in "$LIBU/$id"/*; do
    n=$(basename "$f")
    adb push "$(cygpath -m "$f")" "/data/local/tmp/mm/$id/$n" </dev/null >/dev/null
    adb shell "run-as $PKG cp /data/local/tmp/mm/$id/$n files/models/$id/$n" </dev/null
  done
  adb shell am broadcast -p $PKG -a $ACTION --es cmd rpc --es method native.model.verify --es params "{\"id\":\"$id\"}" </dev/null >/dev/null
  echo "已推送并触发校验：$id"
done
