# -*- coding: utf-8 -*-
"""对联分类与横批推导（启发式，非真实横批）。

流程：流式读取训练集的上下联 -> 去空格并按 (上联, 下联) 去重 -> 词典打分分类
（阈值、挽联否决、类数上限）-> 按字数规则与分类挑横批（确定性，按类限量分散）->
输出 derived.tsv 与 stats.json。全程不把数据集整体读成对象，分两遍流式处理。

用法：
    python -I scripts/couplet/derive.py [--data DIR] [--out DIR] [--limit N]
"""

import argparse
import collections
import hashlib
import json
import math
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LEXICON_PATH = os.path.join(HERE, "lexicon.json")
BANNER_PATH = os.path.join(HERE, "banners.json")
DEFAULT_DATA_DIR = r"E:\workspaces\arkli-models\_src\couplet-clean\x\couplets\train"
DEFAULT_OUT_DIR = r"E:\workspaces\arkli-models\_src\couplet-derived"

FALLBACK_CAT = "通用"        # 无分类时的回落类
FALLBACK_WEIGHT = 0.5        # 回落类的权重
GENERAL_BASE = 0.35          # 有分类时，通用横批库的基础分
VETO_MIN_CAT_WEIGHT = 0.8    # 挽联否决时挽联类的最低权重
OVERLAP_BONUS = 0.15         # 横批每个与上下联重叠的字的加分
IMAGERY_BONUS = 0.10         # 横批每个命中词内字的加分（意象匹配）
OVERLAP_CAP = 2              # 用字重叠与意象匹配最多各计两个字
CAP_RATIO = 0.15             # 单个横批最多占所属分类的比例
CAP_MIN = 3                  # 分类很小时的最小上限
WEIGHT_DIGITS = 3            # 内部权重精度
OUTPUT_DIGITS = 2            # 输出权重精度

# 横批字数规则（见 length_rules）
PREFERRED_LEN = 4            # 默认字数
MIN_LEN = 2                  # 横批最短字数
MAX_LEN = 7                  # 横批最长字数
SHORT_LENS = (2, 3)          # 短横批候选字数
LONG_LENS = (5, 6, 7)        # 长横批候选字数
SHORT_MAX_HALF = 4           # 短横批：上下联最长不超过此字数
SHORT_MAX_TERMS = 1          # 短横批：命中词不超过此个数（意象单一）
LONG_MIN_BEST = 0.6          # 长横批：四字最佳得分低于此值视为四字不贴合
LONG_MIN_HALF = 5            # 长横批（四字不贴合）：上下联最长不少于此字数
LONG_TERM_MIN_HALF = 6       # 长横批（长短语）：上下联最长不少于此字数
LONG_TERM_LEN = 3            # 长横批（长短语）：需有长度不少于此值的命中词
LENGTH_PENALTY = 0.05        # 非四字横批的得分扣减，使四字优先

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
RULE_FOUR = "四字"
RULE_SHORT = "短:意象单一"
RULE_LONG_MISFIT = "长:四字不贴合"
RULE_LONG_PHRASE = "长:长短语"
RULE_OPEN = "放开:无可用候选"
RULE_EMPTY = "兜底"
PairScore = collections.namedtuple("PairScore", "cats hit_chars hit_terms vetoed")


def clean(line):
    """去掉行内全部空白与 BOM，保留其余字符。

    参数:
        line: 原始一行文本。
    返回:
        去空白后的字符串，可能为空。
    """
    return "".join(line.replace("\ufeff", "").split())


def cjk(text):
    """只保留汉字，用于词典匹配与字数统计（标点、字母不计入）。

    参数:
        text: 任意文本。
    返回:
        仅含汉字的字符串。
    """
    return "".join(CJK_RE.findall(text))


def iter_pairs(data_dir):
    """逐行读取 in.txt / out.txt，产出去空格后的 (上联, 下联)。

    参数:
        data_dir: 含 in.txt 与 out.txt 的目录（如 train/）。
    返回:
        生成器，每次产出一对非空的 (上联, 下联)。
    """
    in_path = os.path.join(data_dir, "in.txt")
    out_path = os.path.join(data_dir, "out.txt")
    with open(in_path, encoding="utf-8") as fi, open(out_path, encoding="utf-8") as fo:
        for a, b in zip(fi, fo):
            up, down = clean(a), clean(b)
            if up and down:
                yield up, down


