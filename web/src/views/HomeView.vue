<script setup lang="ts">
// 首页：标题 + 搜索 + 最近使用宫格 + 全部工具宫格，点击进入 /tool/:id
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { pinToolShortcut } from '@/native/shortcut'
import { useToolsStore } from '@/stores/tools'
import { filterTools } from './toolFilter'
import logo from '@/assets/arkli-icon.svg'
import { toolIcon } from './toolIcons'
import { createLongPress } from './useLongPress'

/** 宫格列数：360px 宽下 4 列，名称最多两行 */
const GRID_COLUMNS = 4
/** 最近使用只显示一行 */
const RECENT_SHOWN = GRID_COLUMNS

/** 工具 store */
const store = useToolsStore()
/** 搜索词 */
const keyword = ref('')
/** 过滤后的全部工具 */
const filtered = computed(() => filterTools(store.all, keyword.value))
/** 最近使用（一行）；搜索时隐藏 */
const recent = computed(() => (keyword.value.trim() ? [] : store.recent.slice(0, RECENT_SHOWN)))

/** 路由 */
const router = useRouter()
/** 长按菜单是否显示 */
const sheetShow = ref(false)
/** 长按选中的工具 id */
const pressedId = ref('')
/** 长按选中的工具 */
const pressed = computed(() => store.all.find((t) => t.id === pressedId.value))
/** 长按菜单项（只有一项，留成数组是 ActionSheet 的要求） */
const sheetActions = [{ name: '添加到桌面' }]
/** 长按识别：只在 App 内启用，浏览器里没有桌面可加 */
const longPress = createLongPress((id) => {
  if (!isNativeAvailable()) return
  pressedId.value = id
  sheetShow.value = true
})

/** 点击工具：刚长按过就吞掉这次点击，否则进入工具页 */
function open(id: string): void {
  if (longPress.consumeClick()) return
  void router.push(`/tool/${id}`)
}

/** 菜单选择：请求系统把当前工具固定到桌面 */
async function onSelect(): Promise<void> {
  const t = pressed.value
  sheetShow.value = false
  if (!t) return
  try {
    const r = await pinToolShortcut({ label: t.name, icon: toolIcon(t.id), toolId: t.id })
    showToast(r.requested ? '请在系统弹窗里确认添加' : '当前桌面不支持添加快捷方式')
  } catch (e) {
    showToast(e instanceof Error ? e.message : '添加失败')
  }
}
</script>

<template>
  <div class="home">
    <!-- 状态栏位置的遮罩：窗口是边到边的，内容滚上去时盖住，免得和状态栏的时间、电量叠在一起 -->
    <div class="home__scrim" aria-hidden="true" />
    <header class="home__head">
      <div class="home__row">
        <h1 class="home__title"><img class="home__logo" :src="logo" alt="Arkli" /></h1>
        <van-button class="home__setting" icon="setting-o" plain round hairline to="/settings" aria-label="设置" />
      </div>
    </header>

    <van-search v-model="keyword" shape="round" placeholder="搜索工具名称或简介" />

    <section v-if="recent.length" class="home__block">
      <h2 class="home__label">最近使用</h2>
      <van-grid class="home__grid" :column-num="GRID_COLUMNS" :border="false">
        <van-grid-item
          v-for="t in recent"
          :key="t.id"
          clickable
          class="home__item"
          @click="open(t.id)"
          @touchstart.passive="longPress.start($event, t.id)"
          @touchmove.passive="longPress.move($event)"
          @touchend="longPress.end()"
          @touchcancel="longPress.end()"
          @contextmenu.prevent
        >
          <span class="home__icon">{{ toolIcon(t.id) }}</span>
          <span class="home__name">{{ t.name }}</span>
        </van-grid-item>
      </van-grid>
    </section>

    <section class="home__block">
      <h2 class="home__label">全部工具</h2>
      <van-grid v-if="filtered.length" class="home__grid" :column-num="GRID_COLUMNS" :border="false">
        <van-grid-item
          v-for="t in filtered"
          :key="t.id"
          clickable
          class="home__item"
          @click="open(t.id)"
          @touchstart.passive="longPress.start($event, t.id)"
          @touchmove.passive="longPress.move($event)"
          @touchend="longPress.end()"
          @touchcancel="longPress.end()"
          @contextmenu.prevent
        >
          <span class="home__icon">{{ toolIcon(t.id) }}</span>
          <span class="home__name">{{ t.name }}</span>
        </van-grid-item>
      </van-grid>
      <van-empty v-else description="没有匹配的工具" />
    </section>
    <van-action-sheet
      v-model:show="sheetShow"
      :actions="sheetActions"
      :description="pressed ? `${toolIcon(pressed.id)} ${pressed.name}` : ''"
      cancel-text="取消"
      close-on-click-action
      @select="onSelect"
    />
  </div>
</template>

<style lang="scss" scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: calc(var(--safe-top) + #{$space-4}) 0 calc(var(--safe-bottom) + #{$space-4});

  &__head {
    padding: $space-2 $space-4 0;
  }

  // 标题与设置入口同一行，入口靠右
  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  // 设置：Vant 齿轮图标按钮，与 logo 同为 $logo-size 的方形触控区
  &__setting.van-button {
    width: $logo-size;
    height: $logo-size;
    padding: 0;
    font-size: 20px;
    color: var(--c-text-muted);
  }

  // 状态栏遮罩：固定在顶部，高度等于顶部安全区，颜色同页面底色
  &__scrim {
    position: fixed;
    top: 0;
    right: 0;
    left: 0;
    z-index: 10;
    height: var(--safe-top);
    background: var(--c-bg);
    pointer-events: none;
  }

  // 标题是应用图标；h1 保留给读屏，图片的 alt 就是名字
  &__title {
    margin: 0;
    line-height: 0;
  }

  &__logo {
    display: block;
    width: $logo-size;
    height: $logo-size;
  }


  &__block {
    padding: 0 $space-4;
    margin-top: $space-2;
  }

  &__label {
    margin: $space-3 0 $space-2 $space-1;
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text-muted);
  }

  // 宫格整体做成一张圆角卡片，格子之间靠留白区分
  &__grid {
    overflow: hidden;
    border-radius: var(--van-radius-lg);
    background: var(--c-surface);
  }

  // 长按不选中文字、不弹系统菜单
  &__item {
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  &__icon {
    font-size: 28px;
    line-height: 1.2;
  }

  &__name {
    margin-top: $space-2;
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
    color: var(--c-text);
    // 名称最多两行，超出省略
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}
</style>
