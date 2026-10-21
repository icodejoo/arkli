<script setup lang="ts">
// 工具容器页：顶部导航栏 + 内容区（安全区内边距），按路由 id 异步加载工具组件
import { computed, defineAsyncComponent, nextTick, ref, watch, watchEffect, type Component } from 'vue'
import { showConfirmDialog } from 'vant'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { findTool } from '@/tools/registry'
import { TOOL_SETTING_ROUTE } from '@/router'
import PinToolSheet from '@/shared/PinToolSheet.vue'
import { copyText } from '@/shared/clipboard'
import {
  MENU_KEY_APK,
  MENU_KEY_COPY_LINK,
  MENU_KEY_FLOAT,
  MENU_KEY_PIN,
  MENU_KEY_REFRESH,
  MENU_KEY_SETTINGS,
  MENU_KEY_STAR,
  TOAST_COPY_FAILED,
  TOAST_FLOAT_BUSY,
  floatReplaceMessage,
  TOAST_LINK_COPIED,
  buildMenuActions,
  buildToolDeepLink,
  refreshApp,
  type MenuActionItem,
} from '@/shared/pinToolSheet'
import { useToolsStore } from '@/stores/tools'
import { useFavoritesStore } from '@/stores/favorites'
import { shareApp, shareAppLink } from '@/shared/appShare'
import { shareIconSrc } from '@/shared/shareSheetIcons'
import { useFloatStore, decideFloat } from '@/stores/float'
import { useLiveTools } from '@/shared/floatLive'
import { ToolStage } from '@/shared/ToolStage'
import BlankSetting from '@/views/ToolSettingView.vue'

/** 工具 id 到异步组件的缓存：重复 defineAsyncComponent 会得到不同的组件对象，keep-alive 就命中不了 */
const asyncTools = new Map<string, Component>()

/**
 * 取某个工具的异步组件（同一 id 始终返回同一个对象）。
 *
 * @param id 工具 id
 * @param load 动态加载函数
 * @returns 异步组件
 */
function asyncToolOf(id: string, load: () => Promise<unknown>): Component {
  let c = asyncTools.get(id)
  if (!c) {
    c = defineAsyncComponent(load as Parameters<typeof defineAsyncComponent>[0])
    asyncTools.set(id, c)
  }
  return c
}

/** 路由参数：工具 id */
const props = defineProps<{ id: string }>()

/** 路由器 */
const router = useRouter()
/** 工具 store */
const store = useToolsStore()
/** 分享面板每行放几个图标 */
const SHARE_PER_ROW = 5
/** 收藏 store */
const favorites = useFavoritesStore()
/** 当前工具是否已收藏 */
const starred = computed(() => favorites.has(props.id))
/** 当前工具元信息 */
const meta = computed(() => findTool(props.id))
/** 当前路由 */
const route = useRoute()
/** 当前是否在工具设置页（此时工具首页只隐藏、不卸载，状态保留） */
const inSetting = computed(() => route.name === TOOL_SETTING_ROUTE)
/** 首页与设置页切换用的转场名：进设置推入，回首页弹出 */
const settingTransition = computed(() => (inSetting.value ? 'page-push' : 'page-pop'))
/** 设置页退场动画是否还没结束：期间设置内容要继续挂着，免得动画中途凭空消失 */
const settingLingering = ref(false)
watch(inSetting, (now) => {
  if (!now) settingLingering.value = true
})
/** 浮窗 store */
const floatStore = useFloatStore()
/** 保活的工具 id 列表：前台工具 + 被浮起的工具（状态机见 shared/floatLive.ts） */
const live = useLiveTools(() => props.id)

/**
 * 按 id 取工具的异步组件；id 不存在时为 null。每个工具只建一次异步包装。
 *
 * @param id 工具 id
 * @returns 异步组件或 null
 */
function resolveTool(id: string): Component | null {
  const m = findTool(id)
  return m ? asyncToolOf(m.id, m.load) : null
}

/**
 * 按 id 取工具的设置页组件；工具没声明 `setting` 时用空白页。
 *
 * @param id 工具 id
 * @returns 设置页组件
 */
function resolveSetting(id: string): Component {
  const m = findTool(id)
  return m?.setting ? asyncToolOf(`setting:${m.id}`, m.setting) : BlankSetting
}