def unique_pairs(data_dir, limit=0):
    """按去空格后的 (上联, 下联) 去重并流式产出；判重只存 16 字节摘要以省内存。

    参数:
        data_dir: 数据目录。
        limit: 大于 0 时只产出前 limit 对不重复的对联，用于小批试跑。
    返回:
        生成器，产出不重复的 (上联, 下联)。
    """
    seen = set()
    produced = 0
    for up, down in iter_pairs(data_dir):
        key = hashlib.blake2b((up + "\t" + down).encode("utf-8"), digest_size=16).digest()
        if key in seen:
            continue
        seen.add(key)
        yield up, down
        produced += 1
        if limit and produced >= limit:
            return


class Lexicon:
    """分类词典：合并种子词与挖掘词，建立 词 -> [(分类, 权重)] 索引。"""

    def __init__(self, path=LEXICON_PATH):
        """读取 lexicon.json；种子词权重覆盖同名挖掘词，黑名单词不入索引。

        参数:
            path: 词典文件路径。
        """
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.threshold = float(data["threshold"])
        self.max_cats = int(data["max_cats"])
        self.veto = data["veto"]
        self.categories = list(data["categories"].keys())
        blacklist = set(data.get("blacklist", []))
        self.index = {}
        for cat, info in data["categories"].items():
            words = {}
            words.update(info.get("mined", {}))
            words.update(info.get("seeds", {}))
            for term, weight in words.items():
                if term and term not in blacklist:
                    self.index.setdefault(term, []).append((cat, float(weight)))
        self.max_len = max(len(t) for t in self.index)

    def match(self, text):
        """在纯汉字文本中找出所有词典词（逐位置、长度 1 到 max_len）。

        参数:
            text: 纯汉字文本（单侧上联或下联）。
        返回:
            {词: [(分类, 权重), ...]}，同一词只出现一次。
        """
        return match_terms(self.index, self.max_len, text)


def match_terms(index, max_len, text):
    """在文本中按位置枚举索引里的词（长度 1 到 max_len），供词典与伪标注共用。

    参数:
        index: {词: [(分类, 权重), ...]}。
        max_len: 索引中最长词的字数。
        text: 纯汉字文本。
    返回:
        {词: 索引中的条目}，同一词只出现一次。
    """
    hits = {}
    n = len(text)
    for i in range(n):
        for length in range(1, min(max_len, n - i) + 1):
            term = text[i:i + length]
            entries = index.get(term)
            if entries is not None:
                hits[term] = entries
    return hits


def score_pair(lex, up, down):
    """对一副对联做多分类打分。

    分类分 = 1 - exp(-Σ命中词权重)；低于阈值丢弃；命中挽联强词时否决喜庆类；
    最多保留 max_cats 个，按权重降序（同分按词典分类顺序）；无分类时回落到通用。

    参数:
        lex: Lexicon 实例。
        up: 上联（去空格）。
        down: 下联（去空格）。
    返回:
        PairScore(cats, hit_chars, hit_terms, vetoed)：
        cats 为 [(分类, 权重)]；hit_chars 为命中词包含的字集合；
        hit_terms 为命中词集合；vetoed 表示是否触发挽联否决。
    """
    hits = lex.match(cjk(up))
    hits.update(lex.match(cjk(down)))
    raw = collections.defaultdict(float)
    for entries in hits.values():
        for cat, weight in entries:
            raw[cat] += weight
    kept = {c: 1.0 - math.exp(-r) for c, r in raw.items()}
    kept = {c: w for c, w in kept.items() if w >= lex.threshold}

    veto = lex.veto
    vetoed = any(
        cat == veto["trigger"] and weight >= veto["min_weight"]
        for entries in hits.values()
        for cat, weight in entries
    )
    if vetoed:
        kept = {c: w for c, w in kept.items() if c in veto["keep"]}
        kept[veto["trigger"]] = max(kept.get(veto["trigger"], 0.0), VETO_MIN_CAT_WEIGHT)

    order = {c: i for i, c in enumerate(lex.categories)}
    ranked = sorted(kept.items(), key=lambda kv: (-round(kv[1], WEIGHT_DIGITS), order[kv[0]]))
    cats = [(c, round(w, WEIGHT_DIGITS)) for c, w in ranked[:lex.max_cats]]
    if not cats:
        cats = [(FALLBACK_CAT, FALLBACK_WEIGHT)]
    return PairScore(cats, set("".join(hits.keys())), set(hits.keys()), vetoed)


