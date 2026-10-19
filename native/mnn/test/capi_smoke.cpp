// arkli_mnn C ABI 的宿主冒烟测试（Windows/桌面，经 build-tools.ps1 -HostDll 编出）。
//
// 用法：capi_smoke <model.mnn> <case_dir> [ext.mnn] [tmp_dir]
//   model.mnn  SigLIP2 fp32 的 .mnn（内含权重）
//   case_dir   scripts/mnn/make_case.py 生成的用例目录（input.json + <名>.txt）
//   ext.mnn    可选：同一个模型用 --saveExternalData 转出的版本，旁边有 ext.mnn.weight；给了才跑外置权重用例
//   tmp_dir    可选：合成小模型的落盘目录，默认当前目录
// 退出码：0 全部通过，1 有失败。所有断言失败都会打印原因后继续，最后汇总。

#include "arkli_mnn_capi.h"

#include <MNN/expr/Expr.hpp>
#include <MNN/expr/ExprCreator.hpp>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

using namespace MNN::Express;

namespace {

/** 允许的最大相对误差（相对输出最大绝对值），与 ModuleBasic 的 1% 门槛一致 */
constexpr double kMaxRelErr = 0.01;
/** 错误信息缓冲大小 */
constexpr int kErrLen = 512;
/** fp32 用例里各输入输出名的上限，防止解析失控 */
constexpr size_t kMaxNames = 16;

/** 失败计数与总数 */
int g_fail = 0, g_total = 0;

/** 断言：失败时打印位置与说明 */
#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        ++g_total;                                                             \
        if (!(cond)) {                                                         \
            ++g_fail;                                                          \
            std::printf("  [失败] %s:%d %s  (%s)\n", __FILE__, __LINE__, #cond, std::string(msg).c_str()); \
        }                                                                      \
    } while (0)

/** 一个用例张量：名字、形状、数据 */
struct Tensor {
    std::string name;
    std::vector<int32_t> shape;
    std::vector<float> data;
};

/** 一个用例：输入、期望输出 */
struct Case {
    std::vector<Tensor> inputs, outputs;
};

/** 读整个文本文件 */
std::string slurp(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

/** 读一维文本浮点文件（np.savetxt 格式，每行一个数） */
std::vector<float> loadFloats(const std::string& path) {
    std::vector<float> v;
    const std::string s = slurp(path);
    const char* p = s.c_str();
    char* end = nullptr;
    for (;;) {
        const float x = std::strtof(p, &end);
        if (end == p) break;
        v.push_back(x);
        p = end;
    }
    return v;
}

/** 从 input.json 取出所有 "key": 后面第 idx 个引号字符串之后的位置（极简解析，只服务 make_case.py 的输出） */
std::vector<std::string> quoted(const std::string& s, size_t from, size_t to) {
    std::vector<std::string> r;
    for (size_t i = from; i < to; ++i) {
        if (s[i] != '"') continue;
        const size_t j = s.find('"', i + 1);
        if (j == std::string::npos || j > to) break;
        r.push_back(s.substr(i + 1, j - i - 1));
        i = j;
    }
    return r;
}

/** 解析用例目录：input.json 给出输入名/形状与输出名，各自的 .txt 给出数据 */
bool loadCase(const std::string& dir, Case& c) {
    const std::string js = slurp(dir + "/input.json");
    if (js.empty()) return false;
    const size_t inPos = js.find("\"inputs\""), outPos = js.find("\"outputs\"");
    if (inPos == std::string::npos || outPos == std::string::npos) return false;
    // inputs：逐个 {"name": "...", "shape": [...]}
    size_t pos = inPos;
    while (c.inputs.size() < kMaxNames) {
        const size_t n = js.find("\"name\"", pos);
        if (n == std::string::npos || n > outPos) break;
        const size_t q1 = js.find('"', js.find(':', n) + 1), q2 = js.find('"', q1 + 1);
        Tensor t;
        t.name = js.substr(q1 + 1, q2 - q1 - 1);
        const size_t lb = js.find('[', q2), rb = js.find(']', lb);
        std::stringstream ss(js.substr(lb + 1, rb - lb - 1));
        std::string tok;
        while (std::getline(ss, tok, ',')) t.shape.push_back(std::atoi(tok.c_str()));
        c.inputs.push_back(t);
        pos = rb;
    }
    const size_t lb = js.find('[', outPos), rb = js.find(']', lb);
    for (const auto& name : quoted(js, lb, rb)) {
        Tensor t;
        t.name = name;
        c.outputs.push_back(t);
    }
    for (auto& t : c.inputs) t.data = loadFloats(dir + "/" + t.name + ".txt");
    for (auto& t : c.outputs) t.data = loadFloats(dir + "/" + t.name + ".txt");
    return !c.inputs.empty() && !c.outputs.empty();
}

/** 一组 C 字符串指针，方便传给 net_load */
struct Names {
    std::vector<std::string> store;
    std::vector<const char*> ptrs;
    explicit Names(const std::vector<Tensor>& ts) {
        for (auto& t : ts) store.push_back(t.name);
        for (auto& s : store) ptrs.push_back(s.c_str());
    }
    explicit Names(const std::vector<std::string>& ss) : store(ss) {
        for (auto& s : store) ptrs.push_back(s.c_str());
    }
};

/** 相对误差：max|a-b| / max(max|b|, 1e-6) */
double relErr(const float* a, const std::vector<float>& ref) {
    double mx = 0, md = 0;
    for (size_t i = 0; i < ref.size(); ++i) {
        mx = std::max(mx, std::fabs((double)ref[i]));
        md = std::max(md, std::fabs((double)a[i] - ref[i]));
    }
    return md / std::max(mx, 1e-6);
}

/** 造输入句柄；失败返回 NULL */
arkli_mnn_val* makeVal(const Tensor& t) {
    return arkli_mnn_val_new(ARKLI_F32, t.shape.data(), (int)t.shape.size(), t.data.data());
}

/** 用用例跑一遍并比对输出，返回最大相对误差；失败返回 -1 */
double runCase(arkli_mnn_net* net, const Case& c, const char* tag) {
    std::vector<arkli_mnn_val*> in;
    for (auto& t : c.inputs) in.push_back(makeVal(t));
    std::vector<arkli_mnn_val*> out(c.outputs.size(), nullptr);
    char err[kErrLen] = {0};
    const int rc = arkli_mnn_net_forward(net, in.data(), (int)in.size(), out.data(), (int)out.size(), err, kErrLen);
    CHECK(rc == 0, std::string(tag) + " forward: " + err);
    double worst = -1;
    if (rc == 0) {
        worst = 0;
        for (size_t i = 0; i < out.size(); ++i) {
            int32_t shape[8];
            const int nd = arkli_mnn_val_shape(out[i], shape, 8);
            size_t cnt = 1;
            for (int k = 0; k < nd; ++k) cnt *= shape[k];
            CHECK(cnt == c.outputs[i].data.size(), std::string(tag) + " 输出元素数不符 " + c.outputs[i].name);
            if (cnt != c.outputs[i].data.size()) continue;
            const float* p = (const float*)arkli_mnn_val_read(out[i]);
            CHECK(p != nullptr, "val_read 为空");
            if (!p) continue;
            const double e = relErr(p, c.outputs[i].data);
            std::printf("  %s 输出 %s 相对误差 %.3e\n", tag, c.outputs[i].name.c_str(), e);
            CHECK(e <= kMaxRelErr, std::string(tag) + " 误差超过 1%");
            worst = std::max(worst, e);
        }
    }
    for (auto* v : out) arkli_mnn_val_free(v);
    for (auto* v : in) arkli_mnn_val_free(v);
    return worst;
}

/** 取当前线程最近的错误文本 */
std::string lastErr() {
    char b[kErrLen] = {0};
    arkli_mnn_last_error(b, kErrLen);
    return b;
}

/** 用例 1：SigLIP2 fp32 在 low 与 normal 下的数值比对，并检查 normal 默认被拒 */
void testNumeric(const std::string& model, const Case& c) {
    std::printf("[数值] SigLIP2 fp32 对照 ORT 期望\n");
    Names in(c.inputs), out(c.outputs);
    char err[kErrLen] = {0};
    arkli_mnn_config cfg;
    arkli_mnn_config_default(&cfg);
    arkli_mnn_net* net = arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                                            (int)out.ptrs.size(), &cfg, err, kErrLen);
    CHECK(net != nullptr, std::string("load low: ") + err);
    if (net) {
        runCase(net, c, "low(默认)");
        runCase(net, c, "low 第二次");  // 同一会话重复推理
        arkli_mnn_net_free(net);
    }

    cfg.memory = 0;
    CHECK(arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                             (int)out.ptrs.size(), &cfg, err, kErrLen) == nullptr,
          "normal 默认应被拒绝");
    CHECK(arkli_mnn_last_error_code() == ARKLI_MNN_ERR_ARG, "normal 被拒的错误码");
    arkli_mnn_test_allow_normal(1);
    net = arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                             (int)out.ptrs.size(), &cfg, err, kErrLen);
    CHECK(net != nullptr, std::string("测试开关打开后 normal 应可加载: ") + err);
    if (net) {
        runCase(net, c, "normal(测试开关)");
        arkli_mnn_net_free(net);
    }
    arkli_mnn_test_allow_normal(0);
}

