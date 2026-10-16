"""金标评估：分类（首选/任一/全部合理）、挽联召回与精确率、横批人工判定汇总。

横批是否贴切由人工（本项目里是模型标注员）逐条判定，判定结果存 gold/banner_judgments_<集合>.tsv：
id \t 横批 \t 判定(合格/不合格) \t 备注。横批变了旧判定自动失效，需要重新判。
"""

import os

import gold_io

#: 横批判定文件名模板
JUDGE_FILE = "banner_judgments_{}.tsv"
#: 判定为合格的取值
JUDGE_OK = "合格"
#: 金标里“纯随机”分层的名字（用于报告无偏子集）
RANDOM_STRATUM = "随机"


def classify_metrics(rows, preds):
    """分类指标。

    参数：rows 金标行；preds {id: [(类, 权重)]}
    返回：dict(n, top1, any, all, top1_random, n_random)
    """
    top = anyok = allok = 0
    rtop = rn = 0
    for g in rows:
        cats = [c for c, _ in preds[g["id"]]]
        t = cats[0] in g["cats"]
        top += t
        anyok += any(c in g["cats"] for c in cats)
        allok += all(c in g["cats"] for c in cats)
        if g["stratum"] == RANDOM_STRATUM:
            rn += 1
            rtop += t
    n = len(rows)
    return dict(n=n, top1=round(top / n, 4), any=round(anyok / n, 4), all=round(allok / n, 4),
                n_random=rn, top1_random=round(rtop / rn, 4) if rn else None)


def wan_metrics(rows, preds, pool_marks, pool_preds):
    """挽联指标：召回看金标“是”（含挽联池里挑出的），精确率看挽联池（纯随机、全量通读）。

    参数：rows 金标行；preds {id: 分类}；pool_marks {id: 是/疑/否}；pool_preds {id: 分类}
    返回：dict
    """
    def has_wan(p):
        return any(c == "挽联" for c, _ in p)

    pos = [g for g in rows if g["wan"] == "是"]
    maybe = [g for g in rows if g["wan"] == "疑"]
    tp = sum(has_wan(preds[g["id"]]) for g in pos)
    tq = sum(has_wan(preds[g["id"]]) for g in maybe)
    flagged = [i for i in pool_marks if has_wan(pool_preds[i])]
    pool_yes = sum(1 for i in flagged if pool_marks[i] == "是")
    pool_maybe = sum(1 for i in flagged if pool_marks[i] == "疑")
    pool_pos = sum(1 for m in pool_marks.values() if m == "是")
    pool_tp = sum(1 for i, m in pool_marks.items() if m == "是" and has_wan(pool_preds[i]))
    return dict(
        gold_recall=f"{tp}/{len(pos)}", gold_recall_rate=round(tp / len(pos), 4) if pos else None,
        gold_maybe_hit=f"{tq}/{len(maybe)}",
        missed=[g["id"] for g in pos if not has_wan(preds[g["id"]])],
        pool_size=len(pool_marks), pool_recall=f"{pool_tp}/{pool_pos}",
        pool_flagged=len(flagged), pool_flag_rate=round(len(flagged) / len(pool_marks), 4) if pool_marks else None,
        pool_precision_strict=round(pool_yes / len(flagged), 4) if flagged else None,
        pool_precision_with_maybe=round((pool_yes + pool_maybe) / len(flagged), 4) if flagged else None)


def load_judgments(split):
    """读取横批人工判定。返回 {(id, 横批): (判定, 备注)}；文件不存在返回空。"""
    path = os.path.join(gold_io.GOLD_DIR, JUDGE_FILE.format(split))
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f.read().splitlines():
            if not line or line.startswith("#") or line.startswith("id\t"):
                continue
            p = line.split("\t")
            out[(int(p[0]), p[1])] = (p[2], p[3] if len(p) > 3 else "")
    return out


def banner_metrics(rows, banners, judgments):
    """横批指标：按人工判定统计合格率；没有判定的列为待判。

    参数：rows 金标行；banners {id: 横批}；judgments load_judgments 结果
    返回：dict(judged, ok, rate, pending:[id])
    """
    ok = judged = 0
    pending = []
    for g in rows:
        key = (g["id"], banners[g["id"]])
        if key not in judgments:
            pending.append(g["id"])
            continue
        judged += 1
        ok += judgments[key][0] == JUDGE_OK
    return dict(judged=judged, ok=ok, rate=round(ok / judged, 4) if judged else None, pending=pending)
