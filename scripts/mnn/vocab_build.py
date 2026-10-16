"""构建 NLLB 六语言（zh/en/fr/es/ru/ar）词表 v2：随包裁剪集 ∪ 补充集 + 标点规范化补丁。

为什么是这个方案（证据见 vocab_audit.py 的输出与 docs/research/onnx-to-mnn-migration.md 3.3）：
  - 随包裁剪集相对原版 256,204 词：GB2312 汉字一个不丢，六语语料分词与原版逐 token 一致率 >= 98.5%；
    “懒、媚、妈、汤”等 4188 个 GB2312 常用字是 NLLB 官方 SentencePiece 就没有的，词表层面补不回来（没有嵌入行，也没法训练）；
  - 原版 tokenizer 里“ ” ‘ ’ « » – — 《》【】等常见标点是 <unk>（原版训练数据走过 Moses 标点规范化，tokenizer.json 没带这一步），
    可以在 normalizer 里补 Replace 规则，不增加任何嵌入行；
  - 补充集 = 保证 GB2312 / 六语文字单字 token 完整 + 审计语料里原版会用到而随包集漏掉的词（如西语 ▁rana）+ BPE 合并链闭包。
流程：
  1. 保留集 K = 随包词表 ∪ 补充集 ∪ 特殊 token（<s> <pad> </s> <unk> 与六个语言码）；
  2. 闭包：K 里每个多字符 token 至少要有一条“两个前驱都在 K 内”的合并记录，否则补它最靠前那条记录的前驱，直到稳定；
  3. 合并表 = 原版合并表里“前驱与产物都在 K 内”的条目（保持原顺序，即优先级不变）；
  4. 新 id 按原版 id 升序顺排（<s>=0 <pad>=1 </s>=2 <unk>=3 不变，语言码排在最后），nllb_prepare.py 按 token 字符串映回原 id 裁剪嵌入与 lm_head；
  5. 其余字段（pre_tokenizer、decoder、Precompiled charsmap、Replace、Strip 等）原样取自随包 tokenizer.json，仅在 Precompiled 后插入标点补丁；
  6. 自检：tokenizers 库能加载；新增 token 都可由 BPE 生成（逐词重新分词应得到自身）；语料分词与“原版词表 + 同一套 normalizer”逐 token 一致。

用法：python -I vocab_build.py [--out <目录，缺省 dl/nllb-tok-v2>] [--orig tokenizer.json] [--trim tokenizer.json] [--corpus 文件...] [--no-punct-patch]
  输出：<out>/tokenizer.json 与 <out>/vocab_build.json（规模、新增 token 清单、自检数字）。
  默认 orig 取 dl/nllb-fp32/tokenizer.json，trim 取 dl/nllb-tok/tokenizer.json，corpus 取 data/audit_*.txt。
  把 <out> 登记为 recipes.json 里 nllb 的 tokenizer 即可让 convert_all.py 用它裁剪嵌入。
"""
import argparse
import copy
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, dl_dir, log, need_file  # noqa: E402
import vocab_audit as audit  # noqa: E402

