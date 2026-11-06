# 路演工坊 · Roadshow Studio

用对话生成、逐页精修 HTML 路演材料，并导出 HTML / PDF / PPTX。

- **模板**：输入风格、用途、受众、配色等，AI 生成一套可复用的版式库（封面、目录、数据页、图表页、团队页……）。
- **路演材料**：先选模板，再描述内容并上传支持材料（图片可直接嵌入页面；PDF / TXT / MD / CSV / JSON 会被提取文字作为依据），AI 沿用模板样式生成完整材料。
- **逐页预览与精准修改**：所有材料以页为单位（默认 16:9，1920×1080，可选 4:3 / A4 / 9:16 / 1:1 / 自定义）。
  - 底部对话框直接输入 → 修改整份材料；可切换为“仅当前页”。
  - 在预览中**单击**元素（Shift/⌘ 多选）或**拖动框选**多个元素 → 只修改这些元素。提示词中会写明“第 N 页的哪些元素”（data-eid、标签、class、文字、当前 HTML），并附带一张用红框标出选中元素的页面截图（多模态）。
- **多人协作与修改历史**：项目不设权限，所有用户可读写。每次修改生成一个版本，记录修改人、范围（整份/单页/元素）、提示词，以及**具体修改/新增/移除了哪些元素**（可点击定位）；支持预览和恢复任意历史版本。同一项目的并发修改按项目串行应用，不同页面的修改互不覆盖。
- **用户管理**：首次启动自动创建 `admin`（默认密码 `admin123`，可用环境变量修改）。只有管理员能创建/删除用户、重置密码。
- **模型接入（仅管理员）**：配置多个兼容 OpenAI Chat Completions 协议的接入点（Base URL、模型名、Token、权重、附加请求参数），一键**联通测试**（含多模态校验：发送纯色图片让模型识别颜色）。多个接入点之间按**用户**做加权一致性哈希（Rendezvous Hashing）负载均衡——同一用户固定走同一接入点以命中提示词缓存，接入点故障时自动切换。提供用量与费用统计。
- **导出**：HTML（自包含，素材内联，按 F 进入演示模式）、PDF（矢量，可选中文字）、PDF（逐页截图，与预览像素一致）、PPTX（每页一张 16:9 全幅图片，备注中附该页文字）。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 后端 | Node.js 22 + TypeScript + Fastify | 路由按模块拆分（`server/src/routes/*`） |
| 存储 | SQLite（better-sqlite3，WAL） | 带版本化迁移（`server/src/db.ts`），素材文件存 `data/assets` |
| 文档模型 | cheerio | `server/src/deck.ts`：解析模型输出、分页、元素 ID、diff |
| 渲染/导出 | Playwright（系统 Chrome）+ pptxgenjs | `server/src/render.ts` |
| 前端 | React 19 + Vite + React Router | 预览用 iframe + 注入的选择脚本（`web/src/lib/slideHtml.ts`） |

### 关键设计

- **文档结构**：`{ title, width, height, head, css, pages: [{ id, html }] }`。每页是一个 `<section class="slide" data-page-id>`，页内每个元素带稳定的 `data-eid`，用于选择、提示词定位与修改历史比对。
- **修改流程**：创建任务 → （单页/元素修改时渲染截图）→ 构造提示词 → 流式调用模型 → 解析结果 → 在项目锁内基于**最新**文档应用（单页/元素修改只替换该页）→ 计算 diff → 写入新版本。
- **扩展点**：新增导出格式在 `routes/projects.ts` 的 export 中添加；新增模型协议在 `llm.ts` 中扩展 `chatWithEndpoint`；新增项目类型只需扩展 `projects.type` 与 `prompts.ts`。

## 运行

需要 Node.js ≥ 22 和 Chrome/Chromium（用于 PDF/PPT 导出与截图；路径可通过 `CHROME_PATH` 指定）。

```bash
npm run install:all     # 安装 server 与 web 依赖
npm run build           # 构建前端到 web/dist
npm start               # 启动服务（默认 http://localhost:8787，同时托管前端）
```

开发模式：`npm run dev:server` 与 `npm run dev:web`（Vite 在 5173 端口，代理 `/api` 到 8787）。

登录 `admin / admin123` → 「模型接入」添加接入点并测试 → 「模板」新建模板 → 「路演材料」基于模板新建材料。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `server/data` | 数据库与素材目录 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | 首次启动时创建的管理员 |
| `CHROME_PATH` | 自动探测 | Chrome 可执行文件 |
| `LLM_TIMEOUT_MS` | `600000` | 单次模型调用超时 |
| `SESSION_DAYS` | `14` | 登录有效期 |

## 测试

```bash
npm --prefix server test        # 单元 + API 集成测试（vitest，使用内置的 OpenAI 兼容 mock 服务）
npm --prefix web run test:e2e   # 浏览器端到端测试（Playwright，自动启动带 mock 模型的测试服务）
```

- `server/test/deck.test.ts`：解析、元素 ID、页面替换/拆分/复制/移动/删除、diff。
- `server/test/llm.test.ts`：按用户的一致性哈希负载均衡（确定性、均匀性、权重、增删节点的最小迁移）。
- `server/test/api.test.ts`：登录/权限/用户管理、接入点与多模态联通测试、故障切换、模板与材料创建（含图片/文档素材）、元素/单页/整体修改的提示词内容、并发修改、页面操作、历史与恢复、重命名、HTML/PDF/PPTX 导出、用量统计、失败重试。
- `web/e2e/app.spec.ts`：完整 UI 流程，包括单击/多选/选择上级/框选、三种修改范围、历史预览与恢复、导出下载、多用户协作归属。

推荐模型：OpenRouter 的 `deepseek/deepseek-v4.1-flash-1017`（支持图像输入），附加参数 `{"reasoning":{"effort":"low"}}` 可缩短等待。实测生成 8 页材料约 60–70 秒、约 $0.01；单元素修改约 8 秒、约 $0.003。
<!-- release test -->