/** 用例 2：错误路径，都应返回错误码/NULL 且不崩溃 */
void testErrors(const std::string& model, const Case& c) {
    std::printf("[错误路径]\n");
    Names in(c.inputs), out(c.outputs);
    char err[kErrLen] = {0};
    arkli_mnn_config cfg;
    arkli_mnn_config_default(&cfg);

    CHECK(arkli_mnn_net_load("Z:/不存在/x.mnn", nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                             (int)out.ptrs.size(), &cfg, err, kErrLen) == nullptr,
          "文件不存在应返回 NULL");
    CHECK(std::strlen(err) > 0 && arkli_mnn_last_error_code() == ARKLI_MNN_ERR_LOAD, std::string("文件不存在的错误信息 ") + err);

    Names badIn(std::vector<std::string>{"no_such_input"});
    arkli_mnn_net* n = arkli_mnn_net_load(model.c_str(), nullptr, badIn.ptrs.data(), 1, out.ptrs.data(),
                                          (int)out.ptrs.size(), &cfg, err, kErrLen);
    CHECK(n == nullptr, "输入名不存在应失败");
    std::printf("  输入名不存在 -> %s\n", n ? "(竟然成功了)" : err);
    arkli_mnn_net_free(n);

    Names badOut(std::vector<std::string>{"no_such_output"});
    n = arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), badOut.ptrs.data(), 1, &cfg, err, kErrLen);
    CHECK(n == nullptr, "输出名不存在应失败");
    std::printf("  输出名不存在 -> %s\n", n ? "(竟然成功了)" : err);
    arkli_mnn_net_free(n);

    CHECK(arkli_mnn_net_load(nullptr, nullptr, in.ptrs.data(), 1, out.ptrs.data(), 1, &cfg, err, kErrLen) == nullptr, "model 为空");
    CHECK(arkli_mnn_net_load(model.c_str(), nullptr, nullptr, 0, out.ptrs.data(), 1, &cfg, err, kErrLen) == nullptr, "无输入名");
    arkli_mnn_config bad = cfg;
    bad.memory = 1;
    CHECK(arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                             (int)out.ptrs.size(), &bad, err, kErrLen) == nullptr, "memory=1 非法");
    // power / precision：合法取值能加载，越界被拒
    for (int pw = 0; pw <= 2; ++pw) {
        arkli_mnn_config ok = cfg;
        ok.power = pw;
        ok.precision = pw == 1 ? 1 : 0;
        arkli_mnn_net* n2 = arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(),
                                               out.ptrs.data(), (int)out.ptrs.size(), &ok, err, kErrLen);
        CHECK(n2 != nullptr, std::string("power 合法值应能加载: ") + err);
        if (n2) arkli_mnn_net_free(n2);
    }
    for (int badPower : {-1, 3}) {
        arkli_mnn_config bp = cfg;
        bp.power = badPower;
        CHECK(arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                                 (int)out.ptrs.size(), &bp, err, kErrLen) == nullptr, "power 越界应被拒");
    }
    arkli_mnn_config badPrec = cfg;
    badPrec.precision = 4;
    CHECK(arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                             (int)out.ptrs.size(), &badPrec, err, kErrLen) == nullptr, "precision=4 非法");
    // 不给 err 缓冲也不能崩
    CHECK(arkli_mnn_net_load("Z:/不存在/x.mnn", nullptr, in.ptrs.data(), 1, out.ptrs.data(), 1, &cfg, nullptr, 0) == nullptr, "err 为 NULL");

    arkli_mnn_net* net = arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                                            (int)out.ptrs.size(), &cfg, err, kErrLen);
    CHECK(net != nullptr, "错误路径用的会话加载");
    if (!net) return;
    std::vector<arkli_mnn_val*> o(c.outputs.size(), nullptr);

    // 形状不匹配
    const int32_t wrongShape[] = {1, 3, 100, 100};
    std::vector<float> junk(1 * 3 * 100 * 100, 0.f);
    arkli_mnn_val* bv = arkli_mnn_val_new(ARKLI_F32, wrongShape, 4, junk.data());
    CHECK(bv != nullptr, "造错形状的 val");
    int rc = arkli_mnn_net_forward(net, &bv, 1, o.data(), (int)o.size(), err, kErrLen);
    // 模型声明了固定维时由 C ABI 拦成 INPUT；声明为动态维的模型则由 MNN 在推理时报 RUN，两者都不得崩溃
    CHECK(rc == ARKLI_MNN_ERR_INPUT || rc == ARKLI_MNN_ERR_RUN, std::string("形状不符应返回错误码，实际 ") + std::to_string(rc));
    std::printf("  形状不符 -> %s\n", err);
    CHECK(o[0] == nullptr, "失败时输出应置 NULL");
    arkli_mnn_val_free(bv);

    // 维数不匹配
    const int32_t flat[] = {4};
    float four[4] = {0, 0, 0, 0};
    bv = arkli_mnn_val_new(ARKLI_F32, flat, 1, four);
    rc = arkli_mnn_net_forward(net, &bv, 1, o.data(), (int)o.size(), err, kErrLen);
    CHECK(rc == ARKLI_MNN_ERR_INPUT, "维数不符应返回 INPUT");
    arkli_mnn_val_free(bv);

    // 类型不匹配（int32 喂给 float 输入）
    const int32_t full[] = {1, 3, 224, 224};
    std::vector<int32_t> ints(1 * 3 * 224 * 224, 0);
    bv = arkli_mnn_val_new(ARKLI_I32, full, 4, ints.data());
    rc = arkli_mnn_net_forward(net, &bv, 1, o.data(), (int)o.size(), err, kErrLen);
    CHECK(rc == ARKLI_MNN_ERR_INPUT, "类型不符应返回 INPUT");
    std::printf("  类型不符 -> %s\n", err);
    arkli_mnn_val_free(bv);

    // 个数不符、空指针
    rc = arkli_mnn_net_forward(net, nullptr, 0, o.data(), (int)o.size(), err, kErrLen);
    CHECK(rc == ARKLI_MNN_ERR_ARG, "in 为空应返回 ARG");
    arkli_mnn_val* two[2] = {nullptr, nullptr};
    rc = arkli_mnn_net_forward(net, two, 2, o.data(), (int)o.size(), err, kErrLen);
    CHECK(rc == ARKLI_MNN_ERR_ARG, "输入个数不符应返回 ARG");
    rc = arkli_mnn_net_forward(nullptr, two, 1, o.data(), (int)o.size(), err, kErrLen);
    CHECK(rc == ARKLI_MNN_ERR_ARG, "net 为空应返回 ARG");

    // val_new 的非法参数
    CHECK(arkli_mnn_val_new(7, full, 4, ints.data()) == nullptr, "dtype 非法");
    const int32_t neg[] = {-1};
    CHECK(arkli_mnn_val_new(ARKLI_F32, neg, 1, four) == nullptr, "负维度");
    CHECK(arkli_mnn_val_new(ARKLI_F32, full, 4, nullptr) == nullptr, "data 为空");
    CHECK(arkli_mnn_val_shape(nullptr, nullptr, 0) < 0 && arkli_mnn_val_read(nullptr) == nullptr, "val 为空的读取");

    // NULL 释放安全；错误后会话仍能正常推理
    arkli_mnn_val_free(nullptr);
    arkli_mnn_net_free(nullptr);
    const double e = runCase(net, c, "出错后恢复");
    CHECK(e >= 0, "出错后的会话仍应可用");
    arkli_mnn_net_free(net);
}

