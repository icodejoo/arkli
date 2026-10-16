"""NLLB 词表覆盖率审计：回答“某个字缺，是原版 NLLB 就没有，还是我们裁剪裁掉的？”。

三个层次的对照：
  1. 原版 SentencePiece 模型（sentencepiece.bpe.model，可选，--spm）：官方的词条集合，最权威；
  2. 原版 tokenizer.json（256,204 词）：HF 转换版；
  3. 待审词表 tokenizer.json（随包裁剪版 61,795 词，或 vocab_build.py 产出的新词表）。
输出：
  A. GB2312 一级+二级汉字（6763 个）的单字 token 覆盖：原版有/无、待审有/无、“原版有而待审丢了”的清单；
  B. 原版有而待审没有的单字 token，按文字类别汇总（汉字、西里尔、阿拉伯、拉丁扩展、标点符号等）；
  C. 语料对照（data/audit_{zh,en,fr,es,ru,ar}.txt，每行一句）：每种语言的 UNK 句数、
     与原版分词逐 token 一致的句数比例、待审词表比原版多出的碎片数、缺失字符清单；
  D. BPE 合并链完整性：待审词表里每个带合并记录的 token，其前驱是否都在词表内。

用法：python -I vocab_audit.py [--orig tokenizer.json] [--trim tokenizer.json] [--spm sentencepiece.bpe.model]
                                [--data DIR] [--json out.json]
  默认 orig 取 dl/nllb-fp32/tokenizer.json，trim 取 dl/nllb-tok/tokenizer.json，data 取本目录的 data/。
"""
import argparse
import json
import os
import sys
import unicodedata
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, dl_dir, log, need_file  # noqa: E402

# 词表里的词首标记（Metaspace）
SPACE = "▁"
# 四个基础特殊 token
BASE_SPECIAL = ("<s>", "<pad>", "</s>", "<unk>")
# 审计语料：语言码 -> 文件名
CORPORA = {"zh": "audit_zh.txt", "en": "audit_en.txt", "fr": "audit_fr.txt", "es": "audit_es.txt",
           "ru": "audit_ru.txt", "ar": "audit_ar.txt"}
# GB2312 区位码范围：高字节 0xB0~0xF7（一级 0xB0~0xD7，二级 0xD8~0xF7），低字节 0xA1~0xFE
GB_HI_LEVEL1 = range(0xB0, 0xD8)
GB_HI_LEVEL2 = range(0xD8, 0xF8)
GB_LO = range(0xA1, 0xFF)
# 报告里每类缺失字符最多列多少个
SHOW_MAX = 120


def load_vocab(path):
    """读 tokenizer.json，返回 (词表 {token: id}, 合并列表, 原始 json)。added_tokens 并入词表。"""
    j = json.load(open(path, encoding="utf-8"))
    vocab = dict(j["model"]["vocab"])
    for t in j.get("added_tokens", []):
        vocab[t["content"]] = t["id"]
    return vocab, j["model"]["merges"], j


def load_tokenizer(path):
    """用 tokenizers 库加载 tokenizer.json；个别版本 Precompiled 的 charsmap 为 null 时先剔除再加载。"""
    from tokenizers import Tokenizer
    try:
        return Tokenizer.from_file(path)
    except Exception:
        j = json.load(open(path, encoding="utf-8"))

        def fix(node):
            if isinstance(node, dict):
                if node.get("type") == "Precompiled" and node.get("precompiled_charsmap") is None:
                    return None
                return {k: fix(v) for k, v in node.items()}
            if isinstance(node, list):
                return [x for x in (fix(v) for v in node) if x is not None]
            return node

        return Tokenizer.from_str(json.dumps(fix(j)))


def gb2312_chars(levels=(1, 2)):
    """按区位码枚举 GB2312 汉字；levels 选一级(3755 字)/二级(3008 字)。返回字符列表。"""
    his = []
    if 1 in levels:
        his += list(GB_HI_LEVEL1)
    if 2 in levels:
        his += list(GB_HI_LEVEL2)
    out = []
    for hi in his:
        for lo in GB_LO:
            try:
                out.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass  # 区位里的空位
    return out


def _varint(b, i):
    """读 protobuf varint，返回 (值, 新下标)。"""
    r = s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 127) << s
        s += 7
        if x < 128:
            return r, i


