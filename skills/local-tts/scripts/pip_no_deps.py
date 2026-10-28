#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在没有 MSVC、pip 解析器还会回溯的机器上，把 GPT-SoVITS 依赖装进 venv。

策略：`pip install --no-deps --only-binary=:all:` **逐个** 装 —— 完全跳过依赖解析
（解析器会看见 venv 里 anaconda-base.pth 暴露出来的几百个包，然后无限回溯）。
缺的传递依赖在 import 阶段会直接报 ModuleNotFoundError，再单独补即可。

    python scripts/pip_no_deps.py --dry-run
    python scripts/pip_no_deps.py
    python scripts/pip_no_deps.py --extra scipy soundfile nltk
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

VENV_PY = r"F:\qqbot\.models\gpt-sovits\.venv\Scripts\python.exe"
REQ = r"F:\qqbot\.models\gpt-sovits\requirements-min.txt"
MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"

# requirements-min.txt 里被 "本地桩 / 平台无关" 处理掉的包
SKIP = {
    "pyopenjtalk",   # 无 win wheel，用 site-packages\pyopenjtalk.py 桩
    "jieba_fast",    # 无 cp311 wheel，用 site-packages\jieba_fast 桩（转口 jieba）
    "jieba-fast",
    "python_mecab_ko",
    "torch",
    "torchaudio",    # 走 anaconda-base.pth 复用 Anaconda 的 cu118 版
}

DEFAULT_EXTRA = ["soundfile", "nltk", "lazy-loader", "audioread", "pooch", "soxr",
                 "lightning-utilities", "torchmetrics", "llvmlite", "numba",
                 "pydantic-core", "starlette", "anyio", "sniffio", "h11", "click",
                 "httpx", "httpcore", "certifi", "idna", "python-multipart",
                 "typing-extensions", "packaging", "pyyaml", "tqdm", "requests",
                 "regex", "joblib", "threadpoolctl", "fonttools", "kiwisolver",
                 "cycler", "pyparsing", "python-dateutil", "pillow"]


def read_lines(path):
    out = []
    if not os.path.isfile(path):
        return out
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#") or s.startswith("--"):
                continue
            name = s.split("=")[0].split("<")[0].split(">")[0].split("!")[0].strip()
            if name and name not in SKIP:
                out.append(s)
    return out


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--req", default=REQ)
    ap.add_argument("--python", default=VENV_PY)
    ap.add_argument("--extra", nargs="*", default=DEFAULT_EXTRA)
    a = ap.parse_args(argv)

    if not os.path.isfile(a.python):
        print(f"没找到 venv python：{a.python}")
        return 2
    pkgs = read_lines(a.req)
    seen = set(x.split("=")[0].lower() for x in pkgs)
    for e in a.extra:
        if e.lower() not in seen:
            pkgs.append(e)
            seen.add(e.lower())
    print(f"待装 {len(pkgs)} 个包（--no-deps --only-binary :all:）")

    failed = []
    logf = r"F:\qqbot\tmp\pip-nodeps.log"
    for p in pkgs:
        cmd = [a.python, "-m", "pip", "install", "--no-deps", "--only-binary", ":all:",
               "--progress-bar", "off", "-i", MIRROR, p]
        if a.dry_run:
            print("would:", " ".join(cmd[3:7]), p)
            continue
        # 关键：不用 capture_output（沙箱里子进程管道会 EPERM），改成重定向到文件
        with open(logf, "ab") as lf:
            lf.write(f"\n\n===== {p} =====\n".encode("utf-8"))
            lf.flush()
            r = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, timeout=900)
        if r.returncode != 0:
            tail = ""
            try:
                with open(logf, "rb") as lf:
                    blob = lf.read()[-4000:].decode("utf-8", "replace")
                for line in blob.splitlines():
                    if "ERROR" in line or "error:" in line:
                        tail = line
            except Exception:  # noqa: BLE001
                pass
            failed.append((p, tail))
            print("  FAIL " + p + (f"  ← {tail[:120]}" if tail else ""))
        else:
            print("  ok   " + p)
    print(f"\n完成：{len(pkgs) - len(failed)}/{len(pkgs)} 成功（日志 {logf}）")
    for p, m in failed:
        print(f"  失败 {p}: {m[:200]}")
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
