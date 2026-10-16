# -*- coding: utf-8 -*-
"""derive.py / build_lexicon.py 的单元测试（标准库 unittest）。

运行：python -I scripts/couplet/test_derive.py
"""

import collections
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import build_lexicon  # noqa: E402
import derive  # noqa: E402

RICH_CHARS = "喜吉福庆春财贺乐寿婚"  # 挽联横批不得含的喜庆字


def make_lexicon(tmpdir, categories, threshold=0.35, max_cats=3, blacklist=(), veto=None):
    """写一个临时词典文件并返回路径。

    参数:
        tmpdir: 临时目录。
        categories: {分类: {"seeds": {...}, "mined": {...}}}。
        threshold: 分类阈值。
        max_cats: 最多分类数。
        blacklist: 黑名单词。
        veto: 否决规则，缺省为挽联否决。
    返回:
        词典文件路径。
    """
    data = {
        "threshold": threshold,
        "max_cats": max_cats,
        "veto": veto or {"trigger": "挽联", "min_weight": 0.7, "keep": ["挽联", "人生"]},
        "blacklist": list(blacklist),
        "categories": {c: {"seeds": v.get("seeds", {}), "mined": v.get("mined", {})}
                       for c, v in categories.items()},
    }
    path = os.path.join(tmpdir, "lexicon.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return path


def make_banners(tmpdir, data):
    """写一个临时横批库并返回路径。

    参数:
        tmpdir: 临时目录。
        data: {分类: [横批]}。
    返回:
        横批库文件路径。
    """
    path = os.path.join(tmpdir, "banners.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    return path


class TextHelpersTest(unittest.TestCase):
    """清洗与汉字过滤。"""

    def test_clean_removes_all_spaces_and_bom(self):
        """clean 去掉全部空白与 BOM。"""
        self.assertEqual(derive.clean("﻿晚 风 摇\t树 \n"), "晚风摇树")

    def test_cjk_keeps_only_han_characters(self):
        """cjk 只保留汉字，标点与字母被丢弃。"""
        self.assertEqual(derive.cjk("风，雨abc！树"), "风雨树")


class DatasetTest(unittest.TestCase):
    """流式读取、去重与试跑上限。"""

    def setUp(self):
        """建立含重复与空行的临时数据集。"""
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "in.txt"), "w", encoding="utf-8") as f:
            f.write("晚 风 摇 树\n\n晚 风 摇 树\n春 满 园\n")
        with open(os.path.join(self.dir, "out.txt"), "w", encoding="utf-8") as f:
            f.write("燕 语 呢 喃\n空 行 对 应\n燕 语 呢 喃\n花 满 枝\n")

    def tearDown(self):
        """删除临时目录。"""
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_unique_pairs_dedupes_and_skips_empty(self):
        """去重后只剩两对（空行与重复对被跳过）。"""
        pairs = list(derive.unique_pairs(self.dir))
        self.assertEqual(pairs, [("晚风摇树", "燕语呢喃"), ("春满园", "花满枝")])

    def test_unique_pairs_respects_limit(self):
        """limit 只产出前 N 对去重后的结果。"""
        self.assertEqual(list(derive.unique_pairs(self.dir, limit=1)), [("晚风摇树", "燕语呢喃")])