def length_rules(max_half, best4, hit_terms):
    """判定本副对联允许的横批字数档，并给出每档的原因（规则如下，确定性）。

    - 默认：只允许四字。
    - 短：上下联最长 <= SHORT_MAX_HALF 且命中词 <= SHORT_MAX_TERMS（意象单一）→ 允许 2~3 字。
    - 长：(a) 四字最佳得分 < LONG_MIN_BEST 且上下联最长 >= LONG_MIN_HALF（四字不贴合）；
          (b) 上下联最长 >= LONG_TERM_MIN_HALF 且有长度 >= LONG_TERM_LEN 的命中词（长短语）
          → 允许 5~7 字。两者同时满足时取 (a) 的原因。

    参数:
        max_half: 上下联中较长一侧的汉字数。
        best4: 四字候选中的最佳得分（无四字候选时传 0）。
        hit_terms: 命中的词典词集合。
    返回:
        {字数: 原因}，必含 PREFERRED_LEN。
    """
    allowed = {PREFERRED_LEN: RULE_FOUR}
    if max_half <= SHORT_MAX_HALF and len(hit_terms) <= SHORT_MAX_TERMS:
        for length in SHORT_LENS:
            allowed[length] = RULE_SHORT
    long_reason = None
    if best4 < LONG_MIN_BEST and max_half >= LONG_MIN_HALF:
        long_reason = RULE_LONG_MISFIT
    elif max_half >= LONG_TERM_MIN_HALF and any(len(t) >= LONG_TERM_LEN for t in hit_terms):
        long_reason = RULE_LONG_PHRASE
    if long_reason:
        for length in LONG_LENS:
            allowed[length] = long_reason
    return allowed


class BannerBank:
    """横批库：按分类存放 2~7 字横批，预先计算字集合与归属分类；以下划线开头的键视为注释跳过。"""

    def __init__(self, path=BANNER_PATH):
        """读取 banners.json，校验每条横批为 2~7 个汉字且全库不重复。

        参数:
            path: 横批库文件路径。
        异常:
            ValueError: 横批字数越界、含非汉字或重复时抛出。
        """
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self.banners = {}
        self.chars = {}
        self.home = {}
        for cat, items in data.items():
            if cat.startswith("_"):
                continue
            self.banners[cat] = list(items)
            for text in items:
                if not MIN_LEN <= len(text) <= MAX_LEN or len(cjk(text)) != len(text):
                    raise ValueError(f"横批须为 {MIN_LEN}~{MAX_LEN} 个汉字: {cat} {text}")
                if text in self.home:
                    raise ValueError(f"横批重复: {text}")
                self.home[text] = cat
                self.chars[text] = frozenset(text)


def pick_banner(bank, up, down, cats, hit_chars, hit_terms, counts, caps):
    """为一副对联挑横批。

    候选为所属分类库（及通用库，有分类时基础分较低）。得分 = 分类权重 + 用字重叠加分
    + 意象匹配加分；非四字候选扣 LENGTH_PENALTY。字数只在 length_rules 允许的档内选。
    横批与上下联重叠字数超过其字数一半、或整句包含横批时不选。同分按横批字典序，保证确定性。
    所属分类的横批已达上限（caps）则跳过；全部超限时取得分最高者并标记超限。

    参数:
        bank: BannerBank 实例。
        up: 上联。
        down: 下联。
        cats: score_pair 返回的 [(分类, 权重)]。
        hit_chars: 命中词包含的字集合（意象匹配用）。
        hit_terms: 命中词集合（字数规则用）。
        counts: 横批 -> 已分配次数（由调用方更新）。
        caps: 分类 -> 单个横批上限。
    返回:
        (横批文本, 是否超限, 字数原因)。
    """
    base = dict(cats)
    if FALLBACK_CAT not in base:
        base[FALLBACK_CAT] = GENERAL_BASE
    text = up + down
    text_chars = set(text)
    pool = []
    for cat, weight in base.items():
        for banner in bank.banners.get(cat, ()):
            if banner in text:
                continue
            bchars = bank.chars[banner]
            overlap = len(bchars & text_chars)
            if overlap > len(banner) // 2:
                continue
            imagery = len(bchars & hit_chars)
            score = (weight
                     + min(overlap, OVERLAP_CAP) * OVERLAP_BONUS
                     + min(imagery, OVERLAP_CAP) * IMAGERY_BONUS)
            pool.append((round(score, WEIGHT_DIGITS), banner))
    if not pool:
        return bank.banners[FALLBACK_CAT][0], True, RULE_EMPTY

    max_half = max(len(cjk(up)), len(cjk(down)))
    best4 = max((s for s, b in pool if len(b) == PREFERRED_LEN), default=0.0)
    allowed = length_rules(max_half, best4, hit_terms)
    ranked = [(-(s - (0.0 if len(b) == PREFERRED_LEN else LENGTH_PENALTY)), b)
              for s, b in pool if len(b) in allowed]
    reason_of = allowed
    if not ranked:
        ranked = [(-s, b) for s, b in pool]
        reason_of = {}
    ranked.sort()
    for _, banner in ranked:
        if counts[banner] < caps[bank.home[banner]]:
            return banner, False, reason_of.get(len(banner), RULE_OPEN)
    best = ranked[0][1]
    return best, True, reason_of.get(len(best), RULE_OPEN)


