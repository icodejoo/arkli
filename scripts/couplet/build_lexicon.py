# -*- coding: utf-8 -*-
"""从训练集挖掘分类词典的 mined 字段（统计特异性，不改动人工 seeds 与 blacklist）。

做法：
1. 用 lexicon.json 的种子词对去重后的对联做伪标注：某分类种子得分明显领先才标注，否则不标。
2. 统计 2~4 字连续子串在各伪标注分类中的出现次数。
3. 计算 P(类|词) 与提升度 lift = P(类|词) / P(类)，保留 P、lift、出现次数均达标的词，
   按 P * log2(1+次数) 排序，每类取前 top 个，权重 = 0.5 + 0.4 * min(1, P)。

用法：
    python -I scripts/couplet/build_lexicon.py [--data DIR] [--top 60] [--min-count 8]
"""

import argparse
import collections
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import derive  # noqa: E402  复用清洗、去重与词匹配逻辑

LABEL_MIN_SCORE = 1.0   # 伪标注：领先分类的种子得分下限
LABEL_MARGIN = 0.5      # 伪标注：领先分类与次高分类的得分差下限
SEED_MIN_WEIGHT = 0.5   # 只用权重不低于此值的种子做伪标注
GRAM_MIN_LEN = 2        # 挖掘的最短子串字数
GRAM_MAX_LEN = 4        # 挖掘的最长子串字数
MIN_P = 0.6             # 类特异性下限 P(类|词)
MIN_LIFT = 2.0          # 提升度下限
MINED_BASE = 0.5        # 挖掘词权重基数
MINED_SPAN = 0.4        # 挖掘词权重随 P 增加的幅度


def seed_index(categories):
    """建立仅含种子词（权重不低于 SEED_MIN_WEIGHT）的索引，用于伪标注。

    参数:
        categories: lexicon.json 的 categories 字段。
    返回:
        (索引 {词: [(分类, 权重)]}, 最长词字数)。
    """
    index = {}
    max_len = 1
    for cat, info in categories.items():
        for term, weight in info.get("seeds", {}).items():
            if weight >= SEED_MIN_WEIGHT:
                index.setdefault(term, []).append((cat, float(weight)))
                max_len = max(max_len, len(term))
    return index, max_len


def pseudo_label(index, max_len, up, down):
    """用种子词给一副对联伪标注分类。

    参数:
        index: seed_index 返回的索引。
        max_len: 最长种子词字数。
        up: 上联（去空格）。
        down: 下联（去空格）。
    返回:
        分类名；无法可靠判定时返回 None。
    """
    hits = derive.match_terms(index, max_len, derive.cjk(up))
    hits.update(derive.match_terms(index, max_len, derive.cjk(down)))
    scores = collections.Counter()
    for entries in hits.values():
        for cat, weight in entries:
            scores[cat] += weight
    ranked = scores.most_common(2)
    if not ranked or ranked[0][1] < LABEL_MIN_SCORE:
        return None
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    if ranked[0][1] - second < LABEL_MARGIN:
        return None
    return ranked[0][0]


def grams_of(text):
    """枚举文本中的 2~4 字连续子串（去重）。

    参数:
        text: 纯汉字文本。
    返回:
        子串集合。
    """
    out = set()
    n = len(text)
    for i in range(n):
        for length in range(GRAM_MIN_LEN, GRAM_MAX_LEN + 1):
            if i + length <= n:
                out.add(text[i:i + length])
    return out