def spm_pieces(path):
    """不依赖 sentencepiece 库，手工解析 .model 的 protobuf，返回词条字符串列表（顺序即 id）。"""
    b = open(path, "rb").read()
    pieces, i = [], 0
    while i < len(b):
        k, i = _varint(b, i)
        field, wire = k >> 3, k & 7
        if wire == 2:
            n, i = _varint(b, i)
            d = b[i:i + n]
            i += n
            if field == 1:  # ModelProto.pieces
                j, p = 0, None
                while j < len(d):
                    kk, j = _varint(d, j)
                    ff, ww = kk >> 3, kk & 7
                    if ww == 2:
                        nn, j = _varint(d, j)
                        if ff == 1:
                            p = d[j:j + nn].decode("utf-8")
                        j += nn
                    elif ww == 5:
                        j += 4
                    elif ww == 0:
                        _, j = _varint(d, j)
                    else:
                        j += 8
                pieces.append(p)
        elif wire == 0:
            _, i = _varint(b, i)
        elif wire == 5:
            i += 4
        else:
            i += 8
    return pieces


def has_char(vocab, c):
    """词表里是否有单字 token：c 或 ▁c（词首形式也算，因为 BPE 会按需切出两种形态）。"""
    return c in vocab or SPACE + c in vocab


def script_of(c):
    """粗分文字类别，用来汇总缺失字符。"""
    cp = ord(c)
    name = unicodedata.name(c, "")
    cat = unicodedata.category(c)
    if 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0xF900 <= cp <= 0xFAFF:
        return "汉字"
    if 0x3040 <= cp <= 0x30FF:
        return "日文假名"
    if 0xAC00 <= cp <= 0xD7AF:
        return "韩文"
    if "CYRILLIC" in name:
        return "西里尔"
    if "ARABIC" in name:
        return "阿拉伯"
    if "LATIN" in name:
        return "拉丁"
    if cat.startswith("N"):
        return "数字"
    if cat.startswith(("P", "S")):
        return "标点符号"
    return "其他:" + (name.split(" ")[0] if name else cat)


def single_chars(vocab):
    """词表里所有“单字符 token”（去掉词首 ▁ 后只剩一个字符），返回字符集合。"""
    out = set()
    for t in vocab:
        s = t[1:] if t.startswith(SPACE) and len(t) > 1 else t
        if len(s) == 1 and t not in BASE_SPECIAL:
            out.add(s)
    return out


def merge_closure_broken(vocab, merges):
    """检查 BPE 合并链：每条合并 'a b' 的产物 ab 若在词表里，则 a、b 必须也在词表里。
    返回“产物在词表而前驱缺失”的合并条数（等于零才合法）。"""
    bad = 0
    for m in merges:
        a, b = m.split(" ", 1) if isinstance(m, str) else m
        if (a + b) in vocab and (a not in vocab or b not in vocab):
            bad += 1
    return bad


def tokens_of(tok, text):
    """用 tokenizers 分词，返回 token 字符串列表（不加特殊符号）。"""
    return tok.encode(text, add_special_tokens=False).tokens


def char_is_unk(tok, cache, c):
    """单个字符经该分词器（含 normalizer）后是否变成 <unk>；结果缓存在 cache 里。"""
    if c not in cache:
        cache[c] = "<unk>" in tokens_of(tok, c)
    return cache[c]


def corpus_report(orig_tok, trim_tok, lines):
    """对一份语料逐句比较，返回统计 dict。缺字判定走分词器本身（已含 normalizer，如全角逗号会先变半角）。"""
    n = len(lines)
    same = 0
    unk_o = unk_t = 0
    extra_frag = 0
    miss_o, miss_t = Counter(), Counter()
    cache_o, cache_t = {}, {}
    diffs = []
    for s in lines:
        a, b = tokens_of(orig_tok, s), tokens_of(trim_tok, s)
        if a == b:
            same += 1
        elif len(diffs) < 5:
            diffs.append((s, a, b))
        extra_frag += max(0, len(b) - len(a))
        if "<unk>" in a:
            unk_o += 1
        if "<unk>" in b:
            unk_t += 1
        # 逐字符判定“这个字符会不会变 UNK”（原版/待审各自）
        for c in set(s):
            if c.isspace():
                continue
            if char_is_unk(orig_tok, cache_o, c):
                miss_o[c] += 1
            elif char_is_unk(trim_tok, cache_t, c):
                miss_t[c] += 1
    return {"sentences": n, "identical": same, "identical_rate": same / n if n else 1.0,
            "unk_sentences_orig": unk_o, "unk_sentences_trim": unk_t,
            "extra_fragments": extra_frag, "chars_missing_in_orig": dict(miss_o),
            "chars_lost_by_trim": dict(miss_t), "diff_samples": diffs}


def fmt_chars(chars, limit=SHOW_MAX):
    """把字符序列拼成一行文本，超过 limit 个时截断并注明总数。"""
    chars = list(chars)
    s = "".join(chars[:limit])
    return s + (f"…（共 {len(chars)} 个）" if len(chars) > limit else "")


