"""分类词典的加载与匹配。

匹配规则：每个起点只取最长词条；若它被前面起点的更长词条完全覆盖则丢弃。
这样“千古风流”（中性）会压掉其中的“千古”（挽联），实现靠长词消歧。
"""

import json
import os

#: 词典默认路径
LEXICON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lexicon.json")
#: 中性组名（只用于压制，不计分）
NEUTRAL = "_中性"
#: 两联都有命中时的加成系数
BOTH_LINES_BONUS = 1.25


class Lexicon:
    """分类词典。

    参数：path 词典 JSON 路径
    示例：lex = Lexicon(); lex.score("新春大吉", "福满人间")
    """

    def __init__(self, path=LEXICON_PATH):
        """读取词典并建立 词→{类: 权重} 表。"""
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        #: 类名 → 定义
        self.classes = data["classes"]
        #: 词 → {类: 权重}
        self.table = {}
        for cls, groups in data["lexicon"].items():
            for weight, words in groups.items():
                for word in words.split():
                    entry = self.table.setdefault(word, {})
                    if cls != NEUTRAL:
                        entry[cls] = max(entry.get(cls, 0.0), float(weight))
        #: 最长词条长度
        self.max_len = max(len(w) for w in self.table)

    def match(self, text):
        """返回保留下来的命中词列表（按出现顺序，可重复）。

        参数：text 一联文本
        返回：[词, ...]
        示例：lex.match("千古风流人物") -> ["千古风流", "人物"?]
        """
        n = len(text)
        table = self.table
        hits = []
        reach = 0  # 前面起点的最远结束位置
        for i in range(n):
            best = 0
            for size in range(min(self.max_len, n - i), 0, -1):
                if text[i:i + size] in table:
                    best = size
                    break
            if best and i + best > reach:
                hits.append(text[i:i + best])
                reach = i + best
        return hits

    def score(self, up, down):
        """计算各类词典得分。

        参数：up 上联；down 下联
        返回：(得分字典 {类: 分}, 命中词集合)
        示例：scores, words = lex.score("红烛高照", "喜结良缘")
        """
        per_line = []
        words = set()
        for line in (up, down):
            got = {}
            for word in set(self.match(line)):
                words.add(word)
                for cls, w in self.table[word].items():
                    got[cls] = got.get(cls, 0.0) + w
            per_line.append(got)
        scores = {}
        a, b = per_line
        for cls in set(a) | set(b):
            s = a.get(cls, 0.0) + b.get(cls, 0.0)
            if cls in a and cls in b:
                s *= BOTH_LINES_BONUS
            scores[cls] = s
        return scores, words
