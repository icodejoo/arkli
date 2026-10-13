<script setup lang="ts">
// Bridge 探针：调用 native.hello、native.ping 与 rust.core.version，展示结果或错误
import { onMounted, ref } from 'vue'
import { call } from '@/native/bridge'
import type { BridgeError } from '@/native/protocol'
import { formatError } from './format-error'

/** 探测的方法列表 */
const METHODS = ['native.hello', 'native.ping', 'rust.core.version']

/** 单个方法的探测状态 */
interface ProbeItem {
  /** 方法名 */
  method: string
  /** 状态：等待 / 成功 / 失败 */
  status: 'pending' | 'ok' | 'error'
  /** 成功时的返回值文本，或失败时的错误文本 */
  text: string
}

/** 探测结果列表 */
const items = ref<ProbeItem[]>([])
/** 是否在 Arkli 容器内（浏览器调试时为 false） */
const inContainer = ref(true)

/** 依次探测所有方法并更新展示 */
async function run(): Promise<void> {
  items.value = METHODS.map((method) => ({ method, status: 'pending', text: '请求中…' }))
  inContainer.value = true
  for (const item of items.value) {
    try {
      const data = await call(item.method)
      item.status = 'ok'
      item.text = JSON.stringify(data)
    } catch (e) {
      item.status = 'error'
      item.text = formatError(e)
      // NOT_READY 说明没有原生宿主，归为浏览器调试
      if ((e as Partial<BridgeError>)?.code === 'NOT_READY') inContainer.value = false
    }
  }
}

onMounted(run)
</script>

<template>
  <section>
    <p v-if="!inContainer" class="tip">
      当前不在 Arkli 容器内（可能是浏览器调试），没有原生宿主可以通信。装进 App 后再试。
    </p>
    <ul class="list">
      <li v-for="it in items" :key="it.method" class="row" :class="`row--${it.status}`">
        <code class="row__method">{{ it.method }}</code>
        <span class="row__text">{{ it.text }}</span>
      </li>
    </ul>
    <button class="btn" type="button" @click="run">重新探测</button>
  </section>
</template>

<style lang="scss" scoped>
.tip {
  padding: $space-3;
  border-radius: $radius;
  background: var(--c-warn-bg);
  color: var(--c-warn-text);
  font-size: 14px;
}

.list {
  margin: 0 0 $space-4;
  padding: 0;
  list-style: none;
}

.row {
  padding: $space-3;
  margin-bottom: $space-2;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: $radius;
  word-break: break-all;

  &__method {
    display: block;
    font-weight: 600;
    margin-bottom: $space-1;
  }

  &__text {
    font-size: 13px;
    color: var(--c-text-muted);
  }

  &--ok &__text {
    color: var(--c-ok);
  }

  &--error &__text {
    color: var(--c-error);
  }
}

.btn {
  padding: $space-2 $space-4;
  border: 0;
  border-radius: $radius;
  background: var(--c-primary);
  color: var(--c-on-primary);
  font-size: 15px;
  cursor: pointer;
}
</style>
