# -*- coding: utf-8 -*-
"""通用断点续传下载器（本机只有 python urllib 能连外网）。

用法: python dl.py <url> <dest> [--retries 8] [--stall 60]
卡住检测：连续 stall 秒没有任何新字节就断开重连（pip 那次就是 socket 假活卡了 25 分钟）。
"""
import os
import sys
import time
import urllib.request

CHUNK = 1 << 20


def human(n):
    return f"{n / 2**20:.1f}MB"


def download(url, dest, retries=8, stall=60):
    os.makedirs(os.path.dirname(os.path.abspath(dest)), exist_ok=True)
    part = dest + ".part"
    for attempt in range(1, retries + 1):
        have = os.path.getsize(part) if os.path.exists(part) else 0
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
        if have:
            req.add_header("Range", f"bytes={have}-")
        try:
            with urllib.request.urlopen(req, timeout=stall) as r:
                total = r.headers.get("Content-Length")
                total = int(total) + have if total else None
                if have and r.status != 206:
                    have = 0
                mode = "ab" if have else "wb"
                got, t0, last = have, time.time(), time.time()
                with open(part, mode) as f:
                    while True:
                        chunk = r.read(CHUNK)
                        now = time.time()
                        if not chunk:
                            break
                        if now - last > stall:
                            raise IOError(f"stall {stall}s")
                        f.write(chunk)
                        got += len(chunk)
                        last = now
                        if now - t0 > 5:
                            pct = f"{100.0 * got / total:.1f}%" if total else "?"
                            print(f"  {pct} {human(got)}/{human(total) if total else '?'} "
                                  f"@ {(got - have) / max(now - t0, .1) / 2**20:.2f}MB/s",
                                  flush=True)
                            t0, have = now, got
            size = os.path.getsize(part)
            if total and size < total:
                raise IOError(f"不完整 {human(size)}/{human(total)}")
            os.replace(part, dest)
            print(f"[OK] {dest} {human(size)}", flush=True)
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[重试 {attempt}/{retries}] {e!r}", flush=True)
            time.sleep(min(30, 3 * attempt))
    print(f"[FAIL] {url}", flush=True)
    return False


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = {a.split("=")[0].lstrip("-"): a.split("=", 1)[1] for a in sys.argv[1:] if "=" in a}
    if len(args) < 2:
        print(__doc__)
        raise SystemExit(2)
    ok = download(args[0], args[1], retries=int(opts.get("retries", 8)),
                  stall=float(opts.get("stall", 60)))
    raise SystemExit(0 if ok else 1)
