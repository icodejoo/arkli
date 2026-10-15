// MNN 本地文本模型的 JNI 封装：只暴露「建会话 / 生成 / 释放」三件事，供 Kotlin 的 MnnNative 调用。
// 分词、聊天模板、采样都由 MNN 自带，这里不重复实现。

#include <jni.h>
#include <malloc.h>

#include <exception>
#include <sstream>
#include <string>

#include <llm/llm.hpp>

namespace {

using MNN::Transformer::Llm;

/** bionic `malloc.h` 的 M_PURGE（API 28+）：让分配器把空闲页还给系统；低版本调用返回 0，无副作用 */
constexpr int kMallocPurge = -101;

/** 释放会话后归还内存：先让 MNN 全局执行器丢掉缓存的缓冲，再让分配器退还空闲页，进程 RSS 才会真正回落 */
void giveBackMemory() {
    auto executor = MNN::Express::Executor::getGlobalExecutor();
    if (executor) executor->gc(MNN::Express::Executor::FULL);
    mallopt(kMallocPurge, 0);
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
        Llm* llm = Llm::createLLM(toBytes(env, configPath));
        if (llm == nullptr) {
            throwState(env, "MNN 创建会话失败：配置无法解析");
            return 0;
        }
        if (!llm->load()) {
            Llm::destroy(llm);
            throwState(env, "MNN 加载模型失败：权重或配置不完整");
            return 0;
        }
        return reinterpret_cast<jlong>(llm);
    } catch (const std::exception& e) {
        throwState(env, std::string("MNN 创建会话异常：") + e.what());
        return 0;
    }
}

/**
 * 单轮生成。每次调用前先清掉上一轮的历史与 KV 缓存，所以调用之间互不影响。
 *
 * @param handle 由 nativeCreate 返回的句柄
 * @param prompt 用户内容的 UTF-8 字节（聊天模板由 MNN 套用）
 * @param maxNewTokens 最多生成的 token 数，小于等于 0 表示用模型缺省
 * @return 生成文本的 UTF-8 字节（可能在末尾截断半个字，由 Kotlin 侧宽松解码）；失败时抛 IllegalStateException 并返回 null
 */
JNIEXPORT jbyteArray JNICALL Java_com_let188_arkli_ai_MnnNative_nativeGenerate(
    JNIEnv* env, jclass, jlong handle, jbyteArray prompt, jint maxNewTokens) {
    if (handle == 0) {
        throwState(env, "MNN 会话未创建");
        return nullptr;
    }
    try {
        auto* llm = reinterpret_cast<Llm*>(handle);
        llm->reset();
        std::ostringstream out;
        llm->response(toBytes(env, prompt), &out, nullptr, maxNewTokens > 0 ? maxNewTokens : -1);
        const std::string text = out.str();
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
 * 释放会话并归还内存。句柄为 0 时什么也不做，所以可以重复调用。
 *
 * @param handle 由 nativeCreate 返回的句柄
 */
JNIEXPORT void JNICALL Java_com_let188_arkli_ai_MnnNative_nativeDestroy(JNIEnv*, jclass, jlong handle) {
    if (handle == 0) return;
    Llm::destroy(reinterpret_cast<Llm*>(handle));
    giveBackMemory();
}

}  // extern "C"
