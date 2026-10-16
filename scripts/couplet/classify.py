"""对联多分类：词典分 + 弱监督朴素贝叶斯提升度融合，带挽联专门判定。

流程：
1. 词典打分（lexicon.Lexicon），长词压短词消歧；
2. 用词典高置信结果当弱标签，在全量上训练朴素贝叶斯（nb.NaiveBayes）；
3. 每类综合分 z = 词典分 + BETA × 提升度 × 类偏置，换算成 0~1 权重；
4. 挽联单独判定：命中即置首、并去掉喜庆类；
5. 都不达阈值则回落“通用”。
"""

import math

import lexicon
import nb

#: 参与打分的类（不含通用）
CLASSES = ["春节", "节庆", "婚庆", "祝寿", "乔迁", "开业", "学业", "事业",
           "家国", "山水", "人生", "情感", "文墨", "怀古", "挽联"]
#: 回落类
FALLBACK = "通用"
#: 挽联
WAN = "挽联"
#: 挽联在 CLASSES 中的下标
WAN_INDEX = CLASSES.index(WAN)
#: 证据字典里“挽联最强单词权重”的键
WAN_MAX = "_挽联最强词"
#: 遇挽联时要去掉的喜庆类
FESTIVE = {"春节", "节庆", "婚庆", "祝寿", "乔迁", "开业"}

#: 默认参数（在 dev 上调定，见 README）
PARAMS = {
    "weak_min": 3.0,      # 弱标签：词典首选分下限
    "weak_ratio": 1.5,    # 弱标签：首选分 ≥ 次选分 × 该倍数
    "beta": 16.0,          # 提升度换算到词典分的系数
    "scale": 1.5,         # 权重换算：w = 1 - exp(-z/scale)
    "theta": 0.30,        # 首选类最低权重，低于则回落通用
    "theta2": 0.60,       # 次选类最低权重
    "ratio2": 0.40,       # 次选类综合分须 ≥ 首个主题类综合分 × 该比例
    "max_k": 3,           # 最多输出几类
    "beta_top": 0.0,      # top-k 提升度的系数（主题类）
    "wan_strong": 3.0,    # 挽联：命中单个权重达到此值的挽联词即强判定
    "wan_cap": 2.0,       # 挽联综合分里词典分的封顶
    "wan_gamma": 2.0,     # 挽联综合分 = min(词典分, cap) + gamma × top-k 提升度
    "wan_thr": 4.5,       # 挽联综合分门槛（弱判定：挽联作为附加标签）
    "wan_thr_high": 6.5,  # 挽联综合分高门槛（强判定：挽联置首）
    "wan_min_w": 0.6,     # 判为挽联后的最低权重
    "self_train_rounds": 0,   # 自训练轮数
    "self_train_min_w": 0.9,  # 自训练：首选权重下限
    "self_train_margin": 0.9, # 自训练：次选权重须 < 首选 × 该值
}
#: 各类提升度偏置（乘在 beta 上，用于抑制泛滥的大类）
CLASS_BIAS = {c: 1.0 for c in CLASSES}


def weak_label(scores, params=PARAMS):
    """由词典得分给出弱标签。

    参数：scores {类: 词典分}；params 参数
    返回：类名或 None
    示例：weak_label({"春节": 6.0, "山水": 1.0}) -> "春节"
    """
    if not scores:
        return None
    items = sorted(scores.items(), key=lambda kv: -kv[1])
    top, v = items[0]
    second = items[1][1] if len(items) > 1 else 0.0
    if v >= params["weak_min"] and v >= params["weak_ratio"] * second:
        return top
    return None


def train(pairs, lex, params=PARAMS, rounds=None, log=None):
    """在全量语料上训练弱监督朴素贝叶斯，可做若干轮自训练。

    第 1 轮用词典弱标签；之后每轮用“词典 + 上一轮模型”的高置信首选作标签重训。
    参数：pairs [(上联,下联)]；lex 词典；rounds 自训练轮数（None 取参数）；log 进度回调
    返回：nb.NaiveBayes
    """
    p = dict(PARAMS, **params)
    rounds = int(p["self_train_rounds"] if rounds is None else rounds)
    labels = [weak_label(lex.score(a, b)[0], p) for a, b in pairs]
    model = nb.NaiveBayes(CLASSES).fit(pairs, labels)
    for r in range(rounds):
        clf = Classifier(lex, model, p)
        labels = [clf.confident_label(a, b) for a, b in pairs]
        if log:
            log(f"自训练第 {r + 1} 轮，标签数 {sum(x is not None for x in labels)}")
        model = nb.NaiveBayes(CLASSES).fit(pairs, labels)
    return model


def to_weight(z, scale):
    """把综合分换算成 0~1 权重。"""
    return 1.0 - math.exp(-max(z, 0.0) / scale)


