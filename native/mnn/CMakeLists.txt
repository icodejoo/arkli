# 编 arkli-mnn：C ABI（arkli_mnn_capi.cpp）+ JNI 封装；链接预先编好的 libMNN.so，由 build.sh 驱动。
# 宿主测试（build-tools.ps1 -HostDll）打开 ARKLI_MNN_HOST：不含 JNI 与 LLM 头，Windows 链 MNN.lib，并额外编 capi_smoke。
cmake_minimum_required(VERSION 3.18)
project(arkli_mnn CXX)

# MNN 源码目录与编好的 libMNN.so（宿主上是 MNN.lib 导入库），均由调用脚本传入
set(MNN_SRC "" CACHE PATH "MNN 源码目录")
set(MNN_LIB "" CACHE FILEPATH "编好的 libMNN.so（宿主 Windows 为 MNN.lib）")
option(ARKLI_MNN_HOST "宿主测试构建：只编 C ABI 与测试，不含 JNI" OFF)

add_library(MNN SHARED IMPORTED)
if(WIN32)
    set_target_properties(MNN PROPERTIES IMPORTED_IMPLIB "${MNN_LIB}")
else()
    set_target_properties(MNN PROPERTIES IMPORTED_LOCATION "${MNN_LIB}")
endif()

if(ARKLI_MNN_HOST)
    add_library(arkli-mnn SHARED arkli_mnn_capi.cpp)
else()
    add_library(arkli-mnn SHARED arkli_mnn_capi.cpp arkli_mnn_jni.cpp)
endif()
set_target_properties(arkli-mnn PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
target_include_directories(arkli-mnn PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${MNN_SRC}/include"
    "${MNN_SRC}/transformers/llm/engine/include")
if(NOT MSVC)
    # 隐藏未标 ARKLI_MNN_API 的符号（JNI 入口由 JNIEXPORT 导出），减小体积
    target_compile_options(arkli-mnn PRIVATE -fvisibility=hidden -Os)
endif()
if(ARKLI_MNN_HOST)
    target_link_libraries(arkli-mnn MNN)
    # 宿主冒烟测试：直接链 arkli-mnn 与 MNN（用 MNN 的 Express 接口造合成模型）
    add_executable(capi_smoke test/capi_smoke.cpp)
    set_target_properties(capi_smoke PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
    target_include_directories(capi_smoke PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" "${MNN_SRC}/include")
    target_link_libraries(capi_smoke arkli-mnn MNN)
else()
    target_link_libraries(arkli-mnn MNN log)
endif()
