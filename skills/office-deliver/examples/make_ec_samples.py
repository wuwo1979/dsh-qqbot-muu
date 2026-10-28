#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_ec_samples.py — 造一份"像真的"电化学测试数据，给自测和示例用。

为什么要有它：电化学表格最大的坑不是文件格式，而是**口径**——比容量是按活性物质质量折算的
mAh/g、首圈库伦效率是放电/充电、倍率是同一批样品换电流。这里用一组自洽的参数（LFP 体系）
把常见五种表都造出来，字段名故意混用中英文+单位，用来检验 ec_data 的列识别和单位统一。

用法： python make_ec_samples.py --out <dir>
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

# 体系参数（LFP/硬碳扣式半电池，量级来自文献常见值）
Q_THEORY = 170.0      # mAh/g
Q_FIRST_DIS = 158.4   # 首圈放电比容量
CE_FIRST = 0.924      # 首圈库伦效率（放电/充电）
MASS_MG = 2.13        # 活性物质质量
AREA_CM2 = 1.13       # 极片面积


def gcd_curve(n: int = 240, seed: int = 7) -> pd.DataFrame:
    """恒流充放电一圈：0.2C，2.5~4.0 V，中间有 3.45 V 平台。"""
    rng = np.random.default_rng(seed)
    half = n // 2
    t_chg = np.linspace(0, 1800, half)                       # 秒
    soc = t_chg / t_chg[-1]
    u_chg = 2.5 + 1.5 * (0.55 * soc + 0.45 / (1 + np.exp(-(soc - 0.55) * 26)))
    t_dis = np.linspace(1800, 3600, n - half)
    soc2 = (t_dis - t_dis[0]) / (t_dis[-1] - t_dis[0])
    u_dis = 4.0 - 1.5 * (0.55 * soc2 + 0.45 / (1 + np.exp(-(soc2 - 0.55) * 26)))
    u = np.concatenate([u_chg, u_dis])
    t = np.concatenate([t_chg, t_dis])
    # 容量按时间线性增长再回落（半电池：充电升容量、放电降容量）
    q_chg = soc * Q_FIRST_DIS / CE_FIRST
    q_dis = (1 - soc2) * Q_FIRST_DIS
    q = np.concatenate([q_chg, q_dis])
    i = np.concatenate([np.full(half, 0.2 * Q_THEORY * MASS_MG / 1000),
                        np.full(n - half, -0.2 * Q_THEORY * MASS_MG / 1000)])
    u = u + rng.normal(0, 0.0015, size=u.shape)
    return pd.DataFrame({
        "时间(s)": np.round(t, 1),
        "电位(V)": np.round(u, 4),
        "电流(mA)": np.round(i, 4),
        "容量(mAh)": np.round(q, 3),
    })


def cycle_table(cycles: int = 300, seed: int = 11) -> pd.DataFrame:
    """循环性能：前 5 圈活化，之后线性衰减 + 轻微波动，CE 稳定在 99.5% 附近。"""
    rng = np.random.default_rng(seed)
    n = np.arange(1, cycles + 1)
    fade = 1 - 0.00042 * (n - 1) - 0.010 * np.exp(-(n - 1) / 8)
    q = Q_FIRST_DIS * fade + rng.normal(0, 0.22, size=n.shape)
    ce = np.clip(CE_FIRST + (0.995 - CE_FIRST) * (1 - np.exp(-(n - 1) / 3))
                 + rng.normal(0, 0.0009, size=n.shape), 0.88, 1.0)
    return pd.DataFrame({
        "循环序号": n,
        "放电比容量(mAh/g)": np.round(q, 2),
        "库伦效率(%)": np.round(ce * 100, 2),
    })


def rate_table(seed: int = 13) -> pd.DataFrame:
    """倍率性能：0.2C~5C，回到 0.2C 时恢复率 ~97%。"""
    rng = np.random.default_rng(seed)
    rates = ["0.2C", "0.5C", "1C", "2C", "5C", "0.2C(回)"]
    base = [Q_FIRST_DIS, 148.2, 131.6, 108.4, 64.7, 153.5]
    rows = []
    for r, q in zip(rates, base):
        for k in range(5):  # 每档测 5 圈
            rows.append({"倍率": r, "比容量(mAh/g)": round(q + rng.normal(0, 0.8), 2)})
    return pd.DataFrame(rows)


def eis_table(seed: int = 17) -> pd.DataFrame:
    """EIS：Rs 2.1 Ω，半圆直径≈Rct 46 Ω，低频拖尾。"""
    rng = np.random.default_rng(seed)
    f = np.logspace(5, -2, 46)                    # 100 kHz ~ 0.01 Hz
    w = 2 * np.pi * f
    rs, rct, cpe = 2.1, 46.0, 3.1e-3
    zr = rs + rct / (1 + (w * rct * cpe) ** 2)
    zi = rct * (w * rct * cpe) / (1 + (w * rct * cpe) ** 2)
    # 低频拖尾（扩散）
    zr = zr + 6.5 / np.sqrt(w / (2 * np.pi) + 1e-6) * 0.06
    zi = zi + 7.5 / np.sqrt(w / (2 * np.pi) + 1e-6) * 0.06
    zr = zr + rng.normal(0, 0.12, size=f.shape)
    zi = zi + rng.normal(0, 0.12, size=f.shape)
    return pd.DataFrame({
        "Frequency(Hz)": [f"{x:.4g}" for x in f],
        "Z'(ohm)": np.round(zr, 3),
        "-Z''(ohm)": np.round(zi, 3),
    })


def cv_table(scan: float = 0.2, seed: int = 19) -> pd.DataFrame:
    """CV：3.45 V 氧化峰 / 3.32 V 还原峰，扫速 0.2 mV/s。"""
    rng = np.random.default_rng(seed)
    e_up = np.linspace(2.5, 4.0, 260)
    e_dn = np.linspace(4.0, 2.5, 260)
    i_up = 0.08 * np.exp(-((e_up - 3.45) ** 2) / (2 * 0.045 ** 2)) + 0.004 * (e_up - 3.3)
    i_dn = -0.065 * np.exp(-((e_dn - 3.32) ** 2) / (2 * 0.05 ** 2)) + 0.003 * (e_dn - 3.3)
    e = np.concatenate([e_up, e_dn])
    i = np.concatenate([i_up, i_dn]) * scan / 0.2
    return pd.DataFrame({"电位(V)": np.round(e, 3), "电流(mA)": np.round(i + rng.normal(0, 2e-4, size=e.shape), 5)})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "ec-samples"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    files = {
        "gcd.csv": gcd_curve(),
        "cycle.csv": cycle_table(),
        "rate.csv": rate_table(),
        "eis.csv": eis_table(),
        "cv.csv": cv_table(),
    }
    for name, df in files.items():
        p = os.path.join(a.out, name)
        df.to_csv(p, index=False, encoding="utf-8-sig")
        print(f"{p}  {len(df)} 行  {list(df.columns)}")
    meta = {"Q_FIRST_DIS": Q_FIRST_DIS, "CE_FIRST": CE_FIRST, "MASS_MG": MASS_MG, "AREA_CM2": AREA_CM2}
    print("参数：", meta)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