class Classifier:
    """对联分类器。

    参数：lex 词典；model 训练好的朴素贝叶斯；params 参数；bias 类偏置
    示例：
        clf = Classifier(lex, model)
        clf.predict("爆竹声声辞旧岁", "梅花点点迎新春")  # -> [("春节", 0.98)]
    """

    def __init__(self, lex, model, params=None, bias=None):
        """保存依赖与参数。"""
        self.lex = lex
        self.model = model
        self.params = dict(PARAMS, **(params or {}))
        self.bias = dict(CLASS_BIAS, **(bias or {}))

    def evidence(self, up, down):
        """返回 (词典分, 均值提升度, top-k 提升度)，供调试与评估。

        词典分里额外放入 "_挽联最强词"：命中的挽联词中单个最高权重，用于强判定。
        """
        scores, words = self.lex.score(up, down)
        best = max((self.lex.table[wd].get(WAN, 0.0) for wd in words), default=0.0)
        if best:
            scores[WAN_MAX] = best
        mean, top = self.model.evidence(nb.features(up, down))
        return scores, mean, top

    def predict(self, up, down):
        """预测分类与权重。

        参数：up 上联；down 下联
        返回：[(类, 权重)]，按权重降序；回落时为 [("通用", 权重)]
        示例：predict("爆竹声声辞旧岁", "梅花点点迎新春") -> [("春节", 1.0)]
        """
        return self.decide(*self.evidence(up, down))

    def analyze(self, up, down):
        """预测分类，并给出横批选择要用的挽联判定等级与最佳猜测类。

        返回：([(类, 权重)], 挽联等级 0/1/2, 最佳猜测类)
        示例：cats, level, guess = clf.analyze("盘算", "月亏")
        """
        scores, mean, top = self.evidence(up, down)
        return self.decide(scores, mean, top), self.wan_level(scores, top), self.guess(scores, mean, top)

    def guess(self, scores, mean, top):
        """综合分最高的非挽联类（不看阈值），供回落通用时挑横批参考。"""
        zv = self.zvector(scores, mean, top)
        best = max((v, -i) for i, v in enumerate(zv) if CLASSES[i] != WAN)
        return CLASSES[-best[1]]

    def wan_level(self, scores, top):
        """挽联判定等级：2=强（挽联置首），1=弱（挽联作附加标签），0=否。

        综合分 = min(词典分, cap) + gamma × top-k 提升度；词典命中强词直接按强判定。
        """
        p = self.params
        s = scores.get(WAN, 0.0)
        if scores.get(WAN_MAX, 0.0) >= p["wan_strong"]:
            return 2
        v = min(s, p["wan_cap"]) + p["wan_gamma"] * top[WAN_INDEX]
        if v >= p["wan_thr_high"]:
            return 2
        return 1 if v >= p["wan_thr"] else 0

    def confident_label(self, up, down):
        """自训练用：返回高置信首选类，否则 None。"""
        pred = self.predict(up, down)
        c, w = pred[0]
        if c == FALLBACK or w < self.params["self_train_min_w"]:
            return None
        if c == WAN and self.wan_level(*self._wan_args(up, down)) < 2:
            return None
        if len(pred) > 1 and pred[1][1] >= w * self.params["self_train_margin"]:
            return None
        return c

    def _wan_args(self, up, down):
        """取挽联判定需要的证据。"""
        scores, _, top = self.evidence(up, down)
        return scores, top

    def zvector(self, scores, mean, top):
        """各类综合分 z（列表，与 CLASSES 对齐）。"""
        p = self.params
        return [scores.get(c, 0.0) + self.bias[c] * (p["beta"] * mean[i] + p["beta_top"] * top[i])
                for i, c in enumerate(CLASSES)]

    def decide(self, scores, mean, top):
        """根据证据做决策（与 predict 分开，便于调参时复用证据）。"""
        p = self.params
        z = dict(zip(CLASSES, self.zvector(scores, mean, top)))
        w = {c: to_weight(v, p["scale"]) for c, v in z.items()}
        ranked = sorted(w.items(), key=lambda kv: (-kv[1], CLASSES.index(kv[0])))

        level = self.wan_level(scores, top)
        if level:
            ranked = [(c, v) for c, v in ranked if c not in FESTIVE and c != WAN]
        else:
            ranked = [(c, v) for c, v in ranked if c != WAN]
        out = []
        if level == 2 or (level == 1 and (not ranked or ranked[0][1] < p["theta"])):
            out.append((WAN, max(w[WAN], p["wan_min_w"])))
        elif ranked and ranked[0][1] >= p["theta"]:
            out.append(ranked.pop(0))
            if level == 1:
                # 弱判定：挽联排第二，权重不超过首选
                out.append((WAN, min(out[0][1], max(w[WAN], p["wan_min_w"]))))
        else:
            return [(FALLBACK, round(1.0 - (ranked[0][1] if ranked else 0.0), 2))]
        # 次选：综合分须达到首个主题类综合分的 ratio2 倍；权重按综合分比例折算
        lead = next((c for c, _ in out if c != WAN), None)
        lead_z = z[lead] if lead else max(z[WAN], 1e-9)
        lead_w = out[0][1]
        for c, v in ranked:
            if len(out) >= p["max_k"]:
                break
            if c in dict(out):
                continue
            if v >= p["theta2"] and z[c] >= p["ratio2"] * lead_z:
                out.append((c, min(v, lead_w * z[c] / lead_z)))
        return [(c, round(v, 2)) for c, v in out]
