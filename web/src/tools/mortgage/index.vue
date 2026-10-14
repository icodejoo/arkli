<script setup lang="ts">
// 房贷计算器：商贷 / 公积金 / 组合贷，等额本息或等额本金，附逐月还款表（分批加载，长表不卡）
import { computed, ref } from 'vue'
import {
  calcCombined,
  calcLoan,
  formatCents,
  MAX_YEARS,
  MONTHS_PER_YEAR,
  yuanToCents,
  type LoanInput,
  type LoanResult,
  type RepayMethod,
} from './logic'

/** 一万元 */
const WAN = 10000
/** 还款表每批显示的行数 */
const PAGE_SIZE = 60

/** 贷款类型：商贷 / 公积金 / 组合 */
type Kind = 'biz' | 'fund' | 'combo'

/** 表单里一笔贷款的原始输入（字符串，便于编辑） */
interface LoanForm {
  /** 金额，万元 */
  wan: string
  /** 年利率，% */
  rate: string
  /** 年限 */
  years: string
}

/** 贷款类型 */
const kind = ref<Kind>('biz')
/** 还款方式 */
const method = ref<RepayMethod>('equal-payment')
/** 商贷输入 */
const biz = ref<LoanForm>({ wan: '100', rate: '3.5', years: '30' })
/** 公积金输入 */
const fund = ref<LoanForm>({ wan: '50', rate: '2.85', years: '30' })
/** 还款表是否展开 */
const showTable = ref(false)
/** 已显示的还款表行数 */
const shown = ref(PAGE_SIZE)

/** 把表单转成贷款输入，金额或年限不合法时返回 null */
function toLoan(f: LoanForm): LoanInput | null {
  const wan = Number(f.wan)
  const years = Number(f.years)
  const rate = Number(f.rate)
  if (!(wan > 0) || !(years >= 1) || !Number.isFinite(rate)) return null
  return { principalCents: yuanToCents(wan * WAN), annualRatePct: rate, months: Math.round(years * MONTHS_PER_YEAR) }
}

/** 计算结果与错误提示 */
const outcome = computed<{ result: LoanResult | null; error: string }>(() => {
  const forms = kind.value === 'biz' ? [biz.value] : kind.value === 'fund' ? [fund.value] : [biz.value, fund.value]
  const loans: LoanInput[] = []
  for (const f of forms) {
    const l = toLoan(f)
    if (!l) return { result: null, error: '请填写完整：金额大于 0、年限不少于 1' }
    loans.push(l)
  }
  try {
    return { result: loans.length === 1 ? calcLoan(loans[0], method.value) : calcCombined(loans, method.value), error: '' }
  } catch (e) {
    return { result: null, error: (e as Error).message }
  }
})

/** 当前显示的还款表行 */
const visibleRows = computed(() => outcome.value.result?.rows.slice(0, shown.value) ?? [])
/** 总期数 */
const totalRows = computed(() => outcome.value.result?.rows.length ?? 0)
/** 总贷款额（分） */
const totalPrincipal = computed(() => (outcome.value.result ? outcome.value.result.totalPayment - outcome.value.result.totalInterest : 0))

/** 展开/收起还款表，同时重置分页 */
function toggleTable(): void {
  showTable.value = !showTable.value
  shown.value = PAGE_SIZE
}

