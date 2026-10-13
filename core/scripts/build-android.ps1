<#
.SYNOPSIS
  构建 arkli-ffi 的 Android arm64-v8a 动态库，并生成 Kotlin 绑定。
.DESCRIPTION
  1. 未设置 ANDROID_NDK_HOME 时，取 $env:ANDROID_HOME\ndk 下最新版本。
  2. cargo ndk 构建 libarkli_ffi.so 并输出到 app\src\main\jniLibs。
  3. 用 uniffi-bindgen（library mode）从宿主机 debug 库生成 Kotlin 到 app\src\main\kotlin\uniffi。
  可重复运行：每次先清空绑定输出目录再生成。
.PARAMETER Target
  目标 ABI，默认 arm64-v8a。
.EXAMPLE
  pwsh core\scripts\build-android.ps1
#>
param(
    [string]$Target = 'arm64-v8a'
)

$ErrorActionPreference = 'Stop'

# 常量：库名与相对路径
$LibName = 'libarkli_ffi.so'
$CrateName = 'arkli-ffi'

# 路径：core 目录与仓库根
$CoreDir = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $CoreDir
$JniLibsDir = Join-Path $RepoRoot 'app\src\main\jniLibs'
$KotlinOutDir = Join-Path $RepoRoot 'app\src\main\kotlin'
$BindingsDir = Join-Path $KotlinOutDir 'uniffi'

# 执行外部命令，失败即抛错并说明是哪一步
function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host "==> $Name"
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "步骤失败（退出码 $LASTEXITCODE）：$Name" }
}

try {
    # 前置：cargo-ndk 必须存在
    if (-not (Get-Command cargo-ndk -ErrorAction SilentlyContinue)) {
        throw '未找到 cargo-ndk，请先执行：cargo install cargo-ndk'
    }

    # 前置：定位 NDK
    if (-not $env:ANDROID_NDK_HOME) {
        if (-not $env:ANDROID_HOME) { throw '未设置 ANDROID_NDK_HOME，也没有 ANDROID_HOME，无法定位 NDK' }
        $ndkRoot = Join-Path $env:ANDROID_HOME 'ndk'
        $latest = Get-ChildItem $ndkRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object { [version]($_.Name -replace '[^\d\.]', '') } -Descending |
            Select-Object -First 1
        if (-not $latest) { throw "在 $ndkRoot 下没找到任何 NDK 版本" }
        $env:ANDROID_NDK_HOME = $latest.FullName
    }
    Write-Host "NDK: $env:ANDROID_NDK_HOME"

    Push-Location $CoreDir
    try {
        # 第 1 步：交叉编译 .so 并放入 jniLibs
        Invoke-Step "cargo ndk 构建 $CrateName ($Target)" {
            cargo ndk -t $Target -o $JniLibsDir build --release -p $CrateName
        }

        $so = Join-Path $JniLibsDir "$Target\$LibName"
        if (-not (Test-Path $so)) { throw "构建后未找到产物：$so" }

        # 第 2 步：清理旧绑定，保证幂等
        if (Test-Path $BindingsDir) { Remove-Item $BindingsDir -Recurse -Force }

        # 第 3 步：生成 Kotlin。release 的 strip 会抹掉 UniFFI 元数据，
        # 所以改读宿主机 debug 库（元数据与平台无关，接口一致）
        Invoke-Step '构建宿主机 debug 库（仅供读取元数据）' {
            cargo build -p $CrateName
        }
        $hostLib = Get-ChildItem (Join-Path $CoreDir 'target\debug') -File |
            Where-Object { $_.Name -in 'arkli_ffi.dll', 'libarkli_ffi.so', 'libarkli_ffi.dylib' } |
            Select-Object -First 1
        if (-not $hostLib) { throw '未找到宿主机 debug 库（arkli_ffi.dll/.so/.dylib）' }
        Invoke-Step '生成 Kotlin 绑定' {
            cargo run -q -p uniffi-bindgen -- generate --library $hostLib.FullName --language kotlin --no-format --out-dir $KotlinOutDir
        }

        $kt = Get-ChildItem $BindingsDir -Filter *.kt -Recurse -ErrorAction SilentlyContinue
        if (-not $kt) { throw "未生成 Kotlin 文件：$BindingsDir" }

        $size = (Get-Item $so).Length
        Write-Host ("完成：{0} ({1} 字节, {2:N2} MB)" -f $so, $size, ($size / 1MB))
        $kt | ForEach-Object { Write-Host "Kotlin: $($_.FullName)" }
    }
    finally {
        Pop-Location
    }
}
catch {
    Write-Error "构建失败：$($_.Exception.Message)"
    exit 1
}
