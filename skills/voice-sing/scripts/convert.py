#!/usr/bin/env python
"""换声：把 <input> 的人声换成小蓝的音色。

三种模式，全部输出 44.1kHz wav：
    rvc         —— 真 RVC（需要 rvc-python + hubert_base.pt/rmvpe.pt + 小蓝的 .pth）
    pitch       —— ffmpeg 变调（零依赖，抬音高+共振峰，直接就有"可爱"味）
    passthrough —— 原样转码（只为了对齐格式/采样率）

用法:
    python scripts/convert.py --input vocals.wav --output out.wav \\
        --model F:\\qqbot\\.models\\rvc\\xiaolan\\xiaolan.pth --pitch 4
    python scripts/convert.py --input vocals.wav --output out.wav --mode pitch --pitch-semitones 5

为什么 --pitch 在 rvc 模式也要给 +：RVC 的 f0 升降（-pi 参数）是"把源音高当目标音高"，
女声原唱换到小蓝音色建议 +2~+5 半音，否则容易带出原唱的喉音。
"""

from __future__ import annotations

import argparse
import importlib.util
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import Step, find_ffmpeg, human_size, log, reconfigure_io, run  # noqa: E402

SAMPLE_RATE = 44100


def rvc_available() -> bool:
    return importlib.util.find_spec("rvc_python") is not None


def to_wav(ffmpeg: str, src: Path, dst: Path, *, sample_rate: int = SAMPLE_RATE) -> None:
    cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
              "-i", str(src), "-vn", "-ar", str(sample_rate), "-ac", "1",
              "-c:a", "pcm_s16le", str(dst)])
    if cp.returncode != 0:
        raise RuntimeError(f"转 wav 失败: {(cp.stderr or '').strip()[-800:]}")


def pitch_shift(ffmpeg: str, src: Path, dst: Path, semitones: float) -> None:
    """变调不变速：asetrate 把音高和共振峰一起抬，aresample 回 44.1k，atempo 把时长拉回来。

    共振峰跟着走 → 就是"花栗鼠/小朋友"那种可爱感，正是这里要的。

    关键坑（实测踩到）：asetrate 是"把这堆采样当成 X Hz 来播"，所以必须先保证输入真的是
    44100 Hz —— ref_zh.wav 是 32000 Hz，直接套 44100 的公式会变成 +10 半音、时长还短掉 28%。
    所以这里先统一解成 44.1k 再算。
    """
    factor = 2.0 ** (semitones / 12.0)
    tempo = 1.0 / factor
    if not (0.5 <= tempo <= 2.0):
        raise RuntimeError(f"变调 {semitones} 半音超出 atempo 安全范围（{tempo:.3f}），请控制在 ±12 半音内")
    base = dst.parent / "_pitch_base.wav"
    to_wav(ffmpeg, src, base, sample_rate=SAMPLE_RATE)  # 先统一成 44.1k/单声道
    chain = (f"asetrate={int(SAMPLE_RATE * factor)},aresample={SAMPLE_RATE},"
             f"atempo={tempo:.6f}")
    cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
              "-i", str(base), "-vn", "-af", chain, "-ac", "1",
              "-c:a", "pcm_s16le", str(dst)])
    base.unlink(missing_ok=True)
    if cp.returncode != 0:
        raise RuntimeError(f"变调失败: {(cp.stderr or '').strip()[-800:]}")


