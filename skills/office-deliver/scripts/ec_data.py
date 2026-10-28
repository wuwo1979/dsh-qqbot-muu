#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ec_data.py — 电化学表格数据的「读懂 → 算对 → 说清楚」。

它做的事不是"把表格塞进 Excel"，而是先判断这份数据到底在讲什么（CV / 恒流充放电 /
EIS / 循环 / 倍率），再按那个体系的物理意义算指标，最后把**口径和假设**写清楚——
因为电化学数据最容易错的不是公式，是单位（mAh/g 还是 mAh）、面积、活性物质质量。

用法：
  python ec_data.py probe   <file.xlsx|csv>                 # 只看结构：认得出哪些列、像什么数据
  python ec_data.py analyze <file> --out <dir>              # 算指标 + 出 xlsx/汇总
       [--sheet Sheet1] [--kind cv|gcd|eis|cycle|rate] [--mass 2.13] [--area 1.13]
       [--rate-unit C|mA] [--goal retention]

设计原则（别改）：
1. 认不出来就说认不出来（warnings/questions 里写），不要拿错的列硬算。
2. 每个指标都带 assumptions；单位不一致（mA vs A、mV vs V）先统一再算。
3. 输出里必须能一眼看到"第 1 圈 / 第 N 圈 / 保持率"这类审稿人第一句会问的数。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from office_kit import Xlsx  # noqa: E402

# ── 列名别名表：中文 / 英文 / 常见缩写都收 ────────────────────────────────
ALIASES: dict[str, list[str]] = {
    "cycle": ["循环", "圈数", "循环序号", "cycle", "cycle number", "cycle no", "cyclenumber", "n", "cycleindex"],
    "time": ["时间", "time", "t", "test time", "elapsed", "s", "sec", "min"],
    "potential": ["电位", "电压", "电势", "potential", "voltage", "e", "u", "ewe", "ev", "e/v", "v", "potential(v)", "voltage(v)"],
    "current": ["电流", "current", "i", "current(a)", "current(ma)", "i/a", "i(ma)"],
    "capacity": ["容量", "比容量", "放电容量", "充电容量", "capacity", "specific capacity", "q", "cap",
                 "charge capacity", "discharge capacity", "mah", "mah/g", "mah g-1", "mah·g-1"],
    "efficiency": ["库伦效率", "库仑效率", "效率", "coulombic efficiency", "ce", "efficiency", "%"],
    "energy": ["能量", "能量密度", "比能量", "energy", "energy density", "wh/kg", "wh kg-1", "specific energy"],
    "freq": ["频率", "frequency", "f", "freq", "f/hz", "hz"],
    "zreal": ["z'", "zre", "zreal", "z_real", "实部", "z' (ohm)", "zre(ohm)", "real"],
    "zimag": ["-z''", "z''", "zim", "zimag", "z_imag", "虚部", "z'' (ohm)", "zim(ohm)", "imag"],
    "rate": ["倍率", "c-rate", "rate", "cr", "c", "c rate", "current density", "电流密度", "a/g", "ma/g"],
    "retention": ["保持率", "容量保持率", "retention", "capacity retention", "%retention"],
    "mass": ["质量", "活性物质质量", "mass", "m", "mg", "g"],
    "area": ["面积", "极片面积", "area", "cm2", "cm^2"],
}

UNIT_PAT = re.compile(r"[（(]\s*([a-zA-Z%°·Ωω/^0-9\-\s]+?)\s*[)）]")


def _slug(s: str) -> str:
    s = str(s).strip().lower()
    s = s.replace("－", "-").replace("’", "'").replace("＇", "'")
    s = re.sub(r"\s+", " ", s)
    return s


def map_columns(cols: list[str]) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """返回 (canonical→真实列名, canonical→单位, 没认出来的列)。"""
    mapping, units, unknown = {}, {}, []
    for c in cols:
        key = _slug(c)
        base = UNIT_PAT.sub("", key).strip()
        unit_m = UNIT_PAT.search(key)
        unit = unit_m.group(1).strip() if unit_m else ""
        hit = None
        for canon, names in ALIASES.items():
            if base in names or key in names:
                hit = canon
                break
        if hit is None:
            for canon, names in ALIASES.items():
                if any(n and (n in base or base in n) for n in names if len(n) > 2):
                    hit = canon
                    break
        if hit and hit not in mapping:
            mapping[hit] = c
            # 单位可能写在列名里，也可能写在表头上一行（这里只看列名）
            if not unit:
                for u in ("mah/g", "mah g-1", "mah", "wh/kg", "a/g", "ma/g", "mv/s", "v/s", "hz", "ohm", "ω", "%"):
                    if u in key:
                        unit = u
                        break
            units[hit] = unit
        elif hit is None:
            unknown.append(c)
    return mapping, units, unknown