# 词首标记（Metaspace）
SPACE = audit.SPACE
# 基础特殊 token 及其必须固定的 id（引擎约定：decoder_start=2、eos=2、pad=1）
SPECIAL_IDS = {"<s>": 0, "<pad>": 1, "</s>": 2, "<unk>": 3}
# 六个语言码（FLORES 码）
LANG_CODES = ("zho_Hans", "eng_Latn", "fra_Latn", "spa_Latn", "rus_Cyrl", "arb_Arab")
# 补充单字 token 时认可的文字类别（见 vocab_audit.script_of）
KEEP_SCRIPTS = {"汉字", "拉丁", "西里尔", "阿拉伯", "数字"}
# 标点规范化补丁：目标字符串 -> 源字符（这些源字符在原版分词里是 <unk>，替换目标在词表里都有）。参照 Moses 的标点规范化
PUNCT_PATCH = {
    '"': "“”„«»〃《》〈〉〝〞〟",   # “ ” „ « » 〃 《 》 〈 〉 〝 〞 〟
    "'": "‘’‚",                                                               # ‘ ’ ‚
    "-": "–",                                                                           # –
    " - ": "—",                                                                         # —（Moses 规范为带空格的连字符）
    "[": "【〖",                                                                     # 【 〖
    "]": "】〗",                                                                     # 】 〗
    "~": "～",                                                                           # ～
    "?!": "‽",                                                                          # ‽
    "": "‪‫‬‭‮⁦⁧⁨⁩",                            # 双向文字控制符（阿拉伯语复制粘贴常带），直接删除
}
# 默认输出目录名（recipes.json 里 nllb 的 tokenizer 指向它）
OUT_DIRNAME = "nllb-tok-v2"
# 审计语料默认文件名模式
CORPUS_GLOB = "audit_*.txt"


def patch_rules():
    """把 PUNCT_PATCH 展开成 tokenizers 的 Replace 规范化器节点列表（字符串匹配，一个源字符一条）。"""
    rules = []
    for target, sources in PUNCT_PATCH.items():
        for ch in sources:
            rules.append({"type": "Replace", "pattern": {"String": ch}, "content": target})
    return rules


def patched_normalizer(norm):
    """返回补丁后的 normalizer：在第一个 Precompiled（NFKC 映射）之后插入标点补丁，其余原样保留。"""
    n = copy.deepcopy(norm)
    items = n["normalizers"]
    at = next(i for i, x in enumerate(items) if x["type"] == "Precompiled") + 1
    n["normalizers"] = items[:at] + patch_rules() + items[at:]
    return n


def to_tokenizer(j):
    """由 tokenizer.json 字典构造 tokenizers.Tokenizer（走 vocab_audit 的容错加载逻辑）。"""
    from tokenizers import Tokenizer
    try:
        return Tokenizer.from_str(json.dumps(j))
    except Exception:
        # 与 audit.load_tokenizer 同样的容错：charsmap 为 null 时剔除再加载
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(j, f)
        return audit.load_tokenizer(f.name)


def build_parent_index(merges):
    """合并表 -> {产物: [(优先级, 前驱a, 前驱b), ...]}。"""
    idx = {}
    for rank, m in enumerate(merges):
        a, b = m.split(" ", 1) if isinstance(m, str) else m
        idx.setdefault(a + b, []).append((rank, a, b))
    return idx


def collect_supplement(orig_vocab, trim_vocab, orig_patched_tok, corpus_lines):
    """补充集：(1) GB2312 与六语文字的原版单字 token；(2) 语料里原版分词会用到的 token。返回 (集合, 来源统计)。"""
    extra, stat = set(), {}
    # (1) GB2312 汉字
    gb = {t for c in audit.gb2312_chars() for t in (c, SPACE + c) if t in orig_vocab}
    stat["gb2312_single"] = len(gb - set(trim_vocab))
    extra |= gb
    # (2) 六语文字的单字 token（原版有、文字类别在认可范围内）
    singles = set()
    for t in orig_vocab:
        s = t[1:] if t.startswith(SPACE) and len(t) > 1 else t
        if len(s) == 1 and t not in SPECIAL_IDS and audit.script_of(s) in KEEP_SCRIPTS:
            singles.add(t)
    stat["script_single"] = len(singles - set(trim_vocab) - extra)
    extra |= singles
    # (3) 语料用到的 token（用补丁后的原版分词器分词，所以补丁产生的 " 等也会计入）
    used = set()
    for line in corpus_lines:
        used.update(audit.tokens_of(orig_patched_tok, line))
    used.discard("<unk>")
    stat["corpus_tokens"] = len(used - set(trim_vocab) - extra)
    extra |= {t for t in used if t in orig_vocab}
    return extra, stat