def rvc_convert(ffmpeg: str, src: Path, dst: Path, model: Path, pitch: int,
                device: str, f0_method: str, index_rate: float,
                protect: float, rms_mix_rate: float) -> None:
    """调 rvc_python 的 CLI。它内部自己管模型加载/重采样，输入给 wav 最稳。"""
    if not model.is_file():
        raise RuntimeError(f"RVC 模型不存在: {model}")
    work = dst.parent / "_rvc_in.wav"
    # 2026-10-27: 这里原来是 16000 —— 16k 进去等于先把 8kHz 以上砍掉，RVC 换完还是"原唱但发闷"，
    # 主人直接听成"就是原声直出"。RVC 只需要 16k 来提 f0 特征，音频本身要给完整的 44.1k。
    to_wav(ffmpeg, src, work, sample_rate=44100)
    cmd = [sys.executable, "-m", "rvc_python", "cli",
           "-i", str(work), "-o", str(dst),
           "-mp", str(model),
           "-de", device,
           "-me", f0_method,
           "-pi", str(pitch),
           "-ir", f"{index_rate:g}",
           "-pr", f"{protect:g}",
           "-rmr", f"{rms_mix_rate:g}"]
    cp = run(cmd, timeout=3600, quiet=False)
    if cp.returncode != 0:
        tail = (cp.stderr or cp.stdout or "").strip()[-2000:]
        hint = ""
        if "weights_only" in tail or "UnpicklingError" in tail:
            hint = ("\n提示: torch>=2.6 默认 weights_only=True，RVC 老 .pth 会加载失败。"
                    "\n修法 A: 用独立 venv 装 torch==2.1.1（推荐，见 SKILL.md）"
                    "\n修法 B: 在 rvc_python 里把 torch.load 改成 weights_only=False")
        if "No module named" in tail:
            hint = "\n提示: 缺依赖。装法: python -m pip install rvc-python"
        raise RuntimeError(f"rvc_python 失败(rc={cp.returncode}):\n{tail}{hint}")
    if not dst.is_file() or dst.stat().st_size == 0:
        raise RuntimeError(f"rvc_python 返回 0 但没产出文件: {dst}")
    work.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    reconfigure_io()
    ap = argparse.ArgumentParser(description="换声：RVC / ffmpeg 变调 / 直通")
    ap.add_argument("--input", required=True, help="人声 wav（split.py 的 vocals.wav）")
    ap.add_argument("--output", required=True)
    ap.add_argument("--mode", choices=["auto", "rvc", "pitch", "passthrough"], default="auto")
    ap.add_argument("--model", default=None, help="RVC .pth（auto 模式下没有就降级 pitch）")
    ap.add_argument("--pitch", type=int, default=4, help="RVC 模式: 升降半音（-pi）")
    ap.add_argument("--pitch-semitones", type=float, default=5.0,
                    help="pitch 模式: 变调半音，+5 是「可爱小女孩」档")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--f0-method", default="rmvpe", choices=["rmvpe", "harvest", "crepe", "pm"])
    ap.add_argument("--index-rate", type=float, default=0.75)
    # protect 越低越像目标音色（更"换声"），越高越保原唱咬字；0.33 换完主人说像原声，降到 0.25。
    ap.add_argument("--protect", type=float, default=0.25)
    ap.add_argument("--rms-mix-rate", type=float, default=0.25)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    src = Path(args.input).expanduser()
    if not src.is_file():
        raise SystemExit(f"输入不存在: {src}")
    dst = Path(args.output).expanduser()
    dst.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg()

    mode = args.mode
    model = Path(args.model).expanduser() if args.model else None
    if mode == "auto":
        if rvc_available() and model and model.is_file():
            mode = "rvc"
        elif rvc_available() and not model:
            log("! 没给 --model，RVC 用不了 → 降级 pitch 模式")
            mode = "pitch"
        elif not rvc_available():
            log("! 没装 rvc-python → 降级 pitch 模式（零依赖变调）")
            mode = "pitch"
        else:
            log(f"! 模型不存在 {model} → 降级 pitch 模式")
            mode = "pitch"

    log(f"输入 : {src} ({human_size(src.stat().st_size)})")
    log(f"输出 : {dst}")
    if mode == "rvc":
        log(f"模式 : rvc  model={model} pitch={args.pitch:+d}半音 f0={args.f0_method} device={args.device}")
    elif mode == "pitch":
        log(f"模式 : pitch  {args.pitch_semitones:+.1f} 半音（共振峰一起抬，零依赖）")
    else:
        log("模式 : passthrough")

    if args.dry_run:
        log("[dry-run] 不执行")
        return 0

    st = Step()
    st.begin("convert")
    if mode == "rvc":
        if not rvc_available():
            raise SystemExit("--mode rvc 但没装 rvc-python: python -m pip install rvc-python")
        if not model:
            raise SystemExit("--mode rvc 必须给 --model")
        rvc_convert(ffmpeg, src, dst, model, args.pitch, args.device,
                    args.f0_method, args.index_rate, args.protect, args.rms_mix_rate)
    elif mode == "pitch":
        pitch_shift(ffmpeg, src, dst, args.pitch_semitones)
    else:
        to_wav(ffmpeg, src, dst)

    st.end(**{"out": str(dst), "bytes": dst.stat().st_size, "mode": mode,
              "note": f"{human_size(dst.stat().st_size)}"})
    if args.json:
        st.dump(args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
