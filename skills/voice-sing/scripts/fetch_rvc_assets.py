# -*- coding: utf-8 -*-
"""下载 RVC 推理资源（hubert / rmvpe / pretrained_v2）+ 两个现成音色模型。

全部走 hf-mirror.com（本机 curl/IWR 的 schannel 坏了，只有 python urllib 能连）。
支持断点续传（.part → rename），失败逐条打印原因、不中断其他项。

用法：
  python fetch_rvc_assets.py            # 下全部
  python fetch_rvc_assets.py hubert     # 只下某组（hubert/rmvpe/pretrained/voices）
"""
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

ROOT = r"F:\qqbot\.models"
ASSETS = os.path.join(ROOT, "rvc-assets")
VOICES = os.path.join(ROOT, "rvc-voices")

# 上游仓库（HF）→ 本地路径
BASE_CORE = "https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/"
BASE_VOICE = "https://hf-mirror.com/1358Adrian/so-vits-svc-rvc-models/resolve/main/"

TARGETS = {
    "hubert": [
        (BASE_CORE + "hubert_base.pt", os.path.join(ASSETS, "hubert_base.pt")),
    ],
    "rmvpe": [
        (BASE_CORE + "rmvpe.pt", os.path.join(ASSETS, "rmvpe.pt")),
    ],
    # 只训练要 base；推理其实不需要，留着以后微调用（RUNBOOK 里写明）
    "pretrained": [
        (BASE_CORE + "pretrained_v2/f0G40k.pth", os.path.join(ASSETS, "pretrained_v2", "f0G40k.pth")),
        (BASE_CORE + "pretrained_v2/D40k.pth", os.path.join(ASSETS, "pretrained_v2", "D40k.pth")),
    ],
    "voices": [
        # 软糯：原神 砂糖（怯生生、气声多）
        (BASE_VOICE + "RVC_v2_Public_Models/sucrose_e100_s5400.pth",
         os.path.join(VOICES, "sucrose-luomi", "sucrose_e100_s5400.pth")),
        (BASE_VOICE + "RVC_v2_Public_Models/added_IVF902_Flat_nprobe_1_sucrose_v2.index",
         os.path.join(VOICES, "sucrose-luomi", "added_IVF902_Flat_nprobe_1_sucrose_v2.index")),
        # 飒爽：原神 雷电将军（御姐、稳、有威压）
        (BASE_VOICE + "RVC_v2_Public_Models/ei_raiden_e110_s5060.pth",
         os.path.join(VOICES, "raiden-asa", "ei_raiden_e110_s5060.pth")),
    ],
}


def human(n):
    return f"{n / 2**20:.1f}MB"


def fetch(url, dest, retries=3):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
            if have:
                req.add_header("Range", f"bytes={have}-")
            with urllib.request.urlopen(req, timeout=60) as r:
                total = r.headers.get("Content-Length")
                total = int(total) + have if total else None
                mode = "ab" if (have and r.status == 206) else "wb"
                if mode == "wb":
                    have = 0
                got = have
                t0 = time.time()
                last = 0.0
                with open(tmp, mode) as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        now = time.time()
                        if now - last > 5:
                            last = now
                            pct = f"{100.0 * got / total:.1f}%" if total else "?"
                            spd = (got - have) / max(now - t0, 0.1) / 2**20
                            print(f"    {pct} {human(got)} / {human(total) if total else '?'} "
                                  f"@ {spd:.1f}MB/s", flush=True)
            size = os.path.getsize(tmp)
            if total and size < total:
                raise IOError(f"不完整 {human(size)}/{human(total)}")
            shutil.move(tmp, dest)
            print(f"[OK] {dest} ({human(size)})", flush=True)
            return True
        except Exception as e:  # noqa: BLE001
            have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
            print(f"[重试 {attempt}/{retries}] {os.path.basename(dest)}: {e!r}（已有 {human(have)}）",
                  flush=True)
            time.sleep(2 * attempt)
    print(f"[FAIL] {dest} <- {url}", flush=True)
    return False


def main():
    groups = sys.argv[1:] or list(TARGETS)
    ok = bad = 0
    for g in groups:
        for url, dest in TARGETS[g]:
            if os.path.exists(dest) and os.path.getsize(dest) > 1024:
                print(f"[SKIP] 已存在 {dest} ({human(os.path.getsize(dest))})", flush=True)
                ok += 1
                continue
            print(f"[GET] {url}", flush=True)
            if fetch(url, dest):
                ok += 1
            else:
                bad += 1
    print(f"\n完成：{ok} 个成功 / {bad} 个失败", flush=True)
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
