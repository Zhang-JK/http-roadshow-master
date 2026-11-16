#!/usr/bin/env python3
"""Draws one chart for a slide from a JSON spec (stdin) with matplotlib.

Output (stdout): {"svg": "<svg …>", "png": "<base64 preview>", "width": W, "height": H}.
The SVG keeps its text as text (it can be read, searched and copied) and has a transparent
background, so it sits on any slide. Errors: a message on stderr and exit code 2.

Spec (all keys optional except type and the data):
  type        bar | line | area | pie | donut | scatter | combo | waterfall | funnel | heatmap | radar
  categories  labels of the x axis / slices / funnel steps / heatmap columns / radar axes
  series      [{name, values: [number|null], type: bar|line (combo), axis: left|right (combo), color}]
              scatter: [{name, x: [..], y: [..], labels: [..]}]; heatmap: one series per row
  title, x_label, y_label, y2_label, unit, decimals, horizontal, stacked, show_values, legend,
  highlight (category names drawn in the accent color, the rest muted), totals (waterfall: indexes
  of categories that are absolute totals), center_text (donut), colors, text_color, muted_color,
  background, font_family, font_size (px), width, height (px)
"""
import base64
import io
import json
import logging
import math
import sys

import matplotlib

matplotlib.use("Agg")
logging.getLogger("matplotlib").setLevel(logging.ERROR)
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter, MaxNLocator  # noqa: E402

TYPES = {"bar", "line", "area", "pie", "donut", "scatter", "combo", "waterfall", "funnel", "heatmap", "radar"}
PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#64748b", "#a16207"]
CJK_FONTS = ["Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", "WenQuanYi Micro Hei", "Droid Sans Fallback"]
MAX_POINTS = 500
MAX_SERIES = 12


class SpecError(Exception):
    pass


