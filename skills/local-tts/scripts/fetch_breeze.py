#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Breeze TTS 2 落地下载器（Windows + 免编译路线）
  1) HoppouAI/Breeze-TTS-2.cpp 预编译 windows-x64-vulkan 二进制（Apache-2.0）
  2) q8_0 GGUF 权重（3.4GB，RTX 3060 上官方说约 1.2x 实时）
走 python urllib（PowerShell/schannel 在本机连不上 github；git clone 也失败）。
支持断点续传：重复运行会从已下载字节数继续。
"""
import json
import os
import sys
import time
import urllib.request
import zipfile

ROOT = r"F:\qqbot\.models\breeze-tts2"
REL = "https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases/download/v0.1.3"
ZIP_NAME = "breeze-tts-2-v0.1.3-windows-x64-vulkan.zip"
GGUF = ("breeze-tts-2-q8_0.gguf",
        "https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q8_0.gguf")
UA = {"User-Agent": "Mozilla/5.0 local-tts/1.0"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def download(url, dest, expect_mb=None, resume=True, chunk=1 << 20, timeout=120):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    have = os.path.getsize(dest) if (resume and os.path.exists(dest)) else 0
    headers = dict(UA)
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        mode = "ab" if (have and r.status == 206) else "wb"
        if mode == "wb":
            have = 0
        total = r.headers.get("Content-Length")
        total = int(total) + have if total else None
        last = 0
        with open(dest, mode) as f:
            while True:
                b = r.read(chunk)
                if not b:
                    break
                f.write(b)
                have += len(b)
                if have - last > 200 * 1024 * 1024:
                    last = have
                    dt = max(0.001, time.time() - t0)
                    log(f"    {have/1048576:.0f} MB" +
                        (f" / {total/1048576:.0f} MB" if total else "") +
                        f"  {len(b)/1048576 if False else (have/1048576)/dt:.2f} MB/s")
    dt = time.time() - t0
    size = os.path.getsize(dest)
    log(f"    done {size/1048576:.1f} MB in {dt:.1f}s ({(size-have)/1048576 if False else ''}"
        f"{size/1048576/max(dt,0.001):.2f} MB/s avg)")
    if expect_mb and abs(size / 1048576 - expect_mb) > expect_mb * 0.05:
        log(f"    WARN 大小 {size/1048576:.1f}MB 与预期 {expect_mb}MB 差得多")
    return size


def main():
    os.makedirs(ROOT, exist_ok=True)
    log(f"目标目录 {ROOT}")

    # 1) 预编译二进制
    zp = os.path.join(ROOT, ZIP_NAME)
    log("[1] 下载预编译 windows-x64-vulkan")
    if os.path.exists(zp) and os.path.getsize(zp) > 60 * 1024 * 1024:
        log(f"    已存在 {os.path.getsize(zp)/1048576:.1f} MB，跳过")
    else:
        download(f"{REL}/{ZIP_NAME}", zp, expect_mb=70.5)
    log("[2] 解压")
    try:
        with zipfile.ZipFile(zp) as z:
            names = z.namelist()
            log(f"    {len(names)} 个条目: {names[:8]}")
            z.extractall(ROOT)
    except Exception as e:
        log(f"    解压失败 {e}")
        return 3

    # 2) GGUF 权重
    name, url = GGUF
    gp = os.path.join(ROOT, name)
    log(f"[3] 下载 GGUF {name}")
    if os.path.exists(gp) and os.path.getsize(gp) > 3_000 * 1024 * 1024:
        log(f"    已存在 {os.path.getsize(gp)/1048576:.0f} MB，跳过")
    else:
        try:
            download(url, gp, expect_mb=3403.5)
        except Exception as e:
            log(f"    下载失败 {type(e).__name__}: {e}")
            return 4

    log("[4] 目录清单")
    for base, _d, files in os.walk(ROOT):
        for f in files:
            p = os.path.join(base, f)
            log(f"    {os.path.getsize(p)/1048576:9.1f} MB  {os.path.relpath(p, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
