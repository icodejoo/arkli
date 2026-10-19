/*
 * 图推理会话的 C ABI：把 MNN 的 Module 薄封装成纯 C 接口，编进 libarkli-mnn.so（宿主测试时是 arkli-mnn.dll）。
 * 调用方（Rust 的 libloading、桌面测试）只依赖本头文件，不接触任何 C++ 类型。
 *
 * 约定（所有函数通用）：
 *  - 线程：同一个 net 的所有调用必须由调用方串行（Rust 侧 Mutex、Kotlin 侧 AiHeavyGate）；
 *    不同 net 之间也别并发调用 forward，gc（release_memory）、load、free 也一样——它们都会动 MNN 全局执行器，
 *    且 MNN 内部没加锁，所以这几类调用要用同一把锁串行（Rust 侧是 FORWARD_LOCK）。last_error 是线程本地的，可安全读取。
 *  - 所有权：net_load / val_new / net_forward 返回的句柄归调用方，用对应的 free 释放，释放后不得再用。
 *    句柄之间互相独立：先释放 net 不影响已取出的输出 val；val 也不持有 net。
 *  - 错误：不抛 C++ 异常出边界。失败返回 NULL 或负数错误码，详情见 err 缓冲（可为 NULL）与 arkli_mnn_last_error()。
 *  - 内存：权重一律按 memory=low（保持量化权重、激活动态量化）加载；normal 会把权重还原成 float（NLLB 约 2.85GB），
 *    因此默认被拒绝，只有测试开关 arkli_mnn_test_allow_normal(1) 打开后才放行。
 *  - 数据类型：只有 float32 与 int32。ONNX 里的 int64 输入在 MNN 中是 int32，调用方必须直接传 int32。
 *  - 张量内存：MNN 的输入只借用内存，所以 val_new 一定拷贝 data，绝不引用调用方缓冲区。
 *
 * 典型调用顺序：
 *   arkli_mnn_abi_version() 校验 -> arkli_mnn_net_load() -> 循环 { arkli_mnn_val_new() 造输入
 *   -> arkli_mnn_net_forward() -> arkli_mnn_val_shape()/arkli_mnn_val_read() 读输出 -> arkli_mnn_val_free() }
 *   -> arkli_mnn_net_free() -> arkli_mnn_release_memory()。
 */
#ifndef ARKLI_MNN_CAPI_H
#define ARKLI_MNN_CAPI_H

#include <stdint.h>

/* 导出宏：Windows 用 dllexport；其他平台覆盖 CMake 里的 -fvisibility=hidden */
#if defined(_WIN32)
#define ARKLI_MNN_API __declspec(dllexport)
#else
#define ARKLI_MNN_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

/** ABI 版本号；接口有不兼容改动时递增，调用方 dlopen 后要先校验 */
#define ARKLI_MNN_ABI 2

/** 一个已加载的模型：一个 Module 加自己独占的 RuntimeManager */
typedef struct arkli_mnn_net arkli_mnn_net;
/** 一个张量值（引用计数的 VARP 句柄）：可作输入，也可是 forward 的输出，输出可原样作下一次的输入（KV 零拷贝） */
typedef struct arkli_mnn_val arkli_mnn_val;

/** 加载配置 */
typedef struct {
    /** CPU 线程数，小于等于 0 时取默认 4 */
    int threads;
    /** 内存模式：2 = low（生产唯一可用）；0 = normal（仅测试开关打开后允许）；其他值报错 */
    int memory;
    /** 精度模式：0 normal / 1 high / 2 low(fp16，目标机不支持，慎用) / 3 bf16 */
    int precision;
    /** 性能模式：0 normal / 1 high（占满大核，更快更烫）/ 2 low（省电，明显变慢）；其他值报错 */
    int power;
    /** 非 0 则加载时预重排权重：稳态内存回到权重体积、峰值更低（生产建议 1） */
    int rearrange;
} arkli_mnn_config;

