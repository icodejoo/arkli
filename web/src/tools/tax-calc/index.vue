<script setup lang="ts">
// 个税 / 年终奖估算：综合所得年度税率表，年终奖单独计税与并入对比
import { computed, ref } from 'vue'
import { formatCents, yuanToCents } from '../mortgage/logic'
import { RULE_NOTE, calcSalaryTax, compareBonus } from './logic'

/** 月薪（元） */
const monthly = ref('20000')
/** 每月五险一金（元） */
const insurance = ref('3000')
/** 每月专项附加扣除（元） */
const special = ref('2000')
/** 年终奖（元） */
const bonus = ref('0')

/** 把输入转为分，非法或负数当 0 */
function cents(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? yuanToCents(n) : 0
}

/** 工资部分结果 */
const salary = computed(() =>
  calcSalaryTax({ monthlyCents: cents(monthly.value), insuranceCents: cents(insurance.value), specialCents: cents(special.value) }),
)
/** 年终奖对比，没填奖金时为 null */
const cmp = computed(() => (cents(bonus.value) > 0 ? compareBonus(salary.value, cents(bonus.value)) : null))
/** 更省税方式的文案 */
const betterText = computed(() => {
  if (!cmp.value) return ''
  if (cmp.value.better === 'same') return '两种方式税额相同'
  return cmp.value.better === 'separate' ? '单独计税更省' : '并入综合所得更省'
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="工资薪金（假设 12 个月相同）">
      <van-field v-model="monthly" type="number" label="税前月薪" input-align="right"><template #button>元</template></van-field>
      <van-field v-model="insurance" type="number" label="每月五险一金" input-align="right"><template #button>元</template></van-field>
      <van-field v-model="special" type="number" label="每月专项附加扣除" input-align="right"><template #button>元</template></van-field>
      <van-field v-model="bonus" type="number" label="年终奖" input-align="right"><template #button>元</template></van-field>
    </tool-group>
    <tool-group title="全年估算">
      <van-cell title="应纳税所得额" :value="`${formatCents(salary.taxableCents)} 元`" />
      <van-cell title="应纳税额" :value="`${formatCents(salary.taxCents)} 元`" />
      <van-cell title="税后收入（不含年终奖）" :value="`${formatCents(salary.afterTaxCents)} 元`" />
    </tool-group>
    <tool-group v-if="cmp" title="年终奖两种计税方式">
      <van-cell title="单独计税" :value="`${formatCents(cmp.separateCents)} 元`" />
      <van-cell title="并入综合所得（增加税额）" :value="`${formatCents(cmp.combinedCents)} 元`" />
      <van-cell title="结论" :value="betterText" />
    </tool-group>
    <van-notice-bar wrapable :scrollable="false" :text="`${RULE_NOTE}结果仅为估算，不含其他收入与汇算清缴差异。`" />
  </div>
</template>
