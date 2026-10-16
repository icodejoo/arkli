"""对联语料读取与去重。

只用标准库。数据格式：in.txt / out.txt 每行一副对联的一侧，字间以空格分隔。
"""

import os

#: 默认数据目录（训练集）
DEFAULT_DATA_DIR = r"E:\workspaces\arkli-models\_src\couplet-clean\x\couplets\train"
#: 默认输出目录（不入库）
DEFAULT_OUT_DIR = r"E:\workspaces\arkli-models\_src\couplet-derived"


def strip_spaces(line):
    """去掉一行里所有空白。

    参数：line 原始行
    返回：无空白的字符串
    示例：strip_spaces("晚 风 摇") -> "晚风摇"
    """
    return "".join(line.split())


def load_pairs(data_dir=DEFAULT_DATA_DIR, limit=None):
    """读取并按 (上联, 下联) 去重，保持首次出现的顺序。

    参数：data_dir 含 in.txt/out.txt 的目录；limit 只取去重后前 N 对（None 为全量）
    返回：[(上联, 下联), ...]
    示例：pairs = load_pairs(limit=1000)
    """
    seen = set()
    pairs = []
    with open(os.path.join(data_dir, "in.txt"), encoding="utf-8") as fin, \
            open(os.path.join(data_dir, "out.txt"), encoding="utf-8") as fout:
        for a, b in zip(fin, fout):
            up, down = strip_spaces(a), strip_spaces(b)
            if not up or not down:
                continue
            key = up + "\t" + down
            if key in seen:
                continue
            seen.add(key)
            pairs.append((up, down))
            if limit is not None and len(pairs) >= limit:
                break
    return pairs