def detect_kind(mapping: dict[str, str]) -> str:
    k = set(mapping)
    if {"freq"} & k and ({"zreal"} & k or {"zimag"} & k):
        return "eis"
    if "cycle" in k and "capacity" in k:
        return "cycle"
    if "rate" in k and "capacity" in k:
        return "rate"
    if "time" in k and ({"potential"} & k or "capacity" in k):
        return "gcd"
    if "potential" in k and "current" in k:
        return "cv"
    if "capacity" in k:
        return "cycle"
    return "unknown"


# ── 读表 ─────────────────────────────────────────────────────────────────
def load_table(path: str, sheet: str | None = None) -> pd.DataFrame:
    ext = os.path.splitext(path)[1].lower()
    if ext in {".csv", ".txt", ".tsv"}:
        sep = "\t" if ext in {".tsv", ".txt"} else ","
        for enc in ("utf-8-sig", "gbk", "utf-8", "latin-1"):
            try:
                return pd.read_csv(path, sep=sep, encoding=enc)
            except Exception:
                continue
        raise SystemExit(f"读不了 CSV：{path}")
    df = pd.read_excel(path, sheet_name=sheet, header=0)
    # 有些仪器导出的表头在第二三行：整行几乎都不是数字时往下挪
    looks_header = sum(1 for v in df.columns if isinstance(v, str) and re.search(r"[a-zA-Z\u4e00-\u9fa5]", str(v)))
    if looks_header < 2 and len(df.columns) and str(df.columns[0]).startswith("Unnamed"):
        for skip in (1, 2, 3):
            d2 = pd.read_excel(path, sheet_name=sheet, header=skip)
            cols = [str(c) for c in d2.columns]
            if sum(1 for c in cols if re.search(r"[a-zA-Z\u4e00-\u9fa5]", c)) >= 2:
                return d2
    return df


def to_num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(
        s.astype(str).str.replace(",", "").str.replace("%", "").str.replace("<>", "").str.strip(),
        errors="coerce",
    )


def unify_units(df: pd.DataFrame, mapping: dict[str, str], units: dict[str, str]) -> tuple[pd.DataFrame, list[str]]:
    """把 mV→V、mA→A 之类的量统一到常用单位，返回改动说明。

    注意：只动真·数值列。`rate`（0.2C / 1C）和 `cycle`（第1圈）这类标记列**不许**
    被 pd.to_numeric 洗成 NaN——那是分类信息，洗掉就再也拼不回来了。
    """
    notes: list[str] = []
    out = df.copy()
    NUMERIC = {"potential", "current", "capacity", "efficiency", "energy", "time",
               "freq", "zreal", "zimag", "retention", "mass", "area"}
    for canon, col in mapping.items():
        if col not in out.columns:
            continue
        u = (units.get(canon) or "").lower()
        if canon == "rate":
            # 倍率保留原样（"0.2C" 这种），只把纯数字的挑出来
            out[col] = out[col].astype(str).str.strip()
            continue
        if canon not in NUMERIC:
            continue
        series = to_num(out[col])
        if canon == "potential" and u in {"mv"}:
            series = series / 1000.0
            notes.append(f"{col}: mV→V")
        elif canon == "current" and u in {"ma"}:
            series = series / 1000.0
            notes.append(f"{col}: mA→A")
        out[col] = series
    return out, notes


# ── 各体系的指标 ──────────────────────────────────────────────────────────
@dataclass
class Result:
    kind: str = "unknown"
    mapping: dict[str, str] = field(default_factory=dict)
    units: dict[str, str] = field(default_factory=dict)
    unknown: list[str] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)
    assumptions: list[str] = field(default_factory=list)
    questions: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    tables: dict[str, pd.DataFrame] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "kind": self.kind, "mapping": self.mapping, "metrics": self.metrics,
            "assumptions": self.assumptions, "questions": self.questions,
            "warnings": self.warnings, "notes": self.notes,
            "unknown_columns": self.unknown,
            "tables": {k: v.to_dict("records")[:50] for k, v in self.tables.items()},
        }, ensure_ascii=False, indent=2)


