// MNN 本地文本模型的 JNI 封装：只暴露「建会话 / 生成 / 释放」三件事，供 Kotlin 的 MnnNative 调用。
// 分词、聊天模板、采样都由 MNN 自带，这里不重复实现。

#include <jni.h>

#include <atomic>
#include <cstdio>
#include <exception>
#include <memory>
#include <ostream>
#include <streambuf>
#include <string>

#include <llm/llm.hpp>

#include "arkli_mnn_capi.h"

namespace {

using MNN::Transformer::Llm;

/** 贪心解码配置：输出稳定可复现（翻译、校对、摘要用） */
const char* const kGreedyConfig = "{\"sampler_type\":\"greedy\"}";

/** 温度采样配置模板：%.3f 为温度，%d 为 topK；管线固定为 topK -> topP -> temperature（topP、惩罚沿用模型 config.json） */
const char* const kSampleConfigFmt =
    "{\"sampler_type\":\"mixed\",\"mixed_samplers\":[\"topK\",\"topP\",\"temperature\"],\"temperature\":%.3f,\"topK\":%d}";

/** 小于它的温度按贪心处理（模板只保留 3 位小数，更小的值会被格式化成 0） */
const float kMinTemperature = 0.001f;

/** 采样配置 JSON 的缓冲长度，模板展开后远小于它 */
const size_t kConfigBuf = 192;

/**
 * 一次会话：MNN 的采样器只在 load() 里按配置建一次，load() 之后 set_config 不会重建它（读码结论，见 docs/design/ai-protocol.md），
 * 所以采样变化时要整个会话重建。句柄就是它的指针，重建对 Kotlin 透明。
 */
struct Session {
    /** 引擎 */
    MNN::Transformer::Llm* llm = nullptr;
    /** 模型 config.json 路径，重建时用 */
    std::string configPath;
    /** 当前采样配置的 JSON，用来判断是否要重建 */
    std::string samplerJson;
};

/**
 * 按采样参数生成配置 JSON。温度小于 kMinTemperature 为贪心，否则为带温度与 topK 的混合采样。
 *
 * @param temperature 温度
 * @param topK 候选数，温度大于 0 时才用
 * @return 配置 JSON
 */
std::string samplerConfig(float temperature, int topK) {
    if (temperature < kMinTemperature) return kGreedyConfig;
    char buf[kConfigBuf];
    std::snprintf(buf, sizeof(buf), kSampleConfigFmt, static_cast<double>(temperature), topK > 0 ? topK : 1);
    return buf;
}

/**
 * 创建并加载引擎，采样配置要在 load() 之前设好才会生效。
 *
 * @param configPath 模型 config.json 路径
 * @param samplerJson 采样配置 JSON
 * @param err 失败时写入原因
 * @return 引擎，失败返回 nullptr
 */
Llm* buildLlm(const std::string& configPath, const std::string& samplerJson, std::string* err) {
    Llm* llm = Llm::createLLM(configPath);
    if (llm == nullptr) {
        *err = "MNN 创建会话失败：配置无法解析";
        return nullptr;
    }
    llm->set_config(samplerJson);
    if (!llm->load()) {
        Llm::destroy(llm);
        *err = "MNN 加载模型失败：权重或配置不完整";
        return nullptr;
    }
    return llm;
}

/** 取消标志：每次 nativeGenerate 开始时复位，nativeCancel 置位；同一时刻只有一个生成在跑（Kotlin 侧串行），所以全局一个就够 */
std::atomic<bool> g_cancel{false};

/** 把引擎状态从 USER_CANCEL 复位成 RUNNING：取消后 response() 开头会直接拒绝，不复位就没法再用 */
void clearCancelState(Llm* llm) {
    auto* ctx = const_cast<MNN::Transformer::LlmContext*>(llm->getContext());
    if (ctx->status == MNN::Transformer::LlmStatus::USER_CANCEL) ctx->status = MNN::Transformer::LlmStatus::RUNNING;
}

/**
 * 收集生成文本的输出流缓冲。MNN 每解出一个 token 就写一次并 flush，这里借写入这个时机检查取消标志：
 * 命中就把引擎状态置为 USER_CANCEL，解码循环下一圈开头看到该状态便退出（见 MNN 的 ArGeneration::generate）。
 * 状态是在解码线程自己的回调里改的，没有跨线程写。
 */
class CancelAwareBuf : public std::streambuf {
public:
    /** @param llm 正在生成的引擎 */
    explicit CancelAwareBuf(Llm* llm) : llm_(llm) {}