/** 用例 3：重复创建/释放，并确认输出 val 比会话活得久 */
void testLifecycle(const std::string& model, const Case& c) {
    std::printf("[生命周期] 重复创建/释放\n");
    Names in(c.inputs), out(c.outputs);
    char err[kErrLen] = {0};
    arkli_mnn_config cfg;
    arkli_mnn_config_default(&cfg);
    arkli_mnn_val* survivor = nullptr;
    for (int i = 0; i < 3; ++i) {
        arkli_mnn_net* net = arkli_mnn_net_load(model.c_str(), nullptr, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(),
                                                (int)out.ptrs.size(), &cfg, err, kErrLen);
        CHECK(net != nullptr, std::string("第 ") + std::to_string(i) + " 次加载: " + err);
        if (!net) return;
        if (i == 0) {
            arkli_mnn_val* iv = makeVal(c.inputs[0]);
            std::vector<arkli_mnn_val*> o(c.outputs.size(), nullptr);
            CHECK(arkli_mnn_net_forward(net, &iv, 1, o.data(), (int)o.size(), err, kErrLen) == 0, err);
            arkli_mnn_val_free(iv);  // 输入先于输出释放，输出不应受影响
            survivor = o[0];
            for (size_t k = 1; k < o.size(); ++k) arkli_mnn_val_free(o[k]);
        } else {
            runCase(net, c, "重复创建");
        }
        arkli_mnn_net_free(net);
        arkli_mnn_release_memory();
    }
    // 会话已全部释放，幸存的输出仍可读且与期望一致
    const float* p = (const float*)arkli_mnn_val_read(survivor);
    CHECK(p != nullptr, "会话释放后输出仍可读");
    if (p) {
        const double e = relErr(p, c.outputs[0].data);
        std::printf("  会话释放后读输出 %s 相对误差 %.3e\n", c.outputs[0].name.c_str(), e);
        CHECK(e <= kMaxRelErr, "幸存输出的数值");
    }
    arkli_mnn_val_free(survivor);
    arkli_mnn_release_memory();
    arkli_mnn_release_memory();  // 重复调用无副作用
}

