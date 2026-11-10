#!/usr/bin/env python3
"""Create a roadshow deck through the 路演生成器 MCP server.

The server must have 「允许 MCP 请求」 switched on (用户管理 → mcp) and an MCP token.
Pass the token in ROADSHOW_MCP_TOKEN rather than on the command line.

    pip install "mcp>=1.10"            # matplotlib is optional, for nicer demo charts
    export ROADSHOW_MCP_TOKEN=rs_mcp_...

    # list the templates
    python3 mcp_create_roadshow.py --url http://localhost:9090/mcp --list

    # a deck from a built-in sample load test (CSV, Markdown report and charts)
    python3 mcp_create_roadshow.py --url http://localhost:9090/mcp --demo

    # a deck from your own results
    python3 mcp_create_roadshow.py --url http://localhost:9090/mcp \\
        --template "测试报告" --name "支付网关 3.2 压测报告" --content-file summary.md \\
        --file results.csv --file p99.png --file flame.png:reference --download pdf,pptx
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

TEXT_SUFFIXES = {".html", ".htm", ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml"}
EXPORT_SUFFIX = {"html": ".html", "pdf": ".pdf", "pdf-image": "-image.pdf", "pptx": ".pptx", "zip": ".zip"}


@asynccontextmanager
async def connect(url: str, token: str) -> AsyncIterator[Any]:
    """An MCP client session with list_tools() and call_tool(), for mcp 2.x and 1.x."""
    headers = {"Authorization": f"Bearer {token}"}
    try:
        from mcp import Client  # mcp >= 2
    except ImportError:
        Client = None
    if Client is not None:
        import httpx2
        from mcp.client.streamable_http import streamable_http_client

        async with httpx2.AsyncClient(headers=headers, timeout=httpx2.Timeout(30, read=120)) as http:
            async with Client(streamable_http_client(url, http_client=http)) as client:
                yield client
        return
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(url, headers=headers, timeout=30, sse_read_timeout=120) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


def field(result: Any, snake: str, camel: str) -> Any:
    return getattr(result, snake, None) if hasattr(result, snake) else getattr(result, camel, None)


async def call(session: Any, tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Calls a tool and returns its JSON result; a tool error stops the script with the server's message."""
    result = await session.call_tool(tool, args)
    texts = [c.text for c in result.content if getattr(c, "type", "") == "text"]
    if field(result, "is_error", "isError"):
        sys.exit(f"{tool} failed: {' '.join(texts)}")
    data = field(result, "structured_content", "structuredContent")
    if data is None:
        data = json.loads(texts[0]) if texts and texts[0].lstrip().startswith("{") else {"text": "\n".join(texts)}
    data["_images"] = [c for c in result.content if getattr(c, "type", "") == "image"]
    return data


def file_arg(spec: str) -> dict[str, Any]:
    """PATH or PATH:embed / PATH:reference, as one entry of the files argument."""
    role = None
    m = re.match(r"^(.*):(embed|reference)$", spec)
    if m:
        spec, role = m.group(1), m.group(2)
    path = Path(spec).expanduser()
    if not path.is_file():
        sys.exit(f"File not found: {path}")
    entry: dict[str, Any] = {"filename": path.name}
    if path.suffix.lower() in TEXT_SUFFIXES:
        entry["text"] = path.read_text(encoding="utf-8")
    else:
        entry["data"] = base64.b64encode(path.read_bytes()).decode("ascii")
    if role:
        entry["role"] = role
    return entry


def pick_template(templates: list[dict[str, Any]], wanted: str | None) -> dict[str, Any]:
    if not templates:
        sys.exit("No template is ready yet; create one on the web page (模板) first.")
    if not wanted:
        return templates[0]
    for t in templates:
        if t["templateId"] == wanted:
            return t
    matches = [t for t in templates if wanted.lower() in t["name"].lower()]
    if len(matches) == 1:
        return matches[0]
    names = ", ".join(f'"{t["name"]}" ({t["templateId"]})' for t in (matches or templates))
    sys.exit(f'Template "{wanted}" is {"ambiguous" if matches else "unknown"}; choose one of: {names}')


