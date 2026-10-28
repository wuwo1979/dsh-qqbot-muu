#!/usr/bin/env python
"""人声分离：Demucs 拆轨；没装 Demucs 时降级成 ffmpeg 中置消音（karaoke）。

产物固定两个名字，供 pipeline 使用：
    <outdir>/vocals.wav          人声（给 RVC 换声用）
    <outdir>/instrumental.wav    伴奏（混音用）

用法:
    python scripts/split.py --input song.mp3 --outdir F:\\qqbot\\tmp\\sing
    python scripts/split.py --input song.mp3 --outdir w --mode center-cancel
    python scripts/split.py --input song.mp3 --outdir w --dry-run     # 只打印计划

6GB 显存的实际建议（README 明说默认参数约需 7GB）:
    --segment 7  +  PYTORCH_NO_CUDA_MEMORY_CACHING=1   ← 本脚本自动设这个 env
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import Step, find_ffmpeg, human_size, log, reconfigure_io, run  # noqa: E402

MAX_SEGMENT = 7.8  # htdemucs 系列的硬上限，超了 demucs 自己会报错


def demucs_available() -> bool:
    return importlib.util.find_spec("demucs") is not None


def demucs_cmd_prefix() -> list[str]:
    """返回启动 demucs 的命令前缀：优先控制台脚本，退回 python -m。"""
    exe = shutil.which("demucs")
    if exe:
        return [exe]
    return [sys.executable, "-m", "demucs"]


def _ffmpeg_stem(ffmpeg: str, src: Path, dst: Path, pan: str) -> None:
    """用 pan 滤镜抽 mid(side)。没有 ffprobe，采样率交给 ffmpeg 自动处理。"""
    cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
              "-i", str(src), "-af", pan, "-ac", "2", str(dst)])
    if cp.returncode != 0:
        raise RuntimeError(f"ffmpeg 中置分离失败: {(cp.stderr or '').strip()[-800:]}")


def center_cancel(ffmpeg: str, src: Path, outdir: Path) -> tuple[Path, Path]:
    """降级方案：中置消音。

    L-R（side）里中置的人声被抵消 → 当伴奏；L+R（mid）留人声但也带鼓和贝斯。
    质量远不如 Demucs，胜在 0 依赖、几秒钟出结果 —— 6GB 卡/没网时的保命路。

    实测坑：side 信号天然是反相的（R ≈ -L），任何 mono 下混（QQ 语音条、手机外放、
    某些播放器）都会把它抵消成静音。所以这里把 side 收成单声道再复制两遍，
    用"丢掉立体声宽度"换"在哪里都能听见"。
    """
    instrumental = outdir / "instrumental.wav"
    vocals = outdir / "vocals.wav"
    # side: 去掉中置（人声）→ 收成 mono → 复制成双声道（mono-safe）
    _ffmpeg_stem(ffmpeg, src, instrumental,
                 "pan=mono|c0=0.5*c0-0.5*c1,volume=2.0,pan=stereo|c0=c0|c1=c0")
    # mid: 留下中置；人声在那，但鼓/贝斯也在（给 RVC 够用）
    _ffmpeg_stem(ffmpeg, src, vocals, "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1")
    return vocals, instrumental


def demucs_separate(ffmpeg: str, src: Path, outdir: Path, model: str,
                    segment: float, device: str, overlap: float, shifts: int) -> tuple[Path, Path]:
    """跑 demucs --two-stems=vocals，再把产物改回固定名字。"""
    raw = outdir / "_demucs"
    cmd = demucs_cmd_prefix() + [
        "--two-stems=vocals",
        "-n", model,
        "--segment", f"{segment:g}",
        "--overlap", f"{overlap:g}",
        "--shifts", str(shifts),
        "-d", device,
        "-o", str(raw),
        str(src),
    ]
    env = {}
    if device.startswith("cuda"):
        # 官方 README：显存不够时这个变量能让低显存卡也跑起来
        env["PYTORCH_NO_CUDA_MEMORY_CACHING"] = "1"
    cp = run(cmd, timeout=7200, env=env)
    if cp.returncode != 0:
        tail = (cp.stderr or cp.stdout or "").strip()[-1500:]
        raise RuntimeError(f"demucs 失败(rc={cp.returncode}):\n{tail}")

    # 产物位置: <raw>/<model>/<track>/vocals.wav
    cands = sorted(raw.rglob("vocals.wav"))
    if not cands:
        raise RuntimeError(f"demucs 跑完了但没找到 vocals.wav（在 {raw} 下）")
    v_src = cands[0]
    track_dir = v_src.parent
    inst_src = track_dir / "no_vocals.wav"
    if not inst_src.is_file():
        raise RuntimeError(f"没找到 no_vocals.wav（{inst_src}）")

    vocals = outdir / "vocals.wav"
    instrumental = outdir / "instrumental.wav"
    shutil.copyfile(v_src, vocals)
    shutil.copyfile(inst_src, instrumental)
    return vocals, instrumental


def main(argv: list[str] | None = None) -> int:
    reconfigure_io()
    ap = argparse.ArgumentParser(description="Demucs 拆轨 / ffmpeg 中置消音")
    ap.add_argument("--input", required=True, help="整首歌（或任何带伴奏的音频）")
    ap.add_argument("--outdir", required=True, help="产物目录")
    ap.add_argument("--mode", choices=["auto", "demucs", "center-cancel"], default="auto")
    ap.add_argument("--model", default="htdemucs",
                    help="htdemucs(默认) / htdemucs_ft(慢4倍质量略好) / htdemucs_6s / mdx / mdx_q")
    ap.add_argument("--segment", type=float, default=7.0, help=f"段长秒，上限 {MAX_SEGMENT}")
    ap.add_argument("--device", default="auto", help="auto / cuda / cpu")
    ap.add_argument("--overlap", type=float, default=0.25, help="降质换速度可给 0.1")
    ap.add_argument("--shifts", type=int, default=1, help=">1 会成倍变慢，只在质量优先时用")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    src = Path(args.input).expanduser()
    if not src.is_file():
        raise SystemExit(f"输入不存在: {src}")
    outdir = Path(args.outdir).expanduser()
    outdir.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()

    mode = args.mode
    if mode == "auto":
        mode = "demucs" if demucs_available() else "center-cancel"
    if mode == "demucs" and not demucs_available():
        raise SystemExit("指定了 --mode demucs 但没装 demucs。装法: python -m pip install -U demucs")

    segment = min(max(1.0, args.segment), MAX_SEGMENT)
    device = args.device
    if device == "auto":
        device = "cuda"
        try:
            run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=15)
        except Exception:  # noqa: BLE001
            device = "cpu"

    log(f"输入   : {src}  ({human_size(src.stat().st_size)})")
    log(f"模式   : {mode}" + (f"  model={args.model} segment={segment:g}s device={device}" if mode == "demucs" else "  (ffmpeg 中置消音降级)"))
    log(f"输出到 : {outdir}")
    if mode == "center-cancel":
        log("! 降级模式只对**立体声**有用；如果原曲人声不在正中，消不干净。要真质量请装 Demucs。")

    if args.dry_run:
        log("[dry-run] 不执行")
        return 0

    st = Step()
    st.begin("split")
    if mode == "demucs":
        vocals, instrumental = demucs_separate(ffmpeg, src, outdir, args.model,
                                               segment, device, args.overlap, args.shifts)
    else:
        vocals, instrumental = center_cancel(ffmpeg, src, outdir)

    st.end(**{
        "out": str(vocals.parent),
        "bytes": {"vocals": vocals.stat().st_size, "instrumental": instrumental.stat().st_size},
        "mode": mode,
        "note": f"vocals={human_size(vocals.stat().st_size)} instrumental={human_size(instrumental.stat().st_size)}",
    })
    log(f"vocals       -> {vocals}")
    log(f"instrumental -> {instrumental}")
    if args.json:
        st.dump(args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