/**
 * 用例 4：外置权重“设路径 -> 加载 -> 清空”。
 * A 带外置权重加载后，再加载 B（内置权重的同一模型）；再用没有同名 .weight 的孤儿 .mnn 不带路径加载，应失败而不是读到 A 的权重。
 */
void testExternalWeight(const std::string& model, const std::string& ext, const std::string& tmp, const Case& c) {
    std::printf("[外置权重顺序]\n");
    Names in(c.inputs), out(c.outputs);
    char err[kErrLen] = {0};
    arkli_mnn_config cfg;
    arkli_mnn_config_default(&cfg);
    const std::string weight = ext + ".weight";
    auto load = [&](const std::string& m, const char* w) {
        return arkli_mnn_net_load(m.c_str(), w, in.ptrs.data(), (int)in.ptrs.size(), out.ptrs.data(), (int)out.ptrs.size(), &cfg, err, kErrLen);
    };
    arkli_mnn_net* a = load(ext, weight.c_str());
    CHECK(a != nullptr, std::string("A 带外置权重加载: ") + err);
    arkli_mnn_net* b = load(model, nullptr);
    CHECK(b != nullptr, std::string("B 内置权重加载（A 之后）: ") + err);
    if (a) runCase(a, c, "A(外置)");
    if (b) runCase(b, c, "B(内置)");
    // MNN 默认会去找 <模型>.weight 同名文件，所以真正的“泄漏”要用没有同名权重的孤儿 .mnn 来测
    const std::string orphan = tmp + "/orphan.mnn";
    {
        std::ifstream src(ext, std::ios::binary);
        std::ofstream dst(orphan, std::ios::binary);
        dst << src.rdbuf();
    }
    arkli_mnn_net* o1 = load(orphan, weight.c_str());
    CHECK(o1 != nullptr, std::string("孤儿模型显式给权重路径应成功: ") + err);
    if (o1) runCase(o1, c, "孤儿+显式权重");
    // 注意：MNN 找不到权重文件只打日志，Module::load 仍返回成功（C ABI 无法察觉），所以调用方必须在
    // 模型是外置权重转换时总是传 weight。这里只验证“不会读到上一个会话设过的路径”：
    // 如果读到了 A 的权重，推理结果会是正确的；没读到就不可能正确。
    arkli_mnn_net* o2 = load(orphan, nullptr);
    std::printf("  孤儿模型不给权重路径 -> %s\n", o2 ? "MNN 仍返回成功（已知行为）" : err);
    if (o2) {
        std::vector<arkli_mnn_val*> in2;
        for (auto& t : c.inputs) in2.push_back(makeVal(t));
        std::vector<arkli_mnn_val*> out2(c.outputs.size(), nullptr);
        const int rc2 = arkli_mnn_net_forward(o2, in2.data(), (int)in2.size(), out2.data(), (int)out2.size(), err, kErrLen);
        bool correct = rc2 == 0;
        for (size_t i = 0; correct && i < out2.size(); ++i) {
            const float* p = (const float*)arkli_mnn_val_read(out2[i]);
            correct = p != nullptr && relErr(p, c.outputs[i].data) <= kMaxRelErr;
        }
        std::printf("  该会话推理 rc=%d，结果%s\n", rc2, correct ? "正确(说明读到了别人的权重!)" : "不正确(符合预期)");
        CHECK(!correct, "上一次设置的外置路径不得残留给后一个模型");
        for (auto* v : out2) arkli_mnn_val_free(v);
        for (auto* v : in2) arkli_mnn_val_free(v);
    }
    arkli_mnn_net_free(o2);
    arkli_mnn_net_free(o1);
    // 权重文件不存在
    arkli_mnn_net* miss = load(ext, "Z:/不存在/x.weight");
    CHECK(miss == nullptr, "权重文件不存在应失败");
    arkli_mnn_net_free(miss);
    // 失败之后再正常加载一次，确认路径没有残留
    arkli_mnn_net* a2 = load(ext, weight.c_str());
    CHECK(a2 != nullptr, std::string("失败后再次带权重加载: ") + err);
    if (a2) runCase(a2, c, "A2(外置)");
    arkli_mnn_net_free(a2);
    arkli_mnn_net_free(b);
    arkli_mnn_net_free(a);
}