def mine(data_dir, categories, min_count, top):
    """挖掘各分类的特异性词。

    参数:
        data_dir: 训练集目录。
        categories: lexicon.json 的 categories 字段（含种子词）。
        min_count: 词在伪标注对联中的最少出现次数。
        top: 每类保留的挖掘词数。
    返回:
        {分类: {词: 权重}}。
    """
    index, max_len = seed_index(categories)
    gram_counts = {cat: collections.Counter() for cat in categories}
    labeled = collections.Counter()
    total_pairs = 0
    for up, down in derive.unique_pairs(data_dir):
        total_pairs += 1
        cat = pseudo_label(index, max_len, up, down)
        if cat is None:
            continue
        labeled[cat] += 1
        grams = grams_of(derive.cjk(up)) | grams_of(derive.cjk(down))
        gram_counts[cat].update(grams)
    n_labeled = sum(labeled.values()) or 1
    print(f"去重对联 {total_pairs}，伪标注 {n_labeled}（{n_labeled / max(1, total_pairs):.1%}）", file=sys.stderr)
    for cat in categories:
        print(f"  伪标注 {cat}: {labeled.get(cat, 0)}", file=sys.stderr)

    seed_terms = set()
    for info in categories.values():
        seed_terms.update(info.get("seeds", {}).keys())
    all_grams = set()
    for counter in gram_counts.values():
        all_grams.update(counter.keys())

    candidates = collections.defaultdict(list)
    for gram in all_grams:
        total = sum(gram_counts[cat].get(gram, 0) for cat in categories)
        if total < min_count or gram in seed_terms:
            continue
        for cat in categories:
            n = gram_counts[cat].get(gram, 0)
            if n == 0:
                continue
            p = n / total
            prior = labeled.get(cat, 0) / n_labeled
            lift = p / prior if prior else 0.0
            if p >= MIN_P and lift >= MIN_LIFT:
                score = p * math.log2(1 + n)
                candidates[cat].append((-score, -len(gram), gram, p))

    mined = {}
    for cat in categories:
        picked = select_words(candidates.get(cat, []), seed_terms, top)
        mined[cat] = {g: round(MINED_BASE + MINED_SPAN * min(1.0, p), 2) for g, p in picked}
        print(f"{cat}: 挖掘 {len(candidates.get(cat, []))} 候选，保留 {len(mined[cat])}", file=sys.stderr)
    return mined


def select_words(candidates, seed_terms, top):
    """从候选中按得分贪心选词，去掉与种子词或已选词互为子串的碎片，保证确定性。

    参数:
        candidates: [(-得分, -字数, 词, P(类|词))] 列表。
        seed_terms: 全部种子词集合（包含或被包含于种子词的候选不选）。
        top: 最多保留的词数。
    返回:
        [(词, P(类|词))]，按选入顺序。
    """
    chosen = []
    for _, _, gram, p in sorted(candidates):
        if len(chosen) >= top:
            break
        if any(seed in gram or gram in seed for seed in seed_terms):
            continue
        if any(gram in word or word in gram for word, _ in chosen):
            continue
        chosen.append((gram, p))
    return chosen


def parse_args(argv):
    """解析命令行参数。

    参数:
        argv: 参数列表（不含程序名）。
    返回:
        argparse.Namespace。
    """
    parser = argparse.ArgumentParser(description="挖掘分类词典 mined 字段")
    parser.add_argument("--data", default=derive.DEFAULT_DATA_DIR, help="训练集目录")
    parser.add_argument("--top", type=int, default=60, help="每类保留的挖掘词数")
    parser.add_argument("--min-count", type=int, default=8, help="词的最少出现次数")
    parser.add_argument("--lexicon", default=derive.LEXICON_PATH, help="词典文件路径")
    return parser.parse_args(argv)


def main(argv=None):
    """命令行入口：挖掘后写回 lexicon.json 的 mined 字段。

    参数:
        argv: 参数列表，缺省读取 sys.argv。
    返回:
        退出码。
    """
    args = parse_args(argv if argv is not None else sys.argv[1:])
    with open(args.lexicon, encoding="utf-8") as f:
        data = json.load(f)
    mined = mine(args.data, data["categories"], args.min_count, args.top)
    for cat, info in data["categories"].items():
        info["mined"] = mined.get(cat, {})
    with open(args.lexicon, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
