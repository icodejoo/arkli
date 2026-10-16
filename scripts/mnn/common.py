"""scripts/mnn 的公共小工具：目录约定、校验、子进程、日志。

目录约定（都可用环境变量覆盖，默认放在已被 .gitignore 忽略的 native/mnn/.work/convert 下）：
  ARKLI_MNN_WORK   工作根目录                  默认 <repo>/native/mnn/.work/convert
  ARKLI_MNN_DL     原版模型下载目录            默认 <WORK>/dl
  ARKLI_MNN_SPLIT  NLLB 拆图中间产物目录       默认 <WORK>/split/nllb
  ARKLI_MNN_OUT    转换产物目录（每个模型一个子目录） 默认 <WORK>/out
  ARKLI_MNNCONVERT 固定提交编出的 MNNConvert.exe（见 mnnconv.py）

用 `python -I` 运行时脚本目录不在 sys.path 里，所以每个脚本开头都要先 `sys.path.insert(0, 脚本目录)` 再 import 本模块。
"""
import hashlib
import json
import os
import sys

# 本目录与仓库根
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
# 固定提交的转换器默认位置（native/mnn/build-tools.ps1 的输出）
DEFAULT_CONVERT_EXE = os.path.join(REPO, "native", "mnn", ".work", "build-tools", "MNNConvert.exe")
# 校验文件时的分块大小
HASH_CHUNK = 8 << 20
# 评测统一线程数（与方案 3 节的桌面口径一致）
THREADS = 4
# MNN RuntimeManager 的 memory 取值：0 normal（加载时还原成 float，手机上不能用）/ 2 low（保持量化权重，动态 int8 激活）
MEMORY_NORMAL = 0
MEMORY_LOW = 2


def env_dir(name, default):
    """取环境变量指定的目录，缺省用 default；返回绝对路径。"""
    return os.path.abspath(os.environ.get(name) or default)


def work_dir():
    """工作根目录。"""
    return env_dir("ARKLI_MNN_WORK", os.path.join(REPO, "native", "mnn", ".work", "convert"))


def dl_dir():
    """原版模型下载目录。"""
    return env_dir("ARKLI_MNN_DL", os.path.join(work_dir(), "dl"))


def split_dir():
    """NLLB 拆图中间产物目录。"""
    return env_dir("ARKLI_MNN_SPLIT", os.path.join(work_dir(), "split", "nllb"))


def out_dir():
    """转换产物根目录，每个模型一个子目录（目录名即清单 id）。"""
    return env_dir("ARKLI_MNN_OUT", os.path.join(work_dir(), "out"))


def die(msg, code=1):
    """打印错误并退出（统一的错误出口）。"""
    print(f"错误：{msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def log(msg):
    """打印一行进度（立即刷新，便于看长任务）。"""
    print(msg, flush=True)


def need_file(path, hint=""):
    """确认文件存在，否则报错退出；hint 说明怎么补（比如先跑 fetch.py）。"""
    if not os.path.isfile(path):
        die(f"缺少文件：{path}" + (f"（{hint}）" if hint else ""))
    return path


def sha256_file(path):
    """计算文件 sha256（小写十六进制）。"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(HASH_CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def load_json(path):
    """读 UTF-8 JSON 文件。"""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_recipes():
    """读同目录的 recipes.json（每个模型的输入、量化参数、输出名）。"""
    return load_json(os.path.join(HERE, "recipes.json"))


def fmt_bytes(n):
    """字节数转 MB 文本，例如 94775452 -> '90.4MB'。"""
    return f"{n / (1 << 20):.1f}MB"


def find_asr_model_dir(root):
    """在解压后的语音包根目录里找含 encoder.onnx 的那一层（包内带一层同名顶层目录）。"""
    for dirpath, _dirs, files in os.walk(root):
        if "encoder.onnx" in files and "tokens.txt" in files:
            return dirpath
    die(f"在 {root} 里找不到语音模型目录（要有 encoder.onnx 与 tokens.txt），先运行 fetch.py asr")
