"""对联分类与横批推导的单测（标准库 unittest）。

运行：python -I test_couplet.py
"""

import json
import os
import sys
import tempfile
import unittest
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import banner  # noqa: E402
import classify  # noqa: E402
import corpus  # noqa: E402
import derive  # noqa: E402
import evaluate  # noqa: E402
import lexicon  # noqa: E402
import nb  # noqa: E402

#: 测试用小语料（每类几条，足够训练出方向正确的提升度）
TOY = [
    ("爆竹声声辞旧岁", "梅花点点迎新春"), ("新春纳福家家乐", "旧岁迎祥户户欢"), ("春回大地千山秀", "福满人间万户春"),
    ("青山绿水风光好", "碧海蓝天景色新"), ("山清水秀花千树", "鸟语花香柳万条"), ("明月清风松竹影", "青山绿水鸟虫声"),
    ("音容宛在千秋仰", "风范长存万古哀"), ("驾鹤西归悲泪洒", "仙逝东去恸声哀"), ("噩耗传来天地泣", "英灵永驻日月悲"),
    ("书山有路勤为径", "学海无涯苦作舟"), ("桃李芬芳园丁乐", "杏坛春暖学子勤"),
    ("一壶浊酒诗千首", "半盏清茶墨几行"), ("挥毫泼墨书香远", "吟诗作对韵味长"),
    ("盘算", "月亏"),
]


class LexiconTest(unittest.TestCase):
    """词典匹配。"""

    @classmethod
    def setUpClass(cls):
        """加载真实词典。"""
        cls.lex = lexicon.Lexicon()

    def test_longest_match_suppresses_inner(self):
        """长词“千古风流”（中性）压掉其中的“千古”（挽联）。"""
        hits = self.lex.match("千古风流人物")
        self.assertIn("千古风流", hits)
        self.assertNotIn("千古", hits)
        scores, _ = self.lex.score("千古风流人物", "一时多少豪杰")
        self.assertEqual(scores.get("挽联", 0.0), 0.0)

    def test_both_lines_bonus(self):
        """两联都命中同类时得分有加成。"""
        one, _ = self.lex.score("新春大吉", "万事如意")
        both, _ = self.lex.score("新春大吉", "新岁平安")
        self.assertGreater(both["春节"], one["春节"])

    def test_classes_defined(self):
        """分类体系不超过 16 类，含挽联与通用。"""
        self.assertLessEqual(len(self.lex.classes), 16)
        self.assertIn("挽联", self.lex.classes)
        self.assertIn("通用", self.lex.classes)


class NaiveBayesTest(unittest.TestCase):
    """弱监督朴素贝叶斯。"""

    def test_features(self):
        """特征含单字与分句内二元组，不跨标点。"""
        f = nb.features("春风，秋月", "夏雨")
        self.assertIn("春风", f)
        self.assertNotIn("风秋", f)
        self.assertIn("夏雨", f)

    def test_lift_direction_and_shrink(self):
        """类专属特征提升度为正；短联（特征少）被收缩向 0。"""
        labels = ["春节", "春节", "春节", "山水", "山水", "山水", None, None, None, None, None, None, None, None]
        old = nb.MIN_FEATURE_COUNT
        nb.MIN_FEATURE_COUNT = 1
        try:
            m = nb.NaiveBayes(["春节", "山水"]).fit(TOY, labels)
        finally:
            nb.MIN_FEATURE_COUNT = old
        mean, top = m.evidence(nb.features("新春纳福", "旧岁迎祥"))
        self.assertGreater(mean[0], mean[1])
        self.assertGreater(top[0], 0)
        short_mean, _ = m.evidence({"春"})
        long_mean, _ = m.evidence(nb.features("新春纳福家家乐", "旧岁迎祥户户欢"))
        self.assertLess(abs(short_mean[0]), abs(long_mean[0]) + 1e-9)


