#!/usr/bin/env python
"""混音落盘：换声后的人声 + 伴奏 → 一条 mp3，整体响度压到 -14 LUFS（流媒体/B站标准）。

    python scripts/mix.py --vocal conv.wav --instrumental inst.wav --out song.mp3

本机 ffmpeg 7.1 essentials 实测踩到的三个坑（都已处理）:
  1. loudnorm **必须显式写 print_format=summary/json**，否则这个 build 一声不吭，量不到输入响度。
  2. loudnorm 内部会把音频上采样到 192kHz，所以它后面要再 aresample 回 44100。
  3. 人声通常是 mono、伴奏是 stereo，amix 会退化成 mono → 两边都先 aformat=channel_layouts=stereo。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import Step, find_ffmpeg, human_size, log, probe_duration, reconfigure_io, run  # noqa: E402

RE_IN_I = re.compile(r"Input Integrated:\s*(-?\d+(?:\.\d+)?)")
RE_IN_TP = re.compile(r"Input True Peak:\s*(-?\d+(?:\.\d+)?)")
RE_OUT_I = re.compile(r"Output Integrated:\s*(-?\d+(?:\.\d+)?)")
RE_JSON = re.compile(r'"input_i"\s*:\s*"?(-?\d+(?:\.\d+)?)"?')
# ebur128 逐帧打印 "I: -120.7 LUFS"，只有最后的 summary 才是整段值 → 取最后一处
RE_EBU_I = re.compile(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS")
RE_EBU_TP = re.compile(r"Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS")


def parse_loudnorm(stderr: str) -> dict:
    out = {}
    for key, rx in (("input_i", RE_IN_I), ("input_tp", RE_IN_TP),
                    ("output_i", RE_OUT_I), ("input_i", RE_JSON)):
        if key in out:
            continue
        m = rx.search(stderr or "")
        if m:
            out[key] = float(m.group(1))
    return out


def measure(ffmpeg: str, path: Path) -> dict:
    """用 ebur128 量整条文件的 integrated loudness / true peak（取最后一个 summary）。"""
    cp = run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
              "-af", "ebur128=peak=true", "-f", "null", "-"])
    err = cp.stderr or ""
    i = RE_EBU_I.findall(err)
    tp = RE_EBU_TP.findall(err)
    res = {}
    if i:
        res["i"] = float(i[-1])
    if tp:
        res["tp"] = float(tp[-1])
    return res


def main(argv: list[str] | None = None) -> int:
    reconfigure_io()
    ap = argparse.ArgumentParser(description="人声+伴奏 混回 mp3，-14 LUFS")
    ap.add_argument("--vocal", required=True, help="换声后的人声 wav/mp3")
    ap.add_argument("--instrumental", default=None, help="伴奏；不给就只做人声归一化")
    ap.add_argument("--out", required=True, help="输出 .mp3（后缀会自动补）")
    ap.add_argument("--target", type=float, default=-14.0, help="目标 integrated LUFS（默认 -14）")
    ap.add_argument("--true-peak", type=float, default=-1.5, help="真峰值上限 dBTP")
    ap.add_argument("--lra", type=float, default=11.0)
    ap.add_argument("--vocal-gain", type=float, default=0.0, help="人声增益 dB（正=更突出）")
    ap.add_argument("--inst-gain", type=float, default=0.0, help="伴奏增益 dB")
    ap.add_argument("--vocal-offset", type=float, default=0.0, help="人声整体延迟秒（对齐用）")
    ap.add_argument("--duck", type=float, default=0.0, help=">0 时伴奏闪避（人声一响伴奏压电平），建议 4")
    ap.add_argument("--mp3-bitrate", default="192k")
    ap.add_argument("--no-verify", dest="verify", action="store_false", default=True,
                    help="跳过混音后再量一次的 ebur128")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    ffmpeg = find_ffmpeg()
    vocal = Path(args.vocal).expanduser()
    if not vocal.is_file():
        raise SystemExit(f"人声不存在: {vocal}")
    inst = Path(args.instrumental).expanduser() if args.instrumental else None
    if inst and not inst.is_file():
        raise SystemExit(f"伴奏不存在: {inst}")
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() != ".mp3":
        out = out.with_suffix(".mp3")

    vdur = probe_duration(vocal)
    idur = probe_duration(inst) if inst else 0.0
    log(f"人声 : {vocal}  {vdur:.2f}s  {human_size(vocal.stat().st_size)}")
    if inst:
        log(f"伴奏 : {inst}  {idur:.2f}s  {human_size(inst.stat().st_size)}")
    log(f"输出 : {out}  目标 {args.target} LUFS / TP {args.true_peak} dBTP")
    if inst and abs(vdur - idur) > 2.0:
        log(f"! 人声和伴奏时长差 {abs(vdur - idur):.2f}s，混音按最长走；要用 --vocal-offset 手动对齐")

    # ---- 滤镜图 ----
    norm = (f"loudnorm=I={args.target}:TP={args.true_peak}:LRA={args.lra}:print_format=summary,"
            f"aresample=44100")
    parts: list[str] = []
    vf = "[0:a]aresample=44100,aformat=channel_layouts=stereo"
    if args.vocal_gain:
        vf += f",volume={args.vocal_gain}dB"
    if args.vocal_offset > 0:
        ms = int(args.vocal_offset * 1000)
        vf += f",adelay={ms}|{ms}"
    parts.append(f"{vf}[v]")

    if inst:
        inf = "[1:a]aresample=44100,aformat=channel_layouts=stereo"
        if args.inst_gain:
            inf += f",volume={args.inst_gain}dB"
        if args.duck > 0:
            parts.append(f"{inf}[i0]")
            parts.append("[v]asplit=2[vm][vmain]")
            parts.append(f"[i0][vm]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[idu]")
            parts.append(f"[vmain][idu]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,{norm}[out]")
        else:
            parts.append(f"{inf}[i]")
            parts.append(f"[v][i]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0,{norm}[out]")
    else:
        parts.append(f"[v]{norm}[out]")
    filtergraph = ";".join(parts)
    log("滤镜 : " + filtergraph)

    cmd = [ffmpeg, "-y", "-hide_banner", "-i", str(vocal)]
    if inst:
        cmd += ["-i", str(inst)]
    cmd += ["-filter_complex", filtergraph, "-map", "[out]",
            "-c:a", "libmp3lame", "-b:a", args.mp3_bitrate, "-ar", "44100", "-ac", "2", str(out)]

    if args.dry_run:
        log("[dry-run] 不执行")
        return 0

    st = Step()
    st.begin("mix")
    cp = run(cmd, timeout=1800, quiet=False)
    if cp.returncode != 0:
        raise SystemExit(f"混音失败(rc={cp.returncode}):\n{(cp.stderr or '').strip()[-2000:]}")
    ln = parse_loudnorm(cp.stderr or "")
    st.end(**{"out": str(out), "bytes": out.stat().st_size,
              "mode": "amix+loudnorm" if inst else "loudnorm",
              "note": f"{human_size(out.stat().st_size)}"})

    measured = {}
    if args.verify:
        st.begin("verify")
        measured = measure(ffmpeg, out)
        st.end(**{"note": f"实测 integrated={measured.get('i')} LUFS  true_peak={measured.get('tp')} dBFS"})

    log("")
    log(f"完成 : {out}  ({human_size(out.stat().st_size)}, {probe_duration(out):.2f}s)")
    log(f"响度 : 混音前 {ln.get('input_i', '?')} LUFS / {ln.get('input_tp', '?')} dBTP"
        f" → loudnorm 报 {ln.get('output_i', '?')} LUFS"
        f" → ebur128 实测 {measured.get('i', '?')} LUFS")
    if args.json:
        st.dump(args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
