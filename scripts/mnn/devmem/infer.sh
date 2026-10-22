#!/bin/bash
# 用法：infer.sh 标签 方法 params ；冷启动后调一次推理，响应去掉耗时字段后存 inf/<标签>.txt 并打印 md5 与前 160 字符
export MSYS_NO_PATHCONV=1
A="adb ${ADB_SERIAL:+-s $ADB_SERIAL}"; P=com.let188.arkli.debug.exp; S=$(dirname "$0")
$A shell am force-stop $P; $A logcat -c; $A shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 8
$A shell am broadcast -p $P -a com.let188.arkli.debug.CMD --es cmd rpc --es method "$2" --es params "'$3'" --es id i1 >/dev/null
for i in $(seq 1 150); do $A logcat -d | grep -q 'DBGMSG.*"id":"i1","ok"' && break; sleep 1; done
$A logcat -d | tr -d '\r' | grep 'DBGMSG.*"id":"i1","ok"' | tail -1 | sed 's/.*DBGMSG //; s/", source:.*//' | sed -E 's/"(elapsedMs|loadMs|totalMs|decodeMs|ms|inferMs|refineMs|[a-zA-Z]*Ms)":[0-9]+/"\1":T/g; s/"timings":\{[^}]*\}/"timings":T/g; s/"path":"[^"]*"/"path":P/g' > ${INF_DIR:-/tmp}/$1.txt
echo "$1: $(md5sum < ${INF_DIR:-/tmp}/$1.txt | cut -c1-8) $(cut -c1-170 ${INF_DIR:-/tmp}/$1.txt)"
# 抠图成品文件：按文件名在 cacheDir/arkli/out 下找，打印 sha256 前 12 位
RAW=$($A logcat -d | tr -d '\r' | grep 'DBGMSG.*"id":"i1","ok"' | tail -1)
pp=$(echo "$RAW" | grep -o '"path":"[^"]*"' | head -1 | sed 's/"path":"//; s/"$//' | sed 's/.*[\/]//')
[ -n "$pp" ] && echo "   成品 $pp sha=$($A shell "run-as $P sh -c 'sha256sum cache/arkli/out/$pp'" | cut -c1-12)"