def close_merges(keep, parents):
    """BPE 闭包：保证 keep 里每个多字符 token 至少有一条前驱都在 keep 内的合并记录。
    缺的就补“优先级最靠前那条记录”的两个前驱；循环到稳定。返回 (新增 token 集合, 无合并记录的 token 集合)。"""
    added, orphan = set(), set()
    queue = list(keep)
    while queue:
        t = queue.pop()
        s = t[1:] if t.startswith(SPACE) and len(t) > 1 else t
        if len(s) <= 1 or t in SPECIAL_IDS or t in LANG_CODES:
            continue
        recs = parents.get(t)
        if not recs:
            orphan.add(t)
            continue
        if any(a in keep and b in keep for _, a, b in recs):
            continue
        _, a, b = min(recs)
        for p in (a, b):
            if p not in keep:
                keep.add(p)
                added.add(p)
                queue.append(p)
        queue.append(t)
    return added, orphan


def assign_ids(keep, orig_vocab):
    """按原版 id 升序顺排新 id；返回 (新词表 {token: 新 id}, 新 id -> 原 id 列表)。特殊 token 必须落在 0..3。"""
    order = sorted(keep, key=lambda t: orig_vocab[t])
    new_vocab = {t: i for i, t in enumerate(order)}
    for t, i in SPECIAL_IDS.items():
        if new_vocab.get(t) != i:
            raise SystemExit(f"错误：特殊 token {t} 的新 id 为 {new_vocab.get(t)}，应为 {i}")
    return new_vocab, [orig_vocab[t] for t in order]


def check_reachable(tok, tokens):
    """逐词用 BPE 模型本身分词（不经 normalizer / pre_tokenizer），返回“分词结果不是自身”的 token 集合。"""
    bad = set()
    for t in tokens:
        if t in SPECIAL_IDS or t in LANG_CODES:
            continue
        if [x.value for x in tok.model.tokenize(t)] != [t]:
            bad.add(t)
    return bad


