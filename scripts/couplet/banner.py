"""推荐横批选择（确定性、可分散）。

思路：
1. 候选节点 = 预测分类下的场景节点；节点分 = 类权重 × NODE_CLASS_W + 触发词命中分（封顶）；
2. 取得分接近最高的节点合并为候选池；按基调、季节、字数过滤；
3. 候选横批按“与对联共享的实义字”加权，再用对联文本的哈希做加权抽取。
同一副对联输入相同则结果相同；不依赖全库计数，分散度由节点与候选数量保证。
"""

import hashlib
import json
import math
import os
from collections import Counter

#: 横批库路径
BANNERS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "banners.json")
#: 节点分中类权重的系数
NODE_CLASS_W = 2.0
#: 无触发词的通用节点的基础触发分（略高于单字命中，单个泛字不足以离开通用节点）
GENERIC_TRIGGER = 0.7
#: 单字触发词命中分 / 多字触发词命中分 / 触发分封顶
TRIG_CHAR, TRIG_WORD, TRIG_CAP = 0.8, 1.2, 3.0
#: 首选类权重低于此值时，让“通用”评点式横批参与竞争（权重 = 该值 - 首选权重）
UNSURE_W = 0.9
#: 回落通用时，最佳猜测类的权重（其余给评点式通用横批）
GUESS_W = 0.6
#: 感伤对联对“感”基调节点的加分
SAD_BONUS = 1.0
#: 与最高节点分相差在此范围内的节点并入候选池
NODE_BAND = 0.3
#: 短联阈值（每联最长字数 ≤ 此值时优先 2~3 字横批）
SHORT_MAX = 3
#: 长联阈值（每联最长字数 ≥ 此值时允许 5~7 字横批）
LONG_MIN = 16
#: 长联里选用长横批的比例（百分比，按哈希决定）
LONG_PERCENT = 35
#: 判为“感伤”需要的命中数
SAD_MIN = 2
#: 感伤线索（命中一个计 1）
SAD_WORDS = ("愁 泪 悲 哀 恨 怨 寂寞 孤 凄 惆怅 断肠 憔悴 落寞 寥 残 殇 痛 哭 伤 叹 瘦 病 死 亡 别 离 苦 憾 怅 "
             "凉 泣 萧 衰 败 枯 空 寒 冷 落").split()
#: 感伤时排除的基调
SAD_EXCLUDE = {"喜", "励"}
#: 挽联弱判定时允许的基调
SOLEMN_ALLOW = {"雅", "感", "庄", "讽"}
#: 共享字统计时忽略的虚字/数字
STOP_CHARS = set("之一不人有无而其以于为是在也的了千万百十三两二四五六七八九大小上下中天地年日月何此彼何谁我你他")
#: 判断“与对联重合过半”时忽略的虚字
OVERLAP_IGNORE = set("之一不而其以于为是也的了")
#: 季节字
SEASONS = {"春": "春", "夏": "夏暑炎", "秋": "秋", "冬": "冬腊"}
#: 意象关联：共现次数下限、PMI 封顶、横批字与对联字相同时的关联分、抽取权重的指数系数
ASSOC_MIN_COUNT, ASSOC_CAP, ASSOC_SAME, ASSOC_LAMBDA = 5, 4.0, 2.0, 0.6
#: 具体意象字：横批含这些字时，至少一半要在对联里出现（或与对联用字强关联），否则不选
IMAGERY = set("山峰岭岩崖峦江河湖海溪泉瀑潭波涛浪潮舟帆船桥亭楼阁窗灯烛云霞雾烟虹雨雪霜露冰"
              "月星夕晓夜花草树林竹松柏梅兰菊荷莲桃李杏柳枫桂梧桐蕉稻麦谷禾田茶酒琴棋画剑纸"
              "鹤雁燕莺鹊鸥鹭蝶蜂蝉鱼鸟凤鸾鸳鸯笛箫弦鼓钟塔寺舸楫棹蓑笠鸿鸦猿鹿")
#: 意象字视为“落地”的关联下限（PMI）
IMAGERY_ASSOC = 2.5


def _hash(text):
    """返回文本的稳定整数哈希（md5，跨进程一致）。"""
    return int(hashlib.md5(text.encode("utf-8")).hexdigest(), 16)


def seasons_of(text):
    """文本涉及的季节集合。

    参数：text 文本
    返回：set，如 {"秋"}
    示例：seasons_of("秋风落叶") -> {"秋"}
    """
    return {s for s, chars in SEASONS.items() if any(ch in text for ch in chars)}