def _cycle_metrics(df: pd.DataFrame, m: dict[str, str], r: Result) -> None:
    ccol = m["cycle"]
    qcol = m.get("capacity")
    cyc = to_num(df[ccol])
    q = to_num(df[qcol]) if qcol else None
    if q is None:
        r.warnings.append("没有容量列，只能看循环曲线")
        return
    tmp = pd.DataFrame({"cycle": cyc, "q": q}).dropna().sort_values("cycle")
    # 一个循环里可能有充/放两段，按循环取"最大放电容量"更接近论文口径
    grp = tmp.groupby("cycle")["q"].agg(["max", "min", "mean", "count"])
    r.tables["每圈容量"] = grp.reset_index()
    q1 = float(grp["max"].iloc[0]) if len(grp) else float("nan")
    qn = float(grp["max"].iloc[-1]) if len(grp) else float("nan")
    r.metrics.update({
        "首圈容量": round(q1, 2), "末圈容量": round(qn, 2),
        "容量保持率%": round(qn / q1 * 100, 1) if q1 else float("nan"),
        "循环数": int(grp.shape[0]),
    })
    if len(grp) > 2:
        x = np.arange(len(grp), dtype=float)
        k = float(np.polyfit(x, grp["max"].to_numpy(dtype=float), 1)[0])
        # 习惯上报"衰减"用正数（每圈掉多少），拟合斜率下降时是负的
        r.metrics["每圈衰减(mAh/g/圈)"] = round(abs(k), 4)
        r.metrics["每圈衰减率%/圈"] = round(abs(k / q1 * 100), 4) if q1 else float("nan")
        if q1 and abs(k / q1 * 100) > 0.5:
            r.warnings.append(f"每圈衰减 {abs(k / q1 * 100):.2f}% 偏大，先确认是不是把充电容量当放电容量、"
                              "或前几圈活化没剔除")
    if m.get("efficiency"):
        ce = to_num(df[m["efficiency"]]).dropna()
        if len(ce):
            scale = 1.0 if ce.max() <= 1.5 else 100.0
            r.metrics["平均库伦效率%"] = round(float(ce.mean() / scale * 100), 1)
            if float(ce.max() / scale) > 1.02:
                r.warnings.append("库伦效率有 >102% 的值，常见原因：容量单位混用或充电/放电列颠倒")
    r.assumptions.append("每圈容量取该圈内的最大值（常见充放电各自成行时这样最接近论文口径）")


def _gcd_metrics(df: pd.DataFrame, m: dict[str, str], r: Result) -> None:
    t = to_num(df[m["time"]]) if m.get("time") else None
    u = to_num(df[m["potential"]]) if m.get("potential") else None
    q = to_num(df[m["capacity"]]) if m.get("capacity") else None
    if u is None or (t is None and q is None):
        r.warnings.append("缺少电位/时间列，算不了比容量")
        return
    x = q if q is not None else t
    order = np.argsort(x.to_numpy())
    xv, uv = x.to_numpy(dtype=float)[order], u.to_numpy(dtype=float)[order]
    if len(xv) < 3:
        r.warnings.append("有效点太少")
        return
    qspan = float(np.nanmax(xv) - np.nanmin(xv))
    # 能量 = ∫U dQ（梯形积分），单位 Wh 需要 ×1000/3600（Q 用 Ah 时直接 V·Ah）
    energy = float(np.trapz(uv, xv))
    r.metrics.update({
        "电位范围V": f"{np.nanmin(uv):.2f}~{np.nanmax(uv):.2f}",
        "平均电压V": round(float(np.nanmean(uv)), 3),
        "容量跨度": round(qspan, 2),
    })
    if qspan:
        r.metrics["比能量(容量×平均电压)"] = round(float(np.nanmean(uv)) * qspan, 2)
    r.metrics["∫U·dQ"] = round(energy, 2)
    r.assumptions.append("能量按 ∫U·dQ 梯形积分；若容量单位是 mAh/g，换算 Wh/kg 需 ×(1/3600)后再看量级")
    if "mass" not in m:
        r.questions.append("活性物质质量没给：若要 mAh/g 或 Wh/kg，请提供极片活性物质质量(mg)")