def main():
    """命令行入口：构建词表 v2 并自检。"""
    ap = argparse.ArgumentParser(description="构建 NLLB 六语言词表 v2")
    ap.add_argument("--orig", default=os.path.join(dl_dir(), "nllb-fp32", "tokenizer.json"))
    ap.add_argument("--trim", default=os.path.join(dl_dir(), "nllb-tok", "tokenizer.json"))
    ap.add_argument("--out", default=os.path.join(dl_dir(), OUT_DIRNAME), help="输出目录（缺省 dl/nllb-tok-v2）")
    ap.add_argument("--corpus", nargs="*", help="语料文件（每行一句）；缺省取 data/audit_*.txt")
    ap.add_argument("--no-punct-patch", action="store_true", help="不加标点规范化补丁（做对照用）")
    ap.add_argument("--gold-out", help="另存“原版全词表 + 同一套 normalizer”的金标准 tokenizer.json（eval_vocab_equiv.py 用）")
    a = ap.parse_args()
    need_file(a.orig)
    need_file(a.trim)
    files = a.corpus if a.corpus else sorted(glob.glob(os.path.join(HERE, "data", CORPUS_GLOB)))
    lines = [l.strip() for f in files for l in open(f, encoding="utf-8") if l.strip()]
    log(f"语料 {len(files)} 个文件，{len(lines)} 句")

    ov, om, oj = audit.load_vocab(a.orig)
    tv, _, tj = audit.load_vocab(a.trim)
    base = copy.deepcopy(tj)  # 非词表字段的来源：随包 tokenizer.json
    norm = base["normalizer"] if a.no_punct_patch else patched_normalizer(base["normalizer"])
    base["normalizer"] = norm

    # 原版词表 + 同一套 normalizer，作为分词的“金标准”
    gold_j = copy.deepcopy(oj)
    gold_j["normalizer"] = norm
    gold_j["post_processor"] = base.get("post_processor")
    gold = to_tokenizer(gold_j)
    if a.gold_out:
        with open(a.gold_out, "w", encoding="utf-8") as f:
            json.dump(gold_j, f, ensure_ascii=False)

    parents = build_parent_index(om)
    keep = set(tv) | set(SPECIAL_IDS) | set(LANG_CODES)
    extra, stat = collect_supplement(ov, tv, gold, lines)
    keep |= extra
    added, orphan = close_merges(keep, parents)
    stat["closure_added"] = len(added - set(tv))
    new_tokens = sorted(keep - set(tv), key=lambda t: ov[t])
    log(f"随包词表 {len(tv):,} 词 + 新增 {len(new_tokens)} 词（GB2312 单字 {stat['gb2312_single']}、六语单字 {stat['script_single']}、"
        f"语料用到 {stat['corpus_tokens']}、闭包前驱 {stat['closure_added']}）= {len(keep):,} 词")
    if new_tokens:
        log("新增：" + " ".join(new_tokens[:60]) + (" …" if len(new_tokens) > 60 else ""))

    new_vocab, keep_ids = assign_ids(keep, ov)
    merges = []
    for m in om:
        x, y = m.split(" ", 1) if isinstance(m, str) else m
        if x in new_vocab and y in new_vocab and (x + y) in new_vocab:
            merges.append(m)
    log(f"合并表 {len(merges):,} 条（随包 {len(tj['model']['merges']):,}）")

    out = copy.deepcopy(base)
    out["model"]["vocab"] = new_vocab
    out["model"]["merges"] = merges
    out["added_tokens"] = []
    os.makedirs(a.out, exist_ok=True)
    tpath = os.path.join(a.out, "tokenizer.json")
    with open(tpath, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    # —— 自检 ——
    from tokenizers import Tokenizer
    tok = Tokenizer.from_file(tpath)  # 官方库能直接加载
    assert tok.get_vocab_size() == len(new_vocab), "词表大小与写入不一致"
    for t, i in SPECIAL_IDS.items():
        assert tok.token_to_id(t) == i
    lang_ids = {c: tok.token_to_id(c) for c in LANG_CODES}
    assert all(v is not None for v in lang_ids.values()), "语言码缺失"
    gold_unreach = check_reachable(gold, new_vocab)
    new_unreach = check_reachable(tok, new_vocab)
    regress = sorted(new_unreach - gold_unreach)
    log(f"BPE 可达性：原版里不可达 {len(gold_unreach)}（原版自身的转换瑕疵），新词表不可达 {len(new_unreach)}，"
        f"其中原版可达而新词表不可达 {len(regress)}（要求 0）")
    same = unk_g = unk_n = 0
    for s in lines:
        g, n = audit.tokens_of(gold, s), audit.tokens_of(tok, s)
        same += g == n
        unk_g += "<unk>" in g
        unk_n += "<unk>" in n
    log(f"语料分词与“原版词表+同 normalizer”逐 token 一致 {same}/{len(lines)}（{same / len(lines):.2%}）；含 UNK 句：原版 {unk_g}，新词表 {unk_n}")
    info = {"vocab": len(new_vocab), "trim_vocab": len(tv), "new_tokens": new_tokens, "supplement": stat,
            "merges": len(merges), "orphans_without_merge": len(orphan), "unreachable_new": len(new_unreach),
            "unreachable_regress": regress, "corpus_lines": len(lines), "corpus_identical": same,
            "corpus_unk_gold": unk_g, "corpus_unk_new": unk_n, "lang_ids": lang_ids,
            "punct_patch": not a.no_punct_patch, "embed_rows": len(keep_ids)}
    with open(os.path.join(a.out, "vocab_build.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    log(f"已写 {tpath}")
    if regress:
        sys.exit("错误：存在原版可达而新词表不可达的 token，闭包不完整")


if __name__ == "__main__":
    main()
