"""
fetch_sd15.py — 下载 SD1.5 系单文件模型（比 sd-turbo 2 步糊图质量高得多）

用法：
  python fetch_sd15.py --dest F:/qqbot/.models/counterfeit3 --repo gsdf/Counterfeit-V3.0 --file Counterfeit-V3.0_fp16.safetensors
  python fetch_sd15.py --list gsdf/Counterfeit-V3.0        # 只列文件
"""
import argparse
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HOME", "F:/qqbot/.hf")
os.environ.setdefault("HF_HUB_CACHE", "F:/qqbot/.hf/hub")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import hf_hub_download, HfApi  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--file", default="")
    ap.add_argument("--dest", default="")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    api = HfApi()
    if args.list or not args.file:
        files = api.list_repo_files(args.repo)
        for f in files:
            print(f)
        if not args.file:
            return 0

    os.makedirs(args.dest, exist_ok=True)
    p = hf_hub_download(repo_id=args.repo, filename=args.file, cache_dir=os.environ["HF_HUB_CACHE"])
    size = os.path.getsize(p)
    out = os.path.join(args.dest, os.path.basename(args.file))
    with open(p, "rb") as src, open(out, "wb") as dst:
        while True:
            chunk = src.read(1024 * 1024 * 8)
            if not chunk:
                break
            dst.write(chunk)
    print("OK -> " + out)
    print("bytes = %.1f MB" % (size / 1024 / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
