// 图推理会话 C ABI 的实现，接口契约见 arkli_mnn_capi.h。
// 要点：异常不出边界；输入一律拷贝进自己持有的 VARP；外置权重按“设路径 -> 加载 -> 清空”；默认只允许 memory=low。

#include "arkli_mnn_capi.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#include <MNN/expr/Executor.hpp>
#include <MNN/expr/ExprCreator.hpp>
#include <MNN/expr/Module.hpp>

#if defined(__ANDROID__)
#include <malloc.h>
#endif

using namespace MNN::Express;

/** 张量句柄：持有 VARP，并缓存类型与形状 */
struct arkli_mnn_val {
    /** 底层变量（输入时自己申请内存，输出时来自 forward） */
    VARP var;
    /** ARKLI_F32 / ARKLI_I32 */
    int dtype = ARKLI_F32;
    /** 各维大小 */
    std::vector<int32_t> shape;
    /** 元素总数 */
    size_t count = 0;
};

/** 会话句柄：模型加自己的 RuntimeManager（Module 内部也持有它，这里留一份保证析构顺序明确） */
struct arkli_mnn_net {
    /** 独占的运行时管理器 */
    std::shared_ptr<Executor::RuntimeManager> rt;
    /** 已加载的模块 */
    std::unique_ptr<Module> module;
    /** 模型声明的输入信息（类型、维度、布局） */
    std::vector<Variable::Info> inInfo;
    /** 输入个数 */
    int nIn = 0;
    /** 输出个数 */
    int nOut = 0;
};

namespace {

/** 默认线程数 */
constexpr int kDefaultThreads = 4;
/** 内存模式取值：normal / low（与 MNN 的 BackendConfig::MemoryMode 对应） */
constexpr int kMemNormal = 0;
constexpr int kMemLow = 2;
/** 精度模式的合法范围上限（Precision_Low_BF16） */
constexpr int kPrecisionMax = 3;
/** 性能模式的最大合法值（0 normal / 1 high / 2 low） */
constexpr int kPowerMax = 2;
/** 张量维数上限 */
constexpr int kMaxNdim = 8;
/** bionic `malloc.h` 的 M_PURGE（API 28+）：让分配器把空闲页还给系统；低版本调用返回 0，无副作用 */
constexpr int kMallocPurge = -101;

/** 当前线程最近一次错误的文本 */
thread_local std::string g_lastError;
/** 当前线程最近一次错误的错误码 */
thread_local int g_lastCode = ARKLI_MNN_OK;
/** 测试开关：允许 memory=normal */
std::atomic<int> g_allowNormal{0};

/** 记录错误到线程本地，并按需拷进调用方缓冲（截断、带结尾 0）；返回错误码方便直接 return */
int fail(int code, const std::string& msg, char* err = nullptr, int errLen = 0) {
    g_lastError = msg;
    g_lastCode = code;
    if (err != nullptr && errLen > 0) {
        const size_t n = std::min(msg.size(), static_cast<size_t>(errLen - 1));
        std::memcpy(err, msg.data(), n);
        err[n] = '\0';
    }
    return code;
}

/** 把 MNN 数据类型映射成 ABI 的 dtype；不支持返回 -1 */
int dtypeOf(const halide_type_t& t) {
    if (t.code == halide_type_float && t.bits == 32) return ARKLI_F32;
    if (t.code == halide_type_int && t.bits == 32) return ARKLI_I32;
    return -1;
}

/** 元素总数；任一维为 0 则为 0 */
size_t countOf(const std::vector<int32_t>& shape) {
    size_t n = 1;
    for (int32_t d : shape) n *= static_cast<size_t>(d);
    return n;
}

/** 方便报错的形状文本，如 [1,3,224,224] */
std::string shapeText(const std::vector<int>& shape) {
    std::string s = "[";
    for (size_t i = 0; i < shape.size(); ++i) s += (i ? "," : "") + std::to_string(shape[i]);
    return s + "]";
}

/** 退出作用域时把 RuntimeManager 的外置权重路径清空，异常路径也不会漏 */
struct ExternalFileGuard {
    /** 被管理的运行时 */
    Executor::RuntimeManager* rt;
    ~ExternalFileGuard() {
        try {
            rt->setExternalFile("");
        } catch (...) {
        }
    }
};

/** 校验名字数组：非空指针、个数大于 0 */
bool namesOk(const char* const* names, int n) {
    if (names == nullptr || n <= 0) return false;
    for (int i = 0; i < n; ++i)
        if (names[i] == nullptr || names[i][0] == '\0') return false;
    return true;
}

/** 校验配置并转成 MNN 的取值；非法时返回错误文本 */
std::string checkConfig(const arkli_mnn_config& c) {
    if (c.memory == kMemNormal) {
        if (!g_allowNormal.load()) return "memory=normal 已被禁用（权重会还原成 float，内存暴涨），请用 low(2)";
    } else if (c.memory != kMemLow) {
        return "memory 只能是 2(low)";
    }
    if (c.precision < 0 || c.precision > kPrecisionMax) return "precision 超出范围 0..3";
    if (c.power < 0 || c.power > kPowerMax) return "power 超出范围 0..2";
    return "";
}

}  // namespace

