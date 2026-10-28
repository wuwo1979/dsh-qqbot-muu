#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""office_kit.py — 三种 Office 文件的「房子风格」构建器。

为什么不用现成 skill 的模板：本机真正的 Office 是 **2007（Word/Excel/PowerPoint 12.0）**，
所以这里的每个样式都只用 2007 认识的东西（不用 Morph 切换、不用图标集、不用新图表类型）。

约定（改之前先读 SKILL.md）：
- 中文字体统一「宋体」（正文）/「等线」「黑体」（标题），西文 Calibri；
  必须同时设 `w:eastAsia`，否则 Office 打开会回退成 Times New Roman。
- 页面：docx A4 / 页边距 2.54cm；pptx 16:9 = 13.333×7.5 in（960×540 pt）。
- 数字：金额/密度等一律千分位 + 指定小数位；百分比存成 0~1 的小数 + `0.0%` 格式，
  这样 Excel 里能直接参与计算，显示才是百分数。
"""
from __future__ import annotations

import os
from typing import Iterable, Sequence

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Pt, RGBColor

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.formatting.rule import ColorScaleRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor as PptxRGB
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Inches, Pt as PptxPt

CN_BODY = "宋体"
CN_HEAD = "等线"
LATIN = "Calibri"

INK = RGBColor(0x1F, 0x28, 0x37)
MUTED = RGBColor(0x5B, 0x64, 0x72)
ACCENT = RGBColor(0x0B, 0x6E, 0x99)


# ── 小工具 ────────────────────────────────────────────────────────────────
def _set_cn_font(run, name: str, size: float | None = None, bold: bool = False,
                 color: RGBColor | None = None) -> None:
    run.font.name = LATIN
    run.font.bold = bold
    if size:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)
    rfonts.set(qn("w:ascii"), LATIN)
    rfonts.set(qn("w:hAnsi"), LATIN)


def _shade(cell, hex_fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def _disp_width(text: str) -> int:
    """粗略显示宽度：CJK 全角算 2，其余算 1（用来估列宽）。"""
    w = 0
    for ch in str(text):
        w += 2 if ord(ch) > 0x2E7F else 1
    return w


def _page_field(paragraph, kind: str = "PAGE") -> None:
    """插入域代码（页码），Word 打开才会算出真实页码。"""
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {kind} "
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    txt = OxmlElement("w:t")
    txt.text = "1"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr)
    run._r.append(fld_sep)
    run._r.append(txt)
    run._r.append(fld_end)


# ── Word ─────────────────────────────────────────────────────────────────
class Doc:
    """`Doc()` → 标题 / 小标题 / 正文 / 要点 / 表格 / 图注 / 页脚，一路写下来。"""

    def __init__(self, title: str = "", subtitle: str = "", footer: str = ""):
        self.d = Document()
        sec = self.d.sections[0]
        sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
        sec.left_margin = sec.right_margin = Cm(2.54)
        sec.top_margin = sec.bottom_margin = Cm(2.54)
        self._footer(footer)
        style = self.d.styles["Normal"]
        style.font.name = LATIN
        style.font.size = Pt(10.5)
        style.paragraph_format.line_spacing = 1.4
        style.paragraph_format.space_after = Pt(6)
        if title:
            self.title(title, subtitle)

    # 结构块 ---------------------------------------------------------------
    def title(self, text: str, subtitle: str = "") -> "Doc":
        p = self.d.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_before = Pt(12)
        _set_cn_font(p.add_run(text), CN_HEAD, 22, True, INK)
        if subtitle:
            q = self.d.add_paragraph()
            q.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _set_cn_font(q.add_run(subtitle), CN_BODY, 11, False, MUTED)
        return self

    def heading(self, text: str, level: int = 1) -> "Doc":
        size = {1: 15, 2: 13, 3: 11.5}.get(level, 11)
        p = self.d.add_paragraph()
        p.paragraph_format.space_before = Pt(14 if level == 1 else 10)
        p.paragraph_format.space_after = Pt(6)
        _set_cn_font(p.add_run(text), CN_HEAD, size, True, INK if level == 1 else ACCENT)
        # 让 Word 的导航窗格/目录认得这一级：用内置 Heading 样式挂段落属性
        p.style = self.d.styles[f"Heading {min(level, 3)}"]
        # 标题别孤零零留在页脚：和下一段/表/图绑在一起
        p.paragraph_format.keep_with_next = True
        for run in p.runs:
            _set_cn_font(run, CN_HEAD, size, True, INK if level == 1 else ACCENT)
        return self

    def para(self, text: str, indent: bool = True, size: float = 10.5) -> "Doc":
        p = self.d.add_paragraph()
        if indent:
            p.paragraph_format.first_line_indent = Pt(size * 2)
        _set_cn_font(p.add_run(text), CN_BODY, size, False, INK)
        return self

    def bullets(self, items: Iterable[str], size: float = 10.5) -> "Doc":
        for it in items:
            p = self.d.add_paragraph(style="List Bullet")
            p.paragraph_format.space_after = Pt(3)
            _set_cn_font(p.add_run(it), CN_BODY, size, False, INK)
        return self

    def table(self, header: Sequence[str], rows: Iterable[Sequence], caption: str = "",
              widths_cm: Sequence[float] | None = None, size: float = 9.5) -> "Doc":
        rows = list(rows)
        if caption:
            c = self.d.add_paragraph()
            c.alignment = WD_ALIGN_PARAGRAPH.LEFT
            c.paragraph_format.keep_with_next = True      # 表题不许和表分开
            _set_cn_font(c.add_run(caption), CN_BODY, 9.5, True, MUTED)
        t = self.d.add_table(rows=1, cols=len(header))
        t.style = "Table Grid"
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        for i, h in enumerate(header):
            cell = t.rows[0].cells[i]
            cell.text = ""
            _set_cn_font(cell.paragraphs[0].add_run(str(h)), CN_HEAD, size, True, INK)
            cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
            _shade(cell, "E8F1F6")
        for r in rows:
            cells = t.add_row().cells
            for i, v in enumerate(r):
                cells[i].text = ""
                _set_cn_font(cells[i].paragraphs[0].add_run("" if v is None else str(v)),
                             CN_BODY, size, False, INK)
                cells[i].paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
        if widths_cm:
            for i, w in enumerate(widths_cm):
                for row in t.rows:
                    row.cells[i].width = Cm(w)
        # 行内不许被分页截断（表头行 + 重复表头），避免出现"只有表头留在页尾"
        for idx, row in enumerate(t.rows):
            trPr = row._tr.get_or_add_trPr()
            trPr.append(parse_xml(r'<w:cantSplit %s/>' % nsdecls("w")))
            if idx == 0:
                trPr.append(parse_xml(r'<w:tblHeader %s/>' % nsdecls("w")))
        self.d.add_paragraph().paragraph_format.space_after = Pt(2)
        return self

    def image(self, path: str, width_cm: float = 15.0, caption: str = "") -> "Doc":
        if os.path.exists(path):
            pic = self.d.add_paragraph()
            pic.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pic.paragraph_format.keep_with_next = True    # 图和图注别被拆到两页
            pic.add_run().add_picture(path, width=Cm(width_cm))
            if caption:
                p = self.d.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                _set_cn_font(p.add_run(caption), CN_BODY, 9, False, MUTED)
        return self

    def _footer(self, text: str) -> None:
        footer = self.d.sections[0].footer
        p = footer.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        if text:
            _set_cn_font(p.add_run(text + "　　"), CN_BODY, 9, False, MUTED)
        _set_cn_font(p.add_run("第 "), CN_BODY, 9, False, MUTED)
        _page_field(p, "PAGE")
        _set_cn_font(p.add_run(" 页"), CN_BODY, 9, False, MUTED)

    def save(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self.d.save(path)
        return path


# ── Excel ────────────────────────────────────────────────────────────────
class Xlsx:
    """`Xlsx()` → 每个 sheet 先写表头（自动冻结+筛选），再追加数据行，最后加图表。"""

    def __init__(self):
        self.wb = Workbook()
        self.wb.remove(self.wb.active)
        self._thin = Side(style="thin", color="C9D3DD")
        self.border = Border(left=self._thin, right=self._thin, top=self._thin, bottom=self._thin)

    def sheet(self, title: str, header: Sequence[str], rows: Iterable[Sequence] = (),
              formats: dict[int, str] | None = None, widths: Sequence[float] | None = None,
              note: str = "", freeze: str | None = None, landscape: bool = True,
              fit_width: bool = True):
        ws = self.wb.create_sheet(title)
        ws.append(list(header))
        for c in range(1, len(header) + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = Font(name=CN_HEAD, bold=True, size=10.5, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="0B6E99")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.border = self.border
        for r in rows:
            ws.append(list(r))
        n = ws.max_row
        for row in ws.iter_rows(min_row=2, max_row=n, max_col=len(header)):
            for cell in row:
                cell.font = Font(name=CN_BODY, size=10)
                cell.border = self.border
                cell.alignment = Alignment(horizontal="center", vertical="center")
        for idx, fmt in (formats or {}).items():
            for r in range(2, n + 1):
                ws.cell(row=r, column=idx).number_format = fmt
        # 列宽：没给就按内容估（中文按 2 个字符宽算），避免导出 PDF 时挤成一列
        auto_w = list(widths or [])
        for i in range(1, len(header) + 1):
            if i <= len(auto_w) and auto_w[i - 1]:
                ws.column_dimensions[get_column_letter(i)].width = auto_w[i - 1]
                continue
            cells = [str(ws.cell(row=1, column=i).value or "")]
            cells += [str(ws.cell(row=r, column=i).value or "") for r in range(2, min(n, 200) + 1)]
            longest = max((_disp_width(v) for v in cells), default=8)
            ws.column_dimensions[get_column_letter(i)].width = min(42, max(8, longest + 3))
        ws.freeze_panes = freeze or "A2"
        if len(header):
            ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{max(n, 1)}"
        ws.row_dimensions[1].height = 28
        if note:
            ws.cell(row=n + 2, column=1, value=note).font = Font(name=CN_BODY, size=9, italic=True, color="5B6472")
        # 打印/导出设置：横向 + 缩到一页宽，否则导出 PDF 右边会被裁掉
        ws.page_setup.orientation = "landscape" if landscape else "portrait"
        ws.page_setup.paperSize = ws.PAPERSIZE_A4
        if fit_width:
            ws.sheet_properties.pageSetUpPr.fitToPage = True
            ws.page_setup.fitToWidth = 1
            ws.page_setup.fitToHeight = 0
        ws.print_options.horizontalCentered = True
        ws.page_margins.left = ws.page_margins.right = 0.35
        ws.page_margins.top = ws.page_margins.bottom = 0.45
        ws.print_title_rows = "1:1"
        ws.print_area = f"A1:{get_column_letter(max(len(header), 1))}{n + (2 if note else 0)}"
        return ws

    def heat(self, ws, col: int, better: str = "high", rows: int | None = None):
        """条件格式：三色阶（浅→白→深），中点白色，保证深底上字还看得见。

        想要「越小越好」就交换两端颜色（openpyxl 的 ColorScaleRule 没有 reverse 参数）。
        """
        n = rows or ws.max_row
        rng = f"{get_column_letter(col)}2:{get_column_letter(col)}{n}"
        low, high = ("EAF2F8", "8FB8D6") if better != "low" else ("8FB8D6", "EAF2F8")
        rule = ColorScaleRule(
            start_type="min", start_color=low,
            mid_type="percentile", mid_value=50, mid_color="FFFFFF",
            end_type="max", end_color=high,
        )
        ws.conditional_formatting.add(rng, rule)
        return ws

    def bar(self, ws, title: str, anchor: str, cat_col: int, val_cols: Sequence[int],
            y_title: str = "", horizontal: bool = False, height: float = 9.0):
        n = ws.max_row
        tree = BarChart()
        tree.type = "bar" if horizontal else "col"
        tree.style = 10
        tree.title = title
        tree.y_axis.title = y_title
        tree.height, tree.width = height, 19
        tree.gapWidth = 60
        tree.legend.position = "b"
        tree.y_axis.majorGridlines = None
        data = Reference(ws, min_col=min(val_cols), max_col=max(val_cols), min_row=1, max_row=n)
        cats = Reference(ws, min_col=cat_col, min_row=2, max_row=n)
        tree.add_data(data, titles_from_data=True)
        tree.set_categories(cats)
        ws.add_chart(tree, anchor)
        return tree

    def line(self, ws, title: str, anchor: str, cat_col: int, val_cols: Sequence[int],
             y_title: str = "", height: float = 9.0):
        n = ws.max_row
        ch = LineChart()
        ch.style = 12
        ch.title = title
        ch.y_axis.title = y_title
        ch.height, ch.width = height, 19
        ch.legend.position = "b"
        data = Reference(ws, min_col=min(val_cols), max_col=max(val_cols), min_row=1, max_row=n)
        cats = Reference(ws, min_col=cat_col, min_row=2, max_row=n)
        ch.add_data(data, titles_from_data=True)
        ch.set_categories(cats)
        ws.add_chart(ch, anchor)
        return ch

    def save(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self.wb.save(path)
        return path


# ── PowerPoint ───────────────────────────────────────────────────────────
class Deck:
    """`Deck()` → 封面页 / 要点页 / 表格页 / 图表页，全部 16:9。"""

    W, H = Inches(13.333), Inches(7.5)

    def __init__(self, title: str = "", subtitle: str = ""):
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = self.W, self.H
        self._blank = self.prs.slide_layouts[6]
        if title:
            self.cover(title, subtitle)

    def _text(self, box, text: str, size: int, bold: bool = False, color: PptxRGB | None = None,
              align=PP_ALIGN.LEFT, font: str = CN_HEAD):
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.alignment = align
        run = p.add_run()
        run.text = text
        run.font.size = PptxPt(size)
        run.font.bold = bold
        run.font.name = font
        if color is not None:
            run.font.color.rgb = color
        # 中文字体：pptx 用 <a:ea typeface> 指定东亚字体
        rpr = run._r.get_or_add_rPr()
        ea = rpr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}ea")
        if ea is None:
            from lxml import etree
            ea = etree.SubElement(rpr, "{http://schemas.openxmlformats.org/drawingml/2006/main}ea")
        ea.set("typeface", font)
        return tf

    def cover(self, title: str, subtitle: str = "") -> "Deck":
        s = self.prs.slides.add_slide(self._blank)
        top = s.shapes.add_shape(1, 0, 0, self.W, Emu(int(Inches(0.16))))
        top.fill.solid()
        top.fill.fore_color.rgb = PptxRGB(0x0B, 0x6E, 0x99)
        top.line.fill.background()
        box = s.shapes.add_textbox(Inches(1.1), Inches(2.55), Inches(11.1), Inches(1.4))
        self._text(box, title, 40, True, PptxRGB(0x1F, 0x28, 0x37))
        rule = s.shapes.add_shape(1, Inches(1.1), Inches(3.95), Inches(2.4), Emu(int(Inches(0.045))))
        rule.fill.solid()
        rule.fill.fore_color.rgb = PptxRGB(0x0B, 0x6E, 0x99)
        rule.line.fill.background()
        if subtitle:
            sub = s.shapes.add_textbox(Inches(1.1), Inches(4.18), Inches(11.1), Inches(0.8))
            self._text(sub, subtitle, 16, False, PptxRGB(0x5B, 0x64, 0x72))
        return self

    def bullets(self, title: str, items: Sequence[str], size: int = 20) -> "Deck":
        s = self.prs.slides.add_slide(self._blank)
        self._title(s, title)
        box = s.shapes.add_textbox(Inches(0.95), Inches(1.75), Inches(11.4), Inches(5.1))
        tf = box.text_frame
        tf.word_wrap = True
        for i, it in enumerate(items):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.space_after = PptxPt(12)
            run = p.add_run()
            run.text = "·  " + it
            run.font.size = PptxPt(size)
            run.font.name = CN_BODY
            run.font.color.rgb = PptxRGB(0x1F, 0x28, 0x37)
        return self

    def table(self, title: str, header: Sequence[str], rows: Sequence[Sequence],
              size: int = 13, col_widths: Sequence[float] | None = None) -> "Deck":
        s = self.prs.slides.add_slide(self._blank)
        self._title(s, title)
        rows = list(rows)
        shape = s.shapes.add_table(len(rows) + 1, len(header), Inches(0.8), Inches(1.7),
                                   Inches(11.7), Inches(0.4 * (len(rows) + 1)))
        tbl = shape.table
        for i, h in enumerate(header):
            cell = tbl.cell(0, i)
            cell.text = ""
            p = cell.text_frame.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            run = p.add_run(); run.text = str(h)
            run.font.size = PptxPt(size); run.font.bold = True; run.font.name = CN_HEAD
            run.font.color.rgb = PptxRGB(0xFF, 0xFF, 0xFF)
            cell.fill.solid(); cell.fill.fore_color.rgb = PptxRGB(0x0B, 0x6E, 0x99)
        for r, row in enumerate(rows, start=1):
            for c, v in enumerate(row):
                cell = tbl.cell(r, c)
                cell.text = ""
                p = cell.text_frame.paragraphs[0]
                p.alignment = PP_ALIGN.CENTER
                run = p.add_run(); run.text = "" if v is None else str(v)
                run.font.size = PptxPt(size); run.font.name = CN_BODY
                run.font.color.rgb = PptxRGB(0x1F, 0x28, 0x37)
                cell.fill.solid()
                cell.fill.fore_color.rgb = PptxRGB(0xF4, 0xF8, 0xFB) if r % 2 else PptxRGB(0xFF, 0xFF, 0xFF)
        if col_widths:
            for i, w in enumerate(col_widths):
                tbl.columns[i].width = Inches(w)
        return self

    def chart(self, title: str, categories: Sequence[str], series: dict[str, Sequence[float]],
              kind: str = "bar", unit: str = "") -> "Deck":
        s = self.prs.slides.add_slide(self._blank)
        self._title(s, title)
        data = CategoryChartData()
        data.categories = list(categories)
        for name, vals in series.items():
            data.add_series(name, list(vals))
        ctype = XL_CHART_TYPE.COLUMN_CLUSTERED if kind == "bar" else XL_CHART_TYPE.LINE_MARKERS
        gf = s.shapes.add_chart(ctype, Inches(0.7), Inches(1.65), Inches(11.9), Inches(5.2), data)
        ch = gf.chart
        ch.has_legend = len(series) > 1
        if ch.has_legend and ch.legend is not None:
            ch.legend.position = XL_LEGEND_POSITION.BOTTOM
            ch.legend.include_in_layout = False
        if unit:
            ch.value_axis.has_title = True
            ch.value_axis.axis_title.text_frame.text = unit
        return self

    def picture(self, title: str, path: str, caption: str = "") -> "Deck":
        """图片页：标题 + 等比放大的图（图太大就居中缩到安全区里）。"""
        s = self.prs.slides.add_slide(self._blank)
        self._title(s, title)
        box_w, box_h = Inches(11.6), Inches(4.9)
        pic = s.shapes.add_picture(path, Inches(0.85), Inches(1.55), width=box_w)
        if pic.height > box_h:                      # 竖图：按高度缩，再水平居中
            ratio = box_h / pic.height
            pic.width = Emu(int(pic.width * ratio))
            pic.height = Emu(int(pic.height * ratio))
            pic.left = Emu(int((self.W - pic.width) / 2))
        if caption:
            box = s.shapes.add_textbox(Inches(0.85), Inches(6.55), Inches(11.6), Inches(0.6))
            self._text(box, caption, 14, False, PptxRGB(0x5B, 0x64, 0x72))
        return self

    def _title(self, slide, text: str) -> None:
        bar = slide.shapes.add_shape(1, 0, 0, self.W, Emu(int(Inches(1.15))))
        bar.fill.solid()
        bar.fill.fore_color.rgb = PptxRGB(0xF4, 0xF8, 0xFB)
        bar.line.fill.background()
        box = slide.shapes.add_textbox(Inches(0.8), Inches(0.28), Inches(11.7), Inches(0.7))
        self._text(box, text, 28, True, PptxRGB(0x0B, 0x6E, 0x99))

    def save(self, path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self.prs.save(path)
        return path