/** 张量数据类型 */
enum {
    /** float32 */
    ARKLI_F32 = 0,
    /** int32（承接 ONNX 的 int64 输入） */
    ARKLI_I32 = 1
};

/** 错误码：返回负数的函数用它，arkli_mnn_last_error_code() 也返回它 */
enum {
    /** 成功 */
    ARKLI_MNN_OK = 0,
    /** 参数非法（空指针、个数不符、配置越界） */
    ARKLI_MNN_ERR_ARG = -1,
    /** 模型加载失败（文件不存在、权重缺失、名字不在图里等） */
    ARKLI_MNN_ERR_LOAD = -2,
    /** 输入的类型或形状与模型不符 */
    ARKLI_MNN_ERR_INPUT = -3,
    /** 推理执行失败 */
    ARKLI_MNN_ERR_RUN = -4,
    /** 不支持的输出类型等 */
    ARKLI_MNN_ERR_UNSUPPORTED = -5,
    /** 捕获到未预期的异常 */
    ARKLI_MNN_ERR_INTERNAL = -6
};

/**
 * 返回编译进库里的 ABI 版本（等于 ARKLI_MNN_ABI）。
 * @return 版本号
 */
ARKLI_MNN_API int arkli_mnn_abi_version(void);

/**
 * 用默认值填充配置：threads=4、memory=2(low)、precision=0、power=0、rearrange=1。
 * @param cfg 待填充的配置，NULL 时什么也不做
 */
ARKLI_MNN_API void arkli_mnn_config_default(arkli_mnn_config* cfg);

/**
 * 加载模型。内部每个模型独占一个 RuntimeManager；外置权重严格按“设路径 -> 加载 -> 清空”进行，
 * 保证随后加载的别的模型不会读到这份权重。
 *
 * @param model     .mnn 文件的 UTF-8 路径，不可为空
 * @param weight    外置权重（.mnn.weight）的 UTF-8 路径；NULL 或空串表示权重在 .mnn 里
 * @param in_names  输入名数组（决定 forward 时 in 的顺序），n_in 个；名字必须存在于图里
 * @param n_in      输入个数，必须大于 0
 * @param out_names 输出名数组（决定 forward 时 out 的顺序），n_out 个；名字必须存在于图里
 * @param n_out     输出个数，必须大于 0
 * @param cfg       配置；NULL 等价于 arkli_mnn_config_default 的结果
 * @param err       接收错误描述的缓冲（UTF-8，带结尾 0，超长截断），可为 NULL
 * @param err_len   err 的字节数
 * @return 成功返回会话指针（用 arkli_mnn_net_free 释放）；失败返回 NULL
 */
ARKLI_MNN_API arkli_mnn_net* arkli_mnn_net_load(const char* model, const char* weight,
                                                const char* const* in_names, int n_in,
                                                const char* const* out_names, int n_out,
                                                const arkli_mnn_config* cfg, char* err, int err_len);

/**
 * 新建一个张量值，并拷贝 data（之后调用方可随意改动或释放自己的缓冲）。
 *
 * @param dtype ARKLI_F32 或 ARKLI_I32
 * @param shape 各维大小数组，ndim 个；允许某维为 0（如首步长度为 0 的 KV），不允许负数
 * @param ndim  维数，范围 0..8（0 表示标量，元素数为 1）
 * @param data  元素数据，按 C 顺序（NCHW 逻辑布局）紧密排列；元素数为 0 时可为 NULL
 * @return 句柄（用 arkli_mnn_val_free 释放）；失败返回 NULL，原因见 arkli_mnn_last_error()
 */
ARKLI_MNN_API arkli_mnn_val* arkli_mnn_val_new(int dtype, const int32_t* shape, int ndim, const void* data);

