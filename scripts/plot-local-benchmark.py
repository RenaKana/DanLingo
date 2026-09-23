"""Plot a completed, untimed capacity grid to SVG using ReportLab.

Usage: python scripts/plot-local-benchmark.py REPORT.json OUTPUT.svg
The vector artifact can also be rasterized with sharp.
"""
import argparse
import json
import math
from pathlib import Path

from reportlab.graphics import renderSVG
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, Line, Rect, String
from reportlab.graphics.widgets.markers import makeMarker
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("report", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
if args.output.suffix.lower() != ".svg":
    parser.error("output must be an .svg file")
data = json.loads(args.report.read_text(encoding="utf-8"))
benchmark = data["benchmark"]
groups = benchmark["groups"]
workloads = [("short", "短弹幕", "#215c3e"),
             ("normal", "普通弹幕", "#396ab1"),
             ("long", "长消息 / SC", "#a16620")]
parallels = [1, 2, 4, 8, 16]
expected = {(p, w) for p in parallels for w, _, _ in workloads}
actual = [(g["runtime"]["parallel"], g["workload"]) for g in groups]
if (benchmark["status"] != "completed" or len(actual) != len(expected)
        or set(actual) != expected or any(g["status"] != "completed" for g in groups)):
    raise ValueError("Expected one completed group for every 1/2/4/8/16 x workload")
counts = {g["stats"]["total"] for g in groups}
if len(counts) != 1 or any(g["config"]["measureGpu"] for g in groups):
    raise ValueError("Use a matched untimed grid for default-selection curves")

font_path = Path("C:/Windows/Fonts/msyh.ttc")
font = "Microsoft YaHei"
if font_path.exists():
    pdfmetrics.registerFont(TTFont(font, str(font_path), subfontIndex=0))
else:
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    font = "STSong-Light"
    pdfmetrics.registerFont(UnicodeCIDFont(font))
drawing = Drawing(960, 940)
drawing.add(Rect(0, 0, 960, 940, fillColor=white, strokeColor=None))


def label(x, y, text, size=12, color="#34453b", anchor="start"):
    drawing.add(String(x, y, text, fontName=font, fontSize=size,
                       fillColor=HexColor(color), textAnchor=anchor))


label(60, 899, "HY-MT 1.8B Q8_0 · RTX 5090", 24, "#203c2c")
label(60, 869, "单模型多序列：吞吐与排队延迟", 16)
recommended = benchmark["recommendation"]["recommendedParallel"]
label(60, 842, f"实测推荐 {recommended} 槽  ·  每格 {next(iter(counts))} 条  ·  应用并发 {benchmark['options']['applicationConcurrency']}", 12)
for index, (_, name, color) in enumerate(workloads):
    x = 540 + index * 120
    drawing.add(Line(x, 846, x + 22, 846, strokeColor=HexColor(color), strokeWidth=2))
    label(x + 29, 842, name, 11, color)

fields = [("吞吐（协议成功请求 / 秒）", lambda s: s["requestsPerSecond"]),
          ("平均端到端延迟（秒）", lambda s: s["endToEndMs"]["meanMs"] / 1000),
          ("P95 端到端延迟（秒）", lambda s: s["endToEndMs"]["p95Ms"] / 1000)]
for panel, (title, metric) in enumerate(fields):
    bottom = 627 - panel * 220
    label(60, bottom + 181, title, 13, "#203c2c")
    chart = LinePlot()
    chart.x, chart.y, chart.width, chart.height = 96, bottom, 790, 153
    chart.data = [[(math.log2(g["runtime"]["parallel"]), metric(g["stats"]))
                   for g in sorted(groups, key=lambda g: g["runtime"]["parallel"])
                   if g["workload"] == workload] for workload, _, _ in workloads]
    chart.xValueAxis.valueMin = 0
    chart.xValueAxis.valueMax = 4
    chart.xValueAxis.valueSteps = [0, 1, 2, 3, 4]
    chart.xValueAxis.labelTextFormat = lambda value: str(int(2 ** value))
    chart.yValueAxis.valueMin = 0
    chart.yValueAxis.valueMax = max(y for series in chart.data for _, y in series) * 1.12
    chart.yValueAxis.visibleGrid = True
    chart.yValueAxis.gridStrokeColor = HexColor("#e3e8e4")
    chart.yValueAxis.gridStrokeWidth = .6
    for axis in [chart.xValueAxis, chart.yValueAxis]:
        axis.labels.fontName = font
        axis.labels.fontSize = 10
        axis.strokeColor = HexColor("#b7c3ba")
    for index, (_, _, color) in enumerate(workloads):
        chart.lines[index].strokeColor = HexColor(color)
        chart.lines[index].strokeWidth = 2
        chart.lines[index].symbol = makeMarker("FilledCircle")
        chart.lines[index].symbol.size = 5
    if recommended in parallels:
        x = chart.x + math.log2(recommended) / 4 * chart.width
        drawing.add(Line(x, bottom, x, bottom + chart.height,
                         strokeColor=HexColor("#b7c3ba"), strokeDashArray=[3, 3]))
    drawing.add(chart)

label(491, 146, "原生推理槽 n_parallel（2 倍递增刻度）", 12, anchor="middle")
success = sum(g["stats"]["success"] for g in groups)
total = sum(g["stats"]["total"] for g in groups)
timeouts = sum(g["stats"]["timeout"] for g in groups)
label(60, 104, f"全部 {total} 条：{success} 条协议成功，{total-success} 条失败，{timeouts} 条超时。", 11)
label(60, 81, "延迟包含排队，仅统计协议成功请求；长消息有生成长度截断。", 11)
label(60, 58, "GPU timestamp 诊断关闭。协议成功不代表语义质量；压力网格不代表直播及时率。", 11)
label(60, 30, f"来源：{args.report.parent.name} / report.json · 原生 RAM 提示词快照已关闭", 10, "#66766b")
args.output.parent.mkdir(parents=True, exist_ok=True)
renderSVG.drawToFile(drawing, str(args.output))
print(args.output.resolve())