class LexiconScoringTest(unittest.TestCase):
    """多分类打分、阈值、类数上限、挽联否决。"""

    def setUp(self):
        """建立临时词典目录。"""
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        """删除临时目录。"""
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_threshold_drops_weak_category(self):
        """单个 0.4 权重词得分 0.33 低于阈值 0.35，回落到通用。"""
        path = make_lexicon(self.dir, {"A": {"seeds": {"甲": 1.0}}, "B": {"seeds": {"乙": 0.4}}})
        score = derive.score_pair(derive.Lexicon(path), "甲甲", "乙丙")
        self.assertEqual(score.cats, [("A", round(1 - math.exp(-1.0), 3))])

    def test_weak_only_falls_back_to_general(self):
        """只命中弱词时归入通用，权重为回落权重。"""
        path = make_lexicon(self.dir, {"B": {"seeds": {"乙": 0.4}}, "通用": {}})
        score = derive.score_pair(derive.Lexicon(path), "乙丙", "丁戊")
        self.assertEqual(score.cats, [(derive.FALLBACK_CAT, derive.FALLBACK_WEIGHT)])

    def test_distinct_terms_accumulate(self):
        """两个不同的 0.4 词累计 0.8，过阈值；同一词重复出现只计一次。"""
        path = make_lexicon(self.dir, {"B": {"seeds": {"乙": 0.4, "丙": 0.4}}})
        lex = derive.Lexicon(path)
        self.assertEqual([c for c, _ in derive.score_pair(lex, "乙丙", "乙").cats], ["B"])
        self.assertEqual(derive.score_pair(lex, "乙乙乙", "乙").cats[0][0], derive.FALLBACK_CAT)

    def test_max_cats_keeps_top_by_weight(self):
        """超过 max_cats 时只保留权重最高的前 max_cats 个，且降序。"""
        cats = {c: {"seeds": {t: 1.0}} for c, t in (("A", "甲"), ("B", "乙"), ("C", "丙"), ("D", "丁"))}
        path = make_lexicon(self.dir, cats, max_cats=3)
        score = derive.score_pair(derive.Lexicon(path), "甲乙丙丁", "")
        self.assertEqual(len(score.cats), 3)
        weights = [w for _, w in score.cats]
        self.assertEqual(weights, sorted(weights, reverse=True))

    def test_mourning_veto_removes_festive_categories(self):
        """命中挽联强词时，喜庆类被去掉，挽联保留且权重不低于 0.8。"""
        path = make_lexicon(self.dir, {
            "春节": {"seeds": {"新春": 1.0}},
            "挽联": {"seeds": {"哀": 1.0}},
            "人生": {"seeds": {"修身": 1.0}},
        })
        score = derive.score_pair(derive.Lexicon(path), "新春哀思", "修身")
        self.assertTrue(score.vetoed)
        cats = dict(score.cats)
        self.assertNotIn("春节", cats)
        self.assertIn("挽联", cats)
        self.assertGreaterEqual(cats["挽联"], 0.8)
        self.assertIn("人生", cats)

    def test_blacklist_term_is_not_indexed(self):
        """黑名单中的词不参与匹配。"""
        path = make_lexicon(self.dir, {"A": {"seeds": {"甲": 1.0}, "mined": {"甲乙": 0.9}}},
                            blacklist=["甲乙"])
        lex = derive.Lexicon(path)
        self.assertNotIn("甲乙", lex.index)
        self.assertIn("甲", lex.index)


class LengthRuleTest(unittest.TestCase):
    """横批字数规则（确定性，纯函数）。"""

    def test_four_chars_always_allowed(self):
        """任何情况下四字都在允许档内。"""
        self.assertIn(derive.PREFERRED_LEN, derive.length_rules(9, 0.0, {"甲乙丙"}))

    def test_short_only_for_short_and_simple_couplet(self):
        """上下联不超过 4 字且命中词不超过 1 个时才允许 2~3 字。"""
        self.assertEqual(sorted(derive.length_rules(4, 0.9, {"甲"})), [2, 3, 4])
        self.assertEqual(sorted(derive.length_rules(4, 0.9, {"甲", "乙"})), [4])
        self.assertEqual(sorted(derive.length_rules(5, 0.9, {"甲"})), [4])

    def test_long_when_four_char_misfit(self):
        """四字最佳得分低于 0.6 且上下联最长不少于 5 字时允许 5~7 字，原因为四字不贴合。"""
        allowed = derive.length_rules(5, 0.5, set())
        self.assertEqual(allowed[5], derive.RULE_LONG_MISFIT)
        self.assertEqual(sorted(k for k in allowed if k >= 5), [5, 6, 7])

    def test_long_when_long_phrase_hit(self):
        """上下联最长不少于 6 字且有 3 字以上命中词时允许长横批，原因为长短语。"""
        allowed = derive.length_rules(6, 0.9, {"百年好合"})
        self.assertEqual(allowed[7], derive.RULE_LONG_PHRASE)
        self.assertNotIn(5, derive.length_rules(5, 0.9, {"百年好合"}))


class BannerBankTest(unittest.TestCase):
    """横批库校验。"""

    def setUp(self):
        """建立临时目录。"""
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        """删除临时目录。"""
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_accepts_two_to_seven_chars_and_skips_comment_keys(self):
        """2~7 字的横批通过校验，下划线开头的说明键被跳过。"""
        path = make_banners(self.dir, {"_说明": "注释", "A": ["一二", "一二三", "一二三四五六七"]})
        bank = derive.BannerBank(path)
        self.assertEqual(bank.home["一二三四五六七"], "A")
        self.assertNotIn("_说明", bank.banners)

    def test_rejects_bad_length_nonhan_and_duplicates(self):
        """1 字、8 字、含非汉字、全库重复都会报错。"""
        for bad in (["一"], ["一二三四五六七八"], ["一二三a"]):
            path = make_banners(self.dir, {"A": bad})
            with self.assertRaises(ValueError):
                derive.BannerBank(path)
        path = make_banners(self.dir, {"A": ["一二三四"], "B": ["一二三四"]})
        with self.assertRaises(ValueError):
            derive.BannerBank(path)


