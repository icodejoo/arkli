#!/usr/bin/env bash
# 把 PC 上的本地模型库复制进真机 App 私有目录并触发校验（设备无网、每次重装后都要跑）。
# 用法：scripts/device-push-models.sh [模型库目录，默认 E:/workspaces/arkli-models] [模型 id ...]
# 用法（release 包）：MODE=import PKG=com.let188.arkli scripts/device-push-models.sh [库目录] [id ...]
# 依赖：debug 包（run-as 与调试广播）；不带 id 则推送库内全部模型。
# 数据包（目录里只有 .zip，如 couplet-corpus）推上去后触发 native.model.ensure，由 App 解压并校验，模拟“已下载好压缩包”。
set -euo pipefail
export MSYS_NO_PATHCONV=1
LIB="${1:-E:/workspaces/arkli-models}"; shift || true
# 目标包：默认 debug 包（带 run-as 与调试广播）；可用环境变量 PKG 改成别的包名（release/profile 不可调试，没有 run-as）
PKG=${PKG:-com.let188.arkli.debug}
# 调试广播的 action 是固定字符串，不随包名变
ACTION=com.let188.arkli.debug.CMD
LIBU="$(cygpath -u "$LIB")"
# MODE=import：release 等不可调试的包，推到外部目录 Android/data/<包>/files/import/<id>/，由 App 启动扫描导入（含校验）
MODE=${MODE:-}
if [ "$MODE" = "import" ]; then
  IMP=/sdcard/Android/data/$PKG/files/import
  # 目录必须由 App 自己创建（adb 先建的属主不同，App 读不到）：先拉起，等 import 目录出现
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 </dev/null >/dev/null 2>&1
  ok=0
  for _ in $(seq 1 20); do
    adb shell "[ -d $IMP ]" </dev/null && { ok=1; break; }
    sleep 0.5
  done
  [ $ok -eq 1 ] || { echo "等了 10 秒 $IMP 还没出现：请先手动打开一次 App 再重试" >&2; exit 1; }
  IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=($(ls "$LIBU" | grep -v "^_"))
  for id in "${IDS[@]}"; do
    adb shell "mkdir -p $IMP/$id" </dev/null
    for f in "$LIBU/$id"/*; do
      adb push "$(cygpath -m "$f")" "$IMP/$id/$(basename "$f")" </dev/null >/dev/null
    done
    echo "已推送到导入目录：$id"
  done
  # 重启 App 触发启动扫描导入
  adb shell am force-stop "$PKG" </dev/null
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 </dev/null >/dev/null 2>&1
  echo "已重启 App，导入在后台进行，进度见 AI 中心"
  exit 0
fi
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
  # 目录里放的是压缩包（数据包，如对联语料库）就触发 ensure：原生校验 zip、解压并逐文件核对 sha256；否则只做 verify
  METHOD=native.model.verify
  ls "$LIBU/$id"/*.zip >/dev/null 2>&1 && METHOD=native.model.ensure
  adb shell am broadcast -p $PKG -a $ACTION --es cmd rpc --es method $METHOD --es params "{\"id\":\"$id\"}" </dev/null >/dev/null
  echo "已推送并触发 ${METHOD##*.}：$id"
done