def print_templates(templates: list[dict[str, Any]]) -> None:
    for t in templates:
        print(f'{t["templateId"]}  {t["name"]}  ({t["size"]}, {t["layoutCount"]} layouts)')
        for key in ("style", "purpose", "audience"):
            if t.get(key):
                print(f"    {key}: {t[key]}")
        titles = [lay.get("title") or lay["file"] for lay in t.get("layouts", [])]
        if titles:
            print(f'    layouts: {" | ".join(titles)}')


def download(url: str, token: str, out_dir: Path, fallback: str) -> Path:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            disposition = response.headers.get("Content-Disposition", "")
            m = re.search(r"filename\*=UTF-8''([^;]+)", disposition)
            name = urllib.parse.unquote(m.group(1)) if m else fallback
            target = out_dir / name
            target.write_bytes(response.read())
            return target
    except urllib.error.HTTPError as e:
        sys.exit(f"Download failed ({e.code}): {e.read().decode('utf-8', 'replace')}")


# --- demo data: a load test of a search service, old release against new ---------------------------

LEVELS = [50, 100, 200, 400, 800]
RESULTS = {
    "v1.8": {"qps": [2450, 4600, 6100, 6400, 6350], "p50": [9, 11, 18, 41, 96], "p95": [21, 27, 46, 118, 260],
             "p99": [34, 48, 85, 210, 480], "errors": [0, 0, 0.02, 0.4, 2.9], "cpu": [31, 55, 82, 97, 99]},
    "v2.0": {"qps": [2480, 4920, 8300, 10900, 11400], "p50": [7, 8, 11, 19, 44], "p95": [15, 18, 26, 52, 120],
             "p99": [22, 29, 41, 88, 205], "errors": [0, 0, 0, 0.01, 0.3], "cpu": [24, 41, 63, 84, 96]},
}


def demo_table(metric: str, unit: str) -> str:
    rows = [f"| 并发 | v1.8 {metric} ({unit}) | v2.0 {metric} ({unit}) | 变化 |", "|---|---|---|---|"]
    for i, level in enumerate(LEVELS):
        a, b = RESULTS["v1.8"][metric][i], RESULTS["v2.0"][metric][i]
        change = f"{(b - a) / a * 100:+.0f}%" if a else "—"
        rows.append(f"| {level} | {a} | {b} | {change} |")
    return "\n".join(rows)


def demo_csv() -> str:
    lines = ["version,concurrency,qps,p50_ms,p95_ms,p99_ms,error_rate_pct,cpu_pct"]
    for version, r in RESULTS.items():
        for i, level in enumerate(LEVELS):
            lines.append(f"{version},{level},{r['qps'][i]},{r['p50'][i]},{r['p95'][i]},{r['p99'][i]},{r['errors'][i]},{r['cpu'][i]}")
    return "\n".join(lines) + "\n"


DEMO_SETUP = """- 被测服务：搜索 API（v1.8 线上版本 与 v2.0 候选版本），3 台 c6i.4xlarge（16 vCPU / 32 GB），Ubuntu 22.04，JDK 21
- 后端：Elasticsearch 8.13 集群 6 节点，索引 5200 万文档（与生产一致）
- 压测工具：k6 0.50，独立 2 台施压机；查询从生产日志回放（Top 100 万查询混合，含 12% 长尾查询）
- 方法：每个并发档位预热 2 分钟后稳定压测 10 分钟，记录 p50 / p95 / p99 延迟、QPS、错误率（超时 1 s 计为错误）与 CPU
- SLA：p99 < 100 ms，错误率 < 0.1%
- v2.0 主要改动：查询结果缓存（TTL 60 s）、异步 I/O、与 ES 的连接池复用"""


