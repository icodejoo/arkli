"""生成 NLLB 评测句集 data/sentences_m6.tsv：原 29 句 + 六语 30 个有向语言对各 4 句（共 149 句）。

新增部分取自 data/audit_*.txt：每种源语言等间隔抽 20 句，目标语言按固定顺序轮换，所以每个有向语言对恰好 4 句，结果可重复。
列：源语言<TAB>目标语言<TAB>文本，与 eval_nllb.py 的口径一致。

用法：python -I make_eval_set.py [--out data/sentences_m6.tsv]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, log  # noqa: E402

# 语言码顺序（应用语言码）与审计语料文件名
LANGS = ["zh-CN", "en", "fr", "es", "ru", "ar"]
CORPUS = {"zh-CN": "audit_zh.txt", "en": "audit_en.txt", "fr": "audit_fr.txt", "es": "audit_es.txt",
          "ru": "audit_ru.txt", "ar": "audit_ar.txt"}
# 每个有向语言对的句数；每种源语言需要抽 PER_PAIR * 5 句
PER_PAIR = 4
# 原有 29 句的文件名
BASE_NAME = "sentences.tsv"


def pick(lines, n):
    """从 lines 里等间隔取 n 句（保持顺序，结果可重复）。"""
    step = len(lines) / n
    return [lines[int(i * step)] for i in range(n)]


def build():
    """返回 [(源, 目标, 文本)]：原 29 句 + 新增的有向语言对句子。"""
    rows = [tuple(l.rstrip("\n").split("\t")) for l in open(os.path.join(HERE, "data", BASE_NAME), encoding="utf-8") if l.strip()]
    for src in LANGS:
        lines = [l.strip() for l in open(os.path.join(HERE, "data", CORPUS[src]), encoding="utf-8") if l.strip()]
        targets = [t for t in LANGS if t != src]
        for k, text in enumerate(pick(lines, PER_PAIR * len(targets))):
            rows.append((src, targets[k % len(targets)], text))
    return rows


def main():
    """命令行入口：写 TSV 并打印各语言对的句数。"""
    ap = argparse.ArgumentParser(description="生成 NLLB 评测句集")
    ap.add_argument("--out", default=os.path.join(HERE, "data", "sentences_m6.tsv"))
    a = ap.parse_args()
    rows = build()
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    pairs = {}
    for s, t, _ in rows:
        pairs[(s, t)] = pairs.get((s, t), 0) + 1
    log(f"共 {len(rows)} 句，覆盖 {len(pairs)} 个有向语言对，每对 {min(pairs.values())}~{max(pairs.values())} 句 -> {a.out}")


if __name__ == "__main__":
    main()
