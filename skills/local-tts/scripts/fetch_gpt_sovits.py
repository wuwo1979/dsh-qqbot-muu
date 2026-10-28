#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性下载器：绕过 PowerShell/schannel 的 TLS 问题，用 python urllib 抓。
   1) GPT-SoVITS 源码 zip（codeload.github.com，实测 200 可达）
   2) hf-mirror 上的 GPT-SoVITS 权重清单探测
   全程写盘，不抓子进程 stdout。"""
import json
import os
import sys
import time
import urllib.request
import zipfile

ROOT = r"F:\qqbot\.models\gpt-sovits"
ZIP = os.path.join(ROOT, "src.zip")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) local-tts/1.0"}


def fetch(url, dest=None, limit=None, timeout=120):
    t0 = time.time()
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read() if limit is None else r.read(limit)
        code = r.status
    dt = time.time() - t0
    if dest:
        with open(dest, "wb") as f:
            f.write(data)
    return code, len(data), dt


def main():
    os.makedirs(ROOT, exist_ok=True)
    print(f"[1] 下载源码 zip -> {ZIP}")
    url = "https://codeload.github.com/RVC-Boss/GPT-SoVITS/zip/refs/heads/main"
    try:
        code, n, dt = fetch(url, ZIP, timeout=600)
        print(f"    OK {code} {n/1024/1024:.1f} MB  {dt:.1f}s")
    except Exception as e:
        print(f"    FAIL {type(e).__name__}: {e}")
        return 2

    print("[2] 解压")
    try:
        with zipfile.ZipFile(ZIP) as z:
            names = z.namelist()
            top = sorted({n.split("/")[0] for n in names})
            print(f"    {len(names)} 个条目, 顶层={top}")
            z.extractall(ROOT)
        print(f"    解压到 {ROOT}\\{top[0] if top else '?'}")
    except Exception as e:
        print(f"    FAIL {type(e).__name__}: {e}")
        return 3

    print("[3] 探测 hf-mirror 权重可达性")
    probes = [
        "https://hf-mirror.com/lj1995/GPT-SoVITS/resolve/main/README.md",
        "https://hf-mirror.com/api/models/lj1995/GPT-SoVITS",
        "https://hf-mirror.com/lj1995/GPT-SoVITS/resolve/main/gsv-v2final-pretrained/s2G2333k.pth",
    ]
    for u in probes:
        try:
            code, n, dt = fetch(u, limit=4096, timeout=60)
            print(f"    OK   {code} {n}B {dt:.1f}s  {u}")
        except Exception as e:
            print(f"    FAIL {type(e).__name__}: {str(e)[:100]}  {u}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