def demo_content() -> str:
    return f"""# 搜索服务 v2.0 压测报告

## 1. 测试目标
验证 v2.0 能否在 p99 < 100 ms 的 SLA 下支撑双十一预估峰值 8000 QPS，并与线上 v1.8 对比容量和稳定性。

## 2. 测试环境与方法
{DEMO_SETUP}

## 3. 吞吐量（见 throughput.png）
{demo_table("qps", "QPS")}

v1.8 在 400 并发后吞吐量饱和（约 6400 QPS，CPU 97%）；v2.0 到 800 并发仍在增长，峰值 11400 QPS。

## 4. 延迟（见 latency.png，虚线为 100 ms SLA）
{demo_table("p99", "ms")}

p50 / p95 完整数据见 results.csv。v1.8 在 400 并发时 p99 为 210 ms，超出 SLA；v2.0 在 400 并发（10900 QPS）时 p99 为 88 ms，满足 SLA。

## 5. 错误率与资源
{demo_table("errors", "%")}

CPU：v1.8 在 400 并发达到 97%，v2.0 为 84%。v2.0 内存占用比 v1.8 高 12%（缓存）。

## 6. 异常与限制
- v2.0 冷启动前 3 分钟缓存未命中，p99 达到 140 ms，之后回落到 40 ms 以下
- 800 并发下 v2.0 有 0.3% 请求超时，原因是 ES 线程池排队（report.md 第 4 节）
- 本次未覆盖跨机房故障切换场景

## 7. 结论与下一步
- 结论：v2.0 满足 8000 QPS / p99 < 100 ms 目标，同等 SLA 下容量提升约 70%（6100 → 10900 QPS）
- 风险：冷启动缓存未命中、内存 +12%
- 下一步：5% 流量灰度一周；启动时预热缓存；5 节点下测试 1600 并发

附件：results.csv（全部原始数据）、report.md（完整测试报告）、latency.png（p99 延迟曲线）、throughput.png（吞吐量对比）。每页注明数据来源。"""


def demo_report() -> str:
    return f"""# 搜索服务 v2.0 压测报告（完整版）

## 1. 环境
{DEMO_SETUP}

## 2. 吞吐量
{demo_table("qps", "QPS")}

## 3. 延迟
### p50
{demo_table("p50", "ms")}

### p95
{demo_table("p95", "ms")}

### p99
{demo_table("p99", "ms")}

## 4. 错误分析
{demo_table("errors", "%")}

800 并发时 v2.0 的 0.3% 错误全部为 1 s 超时，对应时间段 ES search 线程池队列长度峰值 870（上限 1000），
扩容 ES 到 8 节点后复测错误率降到 0.02%。

## 5. CPU
{demo_table("cpu", "%")}
"""


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def bars_png(series: list[list[float]], colors: list[tuple[int, int, int]], width: int = 960, height: int = 540) -> bytes:
    """A grouped bar chart without dependencies, used when matplotlib is not installed."""
    pixels = [[(255, 255, 255)] * width for _ in range(height)]
    top = max(max(s) for s in series)
    groups, margin = len(series[0]), 60
    slot = (width - 2 * margin) / groups
    bar = slot / (len(series) + 1)
    for g in range(groups):
        for s, values in enumerate(series):
            h = int((height - 2 * margin) * values[g] / top)
            x0 = int(margin + g * slot + bar * (s + 0.5))
            for y in range(height - margin - h, height - margin):
                for x in range(x0, int(x0 + bar)):
                    pixels[y][x] = colors[s]
    for x in range(margin, width - margin):
        pixels[height - margin][x] = (60, 60, 60)
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pixels)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(raw, 9)) + png_chunk(b"IEND", b"")


