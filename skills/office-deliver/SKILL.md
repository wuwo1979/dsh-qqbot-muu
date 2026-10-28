# office-deliver —— 交得出、能验收的 Office 三件套

给「按数据写报告 / 做 PPT / 出表格」用。特点不是"能生成文件"，而是**生成完能自己验收**：结构体检 + 真 Office 渲染成图，肉眼确认没有空白页、没有溢出、没有糊成一团的图。

## 什么时候用它

- 用户给了表格/CSV/Excel，要一份**报告 + 汇报 PPT + 数据底稿**
- 用户要"正经的 docx / xlsx / pptx"，不是贴一段 markdown
- 电化学数据（循环 / 倍率 / 充放电 / CV / EIS）——`ec_data.py` 会按体系算指标，认不出来就写"待确认"，不硬猜

## 一条命令出三件套

```powershell
$py = 'F:\DSH\DSH Desktop\resources\office-runtime\primary-runtime\dependencies\python\python.exe'
& $py skills\office-deliver\scripts\make_report.py `
    --title "LFP 半电池电化学性能测试" `
    --in  F:\qqbot\tmp\ec-samples `
    --out F:\qqbot\tmp\ec-report `
    --mass 2.13 --area 1.13          # 活性物质质量 mg / 极片面积 cm²（有就填，没有就别填）
```

产出：

| 文件 | 内容 |
|---|---|
| `报告.docx` | 结论摘要表 → 每体系（图 / 指标表 / 口径与假设 / 待确认）→ 附录方法 |
| `数据底稿.xlsx` | 指标汇总页 + 每数据集清洗后的数据 + 原生图表 + 条件格式 |
| `汇报.pptx` | 封面 / 一页看完 / 原生可编辑图表 / 图页 / 指标表 |

`--no-deck` 只出 docx+xlsx。

## 分步用（要自己排版时）

```python
from office_kit import Doc, Xlsx, Deck

d = Doc("标题", subtitle="副标题")          # A4 / 2.54cm 边距 / 中文字体已设
d.heading("一、结论摘要", 1)                 # level=1|2
d.para("正文，**加粗**用 d.para(text, bold=True) 或 para_bold()")
d.bullets(["要点一", "要点二"])
d.table(["列1", "列2"], [["a", 1], ["b", 2]], caption="表 1 说明", widths_cm=[6, 4])
d.image("figures/cycle.png", caption="图 1 循环性能", width_cm=15.5)
d.save("报告.docx")                          # 自动加页脚"第 N 页"

x = Xlsx()
s = x.sheet("汇总")                          # 冻结首行 + 自动筛选 + 边框
x.write_rows(s, ["月份", "播放"], [["2026-07", 120]])
s["C1"].value = "=SUM(B2:B13)"               # 公式是真的公式
x.bar("汇总", "播放", min_col=1, min_row=1, max_row=13, title="月度播放")
x.save("底稿.xlsx")

k = Deck("标题", subtitle="副标题")           # 构造即出封面（16:9 / 13.333×7.5in）
k.bullets("要点", ["a", "b"])
k.chart("倍率性能", ["0.2C", "1C", "5C"], {"比容量": [159, 132, 66]}, kind="bar", unit="mAh/g")
k.picture("循环性能", "figures/cycle.png", caption="保持率 88.3%")   # 等比缩进安全区
k.table("指标一览", ["项", "值"], [["保持率", "88.3%"]], col_widths=[6, 6])
k.save("汇报.pptx")
```

## 验收（这一步别省）

```powershell
# 1) 结构体检：字数/标题层级/表格/图片/页脚域/公式缓存/16:9/字号/溢出
& $py skills\office-deliver\scripts\verify.py 报告.docx
& $py skills\office-deliver\scripts\verify.py 数据底稿.xlsx
& $py skills\office-deliver\scripts\verify.py 汇报.pptx

# 2) 真渲染成图（本机 Office 2007 可用；要 danger-full-access 才能跑 COM）
node skills\office-deliver\scripts\render.mjs 报告.docx --engine com --out out\docx
node skills\office-deliver\scripts\render.mjs 汇报.pptx --engine com --out out\pptx
# 然后 read_image 逐页看图：有没有空白页、溢出、图糊、贴边
```

`verify.py` 有 error 时退出码 1，可以直接接进脚本。

## 电化学口径（`ec_data.py`）

```powershell
& $py skills\office-deliver\scripts\ec_data.py probe  cycle.csv          # 只认列，不算
& $py skills\office-deliver\scripts\ec_data.py analyze cycle.csv --mass 2.13 --area 1.13 --md
```

- 认列靠中英别名（`循环序号/循环圈数/cycle`、`比容量/capacity/discharge capacity`、`库伦效率/CE/coulombic`…）
- 体系判定顺序 `eis → cycle → rate → gcd → cv`，判错就 `--kind` 指定
- 单位归一只动数值列（`mV→V`、`mA→A`）；**倍率列保持字符串**（"0.2C" 不是数字）
- 容量折算：只有单位是 `mAh` 且量级像扣电绝对容量（max ≤ 50）才按质量折算成 `mAh/g`；已经是比容量的不动
- 倍率：按数值倍率取**最大那档**算保持率，最后一行若是"回到 0.2C"的恢复档，另算恢复率
- 指标：循环（首/末圈、保持率、每圈衰减、平均库仑效率）、倍率（各档容量、保持%、恢复%）、gcd（电压区间、平均电压、∫U·dQ）、cv（ΔEp、峰电流比、∫|i|dE）、eis（Rs 高频截距、半圆直径≈Rct）
- 每个指标都带 `assumptions`，算不了就写 `warnings` / `questions`，不给假数

图表用 `plot.py`（纯 Pillow，本机没有 matplotlib）：`line(series, title, xlabel, ylabel, out, y2=…)` 双轴、`bars()`、`scatter()`。中文字体走 `C:/Windows/Fonts/msyh.ttc`。

## 本机的三个硬约束（踩过）

1. **渲染必须 `danger-full-access`**：COM 在 workspace-write 下报 `CannotCreateTypeConstrainedLanguage`；`spawnSync` 抓子进程输出会 `EPERM`，所以所有子进程用 `stdio:'ignore'` + 写文件回读。
2. **LibreOffice 走不通**：`msiexec /a` 装出来的是部署镜像，`soffice --convert-to` 一律 `Fatal Error: 无法启动应用程序`。别在这上面花时间，直接用 Office COM。
3. **别用 PowerShell 回写中文文本**：`Get-Content -Raw | -replace | Set-Content -Encoding UTF8` 在 PS 5.1 下会按 GBK 重读，整份文件变乱码（也���把中文文件名搞坏）。改文件用编辑器/write 工具。

## 自测

```powershell
& $py skills\office-deliver\scripts\selftest.py            # 造 5 组合成数据 → 出三件套 → 体检
& $py skills\office-deliver\scripts\selftest.py --render   # 再加渲染出图（需提权）
```

样例数据在 `samples/`（`cycle.csv` `rate.csv` `gcd.csv` `cv.csv` `eis.csv`），可直接拿来对拍。
