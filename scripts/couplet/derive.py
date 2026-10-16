"""对联分类与推荐横批推导：入口。

用法（python -I，只用标准库）：
    python -I derive.py                      # 全量：训练 + 推导，写 derived.tsv 与 stats.json
    python -I derive.py --limit 20000        # 只取去重后前 N 对（训练也只用这些，结果与全量不同，仅供试跑）
    python -I derive.py --eval dev           # 全量推导后在金标 dev 上评估，结果写入 stats.json
    python -I derive.py --eval holdout --sheet  # 另输出横批判定表，供人工逐条判定
    python -I derive.py --eval both --eval-only # 只评估（读人工判定算横批合格率），合并进已有 stats.json
输出目录默认 E:\\workspaces\\arkli-models\\_src\\couplet-derived\\
"""

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import banner  # noqa: E402
import classify  # noqa: E402
import corpus  # noqa: E402
import evaluate  # noqa: E402
import gold_io  # noqa: E402
import lexicon  # noqa: E402

#: 权重直方图分桶
WEIGHT_BINS = (0.3, 0.5, 0.7, 0.9, 1.01)
#: 统计里列出的横批 Top 数
TOP_BANNERS = 30
#: 横批占比分布分桶（标签, 下限含, 上限不含）
SHARE_BUCKETS = (("≥1%", 0.01, 2.0), ("0.5%~1%", 0.005, 0.01), ("0.1%~0.5%", 0.001, 0.005),
                 ("0.01%~0.1%", 0.0001, 0.001), ("<0.01%", 0.0, 0.0001))


def log(msg):
    """打印带时间戳的进度。"""
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def fmt_cats(cats):
    """分类结果格式化为“类:权重,类:权重”。"""
    return ",".join(f"{c}:{w:.2f}" for c, w in cats)


def build(pairs):
    """训练分类器并准备横批选择器。

    参数：pairs 去重后的对联
    返回：(Classifier, BannerPicker)
    """
    lex = lexicon.Lexicon()
    log("训练弱监督朴素贝叶斯")
    model = classify.train(pairs, lex, log=log)
    log(f"各类弱标签文档数 {dict(zip(classify.CLASSES, model.doc_counts))}")
    clf = classify.Classifier(lex, model)
    log("统计横批意象关联")
    bp = banner.BannerPicker().fit_assoc(pairs)
    return clf, bp


def run(pairs, clf, bp, out_path):
    """批量推导并写 TSV，同时收集统计。

    返回：stats dict
    """
    n = len(pairs)
    first = Counter()
    anycls = Counter()
    weights = defaultdict(lambda: [0] * len(WEIGHT_BINS))
    ncats = Counter()
    banners = Counter()
    blen = Counter()
    cls_banners = defaultdict(Counter)
    wan_levels = Counter()
    t0 = time.time()
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        for k, (up, down) in enumerate(pairs):
            cats, level, guess = clf.analyze(up, down)
            b = bp.pick(up, down, cats, level, guess)
            f.write(f"{up}\t{down}\t{b}\t{fmt_cats(cats)}\n")
            first[cats[0][0]] += 1
            ncats[len(cats)] += 1
            wan_levels[level] += 1
            for c, w in cats:
                anycls[c] += 1
                for i, edge in enumerate(WEIGHT_BINS):
                    if w < edge:
                        weights[c][i] += 1
                        break
            banners[b] += 1
            blen[len(b)] += 1
            cls_banners[cats[0][0]][b] += 1
            if (k + 1) % 100000 == 0:
                log(f"已处理 {k + 1}/{n}")
    elapsed = time.time() - t0
    top = banners.most_common(TOP_BANNERS)
    per_cls = {}
    for c, cnt in cls_banners.items():
        tot = sum(cnt.values())
        b0, v0 = cnt.most_common(1)[0]
        per_cls[c] = dict(count=tot, distinct_banners=len(cnt), top_banner=b0,
                          top_share=round(v0 / tot, 4), top5=[[b, v] for b, v in cnt.most_common(5)])
    return dict(
        pairs=n, derive_seconds=round(elapsed, 1),
        fallback_rate=round(first[classify.FALLBACK] / n, 4),
        first_class={c: [v, round(v / n, 4)] for c, v in first.most_common()},
        any_class={c: [v, round(v / n, 4)] for c, v in anycls.most_common()},
        num_classes={str(k): v for k, v in sorted(ncats.items())},
        weight_hist={"bins": ["<0.3", "<0.5", "<0.7", "<0.9", "<=1"], **{c: v for c, v in weights.items()}},
        wan_level={"无": wan_levels[0], "弱(附加标签)": wan_levels[1], "强(置首)": wan_levels[2]},
        banner_distinct=len(banners),
        banner_share_hist={label: sum(1 for v in banners.values() if lo <= v / n < hi)
                           for label, lo, hi in SHARE_BUCKETS},
        banner_top=[[b, v, round(v / n, 4)] for b, v in top],
        banner_max_share=round(top[0][1] / n, 4) if top else 0,
        banner_length={str(k): [v, round(v / n, 4)] for k, v in sorted(blen.items())},
        banner_per_class=per_cls)