/** 点“浮窗”：忙碌只提示；已有别的浮窗先确认替换；然后浮起并回到上一页 */
async function floatCurrent(): Promise<void> {
  const m = meta.value
  if (!m) return
  const decision = decideFloat(floatStore.isBusy(m.id), floatStore.floating, m.id)
  if (decision === 'busy') {
    showToast(TOAST_FLOAT_BUSY)
    return
  }
  if (decision === 'confirm' && floatStore.floating) {
    try {
      await showConfirmDialog({ title: '替换浮窗', message: floatReplaceMessage(floatStore.floating.name) })
    } catch {
      return
    }
  }
  if (!floatStore.float(m.id)) return
  shareSheet.value = false
  goBack()
}

/** 切换收藏并提示 */
function toggleStar(): void {
  showToast(favorites.toggle(props.id) ? '已收藏' : '已取消收藏')
}

/** 胶囊底部分享面板是否显示 */
const shareSheet = ref(false)
/** “添加到桌面”面板是否显示 */
const pinSheet = ref(false)
/** 分享面板选项：两行（分享/收藏/添加到桌面；刷新/复制链接/设置） */
const shareActions = computed(() => {
  const items = buildMenuActions(isNativeAvailable(), starred.value)
    .flat()
    .map((item) => ({ ...item, icon: shareIconSrc(item.icon) }))
  const rows = []
  for (let i = 0; i < items.length; i += SHARE_PER_ROW) rows.push(items.slice(i, i + SHARE_PER_ROW))
  return rows
})

/** 复制当前工具的深链接并提示 */
async function copyToolLink(): Promise<void> {
  try {
    showToast((await copyText(buildToolDeepLink(props.id))) ? TOAST_LINK_COPIED : TOAST_COPY_FAILED)
  } catch {
    showToast(TOAST_COPY_FAILED)
  }
}

/**
 * 选好分享面板项后执行：刷新、设置、收藏、复制链接、添加到桌面（先关面板再开固定面板），其余为分享。
 *
 * @param option 被选中的面板项（van-share-sheet 的 select 事件第一个参数）
 */
async function onSharePick(option: MenuActionItem): Promise<void> {
  switch (option.key) {
    case MENU_KEY_REFRESH:
      refreshApp()
      return
    case MENU_KEY_SETTINGS:
      shareSheet.value = false
      router.push({ name: TOOL_SETTING_ROUTE, params: { id: props.id } })
      return
    case MENU_KEY_STAR:
      toggleStar()
      return
    case MENU_KEY_COPY_LINK:
      await copyToolLink()
      return
    case MENU_KEY_FLOAT:
      await floatCurrent()
      return
    case MENU_KEY_PIN:
      shareSheet.value = false
      await nextTick()
      pinSheet.value = true
      return
  }
  try {
    const ok = option.key === MENU_KEY_APK ? await shareApp() : await shareAppLink()
    if (!ok) showToast('没能拉起分享')
  } catch {
    showToast('分享失败')
  }
}

/** 返回上一页；没有历史（如直接打开深链）时回首页 */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}

// 打开有效工具时记入最近使用
watchEffect(() => {
  if (meta.value) store.markUsed(meta.value.id)
})
</script>

