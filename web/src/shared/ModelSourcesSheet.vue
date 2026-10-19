<script setup lang="ts">
// 模型下载地址面板：列出文件名、大小、sha256、全部镜像地址与 release 页面，可打开可复制，并说明手动放置方式。只在 AI 中心使用。
import { computed, ref, watch } from 'vue'
import { showToast } from 'vant'
import { modelSources, type ModelSources } from '@/native/model'
import { copyText } from './clipboard'
import { formatBytes } from './image-calc'
import { MANUAL_DIR_HINT, MANUAL_STEPS, MANUAL_STEPS_PACKAGE, allFirstUrls, fileCopyText, footerOf, isSinglePackage, manualDirText, openLink } from './modelSources'
import type { ModelStateName } from '@/native/model'

/** 面板是否显示（v-model） */
const show = defineModel<boolean>({ required: true })
/** 要看的模型 id、展示名与当前状态（决定底部按钮） */
const props = defineProps<{ modelId: string; modelName: string; state: ModelStateName }>()
/** 底部按钮事件：下载、删除、校验（由 AI 中心页执行） */
const emit = defineEmits<{ download: []; remove: []; verify: [] }>()

/** 是否“一个包”的新格式 */
const pkg = computed(() => (data.value && isSinglePackage(data.value) ? data.value : null))

/** 当前底部按钮布局 */
const footer = computed(() => footerOf(props.state))

/** 来源数据，未取到为 null */
const data = ref<ModelSources | null>(null)
/** 取不到时的提示 */
const failed = ref('')

/** 没有原生宿主或读取失败的提示 */
const MSG_UNAVAILABLE = '暂时读不到下载地址（需要在 App 内打开）'

/** 打开面板时读一次来源（一次性读取，不轮询） */
watch(show, async (v) => {
  if (!v) return
  data.value = null
  failed.value = ''
  try {
    data.value = await modelSources(props.modelId)
  } catch {
    failed.value = MSG_UNAVAILABLE
  }
})

/** 复制文本并给出结果提示 */
async function copy(text: string, what: string): Promise<void> {
  showToast((await copyText(text)) ? `已复制${what}` : '复制失败，请手动长按选择')
}

/** 打开链接，失败提示 */
async function open(url: string): Promise<void> {
  if (!(await openLink(url))) showToast('打不开，请先复制再到浏览器里粘贴')
}
</script>

<template>
  <van-popup v-model:show="show" position="bottom" round closeable :style="{ maxHeight: '85vh' }">
    <div class="src">
      <h3 class="src__title">{{ modelName }} · 下载地址</h3>
      <p v-if="failed" class="src__tip">{{ failed }}</p>
      <template v-else-if="data">
        <section v-if="pkg" class="src__file">
          <div class="src__name">{{ pkg.files[0].name }}</div>
          <div class="src__kv">包大小：{{ formatBytes(pkg.files[0].bytes) }}　解压后：{{ formatBytes(pkg.unpackedBytes ?? 0) }}<template v-if="pkg.entryCount">　共 {{ pkg.entryCount }} 个文件</template></div>
          <div v-if="pkg.license" class="src__kv">许可证：{{ pkg.license }}</div>
          <div class="src__row">
            <span class="src__mono">sha256 {{ pkg.files[0].sha256 }}</span>
            <van-button size="mini" plain @click="copy(pkg.files[0].sha256, ' sha256')">复制</van-button>
          </div>
          <div v-for="u in pkg.files[0].urls" :key="u" class="src__row">
            <span class="src__mono src__link" @click="open(u)">{{ u }}</span>
            <van-button size="mini" plain @click="copy(u, '地址')">复制</van-button>
          </div>
        </section>
        <template v-else>
          <section v-for="f in data.files" :key="f.name" class="src__file">
            <div class="src__name">{{ f.name }} <span class="src__size">{{ formatBytes(f.bytes) }}</span></div>
            <div class="src__row">
              <span class="src__mono">sha256 {{ f.sha256 }}</span>
              <van-button size="mini" plain @click="copy(f.sha256, ' sha256')">复制</van-button>
            </div>
            <div v-for="u in f.urls" :key="u" class="src__row">
              <span class="src__mono src__link" @click="open(u)">{{ u }}</span>
              <van-button size="mini" plain @click="copy(u, '地址')">复制</van-button>
            </div>
            <van-button size="mini" plain @click="copy(fileCopyText(f), '文件信息')">复制本文件信息</van-button>
          </section>
        </template>
        <van-button block size="small" plain @click="copy(allFirstUrls(data.files), '全部地址')">复制全部地址（每文件首选）</van-button>
        <section v-if="data.releasePages.length" class="src__file">
          <div class="src__name">release 页面</div>
          <div v-for="p in data.releasePages" :key="p" class="src__row">
            <span class="src__mono src__link" @click="open(p)">{{ p }}</span>
            <van-button size="mini" plain @click="copy(p, '页面地址')">复制</van-button>
          </div>
        </section>
        <section class="src__file">
          <div class="src__name">手动放置</div>
          <ol class="src__steps">
            <li v-for="s in pkg ? MANUAL_STEPS_PACKAGE : MANUAL_STEPS" :key="s">{{ s }}</li>
          </ol>
          <div class="src__row">
            <span class="src__mono">{{ manualDirText(data.dir) }}</span>
            <van-button size="mini" plain @click="copy(manualDirText(data.dir), '目录')">复制</van-button>
          </div>
          <p class="src__tip">{{ MANUAL_DIR_HINT }}</p>
        </section>
      </template>
      <van-loading v-else class="src__tip" />
    </div>
    <!-- 底部固定按钮：未下载主题色「下载」，已下载 danger 色「删除」 -->
    <div class="src__footer">
      <van-button v-if="footer.verify" class="src__btn" plain @click="emit('verify')">校验</van-button>
      <van-button v-if="footer.primary === 'download'" class="src__btn" type="primary" @click="emit('download')">下载</van-button>
      <van-button v-else-if="footer.primary === 'remove'" class="src__btn" type="danger" @click="emit('remove')">删除</van-button>
      <van-button v-else class="src__btn" type="primary" disabled>下载中…</van-button>
    </div>
  </van-popup>
</template>

<style lang="scss" scoped>
.src {
  max-height: calc(85vh - 72px);
  padding: $space-4;
  padding-top: $space-5;
  overflow-y: auto;

  &__title {
    padding-right: 32px; // 给右上角关闭按钮留位
    margin: 0 0 $space-3;
    font-size: 16px;
  }

  &__file {
    padding: $space-3 0;
    border-bottom: 1px solid var(--c-border);
  }

  &__name {
    margin-bottom: $space-2;
    font-weight: 500;
  }

  &__kv {
    margin-bottom: $space-2;
    font-size: 13px;
  }

  &__size {
    font-size: 12px;
    color: var(--c-text-muted);
  }

  &__row {
    display: flex;
    gap: $space-2;
    align-items: center;
    margin-bottom: $space-2;
  }

  &__mono {
    flex: 1;
    font-family: monospace;
    font-size: 12px;
    word-break: break-all;
  }

  &__link {
    color: var(--c-primary);
    text-decoration: underline;
  }

  &__steps {
    padding-left: $space-4;
    margin: 0 0 $space-2;
    font-size: 13px;
  }

  &__tip {
    font-size: 12px;
    color: var(--c-text-muted);
  }

  &__footer {
    display: flex;
    gap: $space-2;
    padding: $space-3 $space-4;
    padding-bottom: calc(#{$space-3} + var(--safe-bottom));
    border-top: 1px solid var(--c-border);
  }

  &__btn {
    flex: 1;
  }
}
</style>