def format_cats(cats):
    """把分类列表格式化为 '分类1:权重,分类2:权重'（权重保留两位小数）。

    参数:
        cats: [(分类, 权重)]。
    返回:
        输出列文本。
    """
    return ",".join(f"{c}:{w:.{OUTPUT_DIGITS}f}" for c, w in cats)


def primary_counts(lex, data_dir, limit):
    """第一遍：统计各分类作为首选分类的对联数，用于计算横批上限。

    参数:
        lex: Lexicon 实例。
        data_dir: 数据目录。
        limit: 试跑上限，0 为全量。
    返回:
        (分类 -> 首选数量的 Counter, 总对数)。
    """
    counter = collections.Counter()
    total = 0
    for up, down in unique_pairs(data_dir, limit):
        counter[score_pair(lex, up, down).cats[0][0]] += 1
        total += 1
    return counter, total


class RunStats:
    """运行统计：分类数量、权重直方图、横批字数与占比、字数规则原因、回落与超限次数。"""

    WEIGHT_BUCKETS = 20  # 权重直方图按 0.05 分桶

    def __init__(self):
        """初始化计数器。"""
        self.primary = collections.Counter()
        self.any_cat = collections.Counter()
        self.weight_hist = collections.defaultdict(lambda: [0] * self.WEIGHT_BUCKETS)
        self.n_cats = collections.Counter()
        self.banner_total = collections.Counter()
        self.len_total = collections.Counter()
        self.len_in_class = collections.defaultdict(collections.Counter)
        self.reason = collections.Counter()
        self.fallback = 0
        self.vetoed = 0
        self.overflow = 0
        self.total = 0

    def add(self, cats, banner, home, overflow, vetoed, reason):
        """累加一副对联的统计结果。

        参数:
            cats: [(分类, 权重)]。
            banner: 分配的横批。
            home: 横批所属分类。
            overflow: 是否横批超限。
            vetoed: 是否触发挽联否决。
            reason: 字数选择原因。
        """
        self.total += 1
        self.primary[cats[0][0]] += 1
        self.n_cats[len(cats)] += 1
        for cat, weight in cats:
            self.any_cat[cat] += 1
            bucket = min(self.WEIGHT_BUCKETS - 1, int(weight * self.WEIGHT_BUCKETS))
            self.weight_hist[cat][bucket] += 1
        if cats[0][0] == FALLBACK_CAT:
            self.fallback += 1
        self.vetoed += int(vetoed)
        self.overflow += int(overflow)
        self.banner_total[banner] += 1
        self.len_total[len(banner)] += 1
        self.len_in_class[home][len(banner)] += 1
        self.reason[reason] += 1


