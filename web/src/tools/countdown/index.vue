<script setup lang="ts">
// 倒数日 / 纪念日：本地保存，按剩余天数排序（农历重复暂不支持）
import { computed, onMounted, ref } from 'vue'
import { createToolStorage } from '@/shared/toolStorage'
import { buildList, describeDays, loadEvents, saveEvents, todayDay, validateEvent, type CountdownEvent } from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('countdown')

/** 全部事件 */
const events = ref<CountdownEvent[]>([])
/** 今天的天序号 */
const today = ref(todayDay())
/** 排好序的列表 */
const list = computed(() => buildList(events.value, today.value))

/** 编辑弹层是否显示 */
const showEdit = ref(false)
/** 正在编辑的事件 id，空表示新增 */
const editId = ref('')
/** 表单：名称 */
const fName = ref('')
/** 表单：日期 */
const fDate = ref('')
/** 表单：每年重复 */
const fYearly = ref(false)
/** 表单错误 */
const error = ref('')

/** 写存储，失败忽略 */
function save(): void {
  saveEvents(store, events.value)
}

onMounted(() => {
  events.value = loadEvents(store)
})

/** 打开编辑弹层，传入事件则为修改 */
function openEdit(ev?: CountdownEvent): void {
  editId.value = ev?.id ?? ''
  fName.value = ev?.name ?? ''
  fDate.value = ev?.date ?? ''
  fYearly.value = ev?.yearly ?? false
  error.value = ''
  showEdit.value = true
}

/** 提交表单 */
function submit(): void {
  error.value = validateEvent(fName.value, fDate.value)
  if (error.value) return
  const item: CountdownEvent = {
    id: editId.value || `${Date.now()}`,
    name: fName.value.trim(),
    date: fDate.value,
    yearly: fYearly.value,
  }
  const i = events.value.findIndex((e) => e.id === item.id)
  if (i >= 0) events.value[i] = item
  else events.value.push(item)
  save()
  showEdit.value = false
}

/** 删除当前编辑的事件 */
function remove(): void {
  events.value = events.value.filter((e) => e.id !== editId.value)
  save()
  showEdit.value = false
}

/** 点击列表项进入编辑 */
function edit(id: string): void {
  openEdit(events.value.find((e) => e.id === id))
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="倒数日">
      <p v-if="!list.length" class="tool-hint">还没有事件，点下面的按钮添加。</p>
      <van-cell
        v-for="it in list"
        :key="it.id"
        :title="it.name"
        :label="`${it.target}${it.yearly ? '（每年）' : ''}`"
        :value="describeDays(it.days)"
        is-link
        @click="edit(it.id)"
      />
      <van-button block type="primary" class="mt" @click="openEdit()">添加事件</van-button>
    </tool-group>
    <van-popup v-model:show="showEdit" position="bottom" round>
      <div class="pop">
        <van-field v-model="fName" label="名称" placeholder="如：生日" maxlength="30" />
        <van-field v-model="fDate" label="日期" type="date" />
        <van-cell title="每年重复">
          <template #right-icon><van-switch v-model="fYearly" size="20" /></template>
        </van-cell>
        <p v-if="error" class="tool-hint err">{{ error }}</p>
        <van-button block type="primary" class="mt" @click="submit">保存</van-button>
        <van-button v-if="editId" block plain type="danger" class="mt" @click="remove">删除</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
.mt {
  margin-top: $space-2;
}
.err {
  color: var(--c-error);
}
.pop {
  padding: $space-2;
}
</style>
