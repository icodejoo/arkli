# 用固定提交的 MNN 源码，在 Windows 上编出模型转换与桌面校验工具：
#   MNNConvert.exe     ONNX -> MNN 转换器（scripts/mnn 的生产转换器，见 docs/research/onnx-to-mnn-migration.md 3.1）
#   ModuleBasic.out.exe 一致性校验工具（配合 scripts/mnn/make_case.py 生成的用例目录）
#
# 用法（PowerShell，不需要先进 VS 开发者命令行）：
#   .\native\mnn\build-tools.ps1                 # 编转换器与 ModuleBasic，输出到 native/mnn/.work/build-tools/
#   .\native\mnn\build-tools.ps1 -Out D:\x       # 换输出目录
#   .\native\mnn\build-tools.ps1 -Jobs 8         # 并行度，默认取逻辑核数
#   .\native\mnn\build-tools.ps1 -HostDll        # 额外编宿主测试用的 MNN.dll + arkli-mnn.dll（C ABI，不含 JNI）+ capi_smoke.exe，复制到输出目录根
#
# 前置：MSVC 14.x 生成工具 + Windows SDK（vswhere 自动找）、CMake 与 Ninja（PATH 上有，或在 ANDROID_HOME/cmake/* 里）。
# 源码：native/mnn/.work/MNN-<提交>/（由 build.sh 首次运行时下载；缺失会提示）。
# 坑：不用 VsDevCmd（它的扩展脚本在部分环境报错），手动设 PATH/INCLUDE/LIB；FetchContent 路径太长会失败，所以输出目录别放深。
param(
    [string]$Out = "",
    [int]$Jobs = [Environment]::ProcessorCount,
    [switch]$HostDll
)
$ErrorActionPreference = "Stop"

# 钉死的 MNN 提交，必须与 native/mnn/build.sh 一致
$MnnCommit = "478c10e8d2351c7a4ea6f6243b97841a1eb39190"
# 要编的目标：转换器 + 一致性校验工具
$Targets = @("MNNConvert", "ModuleBasic.out")

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $here ".work"
$src = Join-Path $work "MNN-$MnnCommit"
if (-not $Out) { $Out = Join-Path $work "build-tools" }

if (-not (Test-Path (Join-Path $src "CMakeLists.txt"))) {
    throw "找不到 MNN 源码：$src。先运行一次 native/mnn/build.sh 让它下载固定提交，或手动解压到该目录"
}

# 在候选目录里找可执行文件：先 PATH，再 Android SDK 自带的 CMake 目录
function Find-Tool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    if ($sdk) {
        $hit = Get-ChildItem (Join-Path $sdk "cmake\*\bin\$name.exe") -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
        if ($hit) { return $hit.FullName }
    }
    throw "找不到 $name（请放进 PATH，或设置 ANDROID_HOME）"
}

# 用 vswhere 定位最新的 MSVC 工具集目录
function Find-Msvc() {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { throw "找不到 vswhere，请安装 VS 2022 生成工具（含 C++ 桌面开发）" }
    $inst = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $inst) { throw "没有装 MSVC x64 生成工具" }
    $ver = Get-ChildItem (Join-Path $inst "VC\Tools\MSVC") | Sort-Object Name | Select-Object -Last 1
    return $ver.FullName
}

# 取 Windows 10/11 SDK 的最新版本号目录
function Find-WinSdk() {
    $root = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
    $ver = Get-ChildItem (Join-Path $root "Include") | Where-Object { Test-Path (Join-Path $_.FullName "ucrt") } | Sort-Object Name | Select-Object -Last 1
    if (-not $ver) { throw "没有装 Windows SDK" }
    return @{ Root = $root; Ver = $ver.Name }
}

$cmake = Find-Tool "cmake"
$ninja = Find-Tool "ninja"
$msvc = Find-Msvc
$sdk = Find-WinSdk
$kit = $sdk.Root; $kv = $sdk.Ver

# 手动设编译环境（不依赖 VsDevCmd）
$env:PATH = "$msvc\bin\Hostx64\x64;$kit\bin\$kv\x64;$env:SystemRoot\system32;$env:SystemRoot"
$env:INCLUDE = "$msvc\include;$kit\Include\$kv\ucrt;$kit\Include\$kv\um;$kit\Include\$kv\shared;$kit\Include\$kv\winrt"
$env:LIB = "$msvc\lib\x64;$kit\Lib\$kv\ucrt\x64;$kit\Lib\$kv\um\x64"
if (-not (Get-Command cl -ErrorAction SilentlyContinue)) { throw "cl.exe 不可用：$msvc" }