def num(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        raise SpecError(f"数值不能是布尔值：{v}")
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    # "1,234", "45%" (the unit goes in `unit`): the number as written.
    s = str(v).strip().replace(",", "").replace("，", "").rstrip("%")
    try:
        f = float(s)
    except ValueError:
        raise SpecError(f"无法识别的数值：{v!r}")
    return f if math.isfinite(f) else None


def is_light(color):
    from matplotlib.colors import to_rgb

    try:
        r, g, b = to_rgb(color)
    except ValueError:
        return False
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6


def valid_color(c):
    from matplotlib.colors import is_color_like

    return isinstance(c, str) and c.strip() != "" and is_color_like(c.strip())


def color_list(spec):
    colors = [c.strip() for c in (spec.get("colors") or []) if valid_color(c)]
    return colors + [c for c in PALETTE if c not in colors]


class Fmt:
    def __init__(self, spec, values):
        self.unit = str(spec.get("unit") or "")
        d = spec.get("decimals")
        if d is None:
            finite = [v for v in values if v is not None]
            d = 0 if all(abs(v - round(v)) < 1e-9 for v in finite) else (1 if all(abs(v) >= 10 for v in finite if v) else 2)
        self.decimals = max(0, min(4, int(d)))

    def value(self, v, unit=True):
        if v is None:
            return ""
        s = f"{v:,.{self.decimals}f}"
        return s + self.unit if unit else s

    def tick(self, v, _pos=None):
        d = self.decimals if abs(v) < 10 and abs(v - round(v)) > 1e-9 else 0
        s = f"{v:,.{d}f}"
        return s + self.unit if self.unit in ("%", "‰") else s


def setup(spec):
    w = max(200, min(4000, int(spec.get("width") or 1200)))
    h = max(150, min(4000, int(spec.get("height") or 675)))
    fs = max(8, min(72, float(spec.get("font_size") or round(min(w, h * 16 / 9) / 54))))
    text = spec["text_color"] if valid_color(spec.get("text_color")) else "#1f2937"
    muted = spec["muted_color"] if valid_color(spec.get("muted_color")) else "#9ca3af"
    for key in ("background", "up_color", "down_color"):
        if spec.get(key) not in (None, "transparent") and not valid_color(spec.get(key)):
            spec.pop(key)
    for s in spec.get("series") or []:
        if isinstance(s, dict) and s.get("color") is not None and not valid_color(s["color"]):
            s.pop("color")
    fonts = [f for f in (spec.get("font_family") or []) if isinstance(f, str)]
    plt.rcParams.update(
        {
            "svg.fonttype": "none",
            "svg.hashsalt": "roadshow-chart",
            "font.family": "sans-serif",
            "font.sans-serif": fonts + CJK_FONTS + ["DejaVu Sans"],
            "font.size": fs,
            "axes.titlesize": fs * 1.25,
            "axes.titleweight": "bold",
            "axes.labelsize": fs * 0.9,
            "xtick.labelsize": fs * 0.85,
            "ytick.labelsize": fs * 0.85,
            "legend.fontsize": fs * 0.85,
            "text.color": text,
            "axes.labelcolor": text,
            "xtick.color": text,
            "ytick.color": text,
            "axes.edgecolor": muted,
            "axes.linewidth": 1.2,
            "axes.unicode_minus": False,
            "legend.frameon": False,
        }
    )
    # 1 pt in the SVG = 1 px on the slide: the figure is w×h points.
    fig = plt.figure(figsize=(w / 72, h / 72), dpi=72, layout="constrained")
    bg = spec.get("background")
    if bg and bg != "transparent":
        fig.patch.set_facecolor(bg)
    return fig, w, h, fs, text, muted


def clean_axes(ax, muted, grid_axis="y"):
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.set_facecolor("none")
    if grid_axis:
        ax.grid(axis=grid_axis, color=muted, alpha=0.25, linewidth=1)
        ax.set_axisbelow(True)
    ax.tick_params(length=0, pad=6)


def get_series(spec, need_values=True):
    series = spec.get("series")
    if not isinstance(series, list) or not series:
        raise SpecError("series 至少需要一组数据")
    if len(series) > MAX_SERIES:
        raise SpecError(f"最多 {MAX_SERIES} 组数据")
    out = []
    for i, s in enumerate(series):
        if not isinstance(s, dict):
            raise SpecError("series 的每一项应是对象：{name, values}")
        item = dict(s)
        item["name"] = str(s.get("name") or f"系列 {i + 1}")
        if need_values:
            vals = s.get("values")
            if not isinstance(vals, list) or not vals:
                raise SpecError(f"「{item['name']}」缺少 values")
            item["values"] = [num(v) for v in vals[:MAX_POINTS]]
        out.append(item)
    return out


def get_categories(spec, n):
    cats = spec.get("categories")
    if cats is None:
        return [str(i + 1) for i in range(n)]
    if not isinstance(cats, list) or not cats:
        raise SpecError("categories 应是非空数组")
    return [str(c) for c in cats[:MAX_POINTS]]


def aligned(series, cats):
    for s in series:
        if len(s["values"]) != len(cats):
            raise SpecError(f"「{s['name']}」有 {len(s['values'])} 个数值，但 categories 有 {len(cats)} 项")


def show_values(spec, n):
    v = spec.get("show_values")
    return bool(v) if v is not None else n <= 16


def legend(spec, ax, n, **kw):
    if spec.get("legend", n > 1):
        ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.1 if kw.pop("below", True) else 1.02), ncol=min(n, 5), **kw)


def bar(spec, fig, fs, text, muted):
    series = get_series(spec)
    cats = get_categories(spec, len(series[0]["values"]))
    aligned(series, cats)
    ax = fig.add_subplot()
    horizontal = bool(spec.get("horizontal")) or (len(cats) > 8 and len(series) == 1 and max(len(c) for c in cats) > 4)
    stacked = bool(spec.get("stacked")) and len(series) > 1
    colors = color_list(spec)
    fmt = Fmt(spec, [v for s in series for v in s["values"]])
    n = len(series)
    width = 0.7 if stacked or n == 1 else 0.8 / n
    highlight = {str(h) for h in (spec.get("highlight") or [])}
    base = [0.0] * len(cats)
    labels = show_values(spec, len(cats) * (1 if stacked else n))
    pos = list(range(len(cats)))
    for i, s in enumerate(series):
        vals = [v or 0 for v in s["values"]]
        offs = [p if stacked or n == 1 else p - 0.4 + width * (i + 0.5) for p in pos]
        c = s.get("color") or colors[i]
        if n == 1 and highlight:
            c = [c if cat in highlight else muted for cat in cats]
        if horizontal:
            bars = ax.barh(offs, vals, height=width, left=base if stacked else None, label=s["name"], color=c)
        else:
            bars = ax.bar(offs, vals, width=width, bottom=base if stacked else None, label=s["name"], color=c)
        if labels:
            ax.bar_label(
                bars,
                labels=[fmt.value(v) for v in s["values"]],
                label_type="center" if stacked else "edge",
                padding=0 if stacked else 4,
                color="white" if stacked else text,
                fontsize=fs * 0.8,
            )
        if stacked:
            base = [b + v for b, v in zip(base, vals)]
    if horizontal:
        ax.set_yticks(pos, cats)
        ax.invert_yaxis()
        ax.xaxis.set_major_formatter(FuncFormatter(fmt.tick))
        clean_axes(ax, muted, "x")
        if labels:
            ax.margins(x=0.12)
    else:
        ax.set_xticks(pos, cats)
        ax.yaxis.set_major_formatter(FuncFormatter(fmt.tick))
        clean_axes(ax, muted)
        if labels:
            ax.margins(y=0.12)
        if len(cats) > 6 and max(len(c) for c in cats) > 4:
            plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
    axis_labels(spec, ax)
    legend(spec, ax, n)
    return ax


