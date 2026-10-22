#!/system/bin/sh
# 设备端：每 100ms 记录 VmRSS/VmHWM（kB）；存在 poll.stop 文件时退出
pid=$1; out=$2; : > $out
while [ -d /proc/$pid ] && [ ! -f /data/local/tmp/poll.stop ]; do
  echo $(grep -E "VmHWM|VmRSS" /proc/$pid/status) >> $out
  sleep 0.1
done