New-Item -ItemType Directory -Force $Out | Out-Null
Write-Host "== MNN $MnnCommit"
Write-Host "== MSVC $msvc"
Write-Host "== 输出 $Out"

# MNN_LOW_MEMORY 必须开（转换器要带出权重量化的相关 schema）；MNN_WIN_RUNTIME_MT 静态 CRT，产物不依赖 VC 运行库
& $cmake -S $src -B $Out -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl `
    -DCMAKE_BUILD_TYPE=Release -DMNN_BUILD_CONVERTER=ON -DMNN_BUILD_SHARED_LIBS=OFF -DMNN_WIN_RUNTIME_MT=ON `
    -DMNN_LOW_MEMORY=ON -DMNN_BUILD_TOOLS=ON -DMNN_BUILD_DEMO=OFF -DMNN_BUILD_TEST=OFF -DMNN_BUILD_BENCHMARK=OFF
if ($LASTEXITCODE -ne 0) { throw "cmake 配置失败（$LASTEXITCODE）" }

& $cmake --build $Out --target $Targets -j $Jobs
if ($LASTEXITCODE -ne 0) { throw "编译失败（$LASTEXITCODE）" }

Write-Host "== 产物"
foreach ($n in @("MNNConvert.exe", "ModuleBasic.out.exe")) {
    $p = Join-Path $Out $n
    if (-not (Test-Path $p)) { throw "缺少产物：$p" }
    $h = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
    Write-Host ("{0}  {1} B  {2}" -f $n, (Get-Item $p).Length, $h)
}
Write-Host "使用：set ARKLI_MNNCONVERT=$Out\MNNConvert.exe 后运行 scripts/mnn/convert_all.py"

if ($HostDll) {
    # 宿主 DLL：MNN 编成共享库（带 MNN_LOW_MEMORY，memory=low 才生效；静态 CRT），再用 native/mnn/CMakeLists.txt 的 ARKLI_MNN_HOST 模式编 C ABI 与冒烟测试
    $dll = Join-Path $Out "hostdll"
    $mnnBuild = Join-Path $dll "mnn"
    $arkBuild = Join-Path $dll "arkli"
    Write-Host "== 宿主 DLL：MNN.dll"
    & $cmake -S $src -B $mnnBuild -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl `
        -DCMAKE_BUILD_TYPE=Release -DMNN_BUILD_SHARED_LIBS=ON -DMNN_SEP_BUILD=OFF -DMNN_WIN_RUNTIME_MT=ON -DMNN_LOW_MEMORY=ON `
        -DMNN_BUILD_CONVERTER=OFF -DMNN_BUILD_TOOLS=OFF -DMNN_BUILD_DEMO=OFF -DMNN_BUILD_TEST=OFF -DMNN_BUILD_BENCHMARK=OFF
    if ($LASTEXITCODE -ne 0) { throw "MNN.dll 配置失败（$LASTEXITCODE）" }
    & $cmake --build $mnnBuild --target MNN -j $Jobs
    if ($LASTEXITCODE -ne 0) { throw "MNN.dll 编译失败（$LASTEXITCODE）" }

    Write-Host "== 宿主 DLL：arkli-mnn.dll + capi_smoke.exe"
    & $cmake -S $here -B $arkBuild -G Ninja "-DCMAKE_MAKE_PROGRAM=$ninja" -DCMAKE_CXX_COMPILER=cl `
        -DCMAKE_BUILD_TYPE=Release -DARKLI_MNN_HOST=ON "-DMNN_SRC=$src" "-DMNN_LIB=$mnnBuild\MNN.lib" `
        -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
    if ($LASTEXITCODE -ne 0) { throw "arkli-mnn 配置失败（$LASTEXITCODE）" }
    & $cmake --build $arkBuild -j $Jobs
    if ($LASTEXITCODE -ne 0) { throw "arkli-mnn 编译失败（$LASTEXITCODE）" }

    # 统一放到输出目录根，方便 Rust 的 ARKLI_MNN_DYLIB 与测试直接引用
    Copy-Item (Join-Path $mnnBuild "MNN.dll") $Out -Force
    Copy-Item (Join-Path $arkBuild "arkli-mnn.dll") $Out -Force
    Copy-Item (Join-Path $arkBuild "capi_smoke.exe") $Out -Force
    foreach ($n in @("MNN.dll", "arkli-mnn.dll", "capi_smoke.exe")) {
        $p = Join-Path $Out $n
        Write-Host ("{0}  {1} B  {2}" -f $n, (Get-Item $p).Length, (Get-FileHash $p -Algorithm SHA256).Hash.ToLower())
    }
    Write-Host "运行：$Out\capi_smoke.exe <siglip2 fp32 model.mnn> <用例目录> [外置权重版 .mnn] [临时目录]"
}
