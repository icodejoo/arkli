"""金标文件读取。"""

import os

#: 金标目录
GOLD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold")


def load_gold(split=None):
    """读取 gold/gold.tsv。

    参数：split "dev" / "holdout" / None（全部）
    返回：[dict(id, split, stratum, up, down, cats:list, wan, theme, avoid)]
    示例：dev = load_gold("dev")
    """
    rows = []
    with open(os.path.join(GOLD_DIR, "gold.tsv"), encoding="utf-8") as f:
        lines = [x for x in f.read().splitlines() if x and not x.startswith("#")]
    for line in lines[1:]:
        p = line.split("\t")
        row = dict(id=int(p[0]), split=p[1], stratum=p[2], up=p[3], down=p[4],
                   cats=p[5].split(","), wan=p[6], theme=p[7], avoid=p[8])
        if split is None or row["split"] == split:
            rows.append(row)
    return rows


def load_wan_pool(split=None):
    """读取挽联补抽池标注。

    参数：split "dev" / "holdout" / None
    返回：{id: "是"/"疑"/"否"}
    """
    out = {}
    with open(os.path.join(GOLD_DIR, "wan_pool.tsv"), encoding="utf-8") as f:
        lines = [x for x in f.read().splitlines() if x and not x.startswith("#")]
    for line in lines[1:]:
        i, s, mark = line.split("\t")
        if split is None or s == split:
            out[int(i)] = mark
    return out
