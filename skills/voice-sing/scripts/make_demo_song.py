#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""造一条**完全自产**的试听歌（不碰任何版权素材）：人声轨 + 伴奏轨 → song.wav。

为什么要有这个脚本：
  `F:\\qqbot` 里没有任何可拆的现成歌曲（只有 TTS 参考音 ref_zh.wav / ref_zh_cute4.wav），
  所以试听链路的人声轨用「GSV 念的台词 + 变调排成旋律」，伴奏用 numpy 现场合成
  C-Am-F-G 的铺底 pad + 轻鼓。全流程零版权风险，且 melody/伴奏都是真音高，
  demucs 能正常拆出 vocals / instrumental —— 这样才能验"拆轨→换声→混音"整条链。

用法:
  python make_demo_song.py --vocal F:\\qqbot\\.models\\tts-ref\\ref_zh_cute4.wav \\
      --outdir F:\\qqbot\\tmp\\sing-demo2 --notes-melody
  # 只造伴奏（人声已有）:
  python make_demo_song.py --outdir ... --inst-only
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import find_ffmpeg, log, probe_duration, reconfigure_io, run  # noqa: E402

SR = 44100
NOTE_S = 0.62          # 每个音 0.62s ≈ 96BPM 的八分音符
NOTE_HZ = {"C4": 261.63, "D4": 293.66, "E4": 329.63, "G4": 392.00,
           "A4": 440.00, "C5": 523.25, "D5": 587.33, "G3": 196.00}


def read_wav(path: Path) -> tuple[list[float], int]:
    with wave.open(str(path), "rb") as w:
        nch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise RuntimeError(f"只吃 16bit wav: {path} (sampwidth={sw})")
    import array
    a = array.array("h")
    a.frombytes(raw)
    if nch == 2:
        a = array.array("h", [a[i] for i in range(0, len(a), 2)])
    return a.tolist(), sr


def write_wav(path: Path, samples, sr: int = SR, channels: int = 1) -> None:
    import array
    a = array.array("h", (max(-32768, min(32767, int(v))) for v in samples))
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(a.tobytes())


def med_f0(samples, sr: int) -> float:
    """粗估基频（自相关）。够用就行 —— 只是用来把段"掰"到目标音高，RVC 后面还会重算 f0。"""
    import numpy as np
    x = np.asarray(samples, dtype=np.float32)
    if x.size < 2048:
        return 0.0
    x = x - x.mean()
    win = x[: min(x.size, sr // 2)]
    corr = np.correlate(win, win, mode="full")[win.size - 1:]
    lo, hi = int(sr / 400), int(sr / 160)          # 女声 TTS 实测 160~400Hz；放宽会掉八度
    if hi >= corr.size:
        hi = corr.size - 1
    seg = corr[lo:hi]
    if seg.size == 0 or seg.max() <= 0:
        return 0.0
    lag = lo + int(seg.argmax())
    return sr / lag if lag else 0.0


def build_melody_voice(ffmpeg: str, vocal: Path, outdir: Path, notes: list[str],
                       workdir: Path) -> Path:
    """把整段 TTS 人声等分切 N 段，每段用 asetrate+atempo 掰到目标音，再拼成旋律。"""
    dur = probe_duration(vocal)
    n = len(notes)
    if dur / n < 0.12:
        raise RuntimeError(f"人声只有 {dur:.2f}s，切 {n} 段太碎；减少 --notes 或换长音频")
    seg = dur / n
    pieces: list[Path] = []
    for i, note in enumerate(notes):
        raw = workdir / f"seg{i:02d}.wav"
        run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
             "-ss", f"{i * seg:.3f}", "-t", f"{seg:.3f}", "-i", str(vocal),
             "-vn", "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(raw)])
        samples, sr = read_wav(raw)
        f0 = med_f0(samples, sr)
        target = NOTE_HZ[note]
        if f0 <= 0:
            ratio = 1.0
        else:
            ratio = target / f0
        ratio = max(0.5, min(2.0, ratio))
        # asetrate 抬音高（时长随之变短）→ atempo 补回原时长
        pitched = workdir / f"p{i:02d}.wav"
        chain = f"asetrate={int(SR * ratio)},aresample={SR},atempo={1.0 / ratio:.6f}"
        cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(raw),
                  "-af", chain, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(pitched)])
        if cp.returncode != 0:
            raise RuntimeError(f"变调失败 seg{i}: {cp.stderr[-400:]}")
        # 对齐到固定音长（短了补静音，长了切掉）
        fixed = workdir / f"n{i:02d}.wav"
        cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(pitched),
                  "-af", f"apad,atrim=0:{NOTE_S:.3f},afade=t=in:st=0:d=0.02,"
                         f"afade=t=out:st={NOTE_S - 0.06:.3f}:d=0.06",
                  "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(fixed)])
        if cp.returncode != 0:
            raise RuntimeError(f"对齐失败 seg{i}: {cp.stderr[-400:]}")
        pieces.append(fixed)
        log(f"  音符 {i + 1}/{n} {note} 源 f0≈{f0:.0f}Hz ×{ratio:.2f}")
    lst = workdir / "concat.txt"
    lst.write_text("\n".join(f"file '{p.as_posix()}'" for p in pieces), encoding="utf-8")
    melody = outdir / "melody.wav"
    cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat",
              "-safe", "0", "-i", str(lst), "-ac", "1", "-ar", str(SR),
              "-c:a", "pcm_s16le", str(melody)])
    if cp.returncode != 0:
        raise RuntimeError(f"拼接失败: {cp.stderr[-400:]}")
    log(f"人声轨: {melody} ({probe_duration(melody):.2f}s)")
    return melody