/** 保存合成模型：命名并存到文件 */
void saveModel(const std::vector<VARP>& outs, const std::string& path) {
    Variable::save(outs, path.c_str());
}

/** 用例 5：合成小模型，覆盖 int32 输入与长度为 0 的输入（KV 首步） */
void testSynthetic(const std::string& dir) {
    std::printf("[合成模型] int32 输入 / 长度为 0 输入\n");
    arkli_mnn_config cfg;
    arkli_mnn_config_default(&cfg);
    char err[kErrLen] = {0};

    // 模型 A：y = x + float(n)
    {
        VARP x = _Input({1, 3}, NCHW, halide_type_of<float>());
        VARP n = _Input({1}, NCHW, halide_type_of<int32_t>());
        x->setName("x");
        n->setName("n");
        VARP y = x + _Cast<float>(n);
        y->setName("y");
        saveModel({y}, dir + "/synth_int.mnn");
        Names in(std::vector<std::string>{"x", "n"}), out(std::vector<std::string>{"y"});
        arkli_mnn_net* net = arkli_mnn_net_load((dir + "/synth_int.mnn").c_str(), nullptr, in.ptrs.data(), 2, out.ptrs.data(), 1, &cfg, err, kErrLen);
        CHECK(net != nullptr, std::string("加载合成 int 模型: ") + err);
        if (net) {
            const int32_t s13[] = {1, 3}, s1[] = {1};
            const float xs[3] = {1.f, 2.f, 3.f};
            const int32_t ns[1] = {10};
            arkli_mnn_val* iv[2] = {arkli_mnn_val_new(ARKLI_F32, s13, 2, xs), arkli_mnn_val_new(ARKLI_I32, s1, 1, ns)};
            arkli_mnn_val* ov[1] = {nullptr};
            int rc = arkli_mnn_net_forward(net, iv, 2, ov, 1, err, kErrLen);
            CHECK(rc == 0, std::string("forward: ") + err);
            if (rc == 0) {
                const float* p = (const float*)arkli_mnn_val_read(ov[0]);
                std::printf("  int32 输入：x+n = %g %g %g\n", p ? p[0] : -1.f, p ? p[1] : -1.f, p ? p[2] : -1.f);
                CHECK(p && p[0] == 11.f && p[1] == 12.f && p[2] == 13.f, "int32 输入参与计算的结果应为 11,12,13");
                CHECK(arkli_mnn_val_dtype(ov[0]) == ARKLI_F32, "输出 dtype");
            }
            // 把 float 当 int32 位置传，应被类型校验拦下
            arkli_mnn_val* swapped[2] = {iv[1], iv[0]};
            rc = arkli_mnn_net_forward(net, swapped, 2, ov, 1, err, kErrLen);
            CHECK(rc == ARKLI_MNN_ERR_INPUT, "输入顺序错应被类型/形状校验拦下");
            arkli_mnn_val_free(iv[0]);
            arkli_mnn_val_free(iv[1]);
            arkli_mnn_val_free(ov[0]);
            arkli_mnn_net_free(net);
        }
    }
    // 模型 B：y = concat(past[1,-1,4], cur[1,2,4], axis=1)；past 长度为 0
    {
        VARP past = _Input({1, -1, 4}, NCHW, halide_type_of<float>());
        VARP cur = _Input({1, 2, 4}, NCHW, halide_type_of<float>());
        past->setName("past");
        cur->setName("cur");
        VARP y = _Concat({past, cur}, 1);
        y->setName("y");
        saveModel({y}, dir + "/synth_kv.mnn");
        Names in(std::vector<std::string>{"past", "cur"}), out(std::vector<std::string>{"y"});
        arkli_mnn_net* net = arkli_mnn_net_load((dir + "/synth_kv.mnn").c_str(), nullptr, in.ptrs.data(), 2, out.ptrs.data(), 1, &cfg, err, kErrLen);
        CHECK(net != nullptr, std::string("加载合成 kv 模型: ") + err);
        if (net) {
            const int32_t s0[] = {1, 0, 4}, s2[] = {1, 2, 4}, s3[] = {1, 3, 4};
            float c2[8], c3[12];
            for (int i = 0; i < 8; ++i) c2[i] = (float)i;
            for (int i = 0; i < 12; ++i) c3[i] = 100.f + i;
            arkli_mnn_val* past0 = arkli_mnn_val_new(ARKLI_F32, s0, 3, nullptr);
            CHECK(past0 != nullptr, std::string("创建长度为 0 的 val: ") + lastErr());
            arkli_mnn_val* cur = arkli_mnn_val_new(ARKLI_F32, s2, 3, c2);
            arkli_mnn_val* ov[1] = {nullptr};
            arkli_mnn_val* iv[2] = {past0, cur};
            int rc = past0 ? arkli_mnn_net_forward(net, iv, 2, ov, 1, err, kErrLen) : -99;
            CHECK(rc == 0, std::string("长度为 0 的 past forward: ") + err);
            if (rc == 0) {
                int32_t sh[4];
                const int nd = arkli_mnn_val_shape(ov[0], sh, 4);
                std::printf("  长度为 0 的 past：输出维数 %d 形状 [%d,%d,%d]\n", nd, sh[0], sh[1], sh[2]);
                CHECK(nd == 3 && sh[0] == 1 && sh[1] == 2 && sh[2] == 4, "输出形状应为 [1,2,4]");
                const float* p = (const float*)arkli_mnn_val_read(ov[0]);
                CHECK(p && p[0] == 0.f && p[7] == 7.f, "长度为 0 时输出应等于 cur");
                // 输出原样作下一步输入（KV 零拷贝）：past=上一步输出，cur 换成 3 步
                arkli_mnn_val* cur3 = arkli_mnn_val_new(ARKLI_F32, s3, 3, c3);
                arkli_mnn_val* next[2] = {ov[0], cur3};
                arkli_mnn_val* ov2[1] = {nullptr};
                // cur 的固定维是 2，给 3 应被拦下
                rc = arkli_mnn_net_forward(net, next, 2, ov2, 1, err, kErrLen);
                CHECK(rc == ARKLI_MNN_ERR_INPUT, "cur 形状不符应被拦下");
                arkli_mnn_val* next2[2] = {ov[0], cur};
                rc = arkli_mnn_net_forward(net, next2, 2, ov2, 1, err, kErrLen);
                CHECK(rc == 0, std::string("输出作为下一步输入: ") + err);
                if (rc == 0) {
                    int32_t sh2[4];
                    CHECK(arkli_mnn_val_shape(ov2[0], sh2, 4) == 3 && sh2[1] == 4, "第二步 past 长度 2 + cur 2 = 4");
                    const float* q = (const float*)arkli_mnn_val_read(ov2[0]);
                    CHECK(q && q[0] == 0.f && q[7] == 7.f && q[8] == 0.f && q[15] == 7.f, "KV 拼接内容");
                }
                arkli_mnn_val_free(ov2[0]);
                arkli_mnn_val_free(cur3);
            }
            arkli_mnn_val_free(ov[0]);
            arkli_mnn_val_free(past0);
            arkli_mnn_val_free(cur);
            arkli_mnn_net_free(net);
        }
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::printf("用法：capi_smoke <model.mnn> <case_dir> [ext.mnn] [tmp_dir]\n");
        return 2;
    }
    const std::string model = argv[1], caseDir = argv[2];
    const std::string ext = argc > 3 ? argv[3] : "";
    const std::string tmp = argc > 4 ? argv[4] : ".";
    CHECK(arkli_mnn_abi_version() == ARKLI_MNN_ABI, "ABI 版本");
    Case c;
    if (!loadCase(caseDir, c)) {
        std::printf("读不到用例：%s\n", caseDir.c_str());
        return 2;
    }
    std::printf("用例：%zu 个输入 %zu 个输出\n", c.inputs.size(), c.outputs.size());
    testNumeric(model, c);
    testErrors(model, c);
    testLifecycle(model, c);
    if (!ext.empty()) testExternalWeight(model, ext, tmp, c);
    testSynthetic(tmp);
    std::printf("\n结果：%d 项断言，%d 项失败\n", g_total, g_fail);
    return g_fail == 0 ? 0 : 1;
}
