#!/bin/bash
# 用法：verify.sh <模型 id> ；冷启动后调 native.model.verify，等到返回
export MSYS_NO_PATHCONV=1
A="adb ${ADB_SERIAL:+-s $ADB_SERIAL}"; P=com.let188.arkli.debug.exp
$A shell am force-stop $P; $A logcat -c; $A shell monkey -p $P -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 8
$A shell am broadcast -p $P -a com.let188.arkli.debug.CMD --es cmd rpc --es method native.model.verify --es params "{\"id\":\"$1\"}" --es id v1 >/dev/null
for i in $(seq 1 90); do $A logcat -d | grep -q 'DBGMSG.*"id":"v1"' && break; sleep 1; done
$A logcat -d | tr -d '\r' | grep 'DBGMSG.*"id":"v1"' | tail -1 | grep -o '"state":"[a-z_]*"\|"code":"[A-Z_]*"\|"message":"[^"]*"' | tr '\n' ' '; echo
