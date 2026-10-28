"""
fetch_direct.py — 直接从 hf-mirror 拉单文件权重（带进度、断点续传、卡住重试）

huggingface_hub 的 snapshot_download 在这台机器上会卡在 0 字节（xet/临时文件问题），
所以出图模型改用最土的办法：urllib + Range 续传。

用法：
  python fetch_direct.py --url https://hf-mirror.com/<repo>/resolve/main/<file>.safetensors --out F:/qqbot/.models/x/model.safetensors
"""
import argparse
import os
import sys
import time
import urllib.error
import urllib.request


def human(n):
    return "%.1f MB" % (n / 1024 / 1024)


def download(url, out, retries=6):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    total = 0
    for attempt in range(1, retries + 1):
        have = os.path.getsize(out) if os.path.exists(out) else 0
        req = urllib.request.Request(url, headers={"User-Agent": "qqbot-fetch/1.0"})
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                if have and r.status == 206:
                    mode = "ab"
                    print("[resume] from %s" % human(have))
                else:
                    if have:
                        print("[restart] server ignored Range, start over")
                    have = 0
                    mode = "wb"
                declared = r.headers.get("Content-Length")
                total = (int(declared) + have) if declared else 0
                t0 = time.time()
                last_print = 0.0
                chunk = 1024 * 1024
                with open(out, mode) as f:
                    got = have
                    while True:
                        buf = r.read(chunk)
                        if not buf:
                            break
                        f.write(buf)
                        got += len(buf)
                        now = time.time()
                        if now - last_print > 2:
                            last_print = now
                            speed = got / max(0.001, now - t0) / 1024 / 1024
                            pct = ("%.1f%%" % (100.0 * got / total)) if total else "?"
                            print("  %s / %s  %s  %.1f MB/s"
                                  % (human(got), human(total) if total else "?", pct, speed), flush=True)
                size = os.path.getsize(out)
                if total and size < total:
                    print("[warn] finished short: %d < %d" % (size, total))
                    continue
                print("OK -> %s (%s)" % (out, human(size)))
                return size
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            print("[retry %d/%d] %r" % (attempt, retries, e), flush=True)
            time.sleep(3)
    raise SystemExit("download failed after retries")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    download(args.url, args.out)


if __name__ == "__main__":
    main()
