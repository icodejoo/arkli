#!/bin/bash
# 用法：asr-wav.sh 标签 ；输出一行摘要（MB）：启动底/峰值HWM/增量/识别后RSS/unload30s后RSS/loadMs/RTF均值/文本是否同基线
export MSYS_NO_PATHCONV=1
A="adb ${ADB_SERIAL:+-s $ADB_SERIAL}"; P=${PKG:-com.let188.arkli.debug.exp}; S=$(dirname "$0")
st() { $A shell "cat /proc/$PID/status" | tr -d '\r' | grep -E "$1" | awk '{print int($2/1024)}'; }
$A shell am force-stop com.let188.arkli.debug; $A shell am force-stop $P; sleep 2
$A logcat -c
$A shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 8
PID=$($A shell pidof $P | tr -d '\r')
r0=$(st VmRSS)
$A push $(cygpath -m $S)/poll.sh /data/local/tmp/poll.sh >/dev/null
$A shell "rm -f /data/local/tmp/poll.stop; nohup sh /data/local/tmp/poll.sh $PID /data/local/tmp/poll.txt >/dev/null 2>&1 &"
sleep 1
$A shell am broadcast -p $P -a com.let188.arkli.debug.CMD --es cmd asrwav >/dev/null
for i in $(seq 1 90); do $A logcat -d -s ArkliDebug:I | grep -q "DBGASR done\|DBGASR FAIL" && break; sleep 1; done
sleep 1
hwm=$(st VmHWM); r1=$(st VmRSS)
$A shell "touch /data/local/tmp/poll.stop"; sleep 0.5
$A shell cat /data/local/tmp/poll.txt | tr -d '\r' > ${INF_DIR:-$S}/poll_$1.txt
$A shell am broadcast -p $P -a com.let188.arkli.debug.CMD --es cmd asrunload >/dev/null
sleep 30
r2=$(st VmRSS)
$A logcat -d -s ArkliDebug:I ArkliSpeech:I | tr -d '\r' > ${INF_DIR:-$S}/log_$1.txt
grep -o "text=「.*」" ${INF_DIR:-$S}/log_$1.txt > ${INF_DIR:-$S}/texts_$1.txt
[ -f ${INF_DIR:-$S}/texts_REF.txt ] || cp ${INF_DIR:-$S}/texts_$1.txt ${INF_DIR:-$S}/texts_REF.txt
same=$(diff -q ${INF_DIR:-$S}/texts_REF.txt ${INF_DIR:-$S}/texts_$1.txt >/dev/null && echo 同 || echo 异)
n=$(wc -l < ${INF_DIR:-$S}/texts_$1.txt)
load=$(grep -o "loadMs=[0-9]*" ${INF_DIR:-$S}/log_$1.txt | tail -1)
rtf=$(grep -o "RTF=[0-9.]*" ${INF_DIR:-$S}/log_$1.txt | cut -d= -f2 | awk '{s+=$1;n++} END{if(n)printf "%.3f",s/n}')
pss=$(grep -o "DBGASR done.*" ${INF_DIR:-$S}/log_$1.txt | grep -o "pss=[0-9]*MB nativeHeap=[0-9]*MB")
echo "$1: 底=$r0 峰值=$hwm 增量=$((hwm-r0)) 识别后RSS=$r1 卸载30s=$r2 $load RTF均=$rtf 文本$same($n条) [$pss]"