def run(data_dir, out_dir, limit, lex, bank):
    """执行两遍流程并写出 derived.tsv 与 stats.json。

    参数:
        data_dir: 数据目录（train/）。
        out_dir: 输出目录。
        limit: 试跑上限，0 为全量。
        lex: Lexicon 实例。
        bank: BannerBank 实例。
    返回:
        stats 字典（与 stats.json 内容一致）。
    """
    started = time.time()
    primary, total = primary_counts(lex, data_dir, limit)
    caps = {cat: max(CAP_MIN, int(CAP_RATIO * primary.get(cat, 0))) for cat in bank.banners}
    print(f"第一遍完成：{total} 对（去重后），耗时 {time.time() - started:.1f}s", file=sys.stderr)

    os.makedirs(out_dir, exist_ok=True)
    tsv_path = os.path.join(out_dir, "derived.tsv")
    counts = collections.Counter()
    stats = RunStats()
    with open(tsv_path, "w", encoding="utf-8", newline="\n") as out:
        for up, down in unique_pairs(data_dir, limit):
            score = score_pair(lex, up, down)
            banner, overflow, reason = pick_banner(
                bank, up, down, score.cats, score.hit_chars, score.hit_terms, counts, caps)
            counts[banner] += 1
            out.write(f"{up}\t{down}\t{banner}\t{format_cats(score.cats)}\n")
            stats.add(score.cats, banner, bank.home[banner], overflow, score.vetoed, reason)
    elapsed = time.time() - started
    print(f"第二遍完成：写出 {stats.total} 行到 {tsv_path}，总耗时 {elapsed:.1f}s", file=sys.stderr)

    result = build_stats_report(stats, bank, caps, primary, elapsed, tsv_path, limit)
    with open(os.path.join(out_dir, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    return result


def _share(n, total):
    """计算比例并保留四位小数。

    参数:
        n: 分子。
        total: 分母，为 0 时按 1 处理。
    返回:
        浮点比例。
    """
    return round(n / max(1, total), 4)


def build_stats_report(stats, bank, caps, primary, elapsed, tsv_path, limit):
    """把 RunStats 整理成 stats.json 的结构。

    参数:
        stats: RunStats 实例。
        bank: BannerBank 实例（取分类顺序）。
        caps: 分类 -> 单横批上限。
        primary: 首选分类计数（第一遍结果）。
        elapsed: 总耗时秒数。
        tsv_path: 输出文件路径。
        limit: 试跑上限。
    返回:
        可直接 json 序列化的字典。
    """
    total = stats.total or 1
    per_cat = {}
    for cat in bank.banners:
        lens = stats.len_in_class.get(cat, collections.Counter())
        n_assigned = sum(lens.values())
        per_cat[cat] = {
            "首选数量": stats.primary.get(cat, 0),
            "含该类数量": stats.any_cat.get(cat, 0),
            "首选占比": _share(stats.primary.get(cat, 0), total),
            "单横批上限": caps[cat],
            "横批字数分布": {str(k): v for k, v in sorted(lens.items())},
            "四字占比": _share(lens.get(PREFERRED_LEN, 0), n_assigned),
            "权重直方图(0.05分桶)": stats.weight_hist.get(cat, [0] * RunStats.WEIGHT_BUCKETS),
        }
    banner_top = []
    for text, n in stats.banner_total.most_common(20):
        home = bank.home[text]
        banner_top.append({
            "横批": text,
            "字数": len(text),
            "所属分类": home,
            "数量": n,
            "占全部比例": _share(n, total),
            "占所属分类比例": _share(n, stats.primary.get(home, 0)),
        })
    max_in_class = {}
    for text, n in stats.banner_total.items():
        home = bank.home[text]
        max_in_class[home] = max(max_in_class.get(home, 0.0), n / max(1, stats.primary.get(home, 0)))
    return {
        "去重后对联数": stats.total,
        "试跑上限": limit,
        "耗时秒": round(elapsed, 1),
        "输出文件": tsv_path,
        "回落通用比例": _share(stats.fallback, total),
        "挽联否决触发数": stats.vetoed,
        "分类数分布": dict(sorted(stats.n_cats.items())),
        "横批超限次数": stats.overflow,
        "横批字数分布": {str(k): {"数量": v, "占比": _share(v, total)}
                         for k, v in sorted(stats.len_total.items())},
        "四字横批全库占比": _share(stats.len_total.get(PREFERRED_LEN, 0), total),
        "字数选择原因分布": {k: {"数量": v, "占比": _share(v, total)}
                             for k, v in stats.reason.most_common()},
        "各分类统计": per_cat,
        "横批占比Top20": banner_top,
        "各分类内单横批最大占比": {k: round(v, 4) for k, v in sorted(max_in_class.items())},
        "横批使用种类数": len(stats.banner_total),
    }


def parse_args(argv):
    """解析命令行参数。

    参数:
        argv: 参数列表（不含程序名）。
    返回:
        argparse.Namespace。
    """
    parser = argparse.ArgumentParser(description="对联分类与横批推导")
    parser.add_argument("--data", default=DEFAULT_DATA_DIR, help="训练集目录（含 in.txt/out.txt）")
    parser.add_argument("--out", default=DEFAULT_OUT_DIR, help="输出目录")
    parser.add_argument("--limit", type=int, default=0, help="试跑：只处理前 N 对去重后的对联，0 为全量")
    return parser.parse_args(argv)


def main(argv=None):
    """命令行入口。

    参数:
        argv: 参数列表，缺省读取 sys.argv。
    返回:
        退出码。
    """
    args = parse_args(argv if argv is not None else sys.argv[1:])
    lex = Lexicon()
    bank = BannerBank()
    result = run(args.data, args.out, args.limit, lex, bank)
    summary = {k: result[k] for k in ("去重后对联数", "耗时秒", "回落通用比例", "挽联否决触发数",
                                      "横批超限次数", "四字横批全库占比")}
    print(json.dumps(summary, ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
