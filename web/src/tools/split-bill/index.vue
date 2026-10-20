<script setup lang="ts">
// 小费 / AA 分账 / 折扣：金额内部用分计算
import { computed, ref } from 'vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { formatCents, yuanToCents } from '../mortgage/logic'
import { calcAa, calcDiscount, calcTip, type AaItem } from './logic'

/** 标签页 */
const tab = ref<'tip' | 'aa' | 'discount'>('tip')
/** 默认成员名前缀 */
const MEMBER_PREFIX = '成员'

/** 输入转分，非法或负数当 0 */
function cents(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? yuanToCents(n) : 0
}

// ---- 小费 ----
/** 账单金额 */
const tipAmount = ref('200')
/** 小费比例 */
const tipPct = ref('15')
/** 人数 */
const tipPeople = ref('2')
/** 小费结果 */
const tip = computed(() => {
  const people = Math.max(1, Math.floor(Number(tipPeople.value)) || 1)
  return calcTip(cents(tipAmount.value), Math.max(0, Number(tipPct.value) || 0), people)
})

// ---- AA ----
/** 成员名 */
const members = ref<string[]>([`${MEMBER_PREFIX}1`, `${MEMBER_PREFIX}2`, `${MEMBER_PREFIX}3`])
/** 表单项目：金额为字符串，参与者为下标 */
const aaItems = ref<{ name: string; amount: string; members: number[] }[]>([{ name: '餐费', amount: '300', members: [0, 1, 2] }])
/** 每个成员应付 */
const aaOwe = computed(() => {
  const items: AaItem[] = aaItems.value.map((i) => ({ name: i.name, cents: cents(i.amount), members: i.members }))
  return calcAa(members.value.length, items)
})

/** 添加成员，新成员默认不参与已有项目 */
function addMember(): void {
  members.value.push(`${MEMBER_PREFIX}${members.value.length + 1}`)
}

/** 删除成员并修正各项目参与者下标 */
function removeMember(idx: number): void {
  if (members.value.length <= 1) return
  members.value.splice(idx, 1)
  for (const it of aaItems.value) {
    it.members = it.members.filter((m) => m !== idx).map((m) => (m > idx ? m - 1 : m))
  }
}

/** 添加项目，默认全员参与 */
function addItem(): void {
  aaItems.value.push({ name: '', amount: '', members: members.value.map((_, i) => i) })
}

/** 切换某项目某成员的参与状态 */
function toggle(it: { members: number[] }, idx: number): void {
  const p = it.members.indexOf(idx)
  if (p >= 0) it.members.splice(p, 1)
  else it.members.push(idx)
}

// ---- 折扣 ----
/** 原价 */
const original = ref('500')
/** 折扣（折） */
const zhe = ref('8.5')
/** 立减 */
const reduce = ref('50')
/** 叠加顺序 */
const order = ref<'rate-first' | 'reduce-first'>('rate-first')
/** 折扣与立减的先后顺序选项 */
const ORDER_OPTIONS: CellOption[] = [
  { value: 'rate-first', label: '先打折再立减' },
  { value: 'reduce-first', label: '先立减再打折' },
]
/** 折扣结果 */
const disc = computed(() =>
  calcDiscount({ originalCents: cents(original.value), zhe: Number(zhe.value) || 10, reduceCents: cents(reduce.value), order: order.value }),
)
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab title="小费" name="tip" />
      <van-tab title="AA 分账" name="aa" />
      <van-tab title="折扣" name="discount" />
    </van-tabs>

    <template v-if="tab === 'tip'">
      <tool-group title="账单">
        <van-field v-model="tipAmount" type="number" label="账单金额" input-align="right"><template #button>元</template></van-field>
        <van-field v-model="tipPct" type="number" label="小费比例" input-align="right"><template #button>%</template></van-field>
        <van-field v-model="tipPeople" type="digit" label="人数" input-align="right"><template #button>人</template></van-field>
      </tool-group>
      <tool-group title="结果">
        <van-cell title="小费" :value="`${formatCents(tip.tipCents)} 元`" />
        <van-cell title="合计" :value="`${formatCents(tip.totalCents)} 元`" />
        <van-cell
          title="每人"
          :value="`${formatCents(tip.perPerson[0])} 元`"
          :label="tip.perPerson[0] !== tip.perPerson[tip.perPerson.length - 1] ? '除不尽，前几位多 1 分' : ''"
        />
      </tool-group>
    </template>

    <template v-else-if="tab === 'aa'">
      <tool-group title="成员">
        <van-field v-for="(_, i) in members" :key="i" v-model="members[i]" :label="`${i + 1}`" maxlength="10">
          <template #button>
            <van-button size="mini" plain type="danger" :disabled="members.length <= 1" @click="removeMember(i)">删除</van-button>
          </template>
        </van-field>
        <van-button size="small" plain @click="addMember">添加成员</van-button>
      </tool-group>
      <tool-group v-for="(it, n) in aaItems" :key="n" :title="`项目 ${n + 1}`">
        <van-field v-model="it.name" label="名称" placeholder="如：餐费" maxlength="20" />
        <van-field v-model="it.amount" type="number" label="金额" input-align="right"><template #button>元</template></van-field>
        <div class="chips">
          <van-tag
            v-for="(m, i) in members"
            :key="i"
            :type="it.members.includes(i) ? 'primary' : 'default'"
            size="large"
            @click="toggle(it, i)"
          >
            {{ m || `${MEMBER_PREFIX}${i + 1}` }}
          </van-tag>
        </div>
        <van-button size="small" plain type="danger" class="mt" @click="aaItems.splice(n, 1)">删除此项</van-button>
      </tool-group>
      <van-button block class="mt" @click="addItem">添加项目</van-button>
      <tool-group title="每人应付">
        <van-cell v-for="(m, i) in members" :key="i" :title="m || `${MEMBER_PREFIX}${i + 1}`" :value="`${formatCents(aaOwe[i])} 元`" />
        <van-cell title="合计" :value="`${formatCents(aaOwe.reduce((a, b) => a + b, 0))} 元`" />
        <p class="tool-hint mt">点名字切换是否参与该项目；除不尽的零头逐分分给靠前的人。</p>
      </tool-group>
    </template>

    <template v-else>
      <tool-group title="价格与优惠">
        <van-field v-model="original" type="number" label="原价" input-align="right"><template #button>元</template></van-field>
        <van-field v-model="zhe" type="number" label="折扣" placeholder="如 8.5，10 为不打折" input-align="right">
          <template #button>折</template>
        </van-field>
        <van-field v-model="reduce" type="number" label="立减" input-align="right"><template #button>元</template></van-field>
        <cell-picker :model-value="order" title="优惠顺序" :options="ORDER_OPTIONS" @update:model-value="order = $event as 'rate-first' | 'reduce-first'" />
      </tool-group>
      <tool-group title="结果">
        <van-cell title="实付" :value="`${formatCents(disc.finalCents)} 元`" />
        <van-cell title="省下" :value="`${formatCents(disc.savedCents)} 元`" />
        <van-cell title="综合折扣" :value="`${disc.effectiveZhe} 折`" />
      </tool-group>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.mt {
  margin-top: $space-2;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  padding: $space-2 0;
}
</style>
