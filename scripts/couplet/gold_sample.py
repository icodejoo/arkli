"""金标分层抽样（一次性脚本，留档用于复现抽样过程）。

分层（共 400）：纯随机 140；挽联强命中 50；挽联弱线索 40；
13 个主题类各 12（按 v0 词典首选类）；词典无命中 14。
每层内交替分入 dev / holdout。输出打乱顺序的盲标清单，不含分层信息。

用法：python -I gold_sample.py   （写 gold/_sample_meta.tsv 与 gold/_blind.tsv）
"""

import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import corpus  # noqa: E402
import lexicon  # noqa: E402

#: 抽样随机种子
SEED = 20261016
#: 探索阶段看过的样本种子（这些不进金标）
EXPLORE_SEED, EXPLORE_N = 7, 300
#: 各主题类每层样本数
PER_CLASS = 12
#: 主题类（不含挽联、通用）
THEMES = ["春节", "节庆", "婚庆", "祝寿", "乔迁", "开业", "学业", "事业",
          "家国", "山水", "人生", "情感", "文墨", "怀古"]
#: 首选类判定的最低得分
MIN_TOP = 2.0
#: 挽联强命中阈值
WAN_STRONG = 4.0
#: 金标目录
GOLD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold")


def main():
    """执行抽样并写文件。"""
    pairs = corpus.load_pairs()
    lex = lexicon.Lexicon()
    explored = set(random.Random(EXPLORE_SEED).sample(range(len(pairs)), EXPLORE_N))
    rng = random.Random(SEED)
    order = list(range(len(pairs)))
    rng.shuffle(order)

    want = {"随机": 140, "挽联强": 50, "挽联弱": 40, "无命中": 14}
    for c in THEMES:
        want["主" + c] = PER_CLASS
    # 乔迁样本极少，名额不足时由随机层补齐，不另行处理
    got = {k: [] for k in want}
    used = set(explored)
    for idx in order:
        if all(len(got[k]) >= want[k] for k in want):
            break
        if idx in used:
            continue
        up, down = pairs[idx]
        if len(got["随机"]) < want["随机"]:
            got["随机"].append(idx)
            used.add(idx)
            continue
        scores, _ = lex.score(up, down)
        wan = scores.get("挽联", 0.0)
        top = max(scores, key=scores.get) if scores else None
        topv = scores.get(top, 0.0) if top else 0.0
        if wan >= WAN_STRONG:
            key = "挽联强"
        elif wan > 0:
            key = "挽联弱"
        elif topv < MIN_TOP:
            key = "无命中"
        else:
            key = "主" + top
        if key in got and len(got[key]) < want[key]:
            got[key].append(idx)
            used.add(idx)

    rows = []
    for key, ids in got.items():
        for j, idx in enumerate(ids):
            split = "dev" if j % 2 == 0 else "holdout"
            rows.append((idx, key, split))
    rng.shuffle(rows)
    os.makedirs(GOLD_DIR, exist_ok=True)
    with open(os.path.join(GOLD_DIR, "_sample_meta.tsv"), "w", encoding="utf-8") as f:
        f.write("id\t分层\t集合\n")
        for idx, key, split in rows:
            f.write(f"{idx}\t{key}\t{split}\n")
    with open(os.path.join(GOLD_DIR, "_blind.tsv"), "w", encoding="utf-8") as f:
        for idx, _, _ in rows:
            up, down = pairs[idx]
            f.write(f"{idx}\t{up}\t{down}\n")
    print({k: len(v) for k, v in got.items()}, len(rows))


#: 挽联补抽池大小（纯随机，人工通读挑出挽联，用于无偏估计召回）
WAN_POOL_N = 3600
#: 挽联补抽池种子
WAN_POOL_SEED = 99


def wan_pool():
    """写出挽联补抽池（排除探索样本与已有金标），供人工通读。"""
    pairs = corpus.load_pairs()
    explored = set(random.Random(EXPLORE_SEED).sample(range(len(pairs)), EXPLORE_N))
    with open(os.path.join(GOLD_DIR, "_sample_meta.tsv"), encoding="utf-8") as f:
        taken = {int(line.split("\t")[0]) for line in f.read().splitlines()[1:]}
    rng = random.Random(WAN_POOL_SEED)
    pool = []
    for idx in rng.sample(range(len(pairs)), WAN_POOL_N + 1000):
        if idx in explored or idx in taken:
            continue
        pool.append(idx)
        if len(pool) >= WAN_POOL_N:
            break
    with open(os.path.join(GOLD_DIR, "_wan_pool.tsv"), "w", encoding="utf-8") as f:
        for idx in pool:
            up, down = pairs[idx]
            f.write(f"{idx}\t{up}\t{down}\n")
    print(len(pool))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "wanpool":
        wan_pool()
    else:
        main()