def axis_labels(spec, ax):
    if spec.get("x_label"):
        ax.set_xlabel(str(spec["x_label"]))
    if spec.get("y_label"):
        ax.set_ylabel(str(spec["y_label"]))


def line(spec, fig, fs, text, muted, area=False):
    series = get_series(spec)
    cats = get_categories(spec, len(series[0]["values"]))
    aligned(series, cats)
    ax = fig.add_subplot()
    colors = color_list(spec)
    fmt = Fmt(spec, [v for s in series for v in s["values"]])
    pos = list(range(len(cats)))
    stacked = area and bool(spec.get("stacked")) and len(series) > 1
    if stacked:
        ax.stackplot(pos, [[v or 0 for v in s["values"]] for s in series], labels=[s["name"] for s in series], colors=colors[: len(series)], alpha=0.85)
    for i, s in enumerate(series):
        c = s.get("color") or colors[i]
        vals = [math.nan if v is None else v for v in s["values"]]
        if not stacked:
            ax.plot(pos, vals, color=c, linewidth=max(2, fs / 8), marker="o" if len(cats) <= 12 else None, markersize=fs / 3, label=s["name"])
            if area:
                ax.fill_between(pos, vals, alpha=0.15, color=c)
            last = max((j for j, v in enumerate(s["values"]) if v is not None), default=None)
            if last is not None and show_values(spec, len(cats)):
                for j, v in enumerate(s["values"]):
                    if v is not None and (len(cats) <= 8 or j == last):
                        ax.annotate(fmt.value(v), (j, v), textcoords="offset points", xytext=(0, fs * 0.6), ha="center", fontsize=fs * 0.75, color=c)
    ax.set_xticks(pos, cats)
    if len(cats) > 12:
        ax.xaxis.set_major_locator(MaxNLocator(12, integer=True))
        ax.set_xticks(ax.get_xticks()[(ax.get_xticks() >= 0) & (ax.get_xticks() < len(cats))])
        ax.set_xticklabels([cats[int(t)] for t in ax.get_xticks()])
    ax.yaxis.set_major_formatter(FuncFormatter(fmt.tick))
    ax.margins(x=0.04, y=0.15)
    clean_axes(ax, muted)
    axis_labels(spec, ax)
    legend(spec, ax, len(series))
    return ax


def pie(spec, fig, fs, text, muted, donut=False):
    s = get_series(spec)[0]
    cats = get_categories(spec, len(s["values"]))
    aligned([s], cats)
    pairs = [(c, v) for c, v in zip(cats, s["values"]) if v and v > 0]
    if not pairs:
        raise SpecError("饼图需要正数")
    ax = fig.add_subplot()
    colors = color_list(spec)
    fmt = Fmt(spec, [v for _, v in pairs])
    total = sum(v for _, v in pairs)
    wedges, _texts, autotexts = ax.pie(
        [v for _, v in pairs],
        labels=[c for c, _ in pairs],
        colors=colors[: len(pairs)],
        startangle=90,
        counterclock=False,
        autopct=lambda p: f"{p:.0f}%" if p >= 3 else "",
        pctdistance=0.78 if donut else 0.62,
        labeldistance=1.08,
        wedgeprops={"width": 0.42, "edgecolor": "white", "linewidth": 2} if donut else {"edgecolor": "white", "linewidth": 2},
        textprops={"fontsize": fs * 0.85, "color": text},
    )
    for t in autotexts:
        t.set_color("white")
        t.set_fontweight("bold")
    if donut:
        center = spec.get("center_text") or fmt.value(total)
        ax.text(0, 0, str(center), ha="center", va="center", fontsize=fs * 1.4, fontweight="bold", color=text)
    ax.set_aspect("equal")
    return ax