class ClassifyTest(unittest.TestCase):
    """分类决策。"""

    @classmethod
    def setUpClass(cls):
        """用小语料训练一个模型（方向正确即可）。"""
        cls.lex = lexicon.Lexicon()
        old = nb.MIN_FEATURE_COUNT
        nb.MIN_FEATURE_COUNT = 1
        try:
            cls.model = classify.train(TOY, cls.lex)
        finally:
            nb.MIN_FEATURE_COUNT = old
        cls.clf = classify.Classifier(cls.lex, cls.model)

    def test_weak_label_threshold(self):
        """弱标签：首选分不足或领先不够则不打标签。"""
        self.assertEqual(classify.weak_label({"春节": 6.0, "山水": 1.0}), "春节")
        self.assertIsNone(classify.weak_label({"春节": 2.0}))
        self.assertIsNone(classify.weak_label({"春节": 4.0, "山水": 3.5}))

    def test_fallback_when_no_evidence(self):
        """无任何证据时回落通用。"""
        zero = [0.0] * len(classify.CLASSES)
        self.assertEqual(self.clf.decide({}, zero, zero)[0][0], classify.FALLBACK)

    def test_output_sorted_and_bounded(self):
        """输出 1~3 类、权重降序且在 0~1。"""
        cats = self.clf.predict("爆竹声声辞旧岁", "梅花点点迎新春")
        self.assertTrue(1 <= len(cats) <= classify.PARAMS["max_k"])
        ws = [w for _, w in cats]
        self.assertEqual(ws, sorted(ws, reverse=True))
        self.assertTrue(all(0 <= w <= 1 for w in ws))
        self.assertEqual(cats[0][0], "春节")

    def test_wan_strong_vetoes_festive(self):
        """命中强挽联词：挽联置首，且去掉喜庆类。"""
        cats = self.clf.predict("新春噩耗传千里", "驾鹤西归泪满襟")
        names = [c for c, _ in cats]
        self.assertEqual(names[0], "挽联")
        self.assertFalse(set(names) & classify.FESTIVE)

    def test_wan_strong_uses_single_word_not_sum(self):
        """强判定看单个最强挽联词，几个弱词累加不触发强判定。"""
        zero = [0.0] * len(classify.CLASSES)
        self.assertEqual(self.clf.wan_level({"挽联": 3.2, classify.WAN_MAX: 1.0}, zero), 0)
        self.assertEqual(self.clf.wan_level({"挽联": 3.0, classify.WAN_MAX: 3.0}, zero), 2)

    def test_wan_weak_is_secondary_tag(self):
        """弱判定：挽联作附加标签排在主题类之后，权重不超过首选。"""
        clf = classify.Classifier(self.lex, self.model, {"wan_thr": -1.0, "wan_thr_high": 99.0})
        cats = clf.predict("青山绿水风光好", "碧海蓝天景色新")
        names = [c for c, _ in cats]
        self.assertIn("挽联", names)
        self.assertNotEqual(names[0], "挽联")
        self.assertLessEqual(dict(cats)["挽联"], cats[0][1])

    def test_analyze_returns_guess(self):
        """analyze 返回分类、挽联等级与最佳猜测类。"""
        cats, level, guess = self.clf.analyze("青山绿水风光好", "碧海蓝天景色新")
        self.assertIn(level, (0, 1, 2))
        self.assertIn(guess, classify.CLASSES)
        self.assertNotEqual(guess, classify.WAN)


