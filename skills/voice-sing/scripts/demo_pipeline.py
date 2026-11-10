# -*- coding: utf-8 -*-
"""唱歌链路一键跑：demucs 拆人声/伴奏 → RVC 换声 → ffmpeg 混成 mp3。

必须在 F:\\qqbot\\.models\\voice-sing-venv 的 python 下跑（要 torch/demucs/rvc_python）：

    F:\\qqbot\\.models\\voice-sing-venv\\Scripts\\python.exe scripts\\demo_pipeline.py ^
        --song F:\\qqbot\\tmp\\sing-demo2\\song.wav ^
        --voice luomi=F:\\qqbot\\.models\\rvc-voices\\sucrose-luomi\\sucrose_e100_s5400.pth^
               |=F:\\qqbot\\.models\\rvc-voices\\sucrose-luomi\\added_IVF902_Flat_nprobe_1_sucrose_v2.index ^
        --voice asa=F:\\qqbot\\.models\\rvc-voices\\raiden-asa\\ei_raiden_e110_s5060.pth ^
        --pitch luomi=0 --pitch asa=-2 ^
        --out-prefix F:\\qqbot\\tmp\\sing-demo

显存：6GB 卡上 demucs 与 RVC 都要吃显存，**先 `ollama stop` 掉常驻模型**再跑；
--segment 7 给 demucs 降峰值（RVC 本身显存占用很小）。
"""

from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
from pathlib import Path

FFMPEG = Path(r"F:\qqbot\.venv-draw\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe")
ASSETS = Path(r"F:\qqbot\.models\rvc-assets")


def run(args, log_path, timeout=5400):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    # RVC 的 faiss 索引 + torch 在 Windows 上会 OpenMP 死锁（表现为几十秒的音频跑十几分钟、
    # GPU 30% 空转）；把 OpenMP 线程限到 1 即可，实测 10s 音频 11s 出结果。
    env.setdefault("OMP_NUM_THREADS", "1")
    env.setdefault("MKL_NUM_THREADS", "1")
    env.setdefault("HF_HOME", r"F:\qqbot\tmp\hf-cache")
    # demucs 的权重默认下到 C:\Users\...\.cache\torch（沙箱不可写 → PermissionError），
    # 指到仓库内目录，权重用 scripts\dl.py 预先下好。
    env.setdefault("TORCH_HOME", r"F:\qqbot\tmp\torch-home")
    with open(log_path, "ab") as fh:
        fh.write(f"\n\n===== {' '.join(map(str, args))} =====\n".encode("utf-8"))
        fh.flush()
        cp = subprocess.run([str(a) for a in args], stdout=fh, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=env, timeout=timeout)
    print(f"  -> rc={cp.returncode} (log {log_path})", flush=True)
    return cp.returncode


def to_wav(src: Path, dst: Path, sr=44100, mono=True):
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn",
           "-ar", str(sr)]
    if mono:
        cmd += ["-ac", "1"]
    cmd += ["-c:a", "pcm_s16le", dst]
    subprocess.run([str(c) for c in cmd], check=True, stdin=subprocess.DEVNULL)


PROBE_LOG = Path(r"F:\qqbot\tmp\sing-probe.log")


def probe_seconds(path: Path) -> float:
    # 本机执行环境不允许创建管道（CreatePipe → WinError 5），所以 ffmpeg 的 stderr 落到文件再读。
    PROBE_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(PROBE_LOG, "wb") as fh:
        subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)],
                       stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT)
    try:
        text = PROBE_LOG.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return 0.0
    for line in text.splitlines():
        if "Duration:" in line:
            hh, mm, ss = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(hh) * 3600 + int(mm) * 60 + float(ss)
    return 0.0