extern "C" {

int arkli_mnn_abi_version(void) { return ARKLI_MNN_ABI; }

void arkli_mnn_config_default(arkli_mnn_config* cfg) {
    if (cfg == nullptr) return;
    cfg->threads = kDefaultThreads;
    cfg->memory = kMemLow;
    cfg->precision = 0;
    cfg->power = 0;
    cfg->rearrange = 1;
}

arkli_mnn_net* arkli_mnn_net_load(const char* model, const char* weight, const char* const* in_names, int n_in,
                                  const char* const* out_names, int n_out, const arkli_mnn_config* cfg, char* err,
                                  int err_len) {
    try {
        if (model == nullptr || model[0] == '\0') {
            fail(ARKLI_MNN_ERR_ARG, "model 路径为空", err, err_len);
            return nullptr;
        }
        if (!namesOk(in_names, n_in) || !namesOk(out_names, n_out)) {
            fail(ARKLI_MNN_ERR_ARG, "输入/输出名为空或个数不合法", err, err_len);
            return nullptr;
        }
        arkli_mnn_config c;
        arkli_mnn_config_default(&c);
        if (cfg != nullptr) c = *cfg;
        const std::string bad = checkConfig(c);
        if (!bad.empty()) {
            fail(ARKLI_MNN_ERR_ARG, bad, err, err_len);
            return nullptr;
        }
        // 先确认文件存在：MNN 对缺失文件只打日志，错误信息不友好
        for (const char* path : {model, weight}) {
            if (path == nullptr || path[0] == '\0') continue;
            FILE* f = std::fopen(path, "rb");
            if (f == nullptr) {
                fail(ARKLI_MNN_ERR_LOAD, std::string("文件打不开：") + path, err, err_len);
                return nullptr;
            }
            std::fclose(f);
        }

        const int threads = c.threads > 0 ? c.threads : kDefaultThreads;
        MNN::BackendConfig backend;
        backend.memory = c.memory == kMemLow ? MNN::BackendConfig::Memory_Low : MNN::BackendConfig::Memory_Normal;
        backend.precision = static_cast<MNN::BackendConfig::PrecisionMode>(c.precision);
        backend.power = static_cast<MNN::BackendConfig::PowerMode>(c.power);
        MNN::ScheduleConfig sched;
        sched.type = MNN_FORWARD_CPU;
        sched.numThread = threads;
        sched.backendConfig = &backend;

        auto net = std::make_unique<arkli_mnn_net>();
        net->rt.reset(Executor::RuntimeManager::createRuntimeManager(sched));
        if (!net->rt) {
            fail(ARKLI_MNN_ERR_LOAD, "创建 RuntimeManager 失败", err, err_len);
            return nullptr;
        }
        net->rt->setHint(MNN::Interpreter::INIT_THREAD_NUMBER, threads);

        const std::vector<std::string> ins(in_names, in_names + n_in);
        const std::vector<std::string> outs(out_names, out_names + n_out);
        Module::Config mc;
        mc.rearrange = c.rearrange != 0;
        {
            // 设路径 -> 加载 -> 清空：守卫保证任何退出路径都会清空
            ExternalFileGuard guard{net->rt.get()};
            if (weight != nullptr && weight[0] != '\0') net->rt->setExternalFile(weight);
            net->module.reset(Module::load(ins, outs, model, net->rt, &mc));
        }
        if (!net->module) {
            fail(ARKLI_MNN_ERR_LOAD, std::string("MNN 加载模型失败（文件损坏或输入/输出名不在图里）：") + model, err,
                 err_len);
            return nullptr;
        }
        const Module::Info* info = net->module->getInfo();
        if (info == nullptr || info->inputs.size() != static_cast<size_t>(n_in) ||
            info->outputNames.size() != static_cast<size_t>(n_out)) {
            fail(ARKLI_MNN_ERR_LOAD, "模型的输入/输出个数与传入的名字个数不符", err, err_len);
            return nullptr;
        }
        net->inInfo = info->inputs;
        net->nIn = n_in;
        net->nOut = n_out;
        return net.release();
    } catch (const std::exception& e) {
        fail(ARKLI_MNN_ERR_INTERNAL, std::string("加载异常：") + e.what(), err, err_len);
    } catch (...) {
        fail(ARKLI_MNN_ERR_INTERNAL, "加载发生未知异常", err, err_len);
    }
    return nullptr;
}

arkli_mnn_val* arkli_mnn_val_new(int dtype, const int32_t* shape, int ndim, const void* data) {
    try {
        if (dtype != ARKLI_F32 && dtype != ARKLI_I32) {
            fail(ARKLI_MNN_ERR_ARG, "dtype 只能是 F32 或 I32");
            return nullptr;
        }
        if (ndim < 0 || ndim > kMaxNdim || (ndim > 0 && shape == nullptr)) {
            fail(ARKLI_MNN_ERR_ARG, "ndim/shape 不合法");
            return nullptr;
        }
        auto v = std::make_unique<arkli_mnn_val>();
        v->dtype = dtype;
        v->shape.assign(shape, shape + ndim);
        for (int32_t d : v->shape) {
            if (d < 0) {
                fail(ARKLI_MNN_ERR_ARG, "shape 里有负数");
                return nullptr;
            }
        }
        v->count = countOf(v->shape);
        if (v->count > 0 && data == nullptr) {
            fail(ARKLI_MNN_ERR_ARG, "data 为空但元素数大于 0");
            return nullptr;
        }
        const halide_type_t type = dtype == ARKLI_F32 ? halide_type_of<float>() : halide_type_of<int32_t>();
        v->var = _Input(std::vector<int>(v->shape.begin(), v->shape.end()), NCHW, type);
        if (v->count > 0) {
            void* dst = v->var->writeMap<uint8_t>();
            if (dst == nullptr) {
                fail(ARKLI_MNN_ERR_INTERNAL, "申请张量内存失败");
                return nullptr;
            }
            std::memcpy(dst, data, v->count * 4);  // float 与 int32 都是 4 字节
            v->var->unMap();
        }
        return v.release();
    } catch (const std::exception& e) {
        fail(ARKLI_MNN_ERR_INTERNAL, std::string("创建张量异常：") + e.what());
    } catch (...) {
        fail(ARKLI_MNN_ERR_INTERNAL, "创建张量发生未知异常");
    }
    return nullptr;
}

int arkli_mnn_val_shape(const arkli_mnn_val* v, int32_t* shape, int cap) {
    if (v == nullptr) return ARKLI_MNN_ERR_ARG;
    const int nd = static_cast<int>(v->shape.size());
    for (int i = 0; shape != nullptr && i < nd && i < cap; ++i) shape[i] = v->shape[i];
    return nd;
}

int arkli_mnn_val_dtype(const arkli_mnn_val* v) { return v == nullptr ? ARKLI_MNN_ERR_ARG : v->dtype; }

const void* arkli_mnn_val_read(arkli_mnn_val* v) {
    if (v == nullptr || v->count == 0) return nullptr;
    try {
        return v->dtype == ARKLI_F32 ? static_cast<const void*>(v->var->readMap<float>())
                                     : static_cast<const void*>(v->var->readMap<int32_t>());
    } catch (...) {
        return nullptr;
    }
}

int arkli_mnn_net_forward(arkli_mnn_net* n, arkli_mnn_val* const* in, int n_in, arkli_mnn_val** out, int n_out,
                          char* err, int err_len) {
    if (out != nullptr)
        for (int i = 0; i < n_out; ++i) out[i] = nullptr;
    try {
        if (n == nullptr || in == nullptr || out == nullptr) return fail(ARKLI_MNN_ERR_ARG, "net/in/out 为空", err, err_len);
        if (n_in != n->nIn || n_out != n->nOut)
            return fail(ARKLI_MNN_ERR_ARG,
                        "输入/输出个数不符：需要 " + std::to_string(n->nIn) + "/" + std::to_string(n->nOut) +
                            "，给了 " + std::to_string(n_in) + "/" + std::to_string(n_out),
                        err, err_len);

        std::vector<VARP> ins(static_cast<size_t>(n_in));
        for (int i = 0; i < n_in; ++i) {
            const arkli_mnn_val* v = in[i];
            if (v == nullptr) return fail(ARKLI_MNN_ERR_ARG, "第 " + std::to_string(i) + " 个输入为空", err, err_len);
            const Variable::Info& want = n->inInfo[static_cast<size_t>(i)];
            const std::string tag = "第 " + std::to_string(i) + " 个输入";
            const int wantDt = dtypeOf(want.type);
            if (wantDt < 0)
                return fail(ARKLI_MNN_ERR_UNSUPPORTED, tag + "的模型类型既不是 float32 也不是 int32，本库不支持", err, err_len);
            if (wantDt != v->dtype)
                return fail(ARKLI_MNN_ERR_INPUT, tag + "类型不符（模型要 " + (wantDt == ARKLI_I32 ? "int32" : "float32") +
                                                     "；int64 输入也要传 int32）", err, err_len);
            // 维数要一致；模型里为负的维是动态维，不比较
            if (!want.dim.empty()) {
                bool ok = want.dim.size() == v->shape.size();
                for (size_t k = 0; ok && k < want.dim.size(); ++k)
                    if (want.dim[k] > 0 && want.dim[k] != v->shape[k]) ok = false;
                if (!ok)
                    return fail(ARKLI_MNN_ERR_INPUT,
                                tag + "形状不符：模型要 " + shapeText(want.dim) + "，给了 " +
                                    shapeText(std::vector<int>(v->shape.begin(), v->shape.end())),
                                err, err_len);
            }
            ins[static_cast<size_t>(i)] = want.order == NC4HW4 ? _Convert(v->var, NC4HW4) : v->var;
        }

        std::vector<VARP> res = n->module->onForward(ins);
        if (res.size() != static_cast<size_t>(n_out))
            return fail(ARKLI_MNN_ERR_RUN, "推理失败：输出个数为 " + std::to_string(res.size()), err, err_len);

        std::vector<std::unique_ptr<arkli_mnn_val>> got;
        for (int i = 0; i < n_out; ++i) {
            VARP o = res[static_cast<size_t>(i)];
            if (o.get() == nullptr) return fail(ARKLI_MNN_ERR_RUN, "第 " + std::to_string(i) + " 个输出为空", err, err_len);
            auto oi = o->getInfo();
            if (oi == nullptr) return fail(ARKLI_MNN_ERR_RUN, "第 " + std::to_string(i) + " 个输出没有形状信息", err, err_len);
            if (oi->order == NC4HW4) {
                o = _Convert(o, NCHW);
                oi = o->getInfo();
                if (oi == nullptr) return fail(ARKLI_MNN_ERR_RUN, "输出布局转换失败", err, err_len);
            }
            const int dt = dtypeOf(oi->type);
            if (dt < 0) return fail(ARKLI_MNN_ERR_UNSUPPORTED, "第 " + std::to_string(i) + " 个输出类型不是 float32/int32", err, err_len);
            auto v = std::make_unique<arkli_mnn_val>();
            v->var = o;
            v->dtype = dt;
            v->shape.assign(oi->dim.begin(), oi->dim.end());
            v->count = countOf(v->shape);
            // 现在就取一次数据：确保计算已完成，之后读取不依赖会话状态
            if (v->count > 0 && v->var->readMap<uint8_t>() == nullptr)
                return fail(ARKLI_MNN_ERR_RUN, "第 " + std::to_string(i) + " 个输出读取失败", err, err_len);
            got.push_back(std::move(v));
        }
        for (int i = 0; i < n_out; ++i) out[i] = got[static_cast<size_t>(i)].release();
        return ARKLI_MNN_OK;
    } catch (const std::exception& e) {
        return fail(ARKLI_MNN_ERR_INTERNAL, std::string("推理异常：") + e.what(), err, err_len);
    } catch (...) {
        return fail(ARKLI_MNN_ERR_INTERNAL, "推理发生未知异常", err, err_len);
    }
}

void arkli_mnn_val_free(arkli_mnn_val* v) {
    try {
        delete v;
    } catch (...) {
    }
}

void arkli_mnn_net_free(arkli_mnn_net* n) {
    try {
        delete n;
    } catch (...) {
    }
}

void arkli_mnn_release_memory(void) {
    try {
        auto executor = Executor::getGlobalExecutor();
        if (executor) executor->gc(Executor::FULL);
    } catch (...) {
    }
#if defined(__ANDROID__)
    mallopt(kMallocPurge, 0);
#endif
}

int arkli_mnn_last_error(char* buf, int buf_len) {
    if (buf != nullptr && buf_len > 0) {
        const size_t n = std::min(g_lastError.size(), static_cast<size_t>(buf_len - 1));
        std::memcpy(buf, g_lastError.data(), n);
        buf[n] = '\0';
    }
    return static_cast<int>(g_lastError.size());
}

int arkli_mnn_last_error_code(void) { return g_lastCode; }

void arkli_mnn_test_allow_normal(int allow) { g_allowNormal.store(allow != 0 ? 1 : 0); }

}  // extern "C"