    /** 已收集的文本 */
    const std::string& text() const { return buf_; }

protected:
    /** 批量写入：收下文本后检查取消 */
    std::streamsize xsputn(const char* s, std::streamsize n) override {
        buf_.append(s, static_cast<size_t>(n));
        stopIfCancelled();
        return n;
    }

    /** 单字符写入：收下后检查取消 */
    int_type overflow(int_type ch) override {
        if (!traits_type::eq_int_type(ch, traits_type::eof())) {
            buf_.push_back(traits_type::to_char_type(ch));
            stopIfCancelled();
        }
        return traits_type::not_eof(ch);
    }

    /** flush：没有可刷的缓冲，只借机检查取消（空输出的 token 也会走到这里） */
    int sync() override {
        stopIfCancelled();
        return 0;
    }

private:
    /** 标志已置位则把引擎状态改为 USER_CANCEL */
    void stopIfCancelled() {
        if (g_cancel.load(std::memory_order_relaxed)) {
            const_cast<MNN::Transformer::LlmContext*>(llm_->getContext())->status = MNN::Transformer::LlmStatus::USER_CANCEL;
        }
    }

    /** 正在生成的引擎 */
    Llm* llm_;
    /** 已收集的文本 */
    std::string buf_;
};

/** 抛出 Java 的 CancellationException（Kotlin 的 CancellationException 即它），调用方随后应立刻返回 */
void throwCancelled(JNIEnv* env) {
    jclass cls = env->FindClass("java/util/concurrent/CancellationException");
    if (cls != nullptr) env->ThrowNew(cls, "文本生成已取消");
}

/** 抛出 Java 的 IllegalStateException，调用方随后应立刻返回 */
void throwState(JNIEnv* env, const std::string& msg) {
    jclass cls = env->FindClass("java/lang/IllegalStateException");
    if (cls != nullptr) env->ThrowNew(cls, msg.c_str());
}

/** 把 Java 字节数组原样拷成 std::string（调用方传 UTF-8 字节，避开 JNI 的改良 UTF-8 对 emoji 的拆分） */
std::string toBytes(JNIEnv* env, jbyteArray arr) {
    if (arr == nullptr) return {};
    const jsize n = env->GetArrayLength(arr);
    std::string out(static_cast<size_t>(n), '\0');
    if (n > 0) env->GetByteArrayRegion(arr, 0, n, reinterpret_cast<jbyte*>(&out[0]));
    return out;
}

}  // namespace

