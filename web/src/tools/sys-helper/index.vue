<script setup lang="ts">
// 系统调试助手：按参数生成 ADB 命令供复制，不会直接修改系统设置
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { openSettings } from '@/native/system'
import { copyText } from '@/shared/clipboard'
import {
  ANIM_MAX,
  ANIM_MIN,
  ANIM_PRESETS,
  BATTERY_MAX,
  BATTERY_MIN,
  BATTERY_RESET_COMMAND,
  BATTERY_STATUS_OPTIONS,
  buildAnimationCommands,
  buildBatteryCommands,
  buildDpiCommands,
  buildSizeCommands,
  CALIBRATION_TIPS,
  DPI_MAX,
  DPI_MIN,
  estimateDensityDpi,
  joinCommands,
  REBOOT_ITEMS,
  RESET_DISPLAY_COMMANDS,
  ROOT_REBOOT_NOTE,
  type CmdResult,
} from './logic'

/** 有宿主时才显示开发者选项按钮 */
const hasNative = isNativeAvailable()
/** 屏幕分辨率（CSS 像素 × 像素比，仅供参考） */
const screenW = Math.round(window.screen.width * window.devicePixelRatio)
/** 屏幕高度（物理像素估算） */
const screenH = Math.round(window.screen.height * window.devicePixelRatio)
/** 网页像素比 */
const dpr = window.devicePixelRatio
/** 推算 dpi */
const estDpi = estimateDensityDpi(dpr)

/** 目标 DPI */
const dpi = ref(estDpi >= DPI_MIN && estDpi <= DPI_MAX ? estDpi : 420)
/** 目标宽 */
const sizeW = ref(screenW)
/** 目标高 */
const sizeH = ref(screenH)
/** 伪装电量 */
const level = ref(50)
/** 伪装状态 */
const status = ref(3)
/** 是否模拟接入电源 */
const ac = ref(false)
/** 动画倍数 */
const scale = ref(0.5)

/** 把输入框的字符串/数字统一转成数字 */
function num(v: unknown): number {
  return v === '' || v === null ? NaN : Number(v)
}

/** 命令结果转展示文本，出错时给出错误 */
function show(r: CmdResult): { text: string; error: string } {
  return r.ok ? { text: joinCommands(r.commands), error: '' } : { text: '', error: r.error }
}

/** 各区命令与错误提示 */
const dpiCmd = computed(() => show(buildDpiCommands(num(dpi.value))))
/** 分辨率命令 */
const sizeCmd = computed(() => show(buildSizeCommands(num(sizeW.value), num(sizeH.value))))
/** 电量命令 */
const batCmd = computed(() => show(buildBatteryCommands(num(level.value), status.value, ac.value)))
/** 动画命令 */
const animCmd = computed(() => show(buildAnimationCommands(num(scale.value))))
/** 还原显示命令文本 */
const resetDisplayText = joinCommands(RESET_DISPLAY_COMMANDS)

