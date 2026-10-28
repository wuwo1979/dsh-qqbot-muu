#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
下 GPT-SoVITS 推理权重（只下 api_v2.py 真跑中文需要的那几个文件，约 430MB）。
走 hf-mirror（huggingface.co 在本机被拒），python urllib（PowerShell/schannel 连不上外网）。
断点续传：重复运行从已下字节继续。

    python scripts/fetch_gsv_weights.py
    python scripts/fetch_gsv_weights.py --with-bert      # 额外下 chinese-roberta-wwm-ext-large（621MB，v1 才需要）
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.request

REPO = "lj1995/GPT-SoVITS"
BASE = f"https://hf-mirror.com/{REPO}/resolve/main/"
UA = {"User-Agent": "Mozilla/5.0 local-tts/1.0"}
DST_ROOT = r"F:\qqbot\.models\gpt-sovits\GPT-SoVITS-main\GPT_SoVITS\pretrained_models"

# 相对路径 -> 期望大小(MB)，None 表示不校验
FILES = {
    # tts_infer.yaml 的 custom/v2 默认组合
    "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt": 148.1,
    "gsv-v2final-pretrained/s2G2333k.pth": 101.1,
    # 中文 hubert 特征提取器（推理必经）
    "chinese-hubert-base/config.json": None,
    "chinese-hubert-base/preprocessor_config.json": None,
    "chinese-hubert-base/pytorch_model.bin": 180.1,
    # v2Pro 备选（v2 效果不满意时切）
    "v2Pro/s2Gv2ProPlus.pth": 190.9,
    "s1v3.ckpt": 148.1,
}
BERT_FILES = {
    "chinese-roberta-wwm-ext-large/pytorch_model.bin": 621.1,
    "chinese-roberta-wwm-ext-large/config.json": None,
    "chinese-roberta-wwm-ext-large/tokenizer.json": None,
}


def log(m: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def fetch(rel: str, expect_mb, timeout: float = 120.0) -> bool:
    dst = os.path.join(DST_ROOT, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    have = os.path.getsize(dst) if os.path.exists(dst) else 0
    if expect_mb and have and abs(have / 1048576 - expect_mb) < expect_mb * 0.02:
        log(f"    skip {rel} ({have/1048576:.1f} MB 已完整)")
        return True
    req = urllib.request.Request(BASE + rel, headers=dict(UA))
    if have:
        req.add_header("Range", f"bytes={have}-")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            mode = "ab" if (have and r.status == 206) else "wb"
            if mode == "wb":
                have = 0
            total = r.headers.get("Content-Length")
            total = (int(total) + have) if total else None
            with open(dst, mode) as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
                    have += len(b)
    except urllib.error.HTTPError as e:
        log(f"    FAIL {rel} HTTP {e.code}")
        return False
    except Exception as e:  # noqa: BLE001
        log(f"    FAIL {rel} {type(e).__name__}: {e}")
        return False
    size = os.path.getsize(dst)
    ok = True
    if expect_mb and abs(size / 1048576 - expect_mb) > expect_mb * 0.05:
        log(f"    WARN {rel} 得到 {size/1048576:.1f}MB != 期望 {expect_mb}MB")
        ok = False
    else:
        log(f"    ok {rel} {size/1048576:.1f} MB" +
            (f" (共 {total/1048576:.0f} MB)" if total else ""))
    return ok


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-bert", action="store_true", help="额外下 roberta-large（v1 才需要，621MB）")
    a = ap.parse_args(argv)

    log(f"目标 {DST_ROOT}")
    todo = dict(FILES)
    if a.with_bert:
        todo.update(BERT_FILES)
    bad = []
    for rel, mb in todo.items():
        log(f"  [{rel}]")
        if not fetch(rel, mb):
            bad.append(rel)
    log(f"完成：{len(todo)-len(bad)}/{len(todo)} 成功" + (f"，失败 {bad}" if bad else ""))
    tot = 0
    for base, _d, files in os.walk(DST_ROOT):
        for f in files:
            tot += os.path.getsize(os.path.join(base, f))
    log(f"pretrained_models 目录共 {tot/1048576:.0f} MB")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
