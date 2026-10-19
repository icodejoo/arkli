<script setup lang="ts">
// BMI 与基础代谢：中国成人分级 + Mifflin-St Jeor，仅供参考
import { computed, ref } from 'vue'
import { ACTIVITY_LEVELS, bmiLevel, calcBmi, calcBmr, calcTdee, normalWeightRange, type Sex } from './logic'

/** 性别 */
const sex = ref<Sex>('male')
/** 年龄 */
const age = ref('30')
/** 身高 cm */
const height = ref('170')
/** 体重 kg */
const weight = ref('65')
/** 活动系数 */
const factor = ref<number>(ACTIVITY_LEVELS[0].factor)

/** 计算结果，输入不全返回 null */
const result = computed(() => {
  const h = Number(height.value)
  const w = Number(weight.value)
  const a = Number(age.value)
  const bmi = calcBmi(h, w)
  if (bmi === null) return null
  const bmr = a > 0 ? calcBmr(sex.value, a, h, w) : null
  return {
    bmi,
    level: bmiLevel(bmi),
    range: normalWeightRange(h),
    bmr,
    tdee: bmr === null ? null : calcTdee(bmr, factor.value),
  }
})
</script>

<template>
  <div class="tool-page">
    <tool-group title="身体数据">
      <van-radio-group v-model="sex" direction="horizontal">
        <van-radio name="male">男</van-radio>
        <van-radio name="female">女</van-radio>
      </van-radio-group>
      <van-field v-model="age" type="digit" label="年龄" input-align="right"><template #button>岁</template></van-field>
      <van-field v-model="height" type="number" label="身高" input-align="right"><template #button>cm</template></van-field>
      <van-field v-model="weight" type="number" label="体重" input-align="right"><template #button>kg</template></van-field>
      <van-field label="活动水平">
        <template #input>
          <select v-model.number="factor" class="sel">
            <option v-for="l in ACTIVITY_LEVELS" :key="l.key" :value="l.factor">{{ l.label }}</option>
          </select>
        </template>
      </van-field>
    </tool-group>
    <tool-group v-if="result" title="结果">
      <van-cell title="BMI" :value="`${result.bmi}（${result.level}）`" />
      <van-cell title="正常体重范围" :value="`${result.range[0]} ~ ${result.range[1]} kg`" />
      <template v-if="result.bmr !== null">
        <van-cell title="基础代谢 BMR" :value="`${result.bmr} 千卡/天`" />
        <van-cell title="每日总能耗 TDEE" :value="`${result.tdee} 千卡/天`" />
      </template>
      <van-notice-bar
        wrapable
        :scrollable="false"
        text="仅供参考，不能替代医学诊断。BMI 分级为中国成人标准，不适用于未成年人、孕妇和运动员。"
      />
    </tool-group>
    <p v-else class="tool-hint">请填写身高和体重。</p>
  </div>
</template>

<style lang="scss" scoped>
.sel {
  width: 100%;
  border: none;
  background: transparent;
  color: inherit;
  font-size: inherit;
}
</style>
