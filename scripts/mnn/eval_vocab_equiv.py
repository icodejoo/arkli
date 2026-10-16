"""词表裁剪的译文级等价性：原版 fp32（256,204 词，ORT merged）与新词表 fp32 拆图（ORT）逐句贪心译文对比。

动机：词表层面的分词一致（vocab_build.py 自检）不等于译文一致——裁掉的词若在某步是全词表的 top-1，贪心结果就会不同。
做法：复用 eval_nllb.py 的 `--one` 后端各跑一遍（原版 merged 走 ort-int4 后端，因为两者接口相同），
把新词表的 id 按 token 字符串映回原版 id，比较 token 序列与译文；两边都用“原版全词表 + 同一套 normalizer”的金标准分词，
所以标点补丁不会造成差异。

前置：
  - <full-dir> 里放 encoder.onnx 与 decoder.onnx（用硬链接指向 dl/nllb-fp32 的 encoder_model.onnx / decoder_model_merged.onnx 即可）；
  - 金标准 tokenizer：vocab_build.py --gold-out <文件>；
  - 新词表的拆图目录（convert_all.py nllb 的 split 目录）与 v2 tokenizer.json。
用法：python -I eval_vocab_equiv.py --full-dir DIR --gold-tokenizer FILE [--tokenizer v2.json] [--split-dir DIR]
                                    [--sentences file.tsv] [--dump out.json]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HERE, dl_dir, die, log, split_dir  # noqa: E402
import eval_nllb as E  # noqa: E402


def run_backend(kind, a, tokenizer, result, extra=()):
    """用 eval_nllb.py 的 --one 在子进程里跑一个后端，结果写到 result(.json)；失败直接退出。"""
    cmd = [sys.executable, "-I", os.path.join(HERE, "eval_nllb.py"), "--one", kind, "--result", result, "--tokenizer", tokenizer,
           "--split-dir", a.split_dir, "--mnn-dir", a.split_dir, "--sentences", a.sentences, "--threads", str(a.threads),
           "--limit", str(a.limit), *extra]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or E.RESULT_TAG not in r.stdout:
        print(r.stderr[-2500:], file=sys.stderr)
        die(f"后端 {kind} 运行失败")
    return json.load(open(result + ".json", encoding="utf-8"))["recs"]


def main():
    """命令行入口：跑两个后端并比较。"""
    ap = argparse.ArgumentParser(description="词表裁剪的译文级等价性评测")
    ap.add_argument("--full-dir", required=True, help="含 encoder.onnx / decoder.onnx 的原版 fp32 merged 目录")
    ap.add_argument("--gold-tokenizer", required=True, help="原版全词表 + 同 normalizer 的 tokenizer.json")
    ap.add_argument("--tokenizer", default=os.path.join(dl_dir(), "nllb-tok-v2", "tokenizer.json"))
    ap.add_argument("--split-dir", default=split_dir())
    ap.add_argument("--sentences", default=os.path.join(HERE, "data", "sentences_m6.tsv"))
    ap.add_argument("--threads", type=int, default=E.THREADS)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dump", help="把逐句对比存成 JSON")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="arkli-eval-equiv-")
    log("原版 fp32 全词表（ORT merged）...")
    full = run_backend("ort-int4", a, a.gold_tokenizer, os.path.join(tmp, "full"), ["--baseline-dir", a.full_dir])
    log("新词表 fp32 拆图（ORT）...")
    new = run_backend("ort-split", a, a.tokenizer, os.path.join(tmp, "new"))
    gold, v2 = E.load_tok(a.gold_tokenizer), E.load_tok(a.tokenizer)
    same_gen = same_out = 0
    diffs = []
    for f, n in zip(full, new):
        mapped = [gold.token_to_id(v2.id_to_token(i)) for i in n["gen"]]  # 新 id -> token 字符串 -> 原版 id
        g = mapped == f["gen"]
        same_gen += g
        same_out += f["out"] == n["out"]
        if not g:
            diffs.append({"src": f["src"], "tgt": f["tgt"], "text": f["text"], "full": f["out"], "new": n["out"]})
    total = len(full)
    log(f"token 序列完全相同 {same_gen}/{total}，译文文本相同 {same_out}/{total}")
    for d in diffs:
        log(f"  {d['src']}->{d['tgt']}  {d['text']}\n    原版全词表：{d['full']}\n    新词表    ：{d['new']}")
    if a.dump:
        json.dump({"total": total, "same_gen": same_gen, "same_out": same_out, "diffs": diffs}, open(a.dump, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