class PickBannerTest(unittest.TestCase):
    """横批选择：四字优先、重叠过滤、上限分散、长横批条件、确定性。"""

    def setUp(self):
        """建立一个只含分类 A 的临时横批库。"""
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        """删除临时目录。"""
        shutil.rmtree(self.dir, ignore_errors=True)

    def _bank(self, items):
        """用给定横批列表生成 BannerBank。

        参数:
            items: 横批列表（全部属于分类 A）。
        返回:
            BannerBank 实例。
        """
        return derive.BannerBank(make_banners(self.dir, {"A": items}))

    def test_four_char_wins_tie_against_short(self):
        """同分时四字胜过短横批（短横批有长度扣减）。"""
        bank = self._bank(["天地玄黄", "宇宙"])
        banner, overflow, reason = derive.pick_banner(
            bank, "一二", "三四", [("A", 0.6)], set(), set(), collections.Counter(), {"A": 99})
        self.assertEqual((banner, overflow, reason), ("天地玄黄", False, derive.RULE_FOUR))

    def test_banner_overlapping_couplet_is_skipped(self):
        """横批与上下联重叠字数超过其字数一半时不选。"""
        bank = self._bank(["一二三四", "天地玄黄"])
        banner, _, _ = derive.pick_banner(
            bank, "一二", "三四", [("A", 0.6)], set(), set(), collections.Counter(), {"A": 99})
        self.assertEqual(banner, "天地玄黄")

    def test_full_sentence_repeat_is_skipped(self):
        """横批整句出现在上下联中时不选。"""
        bank = self._bank(["晚风摇树", "天地玄黄"])
        banner, _, _ = derive.pick_banner(
            bank, "晚风摇树", "燕语呢喃", [("A", 0.6)], set(), set(), collections.Counter(), {"A": 99})
        self.assertEqual(banner, "天地玄黄")

    def test_cap_moves_to_next_candidate_and_flags_overflow(self):
        """横批已达上限时跳到下一个；全部超限时取最优并标记超限。"""
        bank = self._bank(["天地玄黄", "宇宙洪荒"])
        counts = collections.Counter({"天地玄黄": 5})
        banner, overflow, _ = derive.pick_banner(
            bank, "一二", "三四", [("A", 0.6)], set(), set(), counts, {"A": 5})
        self.assertEqual((banner, overflow), ("宇宙洪荒", False))
        counts["宇宙洪荒"] = 5
        banner, overflow, _ = derive.pick_banner(
            bank, "一二", "三四", [("A", 0.6)], set(), set(), counts, {"A": 5})
        self.assertTrue(overflow)

    def test_long_banner_wins_when_four_char_misfit(self):
        """四字不贴合且上下联较长时，重叠两字的六字横批胜出，原因为长横批。"""
        bank = self._bank(["天地玄黄", "一二春风化雨"])
        banner, _, reason = derive.pick_banner(
            bank, "一二三四五", "六七八九十", [("A", 0.5)], set(), set(), collections.Counter(), {"A": 99})
        self.assertEqual((banner, reason), ("一二春风化雨", derive.RULE_LONG_MISFIT))

    def test_deterministic(self):
        """同一输入、同一计数状态，多次调用结果一致。"""
        bank = self._bank(["天地玄黄", "宇宙洪荒", "日月盈昃"])
        results = {derive.pick_banner(bank, "一二", "三四", [("A", 0.6)], {"一"}, {"一"},
                                      collections.Counter(), {"A": 99})[0] for _ in range(5)}
        self.assertEqual(len(results), 1)


