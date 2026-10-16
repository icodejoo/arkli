"""ONNX -> MNN 转换的统一入口。

绝不调用 pip 版 `mnnconvert` 包装脚本（它会带机器 ID 上报阿里云，还会自动 pip install aliyun-log-python-sdk）。
转换器按优先级选：
  1. 环境变量 ARKLI_MNNCONVERT 指向的 MNNConvert（生产用：固定提交，native/mnn/build-tools.ps1 编出）
  2. 默认位置 native/mnn/.work/build-tools/MNNConvert.exe（存在就用）
  3. pip MNN 3.6.1 的 `_tools.mnnconvert` 底层函数（与固定提交产物逐字节等价，仅 27 字节 UUID 差异；试验用）
     设环境变量 ARKLI_MNN_USE_PIP=1 可强制走这条（对照/排查用）

命令行用法（参数与 MNNConvert 完全一致，原样透传）：
  python -I mnnconv.py -f ONNX --modelFile a.onnx --MNNModel a.mnn --weightQuantBits 8
代码里调用：
  from mnnconv import convert
  convert("a.onnx", "a.mnn", ["--weightQuantBits", "8"], log_path="a.log")

常用量化参数（实测结论见 docs/research/onnx-to-mnn-migration.md 3.1）：
  --weightQuantBits 2~8   仅权重量化（默认逐通道）；--weightQuantBlock N 分块；--hqq 用 HQQ 量化；--fp16 权重存 fp16
  --saveExternalData      权重外置为 <name>.mnn.weight
  别同时给 --weightQuantAsymmetric 与 --weightQuantBlock（分块不生效）
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DEFAULT_CONVERT_EXE, die  # noqa: E402

# 转换器成功时必定打印的标志（退出码有时不可靠，两者都查）
SUCCESS_MARK = "Converted Success!"
# 源模型格式参数（固定为 ONNX）
ONNX_ARGS = ["-f", "ONNX"]


def converter_exe():
    """返回要用的 MNNConvert 可执行文件路径；没有（或 ARKLI_MNN_USE_PIP=1）则返回 None（改走 pip 的 _tools）。"""
    if os.environ.get("ARKLI_MNN_USE_PIP") == "1":
        return None
    p = os.environ.get("ARKLI_MNNCONVERT")
    if p:
        if not os.path.isfile(p):
            die(f"ARKLI_MNNCONVERT 指向的文件不存在：{p}")
        return p
    return DEFAULT_CONVERT_EXE if os.path.isfile(DEFAULT_CONVERT_EXE) else None


def converter_label():
    """给日志用的转换器描述。"""
    exe = converter_exe()
    return exe if exe else "pip MNN 的 _tools.mnnconvert（试验用；生产请先 build-tools.ps1）"


def _run_pip_tools(argv):
    """子进程里的 pip 路径：直接调 _tools.mnnconvert，避开包装脚本的上报。"""
    import _tools as tools  # pip MNN 自带的 C 扩展
    tools.mnnconvert(["mnnconvert"] + list(argv))


def convert(onnx_path, mnn_path, args=(), log_path=None):
    """把 onnx_path 转成 mnn_path。

    参数：args 为额外的 MNNConvert 参数列表；log_path 不为空时把转换器输出写进去。
    返回：转换器的完整输出文本。失败（退出码非 0、没有成功标志、没产出文件）时报错退出。
    示例：convert("m.onnx", "m.mnn", ["--weightQuantBits", "8", "--saveExternalData"])
    """
    os.makedirs(os.path.dirname(os.path.abspath(mnn_path)), exist_ok=True)
    argv = ONNX_ARGS + ["--modelFile", onnx_path, "--MNNModel", mnn_path] + list(args)
    exe = converter_exe()
    if exe:
        cmd = [exe] + argv
    else:
        cmd = [sys.executable, "-I", os.path.abspath(__file__)] + argv
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (r.stdout or "") + (r.stderr or "")
    if log_path:
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(out)
    if r.returncode != 0 or SUCCESS_MARK not in out or not os.path.isfile(mnn_path):
        print(out[-3000:], file=sys.stderr)
        die(f"转换失败（退出码 {r.returncode}）：{onnx_path}")
    return out


def main():
    """命令行入口：参数原样透传给转换器。"""
    exe = converter_exe()
    if exe:
        sys.exit(subprocess.call([exe] + sys.argv[1:]))
    _run_pip_tools(sys.argv[1:])


if __name__ == "__main__":
    main()