/**
 * 读取张量的形状。
 *
 * @param v     张量句柄
 * @param shape 接收各维大小的缓冲，可为 NULL（只想查维数）
 * @param cap   shape 能放多少个维度
 * @return 维数 ndim；句柄为空返回负数。若 ndim 大于 cap，只会写入前 cap 个
 */
ARKLI_MNN_API int arkli_mnn_val_shape(const arkli_mnn_val* v, int32_t* shape, int cap);

/**
 * 返回张量的数据类型。
 * @param v 张量句柄
 * @return ARKLI_F32 或 ARKLI_I32；句柄为空返回负数
 */
ARKLI_MNN_API int arkli_mnn_val_dtype(const arkli_mnn_val* v);

/**
 * 只读访问张量数据：F32 当 const float*、I32 当 const int32_t* 读，元素数为各维乘积。
 * 指针由句柄持有，随 val_free 失效；调用方不得写入或释放。
 *
 * @param v 张量句柄
 * @return 数据指针；句柄为空或元素数为 0 时返回 NULL
 */
ARKLI_MNN_API const void* arkli_mnn_val_read(arkli_mnn_val* v);

/**
 * 运行一次前向。按位置传参：in[i] 对应加载时的 in_names[i]，out[i] 对应 out_names[i]。
 * 会校验输入的类型与（固定维的）形状；输入句柄只被借用，调用返回后仍归调用方。
 *
 * @param n       会话
 * @param in      输入句柄数组，n_in 个，必须等于加载时的输入个数
 * @param n_in    输入个数
 * @param out     接收输出句柄的数组，n_out 个；成功后每个都是新句柄，需逐个 val_free；失败时全部置 NULL
 * @param n_out   输出个数，必须等于加载时的输出个数
 * @param err     错误描述缓冲，可为 NULL
 * @param err_len err 的字节数
 * @return 0 成功；负数为 ARKLI_MNN_ERR_*
 */
ARKLI_MNN_API int arkli_mnn_net_forward(arkli_mnn_net* n, arkli_mnn_val* const* in, int n_in,
                                        arkli_mnn_val** out, int n_out, char* err, int err_len);

/**
 * 释放张量句柄；NULL 安全。
 * @param v 张量句柄
 */
ARKLI_MNN_API void arkli_mnn_val_free(arkli_mnn_val* v);

/**
 * 释放会话（连同它的 RuntimeManager 与权重）；NULL 安全。已取出的输出 val 不受影响。
 * 释放后建议再调 arkli_mnn_release_memory() 让进程内存真正回落。
 * @param n 会话
 */
ARKLI_MNN_API void arkli_mnn_net_free(arkli_mnn_net* n);

/**
 * 归还内存：让 MNN 全局执行器丢掉缓存缓冲（Executor::gc FULL），再让分配器退还空闲页（安卓上 mallopt M_PURGE）。
 * 任何时候都可调用，没有会话时也无副作用。
 */
ARKLI_MNN_API void arkli_mnn_release_memory(void);

/**
 * 读取当前线程最近一次失败的描述（成功的调用不会清除它）。
 *
 * @param buf     接收缓冲（UTF-8，带结尾 0，超长截断）
 * @param buf_len buf 的字节数
 * @return 完整描述的字节数（不含结尾 0）；没有错误时为 0
 */
ARKLI_MNN_API int arkli_mnn_last_error(char* buf, int buf_len);

/**
 * 返回当前线程最近一次失败的错误码（ARKLI_MNN_ERR_*），没有则为 ARKLI_MNN_OK。
 * @return 错误码
 */
ARKLI_MNN_API int arkli_mnn_last_error_code(void);

/**
 * 仅供测试：是否允许 memory=normal 加载。默认关闭，生产代码不得调用。
 * @param allow 非 0 为允许
 */
ARKLI_MNN_API void arkli_mnn_test_allow_normal(int allow);

#ifdef __cplusplus
}
#endif

#endif /* ARKLI_MNN_CAPI_H */