def scatter(spec, fig, fs, text, muted):
    series = get_series(spec, need_values=False)
    ax = fig.add_subplot()
    colors = color_list(spec)
    every = []
    for i, s in enumerate(series):
        xs, ys = s.get("x"), s.get("y")
        if not isinstance(xs, list) or not isinstance(ys, list) or len(xs) != len(ys) or not xs:
            raise SpecError(f"散点图「{s['name']}」需要等长的 x 与 y")
        xs = [num(v) for v in xs[:MAX_POINTS]]
        ys = [num(v) for v in ys[:MAX_POINTS]]
        every += ys
        ax.scatter(xs, ys, s=(fs * 0.9) ** 2, color=s.get("color") or colors[i], alpha=0.85, label=s["name"], edgecolors="white", linewidths=1)
        for x, y, lab in zip(xs, ys, s.get("labels") or []):
            if lab:
                ax.annotate(str(lab), (x, y), textcoords="offset points", xytext=(fs * 0.5, fs * 0.3), fontsize=fs * 0.75)
    fmt = Fmt(spec, every)
    ax.yaxis.set_major_formatter(FuncFormatter(fmt.tick))
    clean_axes(ax, muted, "both")
    axis_labels(spec, ax)
    legend(spec, ax, len(series))
    return ax


def combo(spec, fig, fs, text, muted):
    series = get_series(spec)
    cats = get_categories(spec, len(series[0]["values"]))
    aligned(series, cats)
    ax = fig.add_subplot()
    right = None
    colors = color_list(spec)
    bars = [s for s in series if s.get("type", "bar") == "bar"]
    pos = list(range(len(cats)))
    width = 0.8 / max(1, len(bars))
    handles = []
    left_fmt = Fmt(spec, [v for s in series if s.get("axis") != "right" for v in s["values"]])
    right_spec = dict(spec, unit=spec.get("unit2", spec.get("unit")))
    right_fmt = Fmt(right_spec, [v for s in series if s.get("axis") == "right" for v in s["values"]] or [0])
    for i, s in enumerate(series):
        c = s.get("color") or colors[i]
        target = ax
        fmt = left_fmt
        if s.get("axis") == "right":
            right = right or ax.twinx()
            target, fmt = right, right_fmt
        vals = [math.nan if v is None else v for v in s["values"]]
        if s.get("type", "bar") == "bar":
            k = bars.index(s)
            offs = [p - 0.4 + width * (k + 0.5) for p in pos]
            h = target.bar(offs, [0 if math.isnan(v) else v for v in vals], width, color=c, label=s["name"])
            if show_values(spec, len(cats) * len(bars)):
                target.bar_label(h, labels=[fmt.value(v) for v in s["values"]], padding=4, fontsize=fs * 0.75, color=text)
        else:
            (h,) = target.plot(pos, vals, color=c, linewidth=max(2, fs / 8), marker="o", markersize=fs / 3, label=s["name"])
            if show_values(spec, len(cats)):
                for j, v in enumerate(s["values"]):
                    if v is not None:
                        target.annotate(fmt.value(v), (j, v), textcoords="offset points", xytext=(0, fs * 0.6), ha="center", fontsize=fs * 0.75, color=c)
        handles.append(h)
    ax.set_xticks(pos, cats)
    ax.yaxis.set_major_formatter(FuncFormatter(left_fmt.tick))
    ax.margins(y=0.15)
    clean_axes(ax, muted)
    if right:
        right.yaxis.set_major_formatter(FuncFormatter(right_fmt.tick))
        right.spines["top"].set_visible(False)
        right.tick_params(length=0, pad=6)
        # Bars in the lower part, the line above them, so their labels do not collide.
        left_top = max([v for s in bars for v in s["values"] if v is not None] or [1])
        ax.set_ylim(0, left_top * 1.7)
        rv = [v for s in series if s.get("axis") == "right" for v in s["values"] if v is not None] or [0, 1]
        lo, hi = min(0, min(rv)), max(rv)
        span = (hi - lo) or 1
        right.set_ylim(lo - span * 1.2, hi + span * 0.25)
        right.set_yticks([t for t in MaxNLocator(5).tick_values(lo, hi) if lo <= t <= hi + span * 0.1])
        if spec.get("y2_label"):
            right.set_ylabel(str(spec["y2_label"]))
    axis_labels(spec, ax)
    if spec.get("legend", True):
        ax.legend(handles, [h.get_label() for h in handles], loc="upper center", bbox_to_anchor=(0.5, -0.1), ncol=min(len(handles), 5))
    return ax