def demo_charts(out: Path) -> list[Path]:
    latency, throughput = out / "latency.png", out / "throughput.png"
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        colors = [(148, 163, 184), (37, 99, 235)]
        latency.write_bytes(bars_png([RESULTS[v]["p99"] for v in RESULTS], colors))
        throughput.write_bytes(bars_png([RESULTS[v]["qps"] for v in RESULTS], colors))
        return [latency, throughput]
    fig, ax = plt.subplots(figsize=(9.6, 5.4), dpi=100)
    for version, color in zip(RESULTS, ("#94a3b8", "#2563eb")):
        ax.plot(LEVELS, RESULTS[version]["p99"], marker="o", linewidth=2.5, color=color, label=f"{version} p99")
    ax.axhline(100, linestyle="--", color="#dc2626", label="SLA 100 ms")
    ax.set(xscale="log", xlabel="Concurrent users", ylabel="p99 latency (ms)", title="p99 latency vs. concurrency")
    ax.set_xticks(LEVELS, [str(v) for v in LEVELS])
    ax.grid(alpha=0.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(latency)
    fig, ax = plt.subplots(figsize=(9.6, 5.4), dpi=100)
    x = range(len(LEVELS))
    for i, (version, color) in enumerate(zip(RESULTS, ("#94a3b8", "#2563eb"))):
        ax.bar([p + (i - 0.5) * 0.38 for p in x], RESULTS[version]["qps"], width=0.38, color=color, label=version)
    ax.set_xticks(list(x), [str(v) for v in LEVELS])
    ax.set(xlabel="Concurrent users", ylabel="Throughput (QPS)", title="Throughput by concurrency")
    ax.grid(axis="y", alpha=0.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(throughput)
    return [latency, throughput]


def demo_arguments() -> dict[str, Any]:
    out = Path(tempfile.mkdtemp(prefix="roadshow-demo-"))
    (out / "results.csv").write_text(demo_csv(), encoding="utf-8")
    (out / "report.md").write_text(demo_report(), encoding="utf-8")
    charts = demo_charts(out)
    print(f"Demo data written to {out}")
    return {
        "name": "搜索服务 v2.0 压测报告",
        "content": demo_content(),
        "purpose": "上线评审：决定 v2.0 能否在双十一前全量",
        "audience": "研发负责人、SRE 与 CTO",
        "pageCount": 6,
        "notes": "图表直接放在对应页面；结论页突出 8000 QPS 目标是否达成",
        "files": [file_arg(str(p)) for p in charts] + [file_arg(str(out / "results.csv")), file_arg(str(out / "report.md"))],
    }


# --- main ---------------------------------------------------------------------------------------------

async def run(args: argparse.Namespace, token: str) -> int:
    async with connect(args.url, token) as session:
        tools = {t.name for t in (await session.list_tools()).tools}
        missing = {"list_roadshow_templates", "create_roadshow_slides", "get_roadshow_slides_status"} - tools
        if missing:
            sys.exit(f"The server does not offer {', '.join(sorted(missing))}; is this the 路演生成器 MCP URL?")

        listing = await call(session, "list_roadshow_templates", {"includePreviews": bool(args.previews)})
        templates = listing.get("templates", [])
        if args.previews:
            out = Path(args.previews)
            out.mkdir(parents=True, exist_ok=True)
            for t, image in zip(templates, listing["_images"]):
                (out / f'{t["templateId"]}.jpg').write_bytes(base64.b64decode(image.data))
            print(f"Template covers saved to {out}")
        if args.list:
            print_templates(templates)
            return 0

        template = pick_template(templates, args.template)
        print(f'Template: {template["name"]} ({template["templateId"]})')
        if args.demo:
            arguments = demo_arguments()
        else:
            if not args.name or not (args.content or args.content_file):
                sys.exit("Give --name and --content or --content-file (or use --demo)")
            content = Path(args.content_file).read_text(encoding="utf-8") if args.content_file else args.content
            arguments = {"name": args.name, "content": content}
        arguments["templateId"] = template["templateId"]
        for key in ("purpose", "audience", "notes", "aspect"):
            if getattr(args, key):
                arguments[key] = getattr(args, key)
        if args.pages:
            arguments["pageCount"] = args.pages
        if args.width and args.height:
            arguments.update(aspect="custom", width=args.width, height=args.height)
        arguments["files"] = arguments.get("files", []) + [file_arg(f) for f in args.file]

        created = await call(session, "create_roadshow_slides", arguments)
        project_id = created["projectId"]
        print(f'Created {project_id}: {created["name"]} ({created["size"]}), {len(created["files"])} files')
        print(f'Editor: {created["editorUrl"]}')
        if args.no_wait:
            return 0

        started = time.monotonic()
        while True:
            status = await call(session, "get_roadshow_slides_status", {"projectId": project_id, "waitSeconds": 20})
            if status["status"] != "generating":
                break
            print(f'[{time.monotonic() - started:5.0f}s] generating · {status.get("stage")} · {status.get("generatedChars", 0)} chars')
        if status["status"] == "error":
            print(f'Generation failed: {status.get("error")}', file=sys.stderr)
            return 1
        print(f'Ready in {time.monotonic() - started:.0f}s: {status["pageCount"]} pages')
        for page in status["pages"]:
            print(f'  {page["page"]:2}. {page.get("title") or page["file"]}')

        if args.download:
            out_dir = Path(args.out)
            out_dir.mkdir(parents=True, exist_ok=True)
            for fmt in [f.strip() for f in args.download.split(",") if f.strip()]:
                if fmt not in status["downloads"]:
                    sys.exit(f"Unknown format {fmt}; choose from {', '.join(status['downloads'])}")
                path = download(status["downloads"][fmt], token, out_dir, f"{project_id}{EXPORT_SUFFIX[fmt]}")
                print(f"Saved {path} ({path.stat().st_size // 1024} KB)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a roadshow deck through the 路演生成器 MCP server.")
    parser.add_argument("--url", default=os.environ.get("ROADSHOW_MCP_URL", "http://127.0.0.1:9090/mcp"), help="MCP endpoint (env ROADSHOW_MCP_URL)")
    parser.add_argument("--token", help="MCP token; prefer the ROADSHOW_MCP_TOKEN environment variable")
    parser.add_argument("--list", action="store_true", help="list the templates and stop")
    parser.add_argument("--previews", metavar="DIR", help="save a cover image of each template to DIR")
    parser.add_argument("--template", help="template id or part of its name (default: the most recently updated)")
    parser.add_argument("--demo", action="store_true", help="use a built-in sample load test with charts and data files")
    parser.add_argument("--name", help="deck title (材料名称)")
    parser.add_argument("--content", help="what the deck must contain (需要添加的内容), Markdown")
    parser.add_argument("--content-file", help="read the content from a Markdown file")
    parser.add_argument("--purpose", help="purpose (用途)")
    parser.add_argument("--audience", help="audience (受众)")
    parser.add_argument("--notes", help="other requirements (其他要求)")
    parser.add_argument("--pages", type=int, help="number of pages, 1-40")
    parser.add_argument("--aspect", choices=["template", "16:9", "4:3", "a4-landscape", "a4-portrait", "9:16", "1:1"], help="slide size")
    parser.add_argument("--width", type=int, help="custom slide width in pixels (with --height)")
    parser.add_argument("--height", type=int, help="custom slide height in pixels (with --width)")
    parser.add_argument("--file", action="append", default=[], metavar="PATH[:ROLE]", help="attach a file; ROLE is embed (default for images) or reference")
    parser.add_argument("--download", default="html,pdf,pptx", help="formats to download when ready: html, pdf, pdf-image, pptx, zip ('' for none)")
    parser.add_argument("--out", default="roadshow-out", help="download directory")
    parser.add_argument("--no-wait", action="store_true", help="return after starting the generation")
    args = parser.parse_args()
    token = args.token or os.environ.get("ROADSHOW_MCP_TOKEN", "")
    if not token:
        parser.error("set ROADSHOW_MCP_TOKEN (or pass --token)")
    try:
        return asyncio.run(run(args, token))
    except Exception as e:  # the SDKs wrap transport errors (401, 403, refused) in exception groups
        while getattr(e, "exceptions", None):
            e = e.exceptions[0]
        sys.exit(f"MCP request to {args.url} failed: {e}")


if __name__ == "__main__":
    sys.exit(main())
