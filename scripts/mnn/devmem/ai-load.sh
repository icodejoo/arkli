#!/bin/bash
# 用法：aiasr-wav.sh 标签 provider ；冷启动后 native.ai.warmup，输出 底/峰值HWM/增量/稳态RSS/warmup耗时/卸载后RSS
export MSYS_NO_PATHCONV=1
A="adb ${ADB_SERIAL:+-s $ADB_SERIAL}"; P=com.let188.arkli.debug.exp; S=$(dirname "$0"); PROV=$2
st() { $A shell "cat /proc/$PID/status" | tr -d '\r' | grep -E "$1" | awk '{print int($2/1024)}'; }
$A shell am force-stop $P; $A shell am force-stop com.let188.arkli.debug; sleep 2; $A logcat -c
$A shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 8
PID=$($A shell pidof $P | tr -d '\r'); r0=$(st VmRSS)
$A push $(cygpath -m $S)/poll.sh /data/local/tmp/poll.sh >/dev/null
$A shell "rm -f /data/local/tmp/poll.stop; nohup sh /data/local/tmp/poll.sh $PID /data/local/tmp/poll.txt >/dev/null 2>&1 &"; sleep 1
C="$A shell am broadcast -p $P -a com.let188.arkli.debug.CMD"
$C --es cmd rpc --es method native.ai.warmup --es params "{\"provider\":\"$PROV\"}" --es id w1 >/dev/null
for i in $(seq 1 120); do $A logcat -d | grep -q 'DBGMSG.*"id":"w1"' && break; sleep 1; done; sleep 1
hwm=$(st VmHWM); r1=$(st VmRSS)
$A shell "touch /data/local/tmp/poll.stop"; sleep 0.5
msg=$($A logcat -d | tr -d '\r' | grep 'DBGMSG.*"id":"w1"' | tail -1 | cut -c60-330)
el=$(echo "$msg" | grep -o '"elapsedMs":[0-9]*'); err=$(echo "$msg" | grep -o '"code":"[A-Z_]*"')
$C --es cmd rpc --es method native.ai.unload --es params "{\"provider\":\"$PROV\"}" --es id u1 >/dev/null; sleep 6
r2=$(st VmRSS)
echo "$1: 底=$r0 峰值=$hwm 增量=$((hwm-r0)) 稳态RSS=$r1 卸载后=$r2 $el $err"