/** 再多显示一批 */
function more(): void {
  shown.value += PAGE_SIZE
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="kind" type="card">
      <van-tab title="商业贷款" name="biz" />
      <van-tab title="公积金" name="fund" />
      <van-tab title="组合贷" name="combo" />
    </van-tabs>

    <div v-if="kind !== 'fund'" class="tool-card">
      <h3 class="tool-card__title">{{ kind === 'combo' ? '商业贷款部分' : '商业贷款' }}</h3>
      <van-field v-model="biz.wan" type="number" label="贷款金额" placeholder="万元" input-align="right">
        <template #button>万元</template>
      </van-field>
      <van-field v-model="biz.rate" type="number" label="年利率" input-align="right">
        <template #button>%</template>
      </van-field>
      <van-field v-model="biz.years" type="digit" :label="`年限（≤${MAX_YEARS}）`" input-align="right">
        <template #button>年</template>
      </van-field>
    </div>

    <div v-if="kind !== 'biz'" class="tool-card">
      <h3 class="tool-card__title">{{ kind === 'combo' ? '公积金部分' : '公积金贷款' }}</h3>
      <van-field v-model="fund.wan" type="number" label="贷款金额" placeholder="万元" input-align="right">
        <template #button>万元</template>
      </van-field>
      <van-field v-model="fund.rate" type="number" label="年利率" input-align="right">
        <template #button>%</template>
      </van-field>
      <van-field v-model="fund.years" type="digit" :label="`年限（≤${MAX_YEARS}）`" input-align="right">
        <template #button>年</template>
      </van-field>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">还款方式</h3>
      <van-radio-group v-model="method" direction="horizontal">
        <van-radio name="equal-payment">等额本息</van-radio>
        <van-radio name="equal-principal">等额本金</van-radio>
      </van-radio-group>
      <p class="tool-hint mt">利率请按自己的合同填写，这里不内置 LPR。</p>
    </div>

    <div v-if="outcome.error" class="tool-card">
      <p class="tool-hint err">{{ outcome.error }}</p>
    </div>

    <template v-if="outcome.result">
      <div class="tool-card">
        <h3 class="tool-card__title">结果</h3>
        <van-cell
          v-if="method === 'equal-payment'"
          title="每月还款"
          :value="`${formatCents(outcome.result.firstPayment)} 元`"
        />
        <template v-else>
          <van-cell title="首月还款" :value="`${formatCents(outcome.result.firstPayment)} 元`" />
          <van-cell title="末月还款" :value="`${formatCents(outcome.result.lastPayment)} 元`" />
        </template>
        <van-cell title="贷款总额" :value="`${formatCents(totalPrincipal)} 元`" />
        <van-cell title="总利息" :value="`${formatCents(outcome.result.totalInterest)} 元`" />
        <van-cell title="总还款" :value="`${formatCents(outcome.result.totalPayment)} 元`" />
        <p v-if="method === 'equal-payment' && kind === 'combo'" class="tool-hint mt">
          组合贷两笔期限不同时，较短的一笔还清后月供会下降。
        </p>
        <p class="tool-hint mt">逐月利息四舍五入到分，最后一期并入尾差，本金合计精确等于贷款额。</p>
      </div>

      <div class="tool-card">
        <h3 class="tool-card__title">逐月还款表（{{ totalRows }} 期）</h3>
        <van-button size="small" plain @click="toggleTable">{{ showTable ? '收起' : '展开' }}</van-button>
        <div v-if="showTable" class="mt">
          <div class="mg-row mg-row--head">
            <span>期</span><span>月供</span><span>本金</span><span>利息</span><span>剩余</span>
          </div>
          <div v-for="r in visibleRows" :key="r.period" class="mg-row">
            <span>{{ r.period }}</span>
            <span>{{ formatCents(r.payment) }}</span>
            <span>{{ formatCents(r.principal) }}</span>
            <span>{{ formatCents(r.interest) }}</span>
            <span>{{ formatCents(r.balance) }}</span>
          </div>
          <van-button v-if="shown < totalRows" size="small" block class="mt" @click="more">
            再显示 {{ Math.min(PAGE_SIZE, totalRows - shown) }} 期
          </van-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.mt {
  margin-top: $space-2;
}
.err {
  color: var(--c-error);
}

/* 还款表一行五列，窄屏字号小一点，数字右对齐 */
.mg-row {
  display: grid;
  grid-template-columns: 34px repeat(4, 1fr);
  gap: 4px;
  padding: 6px 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--c-border);

  span {
    text-align: right;
    word-break: break-all;
  }
  span:first-child {
    text-align: left;
  }

  &--head {
    color: var(--c-text-muted);
  }
}
</style>
