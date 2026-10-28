#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fetch_sd.py — 下载本地文生图模型（默认 sd-turbo，约 2.4GB，只下 fp16）

为什么单独一个脚本：
    · 走 hf-mirror 镜像（国内直连 huggingface 经常卡死）
    · 只下 fp16 变体（fp32 那套再翻一倍体积，RTX 3060 6G 也用不上）

跑法：
    python fetch_sd.py --repo stabilityai/sd-turbo --dest F:/qqbot/.models/sd-turbo
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="stabilityai/sd-turbo")
    ap.add_argument("--dest", default="F:/qqbot/.models/sd-turbo")
    ap.add_argument("--endpoint", default="https://hf-mirror.com")
    ap.add_argument("--cache", default="F:/qqbot/.hf", help="HF 缓存目录（必须放在可写盘，默认盘会被沙箱拒绝）")
    args = ap.parse_args()

    os.environ.setdefault("HF_ENDPOINT", args.endpoint)
    # 关掉"每次启动都去查新版本"的联网行为
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    # 缓存目录必须落在可写盘：默认 C:\Users\...\.cache\huggingface 在沙箱里是拒绝访问的
    os.environ["HF_HOME"] = args.cache
    os.environ.setdefault("HF_HUB_CACHE", args.cache + "/hub")
    # 关掉 xet（hf-xet 会自己写 xet 缓存目录，报 OSError: I/O error: 拒绝访问 (os error 5)）
    os.environ["HF_HUB_DISABLE_XET"] = "1"

    from huggingface_hub import snapshot_download

    patterns = [
        "model_index.json",
        "*.txt",
        "scheduler/*",
        "tokenizer/*",
        "feature_extractor/*",
        "text_encoder/config.json",
        "text_encoder/model.fp16.safetensors",
        "unet/config.json",
        "unet/diffusion_pytorch_model.fp16.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.fp16.safetensors",
    ]
    print("endpoint =", os.environ["HF_ENDPOINT"])
    print("repo     =", args.repo)
    print("dest     =", args.dest)
    path = snapshot_download(
        repo_id=args.repo,
        local_dir=args.dest,
        allow_patterns=patterns,
        max_workers=4,
    )
    print("OK ->", path)
    total = 0
    for root, _dirs, files in os.walk(args.dest):
        for f in files:
            if f.endswith(".safetensors") or f.endswith(".bin") or f.endswith(".json"):
                total += os.path.getsize(os.path.join(root, f))
    print("bytes = %.1f MB" % (total / 1024 / 1024))


if __name__ == "__main__":
    sys.exit(main())