def evaluate_gold(clf, bp, pairs_index, split, sheet_dir=None):
    """在金标上评估；可另写横批判定表。

    参数：clf 分类器；bp 横批选择器；pairs_index {id: (上联,下联)}；split dev/holdout；sheet_dir 判定表输出目录
    返回：评估结果 dict
    """
    rows = gold_io.load_gold(split)
    preds, bans = {}, {}
    for g in rows:
        cats, level, guess = clf.analyze(g["up"], g["down"])
        preds[g["id"]] = cats
        bans[g["id"]] = bp.pick(g["up"], g["down"], cats, level, guess)
    pool = gold_io.load_wan_pool(split)
    pool_preds = {i: clf.predict(*pairs_index[i]) for i in pool}
    res = dict(classify=evaluate.classify_metrics(rows, preds),
               wan=evaluate.wan_metrics(rows, preds, pool, pool_preds),
               banner=evaluate.banner_metrics(rows, bans, evaluate.load_judgments(split)))
    if sheet_dir:
        path = os.path.join(sheet_dir, f"banner_sheet_{split}.tsv")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("id\t上联\t下联\t分类\t横批\t金标分类\t横批主题\t横批忌讳\n")
            for g in rows:
                f.write(f"{g['id']}\t{g['up']}\t{g['down']}\t{fmt_cats(preds[g['id']])}\t{bans[g['id']]}\t"
                        f"{','.join(g['cats'])}\t{g['theme']}\t{g['avoid']}\n")
        log(f"横批判定表：{path}")
    return res


def main(argv=None):
    """命令行入口。"""
    ap = argparse.ArgumentParser(description="对联多分类与推荐横批推导")
    ap.add_argument("--data", default=corpus.DEFAULT_DATA_DIR, help="含 in.txt/out.txt 的目录")
    ap.add_argument("--out", default=corpus.DEFAULT_OUT_DIR, help="输出目录")
    ap.add_argument("--limit", type=int, default=None, help="只取去重后前 N 对")
    ap.add_argument("--eval", choices=["dev", "holdout", "both"], default=None, help="在金标上评估")
    ap.add_argument("--sheet", action="store_true", help="评估时另写横批判定表")
    ap.add_argument("--eval-only", action="store_true",
                    help="只训练并评估，不重写 derived.tsv；评估结果合并进已有 stats.json")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    t0 = time.time()
    log("读取并去重语料")
    pairs = corpus.load_pairs(args.data, args.limit)
    log(f"去重后 {len(pairs)} 对")
    clf, bp = build(pairs)
    train_seconds = round(time.time() - t0, 1)
    stats_path = os.path.join(args.out, "stats.json")
    if args.eval_only:
        if not args.eval:
            ap.error("--eval-only 需要同时给 --eval")
        with open(stats_path, encoding="utf-8") as f:
            stats = json.load(f)
        index = dict(enumerate(corpus.load_pairs(args.data)))
        splits = ["dev", "holdout"] if args.eval == "both" else [args.eval]
        stats.setdefault("eval", {}).update(
            {s: evaluate_gold(clf, bp, index, s, args.out if args.sheet else None) for s in splits})
        with open(stats_path, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=1)
        log(json.dumps(stats["eval"], ensure_ascii=False))
        return
    stats = run(pairs, clf, bp, os.path.join(args.out, "derived.tsv"))
    stats["train_seconds"] = train_seconds
    stats["total_seconds"] = round(time.time() - t0, 1)
    stats["params"] = classify.PARAMS
    stats["banner_library"] = dict(nodes=len(bp.nodes), distinct=len({b for nd in bp.nodes for k in ("b4", "b2", "bl")
                                                                          for b in nd[k]}))
    if args.eval:
        if args.limit:
            log("提示：--limit 下训练语料不全，评估结果仅供参考")
        index = dict(enumerate(pairs)) if not args.limit else dict(enumerate(corpus.load_pairs(args.data)))
        splits = ["dev", "holdout"] if args.eval == "both" else [args.eval]
        stats["eval"] = {s: evaluate_gold(clf, bp, index, s, args.out if args.sheet else None) for s in splits}
        log(json.dumps(stats["eval"], ensure_ascii=False))
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    log(f"完成，用时 {stats['total_seconds']} 秒；回落通用 {stats['fallback_rate']}；"
        f"最大单横批占比 {stats['banner_max_share']}")


if __name__ == "__main__":
    main()
