"""自测：造合成数据 → 出三件套 → 结构体检（可选真渲染）。

    python selftest.py                 # 只做结构体检
    python selftest.py --render        # 再渲染成图（需要 danger-full-access）
    python selftest.py --keep          # 保留输出目录路径打印出来

为什么要合成数据：真实实验数据往往不方便进仓库，而"能不能算对"必须可复现。
这里的曲线都按已知参数生成（首圈容量、保持率、ΔEp、Rs 都写死在下面），
所以指标算错时人会立刻发现。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(os.path.dirname(HERE), "samples")
PY = sys.executable

# 合成数据的"真值"，看输出对不对就知道算法有没有跑偏
TRUTH = {
    "cycle_first": 156.0,
    "cycle_last": 138.0,
    "cv_dEp": 0.17,
    "eis_rs": 0.9,
    "rate_5C": 66.0,
}


def _sfx(name: str, mass: float = 2.13) -> None:
    rng = np.random.default_rng(7)
    if name == "cycle.csv":
        n = 300
        cap = np.linspace(TRUTH["cycle_first"], TRUTH["cycle_last"], n) + rng.normal(0, 0.08, n)
        cap[0] = TRUTH["cycle_first"]
        ce = np.clip(99.2 + rng.normal(0, 0.35, n), 96, 100.5)
        ce[:3] = [72.0, 91.5, 97.4]
        rows = ["循环序号,比容量(mAh/g),库伦效率(%)"]
        rows += [f"{i + 1},{cap[i]:.2f},{ce[i]:.2f}" for i in range(n)]
    elif name == "rate.csv":
        rates, caps = ["0.2C", "0.5C", "1C", "2C", "5C", "0.2C(回)"], [160, 150, 132, 109, TRUTH["rate_5C"], 155]
        rows = ["倍率,比容量(mAh/g)"]
        for r, c in zip(rates, caps):
            for _ in range(3):
                rows.append(f"{r},{c + rng.normal(0, 0.6):.2f}")
    elif name == "gcd.csv":
        rows = ["时间(min),电位(V),容量(mAh/g)"]
        t, u, q = 0.0, 4.0, 0.0
        for i in range(240):
            t += 1.0
            u = max(2.5, u - 0.0125) if i < 120 else min(4.0, u + 0.0125)
            q += 0.7
            rows.append(f"{t:.0f},{u:.3f},{q:.2f}")
    elif name == "cv.csv":
        rows = ["电位(V),电流(mA)"]
        for e in np.concatenate([np.linspace(2.5, 4.0, 260), np.linspace(4.0, 2.5, 260)]):
            i = 0.08 * np.exp(-((e - 3.45) ** 2) / 0.006) - 0.06 * np.exp(-((e - 3.28) ** 2) / 0.006)
            rows.append(f"{e:.4f},{i + rng.normal(0, 0.0006):.5f}")
    elif name == "eis.csv":
        rng2 = np.logspace(5, -1, 40)
        zre = 1.0 + 0.010 / (rng2 ** 0.5) + 30 / (1 + (rng2 / 8) ** 2)
        zim = 0.010 / (rng2 ** 0.5) + 30 * (rng2 / 8) / (1 + (rng2 / 8) ** 2) + 0.002 * rng2
        rows = ["频率(Hz),Z'(Ω),-Z''(Ω)"]
        rows += [f"{f:.4g},{a:.4f},{b:.4f}" for f, a, b in zip(rng2, zre, zim)]
    else:
        return
    os.makedirs(SAMPLES, exist_ok=True)
    with open(os.path.join(SAMPLES, name), "w", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + "\n")


def main() -> int:
    render = "--render" in sys.argv
    for name in ("cycle.csv", "rate.csv", "gcd.csv", "cv.csv", "eis.csv"):
        if not os.path.exists(os.path.join(SAMPLES, name)):
            _sfx(name)
    out = os.path.join(tempfile.gettempdir(), f"office-selftest-{os.getpid()}")
    os.makedirs(out, exist_ok=True)
    print(f"输出目录 {out}")

    rc = subprocess.run([PY, os.path.join(HERE, "make_report.py"), "--title", "自测：电化学三件套",
                         "--in", SAMPLES, "--out", out, "--mass", "2.13", "--area", "1.13"],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(rc.stdout.strip()[-1200:])
    if rc.returncode != 0:
        print("make_report 失败：", rc.stderr.strip()[-1500:])
        return 1

    sys.path.insert(0, HERE)
    import verify as V  # noqa: E402

    fns = {".docx": V.verify_docx, ".xlsx": V.verify_xlsx, ".pptx": V.verify_pptx}
    bad = 0
    for name in sorted(os.listdir(out)):
        ext = os.path.splitext(name)[1].lower()
        if ext not in fns:
            continue
        r = fns[ext](os.path.join(out, name))
        errs = [i for i in r.get("issues", []) if i.get("level") == "error"]
        warns = [i for i in r.get("issues", []) if i.get("level") == "warning"]
        print(f"{name}: error={len(errs)} warning={len(warns)} {os.path.getsize(os.path.join(out, name)) / 1024:.1f}KB")
        for it in errs + warns:
            print("   ", it.get("level"), it.get("where", ""), it.get("msg"))
        bad += len(errs)

    if render:
        for name in sorted(os.listdir(out)):
            ext = os.path.splitext(name)[1].lower()
            if ext not in fns:
                continue
            sub = os.path.join(out, "render-" + ext.strip("."))
            r = subprocess.run(["node", os.path.join(HERE, "render.mjs"), os.path.join(out, name),
                                "--engine", "com", "--out", sub, "--json"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            print(f"render {name}: rc={r.returncode} {r.stdout.strip()[:200]}")
            bad += 0 if r.returncode == 0 else 1

    print("结论：", "全部通过" if bad == 0 else f"{bad} 个问题")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
