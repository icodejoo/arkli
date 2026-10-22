#!/bin/bash
# 用法：pushmodel.sh <本地目录> <模型 id> ；把目录内容整替换到实验包 files/models/<id>
export MSYS_NO_PATHCONV=1
A="adb ${ADB_SERIAL:+-s $ADB_SERIAL}"; P=com.let188.arkli.debug.exp; D=files/models/$2
$A shell "run-as $P sh -c 'rm -rf $D; mkdir -p $D'"
$A shell "rm -rf /data/local/tmp/pm; mkdir -p /data/local/tmp/pm"
for f in "$1"/*; do n=$(basename "$f"); [ "$n" = convert.json ] && continue
  $A push "$(cygpath -m "$f")" /data/local/tmp/pm/$n >/dev/null
  $A shell "run-as $P sh -c 'cat /data/local/tmp/pm/$n > $D/$n'"; $A shell "rm /data/local/tmp/pm/$n"; done
$A shell "run-as $P sh -c 'ls -l $D'" | awk '{print $5, $8}' | tr '\n' ';'; echo
