<script setup lang="ts">
// 垃圾分类：默认是本地词典检索（上海四分类）；路由 mode=camera 时切到拍照识别
import { computed, defineAsyncComponent, ref } from "vue";
import { useRoute } from "vue-router";
import BottomActions from "@/shared/BottomActions.vue";
import ModelPicker from "@/shared/ModelPicker.vue";
import { MODE_CAMERA, MODE_QUERY, findTool, hasAiChoices } from "@/tools/registry";
import { CATS, WASTE_ITEMS } from "./data";
import { countByCat, getCat, search } from "./logic";

/** 拍照识别子页，进入识别模式才加载 */
const Classify = defineAsyncComponent(
    () => import("../waste-classify/index.vue"),
);
/** 本工具 id */
const TOOL_ID = "waste-sort";
/** 识别模式下是否有模型可选（由 registry 声明的 tasks 决定） */
const hasPicker = hasAiChoices(findTool(TOOL_ID));
/** 当前路由 */
const route = useRoute();
/** 识别子页实例，底部动作栏用它触发拍照/相册 */
const classify = ref<{
    takePhoto: () => void;
    fromAlbum: () => void;
    ready: boolean;
    busy: boolean;
} | null>(null);
/** 是否处于拍照识别模式 */
const camera = computed(() => route.query[MODE_QUERY] === MODE_CAMERA);
/** 识别不可用（模型未就绪或正在识别）时禁用拍照/相册 */
const blocked = computed(() => !classify.value?.ready || !!classify.value?.busy);
/** 搜索框内容 */
const query = ref("");
/** 免责声明 */
const DISCLAIMER =
    "按上海「可回收物 / 有害垃圾 / 湿垃圾 / 干垃圾」四分类整理，仅供参考，以当地最新规定为准。";

/** 检索结果 */
const hits = computed(() => search(query.value));
/** 是否输入了内容 */
const typed = computed(() => query.value.trim() !== "");
/** 各类条数，用于图例 */
const counts = computed(() => countByCat());
</script>

<template>
    <div class="tool-page">
        <!-- 上半：拍照识别 / 词典查询，随右上角摄像头按钮切换 -->
        <Classify v-if="camera" ref="classify" />
        <template v-else>
            <tool-group>
                <van-field
                    v-model="query"
                    label="物品"
                    placeholder="输入物品名，如 电池、奶茶杯"
                    clearable
                />
            </tool-group>

            <template v-if="typed">
                <tool-group v-if="!hits.length">
                    <p class="tool-hint">
                        词典里没找到「{{
                            query.trim()
                        }}」。换个叫法试试；实在分不清，一般投干垃圾，药品电池之类的先问问物业。
                    </p>
                </tool-group>
                <ul v-else class="ws-list">
                    <li v-for="h in hits" :key="h.item.name" class="ws-item">
                        <span
                            class="ws-badge"
                            :style="{
                                background: getCat(h.item.cat)?.color,
                                color: getCat(h.item.cat)?.textColor,
                            }"
                        >
                            {{ getCat(h.item.cat)?.name }}
                        </span>
                        <div class="ws-body">
                            <strong>{{ h.item.name }}</strong>
                            <span v-if="h.matchedAlias" class="tool-hint"
                                >（也叫 {{ h.matchedAlias }}）</span
                            >
                            <p class="tool-hint ws-tip">
                                {{ h.item.tip || getCat(h.item.cat)?.tip }}
                            </p>
                        </div>
                    </li>
                </ul>
            </template>
        </template>

        <!-- 下半：两种模式共享的说明 -->
        <tool-group :title="`四种垃圾怎么投（共 ${WASTE_ITEMS.length} 条物品）`">
            <ul class="ws-legend">
                <li v-for="c in CATS" :key="c.id">
                    <span
                        class="ws-badge"
                        :style="{ background: c.color, color: c.textColor }"
                        >{{ c.name }}</span
                    >
                    <span class="tool-hint"
                        >{{ counts[c.id] }} 条 · {{ c.tip }}</span
                    >
                </li>
            </ul>
        </tool-group>

        <p class="tool-hint">{{ DISCLAIMER }}</p>

        <!-- 识别模式：底部动作栏，左边模型选择器，右边相册、拍照 -->
        <bottom-actions v-if="camera" :ai="hasPicker" album main main-text="拍照" main-type="danger" :disabled="{ album: blocked, main: blocked }" @album="classify?.fromAlbum()" @main="classify?.takePhoto()">
            <template #ai>
                <model-picker :tool-id="TOOL_ID" />
            </template>
        </bottom-actions>
    </div>
</template>

<style lang="scss" scoped>
/* 结果列表 */
.ws-list {
    display: flex;
    flex-direction: column;
    gap: $space-2;
    margin: 0;
    padding: 0;
    list-style: none;
}

/* 一条结果 */
.ws-item {
    display: flex;
    align-items: flex-start;
    gap: $space-3;
    padding: $space-3;
    background: var(--c-surface);
    border-radius: var(--tool-card-radius);
}

/* 分类色块：固定宽度，保证各行对齐 */
.ws-badge {
    flex: none;
    min-width: 68px;
    padding: 4px 8px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
}

/* 文字区 */
.ws-body {
    min-width: 0;
    color: var(--c-text);
}

/* 投放提示 */
.ws-tip {
    margin-top: 2px;
}

/* 图例 */
.ws-legend {
    display: flex;
    flex-direction: column;
    gap: $space-3;
    margin: 0;
    padding: 0;
    list-style: none;

    li {
        display: flex;
        align-items: flex-start;
        gap: $space-3;
    }
}
</style>