def waterfall(spec, fig, fs, text, muted):
    s = get_series(spec)[0]
    cats = get_categories(spec, len(s["values"]))
    aligned([s], cats)
    totals = {int(i) for i in (spec.get("totals") or []) if isinstance(i, (int, float))}
    colors = color_list(spec)
    up, down, total_c = spec.get("up_color") or "#10b981", spec.get("down_color") or "#ef4444", colors[0]
    ax = fig.add_subplot()
    fmt = Fmt(spec, s["values"])
    run = 0.0
    bottoms, heights, cs, shown = [], [], [], []
    for i, v in enumerate(s["values"]):
        v = v or 0
        if i in totals or i == 0:
            bottoms.append(0)
            heights.append(v)
            cs.append(total_c)
            run = v
            shown.append(fmt.value(v))
        else:
            bottoms.append(run if v >= 0 else run + v)
            heights.append(abs(v))
            cs.append(up if v >= 0 else down)
            run += v
            shown.append(("+" if v > 0 else "") + fmt.value(v))
    pos = list(range(len(cats)))
    bars = ax.bar(pos, heights, 0.6, bottom=bottoms, color=cs)
    ax.bar_label(bars, labels=shown, padding=4, fontsize=fs * 0.8, color=text)
    for i in range(len(pos) - 1):
        level = bottoms[i] + heights[i] if (cs[i] != down) else bottoms[i]
        ax.plot([i + 0.3, i + 0.7], [level, level], color=muted, linewidth=1, linestyle="--")
    ax.set_xticks(pos, cats)
    ax.yaxis.set_major_formatter(FuncFormatter(fmt.tick))
    ax.margins(y=0.12)
    clean_axes(ax, muted)
    axis_labels(spec, ax)
    return ax


def funnel(spec, fig, fs, text, muted):
    s = get_series(spec)[0]
    cats = get_categories(spec, len(s["values"]))
    aligned([s], cats)
    vals = [v or 0 for v in s["values"]]
    top = max(vals) or 1
    colors = color_list(spec)
    fmt = Fmt(spec, vals)
    ax = fig.add_subplot()
    pos = list(range(len(cats)))
    ax.barh(pos, vals, left=[(top - v) / 2 for v in vals], height=0.78, color=[colors[0]] * len(vals), alpha=1)
    for i, v in enumerate(vals):
        ax.patches[i].set_alpha(1 - 0.55 * i / max(1, len(vals) - 1))
        conv = f"（{v / vals[0] * 100:.0f}%）" if i and vals[0] else ""
        label = f"{fmt.value(v)}{conv}"
        if v / top > 0.4:
            ax.text(top / 2, i, label, ha="center", va="center", color="white", fontweight="bold", fontsize=fs * 0.9)
        else:
            ax.text((top + v) / 2 + top * 0.02, i, label, ha="left", va="center", color=text, fontweight="bold", fontsize=fs * 0.9)
    ax.set_yticks(pos, cats)
    ax.invert_yaxis()
    ax.set_xticks([])
    for side in ("top", "right", "bottom", "left"):
        ax.spines[side].set_visible(False)
    ax.tick_params(length=0, pad=8)
    ax.set_facecolor("none")
    return ax