def main():
    """命令行入口：打印审计报告，可选另存 JSON。"""
    ap = argparse.ArgumentParser(description="NLLB 词表覆盖率审计")
    ap.add_argument("--orig", default=os.path.join(dl_dir(), "nllb-fp32", "tokenizer.json"))
    ap.add_argument("--trim", default=os.path.join(dl_dir(), "nllb-tok", "tokenizer.json"))
    ap.add_argument("--spm", help="官方 sentencepiece.bpe.model（可选，用来确认“原版就没有”）")
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    ap.add_argument("--json", help="把统计另存为 JSON")
    a = ap.parse_args()
    need_file(a.orig)
    need_file(a.trim)
    ov, om, _ = load_vocab(a.orig)
    tv, tm, _ = load_vocab(a.trim)
    otok, ttok = load_tokenizer(a.orig), load_tokenizer(a.trim)
    res = {"orig_vocab": len(ov), "trim_vocab": len(tv)}
    log(f"原版词表 {len(ov):,} 词；待审词表 {len(tv):,} 词；待审词不在原版的有 {sum(1 for t in tv if t not in ov)} 个")

    log("\n== A. GB2312 汉字单字 token 覆盖 ==")
    sp = set(spm_pieces(a.spm)) if a.spm else None
    for name, lv in (("一级", (1,)), ("二级", (2,)), ("合计", (1, 2))):
        chars = gb2312_chars(lv)
        no_o = [c for c in chars if not has_char(ov, c)]
        no_t = [c for c in chars if not has_char(tv, c)]
        lost = [c for c in chars if has_char(ov, c) and not has_char(tv, c)]
        line = f"{name} {len(chars)} 字：原版缺 {len(no_o)}，待审缺 {len(no_t)}，原版有而待审丢了 {len(lost)}"
        if sp is not None:
            no_s = [c for c in chars if c not in sp and SPACE + c not in sp]
            line += f"，官方 SPM 缺 {len(no_s)}"
        log(line)
        if name == "合计":
            res["gb2312"] = {"total": len(chars), "orig_missing": len(no_o), "trim_missing": len(no_t),
                             "lost_by_trim": lost, "orig_missing_chars": no_o}
            log(f"  原版就缺的常用字示例：{fmt_chars(no_o, 60)}")
            log(f"  裁剪丢的：{fmt_chars(lost) or '（无）'}")
            for c in "懒晴":
                log(f"  “{c}”：原版{'有' if has_char(ov, c) else '无'}，待审{'有' if has_char(tv, c) else '无'}"
                    + (f"，官方 SPM {'有' if (c in sp or SPACE + c in sp) else '无'}" if sp is not None else ""))

    log("\n== B. 原版有而待审没有的单字 token（按文字类别）==")
    oc, tc = single_chars(ov), single_chars(tv)
    lost_by = {}
    for c in sorted(oc - tc):
        lost_by.setdefault(script_of(c), []).append(c)
    for k, v in sorted(lost_by.items(), key=lambda kv: -len(kv[1])):
        log(f"{k:8s} {len(v):5d}  {fmt_chars(v, 60)}")
    res["lost_single_by_script"] = {k: len(v) for k, v in lost_by.items()}
    res["lost_single_chars"] = {k: "".join(v) for k, v in lost_by.items()}

    log("\n== C. 语料对照 ==")
    log("语言\t句数\t与原版分词一致\t原版含UNK句\t待审含UNK句\t多出碎片\t原版就缺的字符\t裁剪新增缺失的字符")
    res["corpora"] = {}
    for lang, fn in CORPORA.items():
        p = os.path.join(a.data, fn)
        if not os.path.isfile(p):
            log(f"{lang}\t（缺 {p}）")
            continue
        lines = [l.strip() for l in open(p, encoding="utf-8") if l.strip()]
        r = corpus_report(otok, ttok, lines)
        res["corpora"][lang] = {k: v for k, v in r.items() if k != "diff_samples"}
        log(f"{lang}\t{r['sentences']}\t{r['identical']}/{r['sentences']} ({r['identical_rate']:.1%})\t"
            f"{r['unk_sentences_orig']}\t{r['unk_sentences_trim']}\t{r['extra_fragments']}\t"
            f"{fmt_chars(r['chars_missing_in_orig'], 40) or '-'}\t{fmt_chars(r['chars_lost_by_trim'], 40) or '-'}")
        for s, x, y in r["diff_samples"][:2]:
            log(f"    差异示例：{s}\n      原版 {x}\n      待审 {y}")

    log("\n== D. BPE 合并链完整性 ==")
    bo, bt = merge_closure_broken(ov, om), merge_closure_broken(tv, tm)
    log(f"原版：产物在词表而前驱缺失的合并 {bo} 条；待审：{bt} 条（要求为 0）")
    res["merge_broken"] = {"orig": bo, "trim": bt}
    if a.json:
        json.dump(res, open(a.json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