class BannerTest(unittest.TestCase):
    """横批选择。"""

    @classmethod
    def setUpClass(cls):
        """加载真实横批库，并在小语料上统计关联。"""
        cls.bp = banner.BannerPicker().fit_assoc(TOY * 5)

    def test_library_format(self):
        """横批库字数合规、每类都有节点、每类有短横批。"""
        with open(banner.BANNERS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        rules = {"b4": lambda s: len(s) == 4, "b2": lambda s: 2 <= len(s) <= 3, "bl": lambda s: 5 <= len(s) <= 7}
        classes = set(lexicon.Lexicon().classes)
        seen = set()
        for nd in data["nodes"]:
            self.assertIn(nd["cls"], classes, nd["id"])
            self.assertIn(nd["mood"], {"喜", "雅", "感", "庄", "励", "讽"}, nd["id"])
            for key, ok in rules.items():
                items = nd.get(key, "").split()
                self.assertEqual(len(items), len(set(items)), nd["id"] + key)
                for b in items:
                    self.assertTrue(ok(b), (nd["id"], key, b))
            seen.add(nd["cls"])
        self.assertEqual(seen, classes)
        for c in classes:
            self.assertTrue(any(nd["b2"] for nd in self.bp.by_cls[c]), c)

    def test_deterministic(self):
        """同一副对联每次结果相同（含新建选择器）。"""
        cats = [("山水", 0.95)]
        a = self.bp.pick("青山绿水风光好", "碧海蓝天景色新", cats)
        b = self.bp.pick("青山绿水风光好", "碧海蓝天景色新", cats)
        c = banner.BannerPicker().fit_assoc(TOY * 5).pick("青山绿水风光好", "碧海蓝天景色新", cats)
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_not_copy_couplet(self):
        """横批不得是对联里的原句片段。"""
        up, down = "春回大地，万象更新", "福满人间，五谷丰登"
        for i in range(30):
            b = self.bp.pick(up + "我" * (i % 3), down + "你" * (i % 3), [("春节", 1.0)])
            self.assertNotIn(b, up)
            self.assertNotIn(b, down)

    def test_season_conflict(self):
        """季节相反的横批被过滤。"""
        self.assertEqual(self.bp._weight("春暖花开", "秋风落叶", "寒露凝霜", set(), {"秋"}), 0.0)
        self.assertGreater(self.bp._weight("秋高气爽", "秋风落叶", "寒露凝霜", set(), {"秋"}), 0.0)

    def test_grounded_imagery(self):
        """含具体意象的横批，意象需在对联里有着落。"""
        text = "爆竹声声辞旧岁|梅花点点迎新春"
        ids = {self.bp.index[ch] for ch in text if ch in self.bp.index}
        self.assertFalse(self.bp.grounded("孤舟蓑笠", text, ids))
        self.assertTrue(self.bp.grounded("梅香雪韵", text, ids))
        self.assertTrue(self.bp.grounded("春意盎然", text, ids))

    def test_wan_strong_solemn(self):
        """挽联强判定只用挽联横批。"""
        lib = {b for nd in self.bp.by_cls["挽联"] for k in ("b4", "b2", "bl") for b in nd[k]}
        for i in range(20):
            b = self.bp.pick("音容宛在千秋仰" + "一" * (i % 4), "风范长存万古哀", [("挽联", 1.0)], wan_level=2)
            self.assertIn(b, lib)

    def test_wan_weak_avoids_joyful(self):
        """挽联弱判定：不用挽联横批，也不用喜庆/励志基调。"""
        bad = {b for nd in self.bp.nodes if nd["cls"] == "挽联" or nd["mood"] in ("喜", "励")
               for k in ("b4", "b2", "bl") for b in nd[k]}
        for i in range(20):
            b = self.bp.pick("江山如画英雄在" + "之" * (i % 4), "岁月峥嵘壮士归", [("家国", 0.9), ("挽联", 0.6)],
                             wan_level=1)
            self.assertNotIn(b, bad - {b2 for nd in self.bp.by_cls["家国"] if nd["mood"] in ("庄", "雅")
                                         for k in ("b4", "b2", "bl") for b2 in nd[k]})

    def test_length_policy(self):
        """短联优先 2~3 字；普通联四字；长联可出现 5~7 字。"""
        self.assertLessEqual(len(self.bp.pick("盘算", "月亏", [("通用", 0.9)])), 3)
        self.assertEqual(len(self.bp.pick("青山绿水风光好", "碧海蓝天景色新", [("山水", 0.95)])), 4)
        longs = set()
        for i in range(60):
            up = "盛世中华，国泰民安，处处欢歌笑语" + chr(0x4E00 + 7 * i)
            down = "神州大地，政通人和，家家幸福安康"
            longs.add(len(self.bp.pick(up, down, [("家国", 1.0)])))
        self.assertTrue(longs & {5, 6, 7})
        self.assertIn(4, longs)

    def test_dispersion(self):
        """同类大量对联里，单个横批不会过度集中。"""
        cnt = Counter()
        for i in range(600):
            cnt[self.bp.pick(f"青山绿水第{i}处", f"碧海蓝天{i}重景", [("山水", 0.95)])] += 1
        self.assertLess(cnt.most_common(1)[0][1] / 600, 0.15)
        self.assertGreater(len(cnt), 15)

    def test_fallback_uses_guess(self):
        """回落通用时可参考最佳猜测类挑横批。"""
        lib = {b for nd in self.bp.by_cls["文墨"] + self.bp.by_cls["通用"] for k in ("b4", "b2", "bl") for b in nd[k]}
        b = self.bp.pick("挥毫泼墨书香远", "吟诗作对韵味长", [("通用", 0.8)], guess="文墨")
        self.assertIn(b, lib)


class EvaluateTest(unittest.TestCase):
    """评估函数。"""

    def test_classify_metrics(self):
        """首选/任一/全部合理的计算。"""
        rows = [dict(id=1, cats=["春节"], stratum="随机"), dict(id=2, cats=["山水", "人生"], stratum="主山水")]
        preds = {1: [("春节", 1.0), ("山水", 0.5)], 2: [("文墨", 0.9), ("山水", 0.6)]}
        m = evaluate.classify_metrics(rows, preds)
        self.assertEqual((m["top1"], m["any"], m["all"]), (0.5, 1.0, 0.0))
        self.assertEqual(m["top1_random"], 1.0)

    def test_wan_metrics(self):
        """挽联召回与池精确率。"""
        rows = [dict(id=1, wan="是"), dict(id=2, wan="是"), dict(id=3, wan="否")]
        preds = {1: [("挽联", 1.0)], 2: [("人生", 0.9)], 3: [("挽联", 0.9)]}
        pool = {10: "是", 11: "否", 12: "疑"}
        pool_preds = {10: [("挽联", 1.0)], 11: [("挽联", 0.7)], 12: [("情感", 0.8)]}
        m = evaluate.wan_metrics(rows, preds, pool, pool_preds)
        self.assertEqual(m["gold_recall"], "1/2")
        self.assertEqual(m["missed"], [2])
        self.assertEqual(m["pool_precision_strict"], 0.5)

    def test_banner_metrics_pending(self):
        """横批变了旧判定失效，记为待判。"""
        rows = [dict(id=1), dict(id=2)]
        m = evaluate.banner_metrics(rows, {1: "春回大地", 2: "万象更新"}, {(1, "春回大地"): ("合格", ""),
                                                                    (2, "旧横批"): ("合格", "")})
        self.assertEqual((m["judged"], m["ok"], m["pending"]), (1, 1, [2]))


class EndToEndTest(unittest.TestCase):
    """端到端：小数据跑通并检查输出格式。"""

    def test_derive_small(self):
        """写临时数据，跑 derive，检查 TSV 四列与权重两位小数。"""
        with tempfile.TemporaryDirectory() as d:
            data = os.path.join(d, "data")
            out = os.path.join(d, "out")
            os.makedirs(data)
            pairs = TOY * 3
            with open(os.path.join(data, "in.txt"), "w", encoding="utf-8") as f:
                f.write("\n".join(" ".join(a) for a, _ in pairs) + "\n")
            with open(os.path.join(data, "out.txt"), "w", encoding="utf-8") as f:
                f.write("\n".join(" ".join(b) for _, b in pairs) + "\n")
            self.assertEqual(len(corpus.load_pairs(data)), len(TOY))
            derive.main(["--data", data, "--out", out])
            with open(os.path.join(out, "derived.tsv"), encoding="utf-8") as f:
                lines = f.read().splitlines()
            self.assertEqual(len(lines), len(TOY))
            for line in lines:
                up, down, b, cats = line.split("\t")
                self.assertTrue(b)
                for item in cats.split(","):
                    name, w = item.split(":")
                    self.assertRegex(w, r"^\d\.\d\d$")
            with open(os.path.join(out, "stats.json"), encoding="utf-8") as f:
                stats = json.load(f)
            self.assertEqual(stats["pairs"], len(TOY))


if __name__ == "__main__":
    unittest.main()
