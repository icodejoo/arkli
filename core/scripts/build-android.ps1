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

# 读 cargo 的 dep-info（与宿主库同目录的 <库名>.d），返回其中最新修改的依赖文件；找不到 dep-info 或没有可用条目时返回 $null。
# dep-info 只有一行：`<产物路径>: <依赖1> <依赖2> ...`，路径里的空格以 `\ ` 转义。
function Get-DepInfoNewest {
    param([System.IO.FileInfo]$Lib)
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($Lib.Name)
    $dep = $null
    foreach ($n in "$stem.d", "lib$stem.d") {
        $p = Join-Path $Lib.DirectoryName $n
        if (Test-Path $p) { $dep = $p; break }
    }
    if (-not $dep) { return $null }
    $text = (Get-Content $dep -Raw).Trim()
    # 产物路径含盘符冒号，依赖列表从第一个 ": " 之后开始
    $idx = $text.IndexOf(': ')
    if ($idx -lt 0) { return $null }
    [regex]::Split($text.Substring($idx + 2), '(?<!\\) +') |
        ForEach-Object { $_.Replace('\ ', ' ') } |
        Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        ForEach-Object { Get-Item -LiteralPath $_ } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

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
        # 产物目录以 cargo 自己的为准（尊重 CARGO_TARGET_DIR / .cargo/config 的 target-dir），不能写死 core\target
        $targetDir = (cargo metadata --format-version 1 --no-deps | ConvertFrom-Json).target_directory
        if ($LASTEXITCODE -ne 0 -or -not $targetDir) { throw '读取 cargo metadata 的 target_directory 失败' }
        $hostLib = Get-ChildItem (Join-Path $targetDir 'debug') -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -in 'arkli_ffi.dll', 'libarkli_ffi.so', 'libarkli_ffi.dylib' } |
            Select-Object -First 1
        if (-not $hostLib) { throw "未找到宿主机 debug 库（arkli_ffi.dll/.so/.dylib），目录：$targetDir\debug" }

        # 过期检查：宿主库必须不早于它真正依赖的源码，否则会按旧元数据生成过期绑定。
        # 只看 cargo 的 dep-info（<库名>.d 列出的依赖文件）：整个 core 下的 *.rs / Cargo.* 里有 uniffi-bindgen、
        # arkli-ai/tests 这类 arkli-ffi 并不依赖的文件，改了它们 cargo 判定无变化、库时间戳不动，会永远误报“已过期”。
        $newestSrc = Get-DepInfoNewest $hostLib
        if (-not $newestSrc) {
            # 找不到 dep-info（极少见）：退回只比 arkli-ffi 及其依赖 crate 的源码
            $newestSrc = Get-ChildItem (Join-Path $CoreDir 'crates') -Directory |
                Where-Object { $_.Name -in 'arkli-ffi', 'arkli-core', 'arkli-ai' } |
                ForEach-Object {
                    $src = Join-Path $_.FullName 'src'
                    if (Test-Path $src) { Get-ChildItem $src -Recurse -File -Filter '*.rs' }
                    Get-Item (Join-Path $_.FullName 'Cargo.toml') -ErrorAction SilentlyContinue
                } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if ($newestSrc -and $hostLib.LastWriteTime -lt $newestSrc.LastWriteTime) {
            throw "宿主机库已过期（$($hostLib.FullName) 早于 $($newestSrc.FullName)），请先重新编译：cargo build -p $CrateName"
        }
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
