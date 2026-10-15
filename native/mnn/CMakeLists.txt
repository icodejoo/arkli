# 只编 JNI 封装：链接预先编好的 libMNN.so（MNN 本体与 LLM 引擎都在里面），由 build.sh 驱动
cmake_minimum_required(VERSION 3.18)
project(arkli_mnn CXX)

# MNN 源码目录与编好的 libMNN.so，均由 build.sh 传入
set(MNN_SRC "" CACHE PATH "MNN 源码目录")
set(MNN_LIB "" CACHE FILEPATH "编好的 libMNN.so")

add_library(MNN SHARED IMPORTED)
set_target_properties(MNN PROPERTIES IMPORTED_LOCATION "${MNN_LIB}")

add_library(arkli-mnn SHARED arkli_mnn_jni.cpp)
set_target_properties(arkli-mnn PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
target_include_directories(arkli-mnn PRIVATE
    "${MNN_SRC}/include"
    "${MNN_SRC}/transformers/llm/engine/include")
# 隐藏除 JNI 入口外的符号，减小体积
target_compile_options(arkli-mnn PRIVATE -fvisibility=hidden -Os)
target_link_libraries(arkli-mnn MNN log)