/** 复制命令 */
async function copy(text: string): Promise<void> {
  if (!text) return
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 打开开发者选项 */
async function openDev(): Promise<void> {
  try {
    if (!(await openSettings('developer'))) showToast('打不开开发者选项，请先在「关于手机」连点版本号开启')
  } catch {
    showToast('打不开开发者选项')
  }
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="先说清楚">
      <p class="tool-hint">本工具不会直接修改系统设置，只帮你生成命令。命令需要在电脑上通过 USB 调试执行（手机开启 USB 调试并授权这台电脑，且已装好 adb）。</p>
      <van-button v-if="hasNative" size="small" plain type="primary" @click="openDev">打开开发者选项</van-button>
    </tool-group>

    <tool-group title="当前信息（仅供参考）">
      <van-cell title="屏幕分辨率" :value="`${screenW} × ${screenH}`" />
      <van-cell title="devicePixelRatio" :value="String(dpr)" />
      <van-cell title="推算 densityDpi" :value="String(estDpi)" />
      <p class="tool-hint">按网页像素比推算，接入原生信息后会更准。</p>
    </tool-group>

    <tool-group title="DPI 与分辨率">
      <van-field v-model="dpi" type="digit" :label="`DPI（${DPI_MIN}~${DPI_MAX}）`" :error-message="dpiCmd.error" />
      <pre class="sh-cmd">{{ dpiCmd.text }}</pre>
      <van-button size="small" type="primary" :disabled="!dpiCmd.text" @click="copy(dpiCmd.text)">复制命令</van-button>
      <van-field v-model="sizeW" type="digit" label="宽（px）" />
      <van-field v-model="sizeH" type="digit" label="高（px）" :error-message="sizeCmd.error" />
      <pre class="sh-cmd">{{ sizeCmd.text }}</pre>
      <van-button size="small" type="primary" :disabled="!sizeCmd.text" @click="copy(sizeCmd.text)">复制命令</van-button>
      <p class="tool-hint">改得太离谱可能导致界面无法操作，记得保留一条还原命令：</p>
      <pre class="sh-cmd">{{ resetDisplayText }}</pre>
      <van-button size="small" @click="copy(resetDisplayText)">复制还原命令</van-button>
    </tool-group>

    <tool-group title="电量伪装">
      <p class="tool-hint">只是让系统显示假电量，真实电池不变；用完请执行 reset。</p>
      <van-field v-model="level" type="digit" :label="`电量（${BATTERY_MIN}~${BATTERY_MAX}）`" :error-message="batCmd.error" />
      <van-radio-group v-model="status" direction="horizontal" class="sh-gap">
        <van-radio v-for="o in BATTERY_STATUS_OPTIONS" :key="o.value" :name="o.value">{{ o.label }}</van-radio>
      </van-radio-group>
      <van-cell center title="模拟接入交流电">
        <template #right-icon><van-switch v-model="ac" size="20" /></template>
      </van-cell>
      <pre class="sh-cmd">{{ batCmd.text }}</pre>
      <van-button size="small" type="primary" :disabled="!batCmd.text" @click="copy(batCmd.text)">复制命令</van-button>
      <pre class="sh-cmd">{{ BATTERY_RESET_COMMAND }}</pre>
      <van-button size="small" @click="copy(BATTERY_RESET_COMMAND)">复制还原命令</van-button>
    </tool-group>

    <tool-group title="动画速度">
      <p class="tool-hint">倍数越大动画越慢，「关」即 0；系统默认是 1。</p>
      <van-radio-group v-model="scale" direction="horizontal" class="sh-gap">
        <van-radio v-for="p in ANIM_PRESETS" :key="p.value" :name="p.value">{{ p.label }}</van-radio>
      </van-radio-group>
      <van-field v-model="scale" type="number" :label="`自定义（${ANIM_MIN}~${ANIM_MAX}）`" :error-message="animCmd.error" />
      <pre class="sh-cmd">{{ animCmd.text }}</pre>
      <van-button size="small" type="primary" :disabled="!animCmd.text" @click="copy(animCmd.text)">复制命令</van-button>
    </tool-group>

    <tool-group title="高级重启">
      <p class="tool-hint">在电脑上执行，需要 USB 调试已授权。</p>
      <van-cell v-for="r in REBOOT_ITEMS" :key="r.adb" :title="r.label" :label="`${r.adb}　${r.note}`" is-link @click="copy(r.adb)" />
      <p class="tool-hint">{{ ROOT_REBOOT_NOTE }}</p>
    </tool-group>

    <tool-group title="电量校准">
      <p v-for="t in CALIBRATION_TIPS" :key="t" class="tool-hint">{{ t }}</p>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
/* 命令块：可横向滚动，等宽字体 */
.sh-cmd {
  margin: $space-2 0;
  padding: $space-2;
  overflow-x: auto;
  font-family: monospace;
  font-size: 12px;
  white-space: pre;
  background: var(--c-bg, transparent);
  border: 1px solid var(--c-border);
  border-radius: 4px;
}
.sh-gap {
  margin: $space-3 0;
}
</style>