extern "C" {

/**
 * 创建并加载模型会话。
 *
 * @param configPath 模型目录里 config.json 绝对路径的 UTF-8 字节
 * @return 会话句柄（指针），失败时抛 IllegalStateException 并返回 0
 */
JNIEXPORT jlong JNICALL Java_com_let188_arkli_ai_MnnNative_nativeCreate(JNIEnv* env, jclass, jbyteArray configPath) {
    try {
        std::unique_ptr<Session> s(new Session());
        s->configPath = toBytes(env, configPath);
        s->samplerJson = kGreedyConfig;  // 不带采样参数的路径默认贪心
        std::string err;
        s->llm = buildLlm(s->configPath, s->samplerJson, &err);
        if (s->llm == nullptr) {
            throwState(env, err);
            return 0;
        }
        return reinterpret_cast<jlong>(s.release());
    } catch (const std::exception& e) {
        throwState(env, std::string("MNN 创建会话异常：") + e.what());
        return 0;
    }
}

/**
 * 单轮生成。每次调用前先清掉上一轮的历史与 KV 缓存，所以调用之间互不影响。
 *
 * @param handle 由 nativeCreate 返回的句柄
 * @param system system 角色提示词的 UTF-8 字节，空则不带 system 消息
 * @param prompt 用户内容的 UTF-8 字节（聊天模板由 MNN 套用）
 * @param maxNewTokens 最多生成的 token 数，小于等于 0 表示用模型缺省
 * @param temperature 采样温度，小于等于 0 表示贪心（此时 topK 无意义）
 * @param topK 温度采样的候选数
 * @return 生成文本的 UTF-8 字节（可能在末尾截断半个字，由 Kotlin 侧宽松解码）；失败时抛 IllegalStateException 并返回 null；
 *         被 nativeCancel 打断时抛 CancellationException 并返回 null（预填充阶段不可打断，最多等它跑完再取消）
 */
JNIEXPORT jbyteArray JNICALL Java_com_let188_arkli_ai_MnnNative_nativeGenerate(
    JNIEnv* env, jclass, jlong handle, jbyteArray system, jbyteArray prompt, jint maxNewTokens,
    jfloat temperature, jint topK) {
    if (handle == 0) {
        throwState(env, "MNN 会话未创建");
        return nullptr;
    }
    g_cancel.store(false);  // 每次调用开始先复位，上一次的取消不能带到这一次
    try {
        auto* s = reinterpret_cast<Session*>(handle);
        const std::string want = samplerConfig(temperature, topK);
        if (s->llm == nullptr || want != s->samplerJson) {
            // 采样配置变了（或上次重建失败后 llm 为空）：重建会话。先释放旧的再建新的，避免两份模型同时占内存；
            // 失败时句柄保持可销毁（llm 置空），并清掉 samplerJson，否则下次拿旧参数调用会误判“配置没变”而跳过重建，
            // 一直抛“会话已失效”直到会话被回收。无自动化测试条件：验证办法是真机上先用一组采样、再让重建失败（如临时挪走
            // 模型文件）后恢复，确认下一次生成会重建成功；Kotlin 侧的兜底见 QwenService 的 INTERNAL 重载测试。
            Llm::destroy(s->llm);
            s->llm = nullptr;
            s->samplerJson.clear();
            std::string err;
            s->llm = buildLlm(s->configPath, want, &err);
            if (s->llm == nullptr) {
                throwState(env, err);
                return nullptr;
            }
            s->samplerJson = want;
        }
        if (s->llm == nullptr) {
            throwState(env, "MNN 会话已失效，请重新加载");
            return nullptr;
        }
        Llm* llm = s->llm;
        llm->reset();
        clearCancelState(llm);  // 上一次若被取消，状态还停在 USER_CANCEL
        CancelAwareBuf buf(llm);
        std::ostream out(&buf);
        MNN::Transformer::ChatMessages messages;
        const std::string sys = toBytes(env, system);
        if (!sys.empty()) messages.emplace_back("system", sys);
        messages.emplace_back("user", toBytes(env, prompt));
        llm->response(messages, &out, nullptr, maxNewTokens > 0 ? maxNewTokens : -1);
        if (g_cancel.load()) {
            clearCancelState(llm);  // 别把“已取消”留给下一次调用
            throwCancelled(env);
            return nullptr;
        }
        const std::string& text = buf.text();
        jbyteArray bytes = env->NewByteArray(static_cast<jsize>(text.size()));
        if (bytes == nullptr) return nullptr;
        env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()), reinterpret_cast<const jbyte*>(text.data()));
        return bytes;
    } catch (const std::exception& e) {
        throwState(env, std::string("MNN 生成异常：") + e.what());
        return nullptr;
    }
}

/**
 * 打断正在进行的 nativeGenerate：在下一个 token 写出时生效，已生成的部分丢弃。
 * 可在任意线程调用；没有生成在跑时只是置位标志，下一次 nativeGenerate 开头会复位它，所以无副作用。
 */
JNIEXPORT void JNICALL Java_com_let188_arkli_ai_MnnNative_nativeCancel(JNIEnv*, jclass) {
    g_cancel.store(true);
}

/**
 * 释放会话并归还内存。句柄为 0 时什么也不做，所以可以重复调用。
 *
 * @param handle 由 nativeCreate 返回的句柄
 */
JNIEXPORT void JNICALL Java_com_let188_arkli_ai_MnnNative_nativeDestroy(JNIEnv*, jclass, jlong handle) {
    if (handle == 0) return;
    std::unique_ptr<Session> s(reinterpret_cast<Session*>(handle));
    if (s->llm != nullptr) Llm::destroy(s->llm);
    arkli_mnn_release_memory();  // 释放后归还内存，进程 RSS 才会真正回落
}

}  // extern "C"