def estimate_shift(vocals: Path, target_hz: float, lo: int, hi: int) -> tuple:
    """用 yin 估原曲人声的中位基频，算出「往目标基频靠」需要几个半音。

    RVC 只移调、不搬共振峰，所以升得越多越尖——这里把上限定死，宁可不那么童。
    返回 (半音, 原曲中位 Hz)；估不出来就 (0, 0)。
    """
    try:
        import numpy as np
        import librosa
        y, sr = librosa.load(str(vocals), sr=16000, mono=True, duration=90)
        f0 = librosa.yin(y, fmin=80, fmax=800, sr=sr)
        f0 = f0[np.isfinite(f0) & (f0 > 80) & (f0 < 800)]
        if f0.size < 50:
            return 0, 0.0
        med = float(np.median(f0))
        shift = 12.0 * math.log2(target_hz / med)
        return int(max(lo, min(hi, round(shift)))), med
    except Exception as exc:  # noqa: BLE001
        print(f"  [auto-pitch] 估音高失败（{type(exc).__name__}: {exc}），回落固定半音")
        return None, 0.0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True)
    ap.add_argument("--voice", action="append", default=[], help="名字=模型.pth[|索引.index]")
    ap.add_argument("--pitch", action="append", default=[], help="名字=半音")
    ap.add_argument("--out-prefix", default=r"F:\qqbot\tmp\sing-demo")
    ap.add_argument("--workdir", default=r"F:\qqbot\tmp\sing-demo-work")
    ap.add_argument("--device", default="cuda:0")
    # 2026-11-09 六调：唱歌必须用 harvest。rmvpe 是给说话的，歌声里长音/颤音会八度误判，
    # 出来就是「死鬼索命」那种忽高忽低的怪腔。harvest 对歌声稳得多（慢一点，值得）。
    ap.add_argument("--method", default="harvest", choices=["harvest", "rmvpe", "pm", "crepe"])
    ap.add_argument("--segment", type=int, default=7, help="demucs 分段长度（6GB 卡用 7）")
    ap.add_argument("--skip-demucs", action="store_true")
    # 2026-11-09 五调：固定半音是「一首行、换一首就翻车」的根因——不同歌的人声音域差太多，
    # 同一首歌里原唱可能是童声（本来就高），再升 3 度必然发尖。改成按原曲人声中位基频
    # 自动算：往目标基频靠，并夹在 [lo, hi] 里。
    ap.add_argument("--auto-pitch", type=float, default=0.0,
                    help="自动音高：目标人声基频 Hz（0=关闭，用 --pitch 的固定值）")
    ap.add_argument("--auto-lo", type=int, default=-2, help="自动音高下限（半音）")
    ap.add_argument("--auto-hi", type=int, default=4, help="自动音高上限（半音）")
    args = ap.parse_args(argv)

    song = Path(args.song)
    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    log = work / "pipeline.log"
    py = sys.executable

    # ---- 1. demucs 拆人声 ----
    stems = work / "htdemucs" / song.stem
    vocals = stems / "vocals.wav"
    inst = stems / "no_vocals.wav"
    if not args.skip_demucs or not vocals.exists():
        print("[1/3] demucs 拆人声 ...", flush=True)
        rc = run([py, "-m", "demucs", "-n", "htdemucs", "--two-stems", "vocals",
                  "--segment", str(args.segment), "-o", work, song], log)
        if rc != 0 or not vocals.exists():
            print("  demucs 失败，退化为整段当人声（伴奏为空）")
            vocals.parent.mkdir(parents=True, exist_ok=True)
            to_wav(song, vocals)
            inst = None
    print(f"  人声: {vocals} ({probe_seconds(vocals):.2f}s)", flush=True)
    if inst and inst.exists():
        print(f"  伴奏: {inst} ({probe_seconds(inst):.2f}s)", flush=True)

    # ---- 2. RVC 换声 ----
    pitches = dict(x.split("=", 1) for x in args.pitch)
    outs = []
    for spec in args.voice:
        name, rest = spec.split("=", 1)
        model, _, index = rest.partition("|")
        dst = work / f"conv-{name}.wav"
        pitch = pitches.get(name, "0")
        if args.auto_pitch and args.auto_pitch > 0:
            auto, med = estimate_shift(vocals, args.auto_pitch, args.auto_lo, args.auto_hi)
            if auto is not None:
                pitch = str(auto)
                print(f"  自动音高：原曲人声中位 {med:.0f}Hz → 目标 {args.auto_pitch:.0f}Hz"
                      f" = {auto:+d} 半音（夹在 {args.auto_lo:+d}~{args.auto_hi:+d}）", flush=True)
        print(f"[2/3] RVC 换声 {name} (pitch={pitch}) ...", flush=True)
        cmd = [py, "-m", "rvc_python", "cli",
               "-i", str(vocals), "-o", str(dst), "-mp", model,
               "-de", args.device, "-me", args.method, "-pi", pitch,
               # 2026-11-09 四调：目标是「童真、纯净清亮、少沙感」。沙感 = 换声颗粒 + 高频嘶声。
               # index_rate 0.75→0.5（index 拉满颗粒最明显）、filter_radius 3→7（多轮中值平滑，
               # 去沙最有效的旋钮）、rms_mix_rate 0.33→0.25（别把音量包络电子化）、protect 0.5→0.33
               # （护住清辅音和气声，咬字才不发糊）。
               "-ir", "0.5", "-fr", "7", "-rmr", "0.25", "-pr", "0.33"]
        if index:
            cmd += ["-ip", index]
        rc = run(cmd, log)
        if rc != 0 or not dst.exists():
            print(f"  {name} 换声失败，见日志 {log}")
            continue
        outs.append((name, dst))
        print(f"  -> {dst} ({probe_seconds(dst):.2f}s)", flush=True)

    # ---- 3. 混音 ----
    made = []
    for name, vocal in outs:
        out = Path(f"{args.out_prefix}-{name}.mp3")
        print(f"[3/3] 混音 {name} -> {out}", flush=True)
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", vocal]
        if inst and inst.exists():
            # 伴奏压到 -3dB 给人声让位；人声 mono 上抬成立体声，避免 amix 退化成单声道
            # 2026-11-09 四调：沙感很大一部分是换声残留的高频嘶声，微信语音条采样率
            # 只到 24k（Nyquist 12k），所以干脆 12k 低通掉——反正发出去也存不住，
            # 留着只会变成「沙」。deesser 也加了一档。
            # 2026-11-09 六调：afftdn 强降噪会把残留噪声修成「水声/幽灵感」——用户原话
            # 「像死鬼索命」，就是它干的。降到 nr=3 只削最底的嘶声，把人声留给 RVC 本身的质感。
            cmd += ["-i", inst, "-filter_complex",
                    "[0:a]aformat=channel_layouts=stereo,highpass=f=75,"
                    "afftdn=nr=3:nf=-55,"
                    "deesser=i=0.35:m=0.6:f=0.5,"
                    "equalizer=f=7500:t=q:w=1.2:g=-2,"
                    "lowpass=f=11500:poles=2,"
                    "alimiter=limit=0.92:level=false,volume=0.98[v];"
                    "[1:a]aformat=channel_layouts=stereo,volume=0.4[i];"
                    "[v][i]amix=inputs=2:duration=shortest:normalize=0,"
                    "loudnorm=I=-15:TP=-1.5:LRA=11:print_format=none,aresample=44100[out]",
                    "-map", "[out]"]
        else:
            cmd += ["-af", "aformat=channel_layouts=stereo"]
        cmd += ["-ar", "44100", "-b:a", "192k", str(out)]
        mix_err = work / "mix.err"
        with open(mix_err, "wb") as eh:
            cp = subprocess.run([str(c) for c in cmd], stdin=subprocess.DEVNULL,
                                stdout=eh, stderr=subprocess.STDOUT)
        if cp.returncode != 0:
            print("  混音失败:", mix_err.read_text(encoding="utf-8", errors="replace")[-600:])
            continue
        made.append(out)
        print(f"  成品: {out} ({probe_seconds(out):.2f}s, "
              f"{out.stat().st_size / 1024:.0f}KB)", flush=True)

    print("\n产出:")
    for p in made:
        print(" ", p)
    return 0 if made else 1


if __name__ == "__main__":
    raise SystemExit(main())
