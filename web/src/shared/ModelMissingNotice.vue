<script setup lang="ts">
// 「无可用模型」提示条：工具页读目录发现当前没有就绪的模型时显示；只提示，点击去 AI 中心查看，下载由 AI 中心负责
import { useRouter } from 'vue-router'
import { AI_CENTER_PATH, MSG_NO_MODEL } from './modelPicker'

/** 路由器：点提示条去 AI 中心 */
const router = useRouter()

/** 点提示条：去 AI 中心 */
function go(): void {
  void router.push(AI_CENTER_PATH)
}
</script>

<template>
  <van-notice-bar mode="link" wrapable :scrollable="false" left-icon="info-o" @click="go">{{ MSG_NO_MODEL }}</van-notice-bar>
</template>