def is_sad(text):
    """是否感伤基调（命中感伤线索 ≥ SAD_MIN）。

    参数：text 上下联拼接文本
    返回：bool
    """
    return sum(1 for w in SAD_WORDS if w in text) >= SAD_MIN


class BannerPicker:
    """横批选择器。

    参数：path 横批库 JSON 路径
    示例：
        bp = BannerPicker()
        bp.pick("爆竹声声辞旧岁", "梅花点点迎新春", [("春节", 0.98)])  # -> "辞旧迎新" 之类
    """

    def __init__(self, path=BANNERS_PATH):
        """读取横批库。"""
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        #: 节点列表
        self.nodes = []
        for nd in data["nodes"]:
            self.nodes.append(dict(
                id=nd["id"], cls=nd["cls"], mood=nd["mood"],
                trig=[self._parse_trig(x) for x in nd.get("trig", "").split()],
                min_hits=nd.get("min_hits", 1),
                b4=nd.get("b4", "").split(), b2=nd.get("b2", "").split(), bl=nd.get("bl", "").split()))
        #: 类 → 节点列表
        self.by_cls = {}
        for nd in self.nodes:
            self.by_cls.setdefault(nd["cls"], []).append(nd)
        #: 横批库实义字表（意象关联只在这些字之间统计）
        self.vocab = sorted({ch for nd in self.nodes for key in ("b4", "b2", "bl")
                             for b in nd[key] for ch in b} - STOP_CHARS)
        #: 字 → 下标
        self.index = {ch: i for i, ch in enumerate(self.vocab)}
        #: 字下标 → {相关字下标: PMI}；未调用 fit_assoc 时为空，关联分为 0
        self.assoc = {}

    def fit_assoc(self, pairs):
        """在语料上统计横批用字之间的共现 PMI（同一副对联内共现）。

        参数：pairs [(上联,下联)]
        返回：self
        示例：bp.fit_assoc(corpus.load_pairs())
        """
        index = self.index
        k = len(self.vocab)
        single = Counter()
        joint = Counter()
        for up, down in pairs:
            ids = sorted({index[ch] for ch in up + down if ch in index})
            single.update(ids)
            for a in range(len(ids)):
                base = ids[a] * k
                for b in range(a + 1, len(ids)):
                    joint[base + ids[b]] += 1
        n = len(pairs)
        neighbors = {}
        for key, c in joint.items():
            if c < ASSOC_MIN_COUNT:
                continue
            a, b = divmod(key, k)
            pmi = math.log(n * c / (single[a] * single[b]))
            if pmi > 0:
                v = min(pmi, ASSOC_CAP)
                neighbors.setdefault(a, {})[b] = v
                neighbors.setdefault(b, {})[a] = v
        self.assoc = neighbors
        return self

    def _char_assoc(self, ch, text_ids, cache):
        """横批某字与对联用字的最大关联（对联里出现过记 ASSOC_SAME）；单次对联内缓存。"""
        v = cache.get(ch)
        if v is not None:
            return v
        i = self.index.get(ch)
        if i is None:
            v = 0.0
        elif i in text_ids:
            v = ASSOC_SAME
        else:
            nb = self.assoc.get(i)
            v = max((nb.get(j, 0.0) for j in text_ids), default=0.0) if nb else 0.0
        cache[ch] = v
        return v

    def grounded(self, banner, text, text_ids, cache=None):
        """横批的具体意象是否在对联里有着落。

        参数：banner 横批；text 对联文本；text_ids 对联实义字下标集合；cache 单次对联内缓存
        返回：bool；不含具体意象字的横批恒为 True
        示例：grounded("孤舟蓑笠", "断桥残雪西湖景|瀚海孤鸿溯漠情", ids) -> False
        """
        imgs = [ch for ch in set(banner) if ch in IMAGERY]
        if not imgs:
            return True
        cache = {} if cache is None else cache
        ok = sum(1 for ch in imgs if ch in text or self._char_assoc(ch, text_ids, cache) >= IMAGERY_ASSOC)
        return ok * 2 >= len(imgs)

    def relevance(self, banner, text_ids, cache=None):
        """横批与对联的意象关联分：横批各字与对联用字最大关联的平均。

        参数：banner 横批；text_ids 对联实义字下标集合；cache 单次对联内缓存
        返回：float，≥0
        """
        cache = {} if cache is None else cache
        return sum(self._char_assoc(ch, text_ids, cache) for ch in banner) / len(banner)

    @staticmethod
    def _parse_trig(token):
        """解析触发词，支持“词:权重”写法；默认单字 TRIG_CHAR、多字 TRIG_WORD。"""
        if ":" in token:
            word, w = token.split(":", 1)
            return word, float(w)
        return token, (TRIG_CHAR if len(token) == 1 else TRIG_WORD)

    def node_scores(self, text, cats, solemn, sad):
        """计算候选节点分。

        参数：text 上下联拼接；cats [(类, 权重)]；solemn 是否挽联弱判定；sad 是否感伤
        返回：[(分, 节点)]，按分降序
        """
        out = []
        for cls, w in cats:
            for nd in self.by_cls.get(cls, []):
                if solemn and (cls == "挽联" or nd["mood"] not in SOLEMN_ALLOW):
                    continue  # 弱判定不确定是否挽联：不用挽联横批，主题横批也只取庄重/雅致/感怀
                if sad and nd["mood"] in SAD_EXCLUDE:
                    continue
                if nd["trig"]:
                    hits = [w for x, w in nd["trig"] if x in text]
                    if len(hits) < nd["min_hits"]:
                        continue
                    t = min(sum(hits), TRIG_CAP)
                else:
                    t = GENERIC_TRIGGER
                if sad and nd["mood"] == "感":
                    t += SAD_BONUS
                out.append((w * NODE_CLASS_W + t, nd))
        out.sort(key=lambda x: -x[0])
        return out

    def pick(self, up, down, cats, wan_level=0, guess=None):
        """为一副对联挑选推荐横批。

        参数：up 上联；down 下联；cats 分类结果 [(类, 权重)]；wan_level 挽联判定等级（2 强 1 弱 0 否）；
              guess 分类回落“通用”时统计模型的最佳猜测类（可选），与评点式横批并列竞争
        返回：横批字符串（保证非空）
        示例：pick("天增岁月人增寿", "春满乾坤福满门", [("春节", 0.99)]) -> 如 "五福临门"
        """
        text = up + "|" + down
        h = _hash(text)
        if cats and cats[0][0] == "通用" and guess and guess != "挽联":
            cats = [(guess, GUESS_W), ("通用", 1.0 - GUESS_W)]
        if wan_level == 2 or (cats and cats[0][0] == "挽联"):
            cats = [("挽联", 1.0)]
        elif cats and cats[0][0] != "通用" and cats[0][1] < UNSURE_W:
            cats = list(cats) + [("通用", UNSURE_W - cats[0][1])]
        solemn = wan_level == 1
        sad = is_sad(text)
        scored = self.node_scores(text, cats, solemn, sad)
        if not scored and solemn:
            scored = self.node_scores(text, [("挽联", 1.0)], False, False)
        if not scored:
            scored = self.node_scores(text, [("通用", 1.0)], False, False)
        best = scored[0][0]
        pool = [nd for s, nd in scored if s >= best - NODE_BAND]

        n = max(len(up), len(down))
        if n <= SHORT_MAX:
            key_order = ("b2", "b4")
        elif n >= LONG_MIN and h % 100 < LONG_PERCENT:
            key_order = ("bl", "b4")
        else:
            key_order = ("b4",)
        seasons = seasons_of(text)
        chars = set(text) - STOP_CHARS
        text_ids = {self.index[ch] for ch in chars if ch in self.index}
        cache = {}
        for key in key_order:
            cands = []
            seen = set()
            for nd in pool:
                for b in nd[key]:
                    if b in seen:
                        continue
                    seen.add(b)
                    weight = self._weight(b, up, down, chars, seasons)
                    if weight > 0 and not self.grounded(b, text, text_ids, cache):
                        weight = 0.0
                    if weight > 0:
                        if self.assoc:
                            weight *= math.exp(ASSOC_LAMBDA * self.relevance(b, text_ids, cache))
                        cands.append((b, weight))
            if cands:
                return self._draw(cands, h >> 20)
        # 兜底：通用节点四字
        fallback = [(b, 1.0) for b in self.by_cls["通用"][0]["b4"]]
        return self._draw(fallback, h >> 20)

    @staticmethod
    def _weight(banner, up, down, chars, seasons):
        """横批候选权重；返回 0 表示过滤掉。"""
        if banner in up or banner in down:
            return 0.0  # 不得整句照搬上下联
        bs = seasons_of(banner)
        if bs and seasons and not (bs & seasons):
            return 0.0  # 季节相反
        shared = len(set(banner) & (set(up) | set(down)) - OVERLAP_IGNORE)
        if shared > len(banner) // 2:
            return 0.0  # 与对联重合过半，近于重复
        return 1.0

    @staticmethod
    def _draw(cands, h):
        """按权重用哈希确定性抽取。"""
        cands.sort()
        total = sum(w for _, w in cands)
        x = (h % 1000003) / 1000003 * total
        acc = 0.0
        for b, w in cands:
            acc += w
            if x < acc:
                return b
        return cands[-1][0]
