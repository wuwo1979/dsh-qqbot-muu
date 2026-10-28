#!/usr/bin/env python
"""探测 voice-sing 跑起来缺什么，并打印**准确的**安装命令。

用法:
    python scripts/check_env.py
    python scripts/check_env.py --json F:\\qqbot\\tmp\\voice-sing-env.json

退出码: 0 = 整条管线可跑（含降级模式）；2 = 连降级模式都缺东西。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    file_size, find_ffmpeg, find_ffprobe, human_size, log, probe_duration,
    reconfigure_io, run, torch_info,
)

# RVC 推理必需权重（HF 上实测真实字节数，hf-mirror 可下）
RVC_ASSETS = {
    "hubert_base.pt": 189_507_909,
    "rmvpe.pt": 181_184_272,
}
# RVC 训练用底模（不训练就不用下）
RVC_TRAIN_ASSETS = {
    "pretrained_v2/f0G40k.pth": 73_106_273,
    "pretrained_v2/f0D40k.pth": 142_875_703,
}
MODEL_ROOTS = [
    Path(r"F:\qqbot\.models\rvc"),
    Path(r"F:\qqbot\.models\demucs"),
]
DEMUCS_TORCH_HUB = Path(os.environ.get("TORCH_HOME", str(Path.home() / ".cache" / "torch"))) / "hub" / "checkpoints"


def head(title: str) -> None:
    log("")
    log(f"== {title} ==")


def main() -> int:
    reconfigure_io()
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    missing_install: list[str] = []
    blockers: list[str] = []
    report: dict = {}

    # ---------- 1. Python / 包 ----------
    head("Python 与依赖")
    log(f"python   : {sys.version.split()[0]}  ({sys.executable})")
    pkgs = torch_info()
    report["python"] = sys.version.split()[0]
    report["packages"] = pkgs

    torch_ver = None
    if pkgs["torch"]:
        try:
            import torch  # noqa: F401
            torch_ver = torch.__version__
            log(f"torch    : {torch.__version__}")
            report["torch"] = torch.__version__
        except Exception as exc:  # noqa: BLE001
            log(f"torch    : 装了但 import 失败 -> {exc!r}")
            report["torch_import_error"] = repr(exc)
            torch_ver = "broken"
    else:
        log("torch    : 缺失（必须，Demucs 和 RVC 都要）")

    for mod in ("torchaudio", "demucs", "rvc_python", "onnxruntime"):
        log(f"{mod:<9}: {'有' if pkgs[mod] else '缺'}")

    if not pkgs["torch"]:
        missing_install.append("E:\\Anaconda\\python.exe -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu118")
    if not pkgs["torchaudio"]:
        missing_install.append("E:\\Anaconda\\python.exe -m pip install torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu118")

    # ---------- 2. GPU ----------
    head("GPU")
    try:
        cp = run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,driver_version",
                  "--format=csv,noheader,nounits"])
        line = (cp.stdout or "").strip().splitlines()[0]
        name, total, used, drv = [x.strip() for x in line.split(",")]
        log(f"{name}  {total}MiB 已用{used}MiB  driver {drv}")
        report["gpu"] = {"name": name, "total_mib": int(total), "used_mib": int(used), "driver": drv}
        if int(total) < 4096:
            log("! 显存 < 4GB：Demucs 必须加 --segment 3~5 且开 PYTORCH_NO_CUDA_MEMORY_CACHING=1")
    except Exception as exc:  # noqa: BLE001
        log(f"没拿到 nvidia-smi 信息（{exc.__class__.__name__}）→ 只能跑 CPU")
        report["gpu"] = None

    # ---------- 3. ffmpeg ----------
    head("ffmpeg")
    try:
        ffmpeg = find_ffmpeg()
        cp = run([ffmpeg, "-hide_banner", "-version"])
        ver = (cp.stdout or "").splitlines()[0]
        log(f"ffmpeg   : {ver}")
        log(f"path     : {ffmpeg}")
        report["ffmpeg"] = {"path": ffmpeg, "version": ver}
        cp = run([ffmpeg, "-hide_banner", "-filters"])
        need = ["loudnorm", "ebur128", "amix", "volume", "pan", "aresample", "atempo", "asetrate"]
        have = {n: (f" {n} " in (cp.stdout or "")) for n in need}
        miss = [k for k, v in have.items() if not v]
        log(f"filters  : {'全有' if not miss else '缺 ' + ','.join(miss)}")
        report["ffmpeg_filters"] = have
        if miss:
            blockers.append(f"ffmpeg 缺滤镜 {miss}，混音/响度功能不可用")
    except Exception as exc:  # noqa: BLE001
        log(f"ffmpeg   : 不可用 -> {exc}")
        blockers.append("ffmpeg 不可用，整条管线无法运行")
        report["ffmpeg"] = None

    ffprobe = find_ffprobe()
    log(f"ffprobe  : {ffprobe or '没有（正常，时长走 ffmpeg -i 兜底解析）'}")
    report["ffprobe"] = ffprobe

    # ---------- 4. RVC 权重 ----------
    head("RVC 权重 / 模型")
    found_assets: dict[str, str] = {}
    for fname, expect in RVC_ASSETS.items():
        hit = None
        for root in MODEL_ROOTS:
            cand = root / fname
            if cand.is_file():
                hit = cand
                break
        if hit:
            sz = file_size(hit)
            ok = abs(sz - expect) < 1_000_000
            log(f"{fname:<16} 有  {human_size(sz)}  {'✓' if ok else '! 大小和官方不符(expect ' + human_size(expect) + ')'}")
            found_assets[fname] = str(hit)
        else:
            log(f"{fname:<16} 缺  (官方 {human_size(expect)})")
    report["rvc_assets"] = found_assets

    # 用户的 RVC 模型 (.pth + 可选 .index)
    user_models = []
    for root in MODEL_ROOTS:
        if root.is_dir():
            for pth in sorted(root.rglob("*.pth")):
                if pth.name in {Path(k).name for k in RVC_TRAIN_ASSETS} or pth.name in RVC_ASSETS:
                    continue
                if "pretrained" in pth.parts:
                    continue
                idx = list(pth.parent.glob("*.index"))
                user_models.append({"pth": str(pth), "index": str(idx[0]) if idx else None,
                                    "mb": round(file_size(pth) / 1048576, 1)})
    if user_models:
        for m in user_models:
            log(f"音色模型  {m['pth']}  {m['mb']}MB  index={'有' if m['index'] else '无'}")
    else:
        log("音色模型  没有（F:\\qqbot\\.models\\rvc\\<名字>\\<名字>.pth 放这里）")
    report["rvc_models"] = user_models

    # ---------- 5. Demucs 权重 ----------
    head("Demucs 权重")
    demucs_files = []
    if DEMUCS_TORCH_HUB.is_dir():
        demucs_files = [p.name for p in DEMUCS_TORCH_HUB.glob("*.th")] + \
                       [p.name for p in DEMUCS_TORCH_HUB.glob("*.pt")]
    if demucs_files:
        log(f"torch hub 里已有: {', '.join(demucs_files)}")
    else:
        log(f"没有（首次跑 demucs 会自动下到 {DEMUCS_TORCH_HUB}，htdemucs 约 80MB）")
    report["demucs_weights"] = demucs_files

    # ---------- 6. 小测试：ffmpeg 合成 1 秒正弦并读时长 ----------
    head("ffmpeg 冒烟测试")
    if report.get("ffmpeg"):
        import tempfile
        tmp = Path(tempfile.gettempdir()) / "voice-sing-smoke.wav"
        try:
            cp = run([find_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
                      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", str(tmp)])
            dur = probe_duration(tmp)
            log(f"合成 1s 正弦 → {dur:.2f}s, {human_size(file_size(tmp))}   ✓")
            report["smoke"] = {"ok": True, "duration": dur}
            tmp.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            log(f"冒烟测试失败: {exc}")
            report["smoke"] = {"ok": False, "error": str(exc)}

    # ---------- 7. 结论 ----------
    head("结论")
    ffmpeg_ok = bool(report.get("ffmpeg"))
    demucs_ok = pkgs["demucs"] and (torch_ver not in (None, "broken"))
    rvc_ok = pkgs["rvc_python"] and (torch_ver not in (None, "broken"))
    asset_ok = len(found_assets) == len(RVC_ASSETS)

    log(f"人声分离 Demucs : {'可跑' if demucs_ok else '缺包 → 会降级成 ffmpeg 中置消音'}")
    log(f"换声 RVC        : {'可跑' if (rvc_ok and asset_ok) else '缺包/缺权重 → 会降级成 ffmpeg 变调(可爱模式)'}")
    log(f"混音 -14 LUFS   : {'可跑' if ffmpeg_ok else '不可用'}")

    log("")
    log("[精确安装命令]")
    install_cmds = list(missing_install)
    if not pkgs["demucs"]:
        install_cmds.append("E:\\Anaconda\\python.exe -m pip install -U demucs")
        log("  # demucs 4.1.0 实测冲突警告：它会把 torchaudio 拉版本，建议装在独立 venv")
        install_cmds.append("python -m venv F:\\qqbot\\.venv-sing ; F:\\qqbot\\.venv-sing\\Scripts\\python.exe -m pip install torch==2.1.1 torchaudio==2.1.1 --index-url https://download.pytorch.org/whl/cu118")
    if not pkgs["rvc_python"]:
        install_cmds.append("E:\\Anaconda\\python.exe -m pip install rvc-python   # 或装进独立 venv（推荐，见 SKILL.md）")
    if not asset_ok:
        log("  # RVC 权重（hf-mirror，实测可连通；直连 huggingface.co 在本机会失败）")
        for fname in RVC_ASSETS:
            install_cmds.append(
                f"curl -L -o F:\\qqbot\\.models\\rvc\\{fname} https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/{fname}")
    if not user_models:
        log("  # 小蓝音色 RVC 模型：需要自己训练（见 SKILL.md「训练」一节）")

    for c in install_cmds:
        log("  " + c)
    report["install"] = install_cmds
    report["ok"] = ffmpeg_ok and not blockers
    report["degraded"] = {"demucs": not demucs_ok, "rvc": not (rvc_ok and asset_ok)}

    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"\n报告已写入 {args.json}")

    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
