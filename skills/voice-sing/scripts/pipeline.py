#!/usr/bin/env python
"""一条命令跑完：拆轨 → 换声 → 混音 → mp3。

最常用（拿原曲的伴奏，把人声换成小蓝）:
    python scripts/pipeline.py --vocal song.mp3 --song song.mp3 --out out.mp3

自己已经有干声（比如小蓝 TTS 唱段）+ 另一首歌的伴奏:
    python scripts/pipeline.py --vocal my_vocal.wav --song beat.mp3 --out out.mp3

只想听"变可爱"的效果（不装任何模型，纯 ffmpeg 变调）:
    python scripts/pipeline.py --vocal vocals.wav --pitch-semitones 5 --out out.mp3

先看计划不执行:
    python scripts/pipeline.py --vocal a.mp3 --song b.mp3 --out c.mp3 --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import convert as convert_mod  # noqa: E402
import mix as mix_mod  # noqa: E402
import split as split_mod  # noqa: E402
from common import Step, file_size, human_size, log, reconfigure_io  # noqa: E402

DEFAULT_WORKROOT = Path(r"F:\qqbot\tmp\sing-work")


def _call(name: str, fn, argv: list[str]) -> None:
    try:
        rc = fn(argv)
    except SystemExit as exc:  # argparse / 脚本内的 SystemExit
        msg = str(getattr(exc, "code", exc))
        if msg in ("0", "None"):
            return
        raise RuntimeError(f"{name} 失败: {msg}") from None
    if rc:
        raise RuntimeError(f"{name} 返回 {rc}")


def main(argv: list[str] | None = None) -> int:
    reconfigure_io()
    ap = argparse.ArgumentParser(description="拆轨→换声→混音→mp3 一条龙")
    ap.add_argument("--vocal", required=True, help="人声来源（原曲 或 已有干声）")
    ap.add_argument("--song", default=None, help="伴奏来源（整首歌，会自动拆轨拿伴奏）；不给则只处理人声")
    ap.add_argument("--out", required=True, help="输出 mp3")
    ap.add_argument("--workdir", default=None, help=f"中间文件目录（默认 {DEFAULT_WORKROOT}\\<时间戳>）")
    ap.add_argument("--keep-work", action="store_true", help="保留中间 wav（默认也保留，方便调参）")

    ap.add_argument("--split-mode", choices=["auto", "demucs", "center-cancel"], default="auto")
    ap.add_argument("--demucs-model", default="htdemucs")
    ap.add_argument("--segment", type=float, default=7.0, help="Demucs 段长秒（6GB 卡给 7）")
    ap.add_argument("--device", default="auto", help="auto / cuda / cpu")

    ap.add_argument("--convert-mode", choices=["auto", "rvc", "pitch", "passthrough"], default="auto")
    ap.add_argument("--model", default=None, help="RVC 小蓝音色 .pth")
    ap.add_argument("--pitch", type=int, default=4, help="RVC 模式升降半音")
    ap.add_argument("--pitch-semitones", type=float, default=5.0, help="pitch 模式变调半音")
    ap.add_argument("--f0-method", default="rmvpe")
    ap.add_argument("--index-rate", type=float, default=0.5)

    ap.add_argument("--target", type=float, default=-14.0, help="目标 LUFS")
    ap.add_argument("--vocal-gain", type=float, default=0.0)
    ap.add_argument("--inst-gain", type=float, default=0.0)
    ap.add_argument("--vocal-offset", type=float, default=0.0)
    ap.add_argument("--duck", type=float, default=0.0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    vocal = Path(args.vocal).expanduser()
    if not vocal.is_file():
        raise SystemExit(f"--vocal 不存在: {vocal}")
    song = Path(args.song).expanduser() if args.song else None
    if song and not song.is_file():
        raise SystemExit(f"--song 不存在: {song}")
    out = Path(args.out).expanduser()
    if out.suffix.lower() != ".mp3":
        out = out.with_suffix(".mp3")
    out.parent.mkdir(parents=True, exist_ok=True)

    workdir = Path(args.workdir).expanduser() if args.workdir else \
        DEFAULT_WORKROOT / time.strftime("%Y%m%d-%H%M%S")
    workdir.mkdir(parents=True, exist_ok=True)

    same_track = bool(song) and song.resolve() == vocal.resolve()
    log("=" * 58)
    log(f"人声来源 : {vocal}")
    log(f"伴奏来源 : {song if song else '（无，输出只有人声）'}")
    log(f"中间目录 : {workdir}")
    log(f"输出     : {out}")
    if same_track:
        log("→ 人声和伴奏是同一首歌：拆一次轨，vocals 去换声、instrumental 去混音")
    log("=" * 58)

    json_paths: list[Path] = []
    dry = ["--dry-run"] if args.dry_run else []

    # ---------- 1. 拆轨 ----------
    vocal_for_convert = vocal
    instrumental: Path | None = None
    if song:
        j = workdir / "split.json"
        _call("split", split_mod.main, [
            "--input", str(song), "--outdir", str(workdir),
            "--mode", args.split_mode if not same_track or args.split_mode != "auto" else "auto",
            "--model", args.demucs_model,
            "--segment", f"{args.segment:g}",
            "--device", args.device,
            "--json", str(j), *dry,
        ])
        json_paths.append(j)
        instrumental = workdir / "instrumental.wav"
        if same_track:
            vocal_for_convert = workdir / "vocals.wav"
        elif not args.dry_run and instrumental.is_file():
            pass
    elif args.dry_run:
        log("[dry-run] 跳过拆轨")

    # ---------- 2. 换声 ----------
    converted = workdir / "converted.wav"
    j = workdir / "convert.json"
    _call("convert", convert_mod.main, [
        "--input", str(vocal_for_convert), "--output", str(converted),
        "--mode", args.convert_mode,
        *(["--model", str(Path(args.model).expanduser())] if args.model else []),
        "--pitch", str(args.pitch),
        "--pitch-semitones", str(args.pitch_semitones),
        "--f0-method", args.f0_method,
        "--index-rate", str(args.index_rate),
        "--device", "cuda:0" if args.device in ("auto", "cuda") else "cpu",
        "--json", str(j), *dry,
    ])
    json_paths.append(j)

    # ---------- 3. 混音 ----------
    j = workdir / "mix.json"
    mix_args = [
        "--vocal", str(converted), "--out", str(out),
        "--target", str(args.target),
        "--vocal-gain", str(args.vocal_gain),
        "--inst-gain", str(args.inst_gain),
        "--vocal-offset", str(args.vocal_offset),
        "--duck", str(args.duck),
        "--json", str(j), *dry,
    ]
    if instrumental is not None:
        mix_args += ["--instrumental", str(instrumental)]
    _call("mix", mix_mod.main, mix_args)
    json_paths.append(j)

    if args.dry_run:
        log("[dry-run] 计划完，没动文件")
        return 0

    # ---------- 4. 汇总 ----------
    steps: list[dict] = []
    for p in json_paths:
        try:
            steps.extend(json.loads(p.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            pass
    total = sum(s.get("seconds", 0) for s in steps)
    log("")
    log("=" * 58)
    log(f"产物 : {out}  {human_size(file_size(out))}")
    log(f"耗时 : 各步合计 {total:.1f}s")
    for s in steps:
        log(f"  - {s['step']:<8} {s.get('seconds', 0):>7.2f}s  {s.get('note', '')}")
    log(f"中间 : {workdir}")
    log("=" * 58)
    if args.json:
        Path(args.json).write_text(json.dumps({"output": str(out), "bytes": file_size(out),
                                               "total_seconds": round(total, 2),
                                               "workdir": str(workdir), "steps": steps},
                                              ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