def _cv_metrics(df: pd.DataFrame, m: dict[str, str], r: Result) -> None:
    e = to_num(df[m["potential"]])
    i = to_num(df[m["current"]])
    ok = e.notna() & i.notna()
    ev, iv = e[ok].to_numpy(dtype=float), i[ok].to_numpy(dtype=float)
    if len(iv) < 8:
        r.warnings.append("CV 点数太少")
        return
    # 轻度平滑，压掉仪器噪声（窗口按点数自适应，别把峰压平）
    win = max(3, min(9, len(iv) // 40 * 2 + 1))
    k = np.ones(win) / win
    smooth = np.convolve(iv, k, mode="same")
    # 主峰：直接取正向最大值与负向最小值（CV 里这两个就是主氧化/还原峰；
    # 多峰体系要精确分峰得做基线扣除，这里只给"主峰"口径并写进 assumptions）
    ia, ic = int(np.nanargmax(smooth)), int(np.nanargmin(smooth))
    thr = 0.2 * max(abs(float(smooth[ia])), abs(float(smooth[ic]))) or 1e-12
    peaks = []
    if smooth[ia] > thr:
        peaks.append(("氧化", float(ev[ia]), float(smooth[ia])))
    if -smooth[ic] > thr:
        peaks.append(("还原", float(ev[ic]), float(smooth[ic])))
    r.tables["峰"] = pd.DataFrame(peaks, columns=["类型", "电位V", "电流"])
    if len(peaks) == 2:
        r.metrics["峰电位差ΔEp(V)"] = round(abs(peaks[0][1] - peaks[1][1]), 3)
        r.metrics["峰电流比|Ipa/Ipc|"] = round(abs(peaks[0][2] / peaks[1][2]), 2) if peaks[1][2] else float("nan")
    else:
        r.warnings.append("只找到一个方向的峰，ΔEp 算不了（可能是单边扫描或基线漂移）")
    charge = float(np.trapz(np.abs(iv), ev))
    r.metrics["电荷量(∫|i|dE)"] = round(charge, 4)
    r.assumptions.append("峰用滑动平均后的一阶差分找；扫速/面积未给时电荷量只作相对比较")
    if "area" not in m:
        r.questions.append("没给电极面积与扫速：如果要 mA/cm² 或比电容，需要面积(cm²)与扫速(mV/s)")


def _eis_metrics(df: pd.DataFrame, m: dict[str, str], r: Result) -> None:
    f = to_num(df[m["freq"]])
    zr = to_num(df[m.get("zreal")])
    zi = to_num(df[m.get("zimag")])
    ok = f.notna() & zr.notna()
    if not ok.any():
        r.warnings.append("EIS 缺频率或实部")
        return
    fr, x, y = f[ok].to_numpy(dtype=float), zr[ok].to_numpy(dtype=float), zi[ok].to_numpy(dtype=float)
    order = np.argsort(-fr)  # 高频在前
    r.metrics["Rs(高频截距,Ω)"] = round(float(x[order][0]), 3)
    r.metrics["最大实部(Ω)"] = round(float(np.nanmax(x)), 3)
    if np.nanmax(x) > np.nanmin(x):
        r.metrics["半圆直径≈Rct(Ω)"] = round(float(np.nanmax(x) - x[order][0]), 3)
    r.metrics["频率范围Hz"] = f"{np.nanmin(fr):.3g}~{np.nanmax(fr):.3g}"
    r.tables["EIS点"] = pd.DataFrame({"f": fr, "Z'": x, "-Z''": y})
    r.assumptions.append("Rs 取最高频点实部；Rct 粗略取 'max(Z') - Rs'，精确值应做等效电路拟合")


def _rate_metrics(df: pd.DataFrame, m: dict[str, str], r: Result) -> None:
    rcol, qcol = m.get("rate"), m.get("capacity")
    if not rcol or not qcol:
        r.warnings.append("倍率数据缺 '倍率' 或 '容量' 列")
        return
    tmp = pd.DataFrame({"rate": df[rcol].astype(str).str.strip(), "q": to_num(df[qcol])}).dropna()
    if not len(tmp):
        r.warnings.append("倍率或容量列没有可用数值")
        return
    grp = tmp.groupby("rate", sort=False)["q"].max().reset_index()
    r.tables["倍率容量"] = grp
    # 从 "0.2C"、"1C"、"5C"、"0.2C(回)" 里抠出数值倍率，用来判断"最高倍率"和"回到首档"
    def _num(label: str) -> float | None:
        mm = re.search(r"(\d+(?:\.\d+)?)", label)
        return float(mm.group(1)) if mm else None

    labels = list(grp["rate"])
    nums = [_num(x) for x in labels]
    pairs = [(lb, nn, float(q)) for lb, nn, q in zip(labels, nums, grp["q"]) if nn is not None]
    if len(grp) >= 2:
        first = float(grp["q"].iloc[0])
        if pairs:
            lb, nn, qv = max(pairs, key=lambda t: t[1])
            r.metrics["最高倍率"] = lb
            r.metrics["最高倍率容量"] = round(qv, 2)
            r.metrics["相对首档保持%"] = round(qv / first * 100, 1) if first else float("nan")
        r.metrics["倍率档数"] = int(len(grp))
        # 最后一档如果又回到首档倍率（"0.2C(回)" 这种），算恢复率
        if pairs and nums[0] is not None and nums[-1] is not None and abs(nums[-1] - nums[0]) < 1e-9 and len(grp) > 2:
            r.metrics["回到首档恢复%"] = round(float(grp["q"].iloc[-1]) / first * 100, 1) if first else float("nan")
    r.assumptions.append("同倍率取容量最大值；「相对首档保持%」用数值倍率最大那一档算，" \
                         "不是最后一行（最后一行常是「回到小倍率」的恢复测试）")


KIND_FN = {"cycle": _cycle_metrics, "gcd": _gcd_metrics, "cv": _cv_metrics, "eis": _eis_metrics, "rate": _rate_metrics}
KIND_CN = {"cycle": "循环性能", "gcd": "恒流充放电", "cv": "循环伏安(CV)", "eis": "交流阻抗(EIS)", "rate": "倍率性能", "unknown": "未识别"}


def analyze(path: str, sheet: str | None = None, kind: str | None = None,
            mass_mg: float | None = None, area_cm2: float | None = None) -> tuple[Result, pd.DataFrame]:
    raw = load_table(path, sheet)
    cols = [str(c) for c in raw.columns]
    mapping, units, unknown = map_columns(cols)
    r = Result(mapping=mapping, units=units, unknown=unknown)
    df, notes = unify_units(raw, mapping, units)
    r.notes = notes
    r.kind = kind or detect_kind(mapping)
    if r.kind == "unknown":
        r.warnings.append(f"认不出这是哪种电化学数据；列名={cols}")
    if mass_mg and "capacity" in mapping:
        q = to_num(df[mapping["capacity"]])
        unit = (units.get("capacity") or "").lower()
        abs_unit = ("mah/g" not in unit) and ("mah g-1" not in unit) and ("mah" in unit or unit == "")
        qmax = float(q.max()) if q.notna().any() else 0.0
        if abs_unit and 0 < qmax <= 50:
            # 扣式电池绝对容量一般个位数 mAh：这种才按质量折算成 mAh/g
            df[mapping["capacity"]] = q / (mass_mg / 1000.0)
            r.assumptions.append(f"容量按 {mass_mg} mg 活性物质质量折算成 mAh/g（原值 {qmax:.3g} 像绝对容量 mAh）")
        elif abs_unit and qmax > 50:
            r.warnings.append(
                f"容量列标的单位是 mAh，但最大值 {qmax:.4g}——这个量级更像比容量(mAh/g)。"
                f"已按「当作比容量」处理，没再乘/除质量；若确实是绝对容量请告我极片质量。")
    if area_cm2 and "current" in mapping:
        df[mapping["current"]] = to_num(df[mapping["current"]]) / area_cm2
        r.assumptions.append(f"电流按面积 {area_cm2} cm² 换算成 A/cm²")
    fn = KIND_FN.get(r.kind)
    if fn:
        fn(df, mapping, r)
    r.tables["清洗后数据"] = df
    return r, df


# ── 输出 ─────────────────────────────────────────────────────────────────
def write_workbook(r: Result, df: pd.DataFrame, out_path: str) -> str:
    xl = Xlsx()
    clean = r.tables.get("清洗后数据", df)
    head = [str(c) for c in clean.columns]
    rows = clean.head(2000).itertuples(index=False, name=None)
    xl.sheet("清洗后数据", head, rows, widths=[max(12, len(str(c)) + 6) for c in head],
             note=f"来自原始文件；口径：{KIND_CN.get(r.kind)}" + ("；单位已统一：" + "、".join(r.notes) if r.notes else ""))

    if r.metrics:
        xl.sheet("指标汇总", ["指标", "值", "说明"], [(k, v, "自动计算，见口径") for k, v in r.metrics.items()],
                 widths=[24, 20, 34])
    for name, tb in r.tables.items():
        if name == "清洗后数据" or tb is None or not len(tb):
            continue
        cols = [str(c) for c in tb.columns]
        xl.sheet(name[:28], cols, tb.itertuples(index=False, name=None),
                 widths=[max(12, len(c) + 6) for c in cols])
    # 主图：有循环/倍率就在汇总表上画
    if "每圈容量" in r.tables and len(r.tables["每圈容量"]) > 2:
        ws = xl.wb["每圈容量"]
        xl.line(ws, "容量随循环变化", f"H2", 1, [2], y_title="容量")
    if "倍率容量" in r.tables and len(r.tables["倍率容量"]) > 2:
        ws = xl.wb["倍率容量"]
        xl.bar(ws, "不同倍率下的容量", "F2", 1, [2], y_title="容量")
    return xl.save(out_path)


def summary_md(r: Result, src: str) -> str:
    lines = [f"# 电化学数据解读：{os.path.basename(src)}", "",
             f"- 判定类型：**{KIND_CN.get(r.kind, r.kind)}**",
             f"- 认出的列：{', '.join(f'{k}→{v}' for k, v in r.mapping.items()) or '（无）'}"]
    if r.unknown:
        lines.append(f"- 没认出的列：{', '.join(r.unknown)}")
    if r.metrics:
        lines += ["", "## 关键指标", ""]
        for k, v in r.metrics.items():
            lines.append(f"- **{k}**：{v}")
    if r.assumptions:
        lines += ["", "## 口径与假设（要跟用户确认的都在这）", ""]
        lines += [f"- {a}" for a in r.assumptions]
    if r.questions:
        lines += ["", "## 还需要问用户", ""]
        lines += [f"- {q}" for q in r.questions]
    if r.warnings:
        lines += ["", "## 风险 / 没算的", ""]
        lines += [f"- {w}" for w in r.warnings]
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description="电化学表格数据解读")
    ap.add_argument("cmd", choices=["probe", "analyze"])
    ap.add_argument("file")
    ap.add_argument("--out", default="")
    ap.add_argument("--sheet", default=None)
    ap.add_argument("--kind", default=None, choices=["cv", "gcd", "eis", "cycle", "rate"])
    ap.add_argument("--mass", type=float, default=None, help="活性物质质量 mg")
    ap.add_argument("--area", type=float, default=None, help="电极面积 cm²")
    ap.add_argument("--goal", default="", help="用户真实目的，如 retention / rate / eis-fit")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.cmd == "probe":
        raw = load_table(a.file, a.sheet)
        cols = [str(c) for c in raw.columns]
        mapping, units, unknown = map_columns(cols)
        print(json.dumps({
            "shape": list(raw.shape), "columns": cols, "mapping": mapping, "units": units,
            "unknown": unknown, "kind_guess": detect_kind(mapping),
            "head": raw.head(3).to_dict("records"),
        }, ensure_ascii=False, indent=2))
        return

    r, df = analyze(a.file, a.sheet, a.kind, a.mass, a.area)
    if a.goal:
        r.assumptions.append(f"用户目的：{a.goal}（指标按这个目的排序）")
    out_dir = a.out or os.path.join(os.path.dirname(os.path.abspath(a.file)), "ec-out")
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(a.file))[0]
    xlsx_path = write_workbook(r, df, os.path.join(out_dir, f"{base}-解读.xlsx"))
    md_path = os.path.join(out_dir, f"{base}-解读.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(summary_md(r, a.file))
    print(summary_md(r, a.file))
    print(f"已写出：\n  {xlsx_path}\n  {md_path}")
    if a.json:
        print(r.to_json())


if __name__ == "__main__":
    main()
