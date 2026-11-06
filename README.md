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
- **一键部署与在线更新（Linux，默认端口 9090）**：`deploy.sh` 一条命令完成安装（Node.js、依赖、构建、系统服务、开机自启）；管理员可在「系统更新」页面一键检查更新、立即更新，更新前自动备份数据库，新版本健康检查失败时自动回滚并恢复数据。
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

## 部署到 Linux 服务器（推荐）

支持 Ubuntu/Debian、CentOS/RHEL/Rocky、openSUSE 等（x86_64 / arm64）。脚本自动安装 Node.js 22、中文字体、浏览器（用于 PDF/PPT 导出），以独立系统用户 `roadshow` 运行，有 systemd 时注册为 `roadshow-studio` 服务（开机自启、崩溃自动重启），否则使用内置守护进程。

```bash
# 从 git 仓库安装（以后可在线检查/更新该分支的最新提交）
sudo bash deploy.sh install --repo https://github.com/<org>/roadshow-studio.git --branch main

# 或：从发布包清单安装（以后检查 latest.json 中的 version）
sudo bash deploy.sh install --manifest https://your-host/roadshow/latest.json

# 或：直接用当前目录的代码安装（之后用 update --from 手动更新）
sudo bash deploy.sh install
```

安装完成后访问 `http://<服务器IP>:9090`（默认账号 `admin / admin123`，可用 `--admin-password` 指定）。

**一键检查更新 / 更新部署**

- 网页：管理员 →「系统更新」→「检查更新」→「立即更新」。页面实时显示进度与部署日志，服务重启期间自动等待恢复。系统每 6 小时自动检查一次，有新版本时导航栏显示红点。
- 命令行：`sudo bash deploy.sh`（未安装则安装，已安装则检查并更新），或使用已注册的 `roadshow-studio` 命令：

```bash
roadshow-studio check            # 检查更新（--json 输出机器可读结果）
roadshow-studio update           # 更新部署（--yes 跳过确认，--force 强制重建，--from PATH 用本地代码/压缩包）
roadshow-studio rollback         # 回滚到上一个版本，并恢复更新前的数据库备份
roadshow-studio status           # 版本、端口、更新源、运行状态
roadshow-studio logs -f          # 应用日志
roadshow-studio restart | stop | start
sudo roadshow-studio uninstall   # 卸载程序（保留数据；--purge 连同数据删除）
```

**更新流程**：获取新代码 → 在新的 `releases/<时间>` 目录中安装依赖并构建（不影响正在运行的服务）→ 备份 SQLite 数据库 → 切换 `current` 软链接并重启 → 健康检查（确认 `/api/health` 返回新版本号）。构建失败时服务不受影响；新版本无法启动或反复崩溃时自动切回旧版本并恢复数据库。默认保留最近 3 个版本与 7 份数据库备份。

**安装选项**：`--port`（默认 9090）、`--host`（默认 0.0.0.0）、`--base`（默认 `/opt/roadshow-studio`）、`--user`、`--no-systemd`、`--npm-registry https://registry.npmmirror.com`、`--node-mirror https://npmmirror.com/mirrors/node`（国内网络）。非 root 用户也可安装到自己有权限的目录（如 `--base ~/roadshow`），此时跳过系统依赖安装并使用内置守护进程。

**目录结构**（`/opt/roadshow-studio`）：`releases/` 各版本、`current` 当前版本、`shared/data` 数据库与素材、`shared/backups` 数据库备份、`shared/logs` 应用与部署日志、`shared/deploy.conf` 部署配置（可修改端口、更新源等后执行 `roadshow-studio restart`）、`shared/extra.env` 额外环境变量（如 `CHROME_PATH`、`LLM_TIMEOUT_MS`）。

**发布新版本（发布包方式）**：在仓库中执行 `bash scripts/package-release.sh [输出目录] [下载地址前缀]`，生成 `roadshow-studio-<版本>.tar.gz` 与 `latest.json`（含版本、提交、SHA256），上传到任意静态文件服务即可；服务器端会校验 SHA256。git 方式只需推送到所跟踪的分支。版本号 = 根目录 `package.json` 的 `version` + 提交短哈希。

## 本地运行 / 开发

需要 Node.js ≥ 22 和 Chrome/Chromium（用于 PDF/PPT 导出与截图；路径可通过 `CHROME_PATH` 指定）。

```bash
npm run install:all     # 安装 server 与 web 依赖
npm run build           # 构建前端到 web/dist
npm start               # 启动服务（默认 http://localhost:9090，同时托管前端）
```

开发模式：`npm run dev:server` 与 `npm run dev:web`（Vite 在 5173 端口，代理 `/api` 到 9090）。

登录 `admin / admin123` → 「模型接入」添加接入点并测试 → 「模板」新建模板 → 「路演材料」基于模板新建材料。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `9090` / `0.0.0.0` | 监听地址 |
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
- `server/test/system.test.ts`：版本信息、系统更新接口（检查/启动更新/日志/并发保护/权限）、回滚后的数据库恢复。
- `deploy.sh`：在本机实际验证了 git 源与发布包源的安装、网页一键更新、命令行更新、构建失败不影响服务、新版本崩溃自动回滚并恢复数据库、手动回滚、非 root 安装、卸载。
- `web/e2e/app.spec.ts`：完整 UI 流程，包括单击/多选/选择上级/框选、三种修改范围、历史预览与恢复、导出下载、多用户协作归属。

推荐模型：OpenRouter 的 `deepseek/deepseek-v4.1-flash-1017`（支持图像输入），附加参数 `{"reasoning":{"effort":"low"}}` 可缩短等待。实测生成 8 页材料约 60–70 秒、约 $0.01；单元素修改约 8 秒、约 $0.003。