<template>
  <div class="shell">
    <van-nav-bar
      class="shell__nav"
      :title="meta?.name ?? '未找到工具'"
      left-arrow
      fixed
      placeholder
      safe-area-inset-top
      @click-left="goBack"
    >
      <template v-if="meta" #right>
        <!-- 工具页可用 teleport 往这里放自己的标题栏按钮（如筛选） -->
        <span id="shell-nav-actions" class="shell__slot" />
        <!-- 小程序风格胶囊：左「…」唤起底部分享面板，右收藏 -->
        <div class="shell__capsule">
          <button type="button" class="shell__capsule-btn" aria-label="分享" @click.stop="shareSheet = true">
            <van-icon name="ellipsis" />
          </button>
          <i class="shell__capsule-divider" />
          <button
            type="button"
            :class="['shell__capsule-btn', { 'shell__star--on': starred }]"
            :aria-label="starred ? '取消收藏' : '收藏'"
            @click.stop="toggleStar"
          >
            <van-icon :name="starred ? 'star' : 'star-o'" />
          </button>
        </div>
      </template>
    </van-nav-bar>
    <van-share-sheet v-model:show="shareSheet" class="shell__share" :options="shareActions" cancel-text="取消" @select="onSharePick" />
    <pin-tool-sheet v-if="meta" v-model:show="pinSheet" :tool="meta" />
    <main class="shell__body">
      <!-- 工具舞台：前台工具 + 被浮起的工具各自保活，其余离开即卸载；工具之间互跳（取色器 → 颜色助手）再返回仍保留状态 -->
      <!-- 首页与设置页互相进退：复用全局页面转场（进设置推入、回首页弹出），样式见 styles/index.scss 的“页面转场” -->
      <transition :name="settingTransition">
        <div v-show="!inSetting" class="shell__page">
          <tool-stage v-if="meta" :ids="live" :active-id="props.id" :resolve="resolveTool" />
        </div>
      </transition>
      <!-- 设置舞台：只保活当前工具的设置页，切到别的工具就卸载（首页舞台里被浮起的工具另当别论）；退场动画结束后才卸载内容 -->
      <transition :name="settingTransition" @after-leave="settingLingering = false">
        <div v-if="meta" v-show="inSetting" class="shell__page">
          <tool-stage :ids="[props.id]" :active-id="inSetting || settingLingering ? props.id : ''" :resolve="resolveSetting" />
        </div>
      </transition>
      <van-empty v-if="!meta" description="没有找到这个工具" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.shell {
  min-height: 100vh;

  // 导航栏右侧的收藏星标；已收藏用主色
  &__star {
    font-size: 22px;
    color: var(--c-text-muted);

    &--on {
      color: var(--c-primary);
    }
  }

  // 工具页挂进来的标题栏按钮容器
  &__slot {
    display: inline-flex;
    align-items: center;
  }


  // 摄像头按钮与胶囊之间留空
  &__cam {
    margin-right: $space-3;
  }

  // vant 给整个右侧区域加了按下变淡，去掉，改由胶囊内各按钮自己反馈
  &__nav :deep(.van-nav-bar__right:active) {
    opacity: 1;
  }

  // 右侧胶囊按钮组
  &__capsule {
    display: inline-flex;
    align-items: center;
    height: 30px;
    margin-left: $space-2;
    border: 1px solid var(--c-border, rgba(127, 127, 127, 0.35));
    border-radius: 15px;
  }

  // 胶囊内单个按钮
  &__capsule-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 100%;
    padding: 0;
    font-size: 20px;
    color: var(--c-text);
    background: none;
    border: 0;

    &:active {
      opacity: 0.5;
    }

    &.shell__star--on {
      color: var(--c-primary);
    }
  }

  // 胶囊中间分隔线
  &__capsule-divider {
    width: 1px;
    height: 16px;
    background: var(--c-border, rgba(127, 127, 127, 0.35));
  }

  // 首页 / 设置页各占一页；转场时它会变成 fixed 叠在导航栏下方（见下面 :deep 规则）
  &__page {
    box-sizing: border-box;
    max-width: 720px;
    margin: 0 auto;
    padding: var(--page-pad);
    padding-bottom: calc(var(--page-pad) + var(--safe-bottom));
  }

  // 转场中：全局样式让页面铺满屏幕，这里把顶部让给导航栏，内容超出时在页内裁掉
  &__page[class*='page-'][class*='-active'] {
    top: calc(var(--van-nav-bar-height, 46px) + var(--safe-top));
    max-width: none;
    margin: 0;
  }
}
</style>

<!-- 底部分享面板被 teleport 到 body，根元素拿不到 scoped 的 data-v 属性，所以这块样式不能带 scoped -->
<style lang="scss">
.shell__share {
  // 一行 5 个：每项占 1/5 宽，图标在项内居中，文案允许换行
  .van-share-sheet__options {
    padding-left: 0;
  }

  .van-share-sheet__option {
    flex: 0 0 20%;
    min-width: 0;
  }

  .van-share-sheet__image-icon {
    margin: 0 auto;
  }

  .van-share-sheet__name {
    text-align: center;
    line-height: 1.3;
  }

  // 图标是彩色 svg（img）：做成圆角方块，底色跟随主题，内边距 20% 让图标占方块的 6 成
  .van-share-sheet__image-icon {
    box-sizing: border-box;
    padding: calc(var(--van-share-sheet-icon-size) * 0.2);
    background: var(--c-surface-active);
    border-radius: 12px;
  }

  .van-share-sheet__name {
    color: var(--c-text-muted);
  }
}
</style>