def midi_hz(m: int) -> float:
    return 440.0 * 2 ** ((m - 69) / 12.0)


def build_instrumental(ffmpeg: str, outdir: Path, seconds: float, bars: int = 2) -> Path:
    """C-Am-F-G 铺底 pad（三和弦叠加 + 慢包络）+ 每拍一个软 kick / 反拍 hi-hat。"""
    import numpy as np

    sr = SR
    total = int(seconds * sr) + 1
    buf = np.zeros(total, dtype=np.float32)
    bar_s = seconds / bars
    chords = [(-12, [60, 64, 67]), (-12, [57, 60, 64]), (-12, [53, 57, 60]), (-12, [55, 59, 62])]
    for b in range(bars):
        root_oct, notes = chords[b % len(chords)]
        t0 = b * bar_s
        for m in notes:
            f = midi_hz(m + root_oct + 12)
            n = int(bar_s * sr)
            t = np.arange(n) / sr
            env = np.minimum(1.0, t / 0.05) * np.minimum(1.0, (bar_s - t) / 0.25)
            wave_ = (0.14 * np.sin(2 * np.pi * f * t)
                     + 0.06 * np.sin(2 * np.pi * f * 2 * t)
                     + 0.03 * np.sin(2 * np.pi * f * 3 * t))
            s = int(t0 * sr)
            seg = (wave_ * env).astype(np.float32)
            buf[s:s + n] += seg[: buf[s:s + n].size]
    # 低音 root
    for b in range(bars):
        root = chords[b % len(chords)][1][0] - 24
        f = midi_hz(root)
        n = int(bar_s * sr)
        t = np.arange(n) / sr
        env = np.minimum(1.0, t / 0.03) * np.minimum(1.0, (bar_s - t) / 0.2)
        buf[int(b * bar_s * sr): int(b * bar_s * sr) + n] += (0.22 * np.sin(2 * np.pi * f * t) * env).astype(np.float32)
    # 鼓
    rng = np.random.default_rng(7)
    beat_s = bar_s / 4
    for i in range(int(bars * 4)):
        t0 = i * beat_s
        n = int(0.18 * sr)
        t = np.arange(n) / sr
        kick = 0.35 * np.sin(2 * np.pi * (90 * np.exp(-t * 18) + 45) * t) * np.exp(-t * 14)
        s = int(t0 * sr)
        buf[s:s + n] += kick[: buf[s:s + n].size].astype(np.float32)
        if i % 2 == 1:                      # 反拍 hi-hat
            n2 = int(0.06 * sr)
            t2 = np.arange(n2) / sr
            hat = 0.07 * rng.standard_normal(n2) * np.exp(-t2 * 90)
            s2 = int((t0 + beat_s / 2) * sr)
            buf[s2:s2 + n2] += hat[: buf[s2:s2 + n2].size].astype(np.float32)
    # 归一 + 立体声（右声道轻微延迟营造宽度）
    buf /= max(1e-6, float(np.abs(buf).max())) / 0.85
    delay = int(0.012 * sr)
    left = buf
    right = np.concatenate([np.zeros(delay, dtype=np.float32), buf[:-delay]]) * 0.92
    inter = np.empty(total * 2, dtype=np.float32)
    inter[0::2], inter[1::2] = left, right
    inst = outdir / "inst.wav"
    write_wav(inst, np.clip(inter * 32767, -32768, 32767), sr, 2)
    log(f"伴奏轨: {inst} ({seconds:.2f}s, C-Am-F-G)")
    return inst


