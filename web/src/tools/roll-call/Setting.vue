<script setup lang="ts">
// 随机点名设置页：不重复、自动停止、转速、模糊；状态与主页面共享
import {
  BLUR_DEF,
  IDLE_RPM_DEF,
  MAX_SPIN_SECONDS,
  MIN_SPIN_SECONDS,
  SPIN_RPS_DEF,
  useRollCallSettings,
} from './settings'

/** 共享设置 */
const { noRepeat, autoStop, spinSeconds, blurPx, idleRpm, spinRps, resetUsed } = useRollCallSettings()
</script>

<template>
  <div class="tool-setting">
    <tool-group title="点名设置">
      <van-cell title="不重复" label="一份名单最多被抽中一次" center>
        <template #value><van-switch v-model="noRepeat" size="22" @change="resetUsed" /></template>
      </van-cell>
      <van-cell title="是否自动停止" label="关闭后需手动点“停止”" center>
        <template #value><van-switch v-model="autoStop" size="22" /></template>
      </van-cell>
      <van-cell v-if="autoStop" class="spin-cell" title="转动时长" :label="`${spinSeconds} 秒`" center>
        <van-slider v-model="spinSeconds" :min="MIN_SPIN_SECONDS" :max="MAX_SPIN_SECONDS" :step="1" />
      </van-cell>
      <van-cell class="spin-cell" title="抽奖转速" :label="`${spinRps} 圈/秒`" center>
        <van-slider v-model="spinRps" :min="SPIN_RPS_DEF.min" :max="SPIN_RPS_DEF.max" :step="SPIN_RPS_DEF.step" />
      </van-cell>
      <van-cell class="spin-cell" title="闲时转速" :label="`${idleRpm} 圈/分`" center>
        <van-slider v-model="idleRpm" :min="IDLE_RPM_DEF.min" :max="IDLE_RPM_DEF.max" :step="IDLE_RPM_DEF.step" />
      </van-cell>
      <van-cell class="spin-cell" title="模糊程度" :label="blurPx > 0 ? `${blurPx} px` : '关闭'" center>
        <van-slider v-model="blurPx" :min="BLUR_DEF.min" :max="BLUR_DEF.max" :step="BLUR_DEF.step" />
      </van-cell>
      <van-button v-if="noRepeat" size="small" plain @click="resetUsed">重置已抽记录</van-button>
    </tool-group>
  </div>
</template>

<style scoped>
/* 标题按内容宽，滑块占满剩余宽度；两侧留边距免得圆点被 overflow 裁掉 */
.spin-cell :deep(.van-cell__title) {
  flex: none;
}
.spin-cell :deep(.van-cell__value) {
  flex: 1;
  max-width: none;
  overflow: visible;
  display: flex;
  align-items: center;
  padding: 8px 12px 8px 20px;
}
.spin-cell :deep(.van-slider) {
  flex: 1;
}
</style>
