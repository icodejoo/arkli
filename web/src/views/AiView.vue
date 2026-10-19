<script setup lang="ts">
// AI 中心页：在线大模型配置入口（占位）、本地模型（下载 / 校验 / 查看下载地址）；右上角菜单图标进入二级页「AI 应用」（带 ai 标签的工具宫格）
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { useModelsStore } from '@/stores/models'
import { formatBytes } from '@/shared/image-calc'
import ModelSourcesSheet from '@/shared/ModelSourcesSheet.vue'
import MnnParamsSheet from '@/shared/MnnParamsSheet.vue'

/** 模型配置占位卡片的文案 */
const MODEL_ENTRY_TEXT = '在线大模型配置（即将支持）'

/** 在线大模型配置卡片图标 */
const MODEL_ENTRY_ICON = 'bulb-o'

/** MNN 基础参数入口标题 */
const MNN_ENTRY_TITLE = 'MNN 基础参数'

/** MNN 基础参数入口副文案 */
const MNN_ENTRY_SUB = '所有本地模型共用'

/** MNN 基础参数入口图标 */
const MNN_ENTRY_ICON = 'setting-o'

/** 箭头图标名称 */
const ARROW_ICON = 'arrow'

/** AI 应用二级页的路径 */
const AI_APPS_PATH = '/ai/apps'

/** 路由器 */
const router = useRouter()

/** 模型 store（状态由原生推送，这里只读 + 触发动作） */
const models = useModelsStore()
/** 下载地址面板是否显示 */
const sourcesShow = ref(false)
/** 面板当前查看的模型 */
const sourcesTarget = ref({ id: '', name: '' })

/** MNN 基础参数面板是否显示 */
const mnnSheetShow = ref(false)

/** 面板当前模型的状态（读 store，下载进度、删除后会实时变化） */
const sourcesState = computed(() => models.get(sourcesTarget.value.id)?.state ?? 'absent')

/** 打开某模型的下载页面弹窗（下载地址、下载/删除按钮） */
function showSources(id: string, name: string): void {
  sourcesTarget.value = { id, name }
  sourcesShow.value = true
}

/** 打开 MNN 基础参数面板 */
function showMnnSheet(): void {
  mnnSheetShow.value = true
}

/** 点击下载，失败只提示 */
async function onDownload(id: string): Promise<void> {
  try {
    await models.download(id)
  } catch {
    showToast('当前无法下载，可以点「下载地址」手动下载')
  }
}

/** 重新校验（手动放入文件后用），失败只提示 */
async function onVerify(id: string): Promise<void> {
  try {
    await models.verify(id)
  } catch {
    showToast('校验失败')
  }
}

/** 删除模型：先二次确认，取消不报错，失败只提示 */
async function onRemove(id: string, name: string): Promise<void> {
  try {
    await showConfirmDialog({ title: '删除模型', message: `删除「${name}」后需要重新下载才能使用。` })
  } catch {
    return
  }
  try {
    await models.remove(id)
  } catch {
    showToast('删除失败')
  }
}

/** 进入二级页「AI 应用」 */
function openApps(): void {
  void router.push(AI_APPS_PATH)
}

/** 点击模型配置：暂未实现，只提示 */
function onModelEntry(): void {
  showToast('敬请期待')
}
</script>

<template>
  <div class="ai">
    <van-nav-bar title="AI 中心" fixed placeholder safe-area-inset-top>
      <template #right>
        <van-icon name="apps-o" size="22" role="button" aria-label="AI 应用" @click="openApps" />
      </template>
    </van-nav-bar>
    <main class="ai__body">
      <div class="ai__entries">
        <button type="button" class="ai__model" @click="onModelEntry">
          <van-icon :name="MODEL_ENTRY_ICON" class="ai__model-icon" />
          <span class="ai__model-text">{{ MODEL_ENTRY_TEXT }}</span>
          <van-icon :name="ARROW_ICON" class="ai__model-arrow" />
        </button>
        <button type="button" class="ai__model" @click="showMnnSheet">
          <van-icon :name="MNN_ENTRY_ICON" class="ai__model-icon" />
          <span class="ai__model-text">
            <span>{{ MNN_ENTRY_TITLE }}</span>
            <span class="ai__model-sub">{{ MNN_ENTRY_SUB }}</span>
          </span>
          <van-icon :name="ARROW_ICON" class="ai__model-arrow" />
        </button>
      </div>
      <template v-if="models.list.length">
        <h2 class="ai__label">本地模型</h2>
        <!-- 整行可点：打开下载页面弹窗；右侧只放箭头 -->
        <button v-for="m in models.list" :key="m.id" type="button" class="ai__item" @click="showSources(m.id, m.displayName)">
          <span class="ai__item-main">
            <span>{{ m.displayName }}</span>
            <span class="ai__item-sub">{{ m.purpose }} · {{ formatBytes(m.totalBytes) }} · {{ m.state }}</span>
          </span>
          <van-icon :name="ARROW_ICON" class="ai__item-arrow" />
        </button>
        <model-sources-sheet
          v-model="sourcesShow"
          :model-id="sourcesTarget.id"
          :model-name="sourcesTarget.name"
          :state="sourcesState"
          @download="onDownload(sourcesTarget.id)"
          @verify="onVerify(sourcesTarget.id)"
          @remove="onRemove(sourcesTarget.id, sourcesTarget.name)"
        />
      </template>
      <mnn-params-sheet v-model="mnnSheetShow" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.ai {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
    padding-bottom: calc(#{$space-4} + var(--tabbar-total));
  }

  // 顶部入口并排容器
  &__entries {
    display: flex;
    flex-wrap: wrap;
    gap: $space-3;
  }

  // 模型配置与基础参数入口卡片
  &__model {
    display: flex;
    flex: 1 1 140px;
    align-items: center;
    min-width: 0;
    padding: $space-3 $space-4;
    font: inherit;
    color: var(--c-text);
    text-align: left;
    background: var(--c-surface);
    border: 0;
    border-radius: var(--tool-card-radius);

    &:active {
      background: var(--c-surface-active);
    }
  }

  &__model-icon {
    flex-shrink: 0;
    margin-right: $space-3;
    font-size: 20px;
    color: var(--c-primary);
  }

  &__model-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
  }

  &__model-sub {
    font-size: 12px;
    color: var(--c-text-muted);
  }

  &__model-arrow {
    flex-shrink: 0;
    color: var(--c-text-muted);
  }

  // 本地模型行
  &__item {
    display: flex;
    gap: $space-2;
    align-items: center;
    width: 100%;
    padding: $space-3 $space-4;
    margin-bottom: $space-2;
    font: inherit;
    color: var(--c-text);
    text-align: left;
    background: var(--c-surface);
    border: 0;
    border-radius: var(--tool-card-radius);

    &:active {
      background: var(--c-surface-active);
    }
  }

  &__item-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  &__item-sub {
    font-size: 12px;
    color: var(--c-text-muted);
  }

  &__item-arrow {
    color: var(--c-text-muted);
  }

  &__label {
    margin: $space-4 0 $space-2 $space-1;
    font-size: 13px;
    font-weight: 500;
    color: var(--c-text-muted);
  }
}
</style>