def mix_song(ffmpeg: str, vocal: Path, inst: Path, out: Path) -> Path:
    cp = run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
              "-i", str(vocal), "-i", str(inst),
              "-filter_complex", "[0:a]volume=1.0,aresample=44100,apad[v];"
                                 "[1:a]volume=0.9,aresample=44100[i];"
                                 "[v][i]amix=inputs=2:duration=shortest:normalize=0[o]",
              "-map", "[o]", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(out)])
    if cp.returncode != 0:
        raise RuntimeError(f"混音失败: {cp.stderr[-400:]}")
    log(f"成品: {out} ({probe_duration(out):.2f}s)")
    return out


def main(argv: list[str] | None = None) -> int:
    reconfigure_io()
    ap = argparse.ArgumentParser(description="自产试听歌：人声轨 + 伴奏轨 → song.wav")
    ap.add_argument("--vocal", default=None, help="TTS 人声 wav（不给则只用 --sine 造静音人声）")
    ap.add_argument("--outdir", default=r"F:\qqbot\tmp\sing-demo2")
    ap.add_argument("--notes", default="C4,D4,E4,G4,A4,G4,E4,D4,C4,A4,G4,E4",
                    help="逗号分隔旋律音（每个 0.62s）")
    ap.add_argument("--extra-seconds", type=float, default=0.0)
    ap.add_argument("--inst-only", action="store_true")
    args = ap.parse_args(argv)

    ffmpeg = find_ffmpeg()
    outdir = Path(args.outdir)
    workdir = outdir / "work"
    workdir.mkdir(parents=True, exist_ok=True)

    if args.inst_only:
        build_instrumental(ffmpeg, outdir, 8.0)
        return 0

    if not args.vocal:
        raise SystemExit("--vocal 必填（或用 --inst-only）")
    vocal = Path(args.vocal)
    if not vocal.is_file():
        raise SystemExit(f"人声不存在: {vocal}")
    notes = [n.strip() for n in args.notes.split(",") if n.strip()]
    for n in notes:
        if n not in NOTE_HZ:
            raise SystemExit(f"未知音符 {n}（可选：{', '.join(NOTE_HZ)}）")

    melody = build_melody_voice(ffmpeg, vocal, outdir, notes, workdir)
    secs = probe_duration(melody) + args.extra_seconds
    inst = build_instrumental(ffmpeg, outdir, secs, bars=2)
    song = mix_song(ffmpeg, melody, inst, outdir / "song.wav")
    print(str(song))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
