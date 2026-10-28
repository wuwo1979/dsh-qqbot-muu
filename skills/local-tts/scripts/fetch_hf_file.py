#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 hf-mirror 直链下载单个文件，支持 Range 断点续传与多轮重试。

用法：
  python fetch_hf_file.py <repo> <repo内路径> <本地绝对路径>

例：
  python fetch_hf_file.py lj1995/GPT-SoVITS chinese-roberta-wwm-ext-large/config.json \
      F:/qqbot/.models/gpt-sovits/GPT-SoVITS-main/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/config.json

为什么不用 huggingface_hub / modelscope：本机 PowerShell 走 schannel 全挂，
只有 python urllib 能通 hf-mirror；而且单连接常被腰斩，必须能续传。
"""
import os
import sys
import time
import urllib.error
import urllib.request

MIRROR = "https://hf-mirror.com"
UA = {"User-Agent": "local-tts-fetch/1.0"}
BLOCK = 1 << 20


def head_size(url):
    req = urllib.request.Request(url, headers=UA, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers.get("Content-Length") or 0)


def fetch_once(url, path, total):
    have = os.path.getsize(path) if os.path.exists(path) else 0
    if total and have >= total:
        return True
    hdrs = dict(UA)
    if have:
        hdrs["Range"] = "bytes=%d-" % have
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=120) as r:
        mode = "ab" if have else "wb"
        if have and r.status != 206:
            mode, have = "wb", 0
        with open(path, mode) as f:
            while True:
                chunk = r.read(BLOCK)
                if not chunk:
                    break
                f.write(chunk)
                have += len(chunk)
                if total:
                    sys.stdout.write("\r  %s %.1f%% (%.0f/%.0f MB)"
                                     % (os.path.basename(path), 100.0 * have / total,
                                        have / 1048576.0, total / 1048576.0))
                    sys.stdout.flush()
    print()
    return (not total) or os.path.getsize(path) >= total


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2
    repo, remote, local = argv[1], argv[2], argv[3]
    url = "%s/%s/resolve/main/%s" % (MIRROR, repo, remote)
    d = os.path.dirname(local)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    try:
        total = head_size(url)
    except Exception as exc:  # noqa: BLE001
        print("HEAD 失败（继续盲下）: %r" % (exc,))
        total = 0
    for i in range(1, 7):
        try:
            if fetch_once(url, local, total):
                print("OK %s (%d B)" % (local, os.path.getsize(local)))
                return 0
        except Exception as exc:  # noqa: BLE001
            print("第 %d 轮中断: %r" % (i, exc))
            time.sleep(1.5 * i)
    print("FAIL %s" % local)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
