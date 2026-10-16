"""弱监督朴素贝叶斯：字 + 二元组特征，按“类条件概率 / 全库背景概率”的对数提升度打分。

只用标准库。训练标签来自词典高置信结果（见 classify.weak_label）。
"""

import math
import re
from collections import Counter

#: 分句用的标点
_SPLIT = re.compile(r"[，。、；：？！,.;:?!“”‘’\"（）()《》·…—\-\s]+")
#: 特征最低全库频次（低于此值不进词表）
MIN_FEATURE_COUNT = 20
#: 平滑：向背景分布收缩的伪文档数
PSEUDO_DOCS = 50
#: 平均提升度的伪特征数（收缩量）
SHRINK_FEATURES = 6
#: “强线索”聚合取前几个特征
TOP_K = 5
#: 单个特征提升度截断（防止稀有特征一票定类）
LIFT_CLIP = 3.0


def features(up, down):
    """抽取一副对联的特征集合（去重）。

    参数：up 上联；down 下联
    返回：set，含单字与分句内二元组
    示例：features("春风", "秋月") -> {"春", "风", "春风", "秋", "月", "秋月"}
    """
    out = set()
    for line in (up, down):
        for seg in _SPLIT.split(line):
            out.update(seg)
            for i in range(len(seg) - 1):
                out.add(seg[i:i + 2])
    return out


class NaiveBayes:
    """弱监督朴素贝叶斯模型。

    示例：
        nb = NaiveBayes(classes)
        nb.fit(pairs, labels)   # labels[i] 为类名或 None
        nb.lifts(features(up, down))  # -> [每类平均提升度]
    """

    def __init__(self, classes):
        """参数：classes 类名列表（顺序即输出顺序）。"""
        #: 类名列表
        self.classes = list(classes)
        #: 特征 → 各类提升度元组
        self.weights = {}
        #: 各类训练文档数
        self.doc_counts = [0] * len(self.classes)

    def fit(self, pairs, labels):
        """在全量上统计背景频次，在带标签的文档上统计类频次。

        参数：pairs [(上联,下联)]；labels 与 pairs 等长，元素为类名或 None
        返回：self
        """
        index = {c: i for i, c in enumerate(self.classes)}
        background = Counter()
        per_class = [Counter() for _ in self.classes]
        for (up, down), lab in zip(pairs, labels):
            feats = features(up, down)
            background.update(feats)
            if lab is not None:
                k = index[lab]
                per_class[k].update(feats)
                self.doc_counts[k] += 1
        total = len(pairs)
        vocab = [f for f, n in background.items() if n >= MIN_FEATURE_COUNT]
        for f in vocab:
            p_bg = background[f] / total
            row = []
            for k in range(len(self.classes)):
                n_k = self.doc_counts[k]
                p = (per_class[k][f] + PSEUDO_DOCS * p_bg) / (n_k + PSEUDO_DOCS)
                lift = math.log(p / p_bg)
                row.append(max(-LIFT_CLIP, min(LIFT_CLIP, lift)))
            self.weights[f] = tuple(row)
        return self

    def lifts(self, feats):
        """计算各类的平均提升度（整体主题证据）。

        参数：feats 特征集合
        返回：list[float]，与 classes 对齐；无已知特征时全 0
        """
        return self.evidence(feats)[0]

    def evidence(self, feats):
        """同时返回两种聚合：收缩均值与最强 TOP_K 个特征的均值。

        收缩均值看整体主题；TOP_K 均值看“有没有几个强线索”，用于挽联这类检测任务。
        参数：feats 特征集合
        返回：(均值列表, top-k 列表)，均与 classes 对齐
        示例：mean, top = nb.evidence(features("音容宛在", "风范长存"))
        """
        w = self.weights
        rows = [w[f] for f in feats if f in w]
        k = len(self.classes)
        if not rows:
            return [0.0] * k, [0.0] * k
        n = len(rows)
        cols = list(zip(*rows))
        # 加伪特征数收缩：特征越少（短联）越向 0 靠拢，避免“面|容”这类两字联提升度虚高
        mean = [sum(c) / (n + SHRINK_FEATURES) for c in cols]
        # 不足 TOP_K 个特征时按 0 补齐，短联同样被收缩
        top = [sum(sorted(c, reverse=True)[:TOP_K]) / TOP_K for c in cols]
        return mean, top

    def top_features(self, cls, k=40, min_count=0):
        """列出某类提升度最高的特征，供人工审阅。

        参数：cls 类名；k 数量
        返回：[(特征, 提升度)]
        """
        j = self.classes.index(cls)
        items = sorted(self.weights.items(), key=lambda kv: -kv[1][j])
        return [(f, round(r[j], 2)) for f, r in items[:k]]