def heatmap(spec, fig, fs, text, muted):
    series = get_series(spec)
    cats = get_categories(spec, len(series[0]["values"]))
    aligned(series, cats)
    ax = fig.add_subplot()
    from matplotlib.colors import LinearSegmentedColormap

    base = color_list(spec)[0]
    cmap = LinearSegmentedColormap.from_list("rs", ["#f8fafc", base])
    grid = [[math.nan if v is None else v for v in s["values"]] for s in series]
    finite = [v for row in grid for v in row if not math.isnan(v)]
    fmt = Fmt(spec, finite)
    im = ax.imshow(grid, cmap=cmap, aspect="auto")
    lo, hi = (min(finite), max(finite)) if finite else (0, 1)
    if len(cats) * len(series) <= 120:
        for r, row in enumerate(grid):
            for c, v in enumerate(row):
                if not math.isnan(v):
                    dark = (v - lo) / ((hi - lo) or 1) > 0.55
                    ax.text(c, r, fmt.value(v), ha="center", va="center", fontsize=fs * 0.75, color="white" if dark else text)
    ax.set_xticks(range(len(cats)), cats)
    ax.set_yticks(range(len(series)), [s["name"] for s in series])
    for side in ("top", "right", "bottom", "left"):
        ax.spines[side].set_visible(False)
    ax.tick_params(length=0, pad=6)
    fig.colorbar(im, ax=ax, shrink=0.8, format=FuncFormatter(fmt.tick)).outline.set_visible(False)
    axis_labels(spec, ax)
    return ax


def radar(spec, fig, fs, text, muted):
    series = get_series(spec)
    cats = get_categories(spec, len(series[0]["values"]))
    aligned(series, cats)
    if len(cats) < 3:
        raise SpecError("雷达图至少需要 3 个维度")
    ax = fig.add_subplot(projection="polar")
    colors = color_list(spec)
    angles = [2 * math.pi * i / len(cats) for i in range(len(cats))]
    for i, s in enumerate(series):
        vals = [v or 0 for v in s["values"]]
        c = s.get("color") or colors[i]
        ax.plot(angles + angles[:1], vals + vals[:1], color=c, linewidth=max(2, fs / 8), label=s["name"])
        ax.fill(angles + angles[:1], vals + vals[:1], color=c, alpha=0.18)
    ax.set_xticks(angles, cats)
    ax.set_theta_offset(math.pi / 2)
    ax.set_theta_direction(-1)
    ax.tick_params(axis="y", labelsize=fs * 0.65, colors=muted)
    ax.grid(color=muted, alpha=0.35)
    ax.spines["polar"].set_color(muted)
    ax.set_facecolor("none")
    legend(spec, ax, len(series), below=True)
    return ax


DRAW = {
    "bar": bar,
    "line": line,
    "area": lambda *a: line(*a, area=True),
    "pie": pie,
    "donut": lambda *a: pie(*a, donut=True),
    "scatter": scatter,
    "combo": combo,
    "waterfall": waterfall,
    "funnel": funnel,
    "heatmap": heatmap,
    "radar": radar,
}


def render(spec):
    kind = str(spec.get("type") or "").strip().lower()
    if kind not in TYPES:
        raise SpecError(f"不支持的图表类型「{kind}」，type 应为 {' / '.join(sorted(TYPES))} 之一")
    fig, w, h, fs, text, muted = setup(spec)
    ax = DRAW[kind](spec, fig, fs, text, muted)
    if spec.get("title"):
        fig.suptitle(str(spec["title"]), fontsize=fs * 1.3, fontweight="bold", color=text)
    del ax
    svg = io.StringIO()
    fig.savefig(svg, format="svg", transparent=not spec.get("background") or spec.get("background") == "transparent", metadata={"Date": None})
    png = io.BytesIO()
    preview_bg = spec.get("background") if spec.get("background") not in (None, "", "transparent") else ("#111827" if is_light(text) else "white")
    fig.savefig(png, format="png", dpi=72 * min(1, 720 / w), facecolor=preview_bg)
    plt.close(fig)
    out = svg.getvalue()
    out = out[out.index("<svg") :]
    out = out.replace(f'width="{w}pt" height="{h}pt"', f'width="{w}" height="{h}"', 1)
    return {"svg": out, "png": base64.b64encode(png.getvalue()).decode(), "width": w, "height": h}


def main():
    try:
        spec = json.load(sys.stdin)
        if not isinstance(spec, dict):
            raise SpecError("图表参数应是一个 JSON 对象")
        json.dump(render(spec), sys.stdout)
    except SpecError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    except (ValueError, TypeError) as e:
        print(f"图表参数有误：{e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