class PipelineTest(unittest.TestCase):
    """小数据集端到端：输出格式、统计文件、确定性。"""

    def setUp(self):
        """建立临时数据集、词典与横批库。"""
        self.dir = tempfile.mkdtemp()
        self.data = os.path.join(self.dir, "data")
        os.makedirs(self.data)
        with open(os.path.join(self.data, "in.txt"), "w", encoding="utf-8") as f:
            f.write("新 春 爆 竹 响\n千 古 哀 思 长\n晚 风 摇 树\n")
        with open(os.path.join(self.data, "out.txt"), "w", encoding="utf-8") as f:
            f.write("福 满 人 间 来\n泪 洒 九 泉 下\n燕 语 呢 喃\n")
        self.lex = derive.Lexicon(make_lexicon(self.dir, {
            "春节": {"seeds": {"新春": 1.0, "爆竹": 1.0}},
            "挽联": {"seeds": {"哀": 1.0, "泪": 1.0}},
            "通用": {},
        }))
        self.bank = derive.BannerBank(make_banners(self.dir, {
            "春节": ["新春大吉", "福满人间", "福到"],
            "挽联": ["千古流芳", "音容宛在"],
            "通用": ["和谐美满", "一路平安"],
        }))

    def tearDown(self):
        """删除临时目录。"""
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_run_writes_four_fields_and_stats(self):
        """每行四列，统计文件含必要字段，挽联否决生效。"""
        out = os.path.join(self.dir, "out")
        result = derive.run(self.data, out, 0, self.lex, self.bank)
        with open(os.path.join(out, "derived.tsv"), encoding="utf-8") as f:
            rows = [line.rstrip("\n").split("\t") for line in f]
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(len(r) == 4 for r in rows))
        self.assertEqual(result["挽联否决触发数"], 1)
        self.assertIn("字数选择原因分布", result)
        self.assertTrue(os.path.exists(os.path.join(out, "stats.json")))

    def test_run_is_reproducible(self):
        """两次运行输出完全一致。"""
        out1 = os.path.join(self.dir, "o1")
        out2 = os.path.join(self.dir, "o2")
        derive.run(self.data, out1, 0, self.lex, self.bank)
        derive.run(self.data, out2, 0, self.lex, self.bank)
        with open(os.path.join(out1, "derived.tsv"), encoding="utf-8") as a, \
                open(os.path.join(out2, "derived.tsv"), encoding="utf-8") as b:
            self.assertEqual(a.read(), b.read())

    def test_format_cats(self):
        """分类格式为 名:权重（两位小数），逗号分隔。"""
        self.assertEqual(derive.format_cats([("春节", 0.8), ("挽联", 0.4)]), "春节:0.80,挽联:0.40")


class MinedWordSelectionTest(unittest.TestCase):
    """挖掘词的碎片过滤（build_lexicon.select_words）。"""

    def test_drops_fragments_of_seeds_and_chosen_words(self):
        """包含或被包含于种子词、或与已选词互为子串的候选被丢弃，长词同分时优先。"""
        candidates = [
            (-0.9, -4, "洞房花烛", 0.9),
            (-0.9, -2, "花烛", 0.9),       # 被已选的“洞房花烛”包含
            (-0.8, -2, "迎春", 0.8),       # 与种子“迎春”相同
            (-0.7, -2, "鸳鸯", 0.7),
        ]
        chosen = build_lexicon.select_words(candidates, {"迎春"}, 10)
        self.assertEqual([g for g, _ in chosen], ["洞房花烛", "鸳鸯"])


class RealResourcesTest(unittest.TestCase):
    """真实词典与横批库的约束检查。"""

    @classmethod
    def setUpClass(cls):
        """加载真实词典与横批库。"""
        cls.lex = derive.Lexicon()
        cls.bank = derive.BannerBank()

    def test_every_class_has_enough_banners_and_four_char_majority(self):
        """每类至少 20 条横批，且四字占比不低于 60%。"""
        for cat, items in self.bank.banners.items():
            self.assertGreaterEqual(len(items), 20, cat)
            four = sum(1 for t in items if len(t) == derive.PREFERRED_LEN)
            self.assertGreaterEqual(four / len(items), 0.6, cat)

    def test_mourning_banners_are_solemn(self):
        """挽联横批不含喜庆字。"""
        for text in self.bank.banners["挽联"]:
            self.assertFalse(set(text) & set(RICH_CHARS), text)

    def test_real_mourning_couplet_is_not_festive(self):
        """真实词典下，含哀悼词的对联不会保留春节或婚庆分类。"""
        score = derive.score_pair(self.lex, "新春爆竹迎春来", "千古哀思泪满襟")
        cats = [c for c, _ in score.cats]
        self.assertIn("挽联", cats)
        self.assertNotIn("春节", cats)
        self.assertNotIn("婚庆", cats)


if __name__ == "__main__":
    unittest.main()
