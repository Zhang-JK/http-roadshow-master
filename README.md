# 路演工坊 · Roadshow Studio

用对话生成、逐页精修 HTML 路演材料，并导出 HTML / PDF / PPTX。

- **模板**：输入风格、用途、受众、配色等，AI 生成一套可复用的版式库（封面、目录、数据页、图表页、团队页……）。
- **路演材料**：先选模板，再描述内容并上传支持材料（图片可直接嵌入页面；PDF / TXT / MD / CSV / JSON 会被提取文字作为依据），AI 沿用模板样式生成完整材料。
- **参考图片 / 参考 PPT / 参考 HTML**：新建对话框和编辑器底部对话框（📎）都可以上传图片或 PPT/PPTX/ODP/Key/PDF/HTML。图片可选择“嵌入页面”（AI 可用 `<img>` 放进页面，如 Logo、产品图）或“仅参考”（只让 AI 借鉴风格/版式/内容）；PPT/PDF 会逐页导出为图片交给多模态模型，HTML 在断网的无头浏览器中按 `section.slide` / `.slide` 等页面元素逐页截图（没有页面元素时按 1280×720 分屏截取），并同时提取文字。新建模板时参考用于模仿视觉风格，新建材料时用于提取内容与结构（视觉以所选模板为准），修改时随本次修改附带。
- **只读文件工具**：参考文件往往远超上下文，短文档（≤6000 字）直接放进提示词，长文档只放开头预览和文件编号（F1、F2…），模型通过函数调用按需查阅：`list_files`、`read_text`（按页或分段）、`read_raw`（HTML/Markdown 等源码）、`search_files`、`view_page`（重新查看某页图片）、`list_archive` / `read_archive_entry`（直接读取 PPTX/DOCX 内部的 XML 与图片）。这些工具全部只读，只能访问本项目中本次提供的文件。
- **自检（智能体循环）**：模型输出初稿后，服务端在无头 Chrome 中渲染草稿并做 DOM 布局检查（文字超出页面、内容被容器裁切、文字重叠、图片加载失败、字号过小、空白页），把全部页面的缩略图总览和检查报告交给模型；模型可用 `render_pages`（渲染指定页并返回截图）、`check_layout`、`read_draft`（读取页面/CSS 源码）、`replace_in_draft`（精确替换片段）、`rewrite_page`（重写或拆分页面）、`delete_page` 查看并修复自己的草稿，修复完成才保存为新版本。工具只修改内存中的草稿，参考文件仍然只读；单页/元素修改时只有被修改的页面可写。若仍有错误会自动复查一次。可在「模型接入 → 生成设置」关闭或调整最多工具轮数（默认 10）；每次任务的自检结果（修复前后的错误数、修改次数）记录在任务中并在完成提示里显示。
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
- **修改流程**：创建任务 → （单页/元素修改时渲染截图）→ 构造提示词 → 流式调用模型（可调用只读文件工具）→ 解析为草稿 → 自检循环（`server/src/draft.ts`：渲染、布局检查、模型用草稿工具修复）→ 在项目锁内基于**最新**文档应用（单页/元素修改只替换该页）→ 计算 diff → 写入新版本。
- **工具调用**：`llm.ts` 的 `chatWithTools` 实现 OpenAI 风格的函数调用循环（流式合并 `tool_calls`，工具返回的图片以紧随其后的 user 消息转发，最后一轮 `tool_choice: none` 强制作答）；文件工具在 `fileTools.ts`，草稿工具在 `draft.ts`。自检阶段不再重发初稿 HTML（模型用 `read_draft` 按需读取），并只保留原提示中的前 6 张图片，以控制上下文（DeepSeek 在线版上下文 200k）。
- **扩展点**：新增导出格式在 `routes/projects.ts` 的 export 中添加；新增模型协议在 `llm.ts` 中扩展 `chatWithEndpoint`；新增项目类型只需扩展 `projects.type` 与 `prompts.ts`。

## 从 GitHub Actions 预编译包部署（服务器无需 npm）

每次推送到 `main`，GitHub Actions（`.github/workflows/release.yml`）会编译前后端并发布一个 Release：每种 CPU（x64 / arm64）一个安装包，内含编译好的程序、生产依赖 `node_modules` 和 Node.js 运行时，约 75MB。服务器只需下载这一个文件，**不访问 npm、不下载 Node.js**，适合公司代理拦截 npm 的环境：

```bash
curl -fsSLO https://raw.githubusercontent.com/Zhang-JK/http-roadshow-master/main/deploy_from_action.sh
sudo -E bash deploy_from_action.sh                          # 安装；已安装时更新到最新预编译版本
sudo -E bash deploy_from_action.sh --proxy http://proxy:8080 --ca-cert corp-root.crt --port 9090
```

- 先测试能否访问 GitHub 发布清单，再下载安装包并校验 SHA256，然后交给包内的 `deploy.sh` 完成安装（系统用户、systemd、开机自启等与下文相同）。代理、证书参数与 `deploy.sh` 一致（`--proxy`、`--ca-cert 文件|auto`、`--insecure`），其他参数（`--port`、`--base`、`--user` 等）原样传给 `deploy.sh`。
- 之后网页「系统更新」和 `roadshow-studio update` 都从 GitHub Release 获取新的预编译包（配置中 `PREBUILT=1`，不会再走 npm）。
- 服务器连 GitHub 也访问不了时：在能上网的电脑上从 Release 页面下载对应的 `roadshow-studio-…-linux-x64.tar.gz`，复制到服务器后执行 `sudo bash deploy_from_action.sh --file 安装包.tar.gz`。也可以把 Release 中的文件放到内网服务器上，用 `--manifest http://内网地址/latest-linux-x64.json` 安装和更新。
- `--tag r1.1.0-abc1234` 安装指定版本；`--repo 用户/仓库` 使用 fork。也可在本地执行 `bash scripts/package-prebuilt.sh x64 输出目录` 生成同样的安装包（需先编译并 `npm prune --omit=dev`）。

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

### 公司代理 / HTTPS 证书

安装和更新前会先做**网络连接检测**（不安装任何东西）：代理端口是否可连、Node.js 下载源、npm 仓库，并实际下载最大的依赖包（`better-sqlite3`，约 11MB，含预编译二进制）核对 SHA512，以发现「仓库能访问但安装包被代理拦截或替换」的情况，以及 git 仓库或发布清单、系统软件源、Chrome 下载源、模型接口。任何必需项不通时直接停止，并说明原因（DNS 失败、连不上、超时、代理要求认证、证书不受信任及其签发者等）和建议的参数。也可单独运行：

```bash
sudo -E bash deploy.sh nettest                                   # 用当前环境变量里的 https_proxy
sudo bash deploy.sh nettest --proxy http://proxy.corp:8080
```

公司代理会解密 HTTPS 并用自己的根证书重新签名，因此常见的「无法获取 Node.js 版本列表」实际是证书校验失败。按推荐顺序：

```bash
# 1. 推荐：信任公司根证书（从 IT 获取，PEM 或 DER 均可）
sudo bash deploy.sh install --proxy http://proxy.corp:8080 --ca-cert /path/corp-root-ca.crt

# 2. 让脚本从代理返回的证书链中取根证书（会打印主题与 SHA256 指纹，请与 IT 核对）
sudo bash deploy.sh install --proxy http://proxy.corp:8080 --ca-cert auto

# 3. 拿不到证书时：关闭证书校验（不安全，仅限可信内网）
sudo bash deploy.sh install --proxy http://proxy.corp:8080 --insecure
```

- 不加 `--proxy` 时默认使用 `https_proxy`/`http_proxy` 环境变量（用 `sudo` 运行时也会读取调用者的这两个变量，以及 `no_proxy`）；两者都没有时沿用上次保存的代理（网页一键更新即依赖这一点）；`--proxy none` 表示直连。需要认证的代理写成 `http://用户:密码@proxy:8080`（日志中密码会被隐藏）；`--no-proxy .corp.local,10.0.0.0/8` 指定直连地址（本机总是直连）。
- 证书会复制到 `shared/certs/`，与系统根证书合并后用于 curl、git、npm、apt/dnf、Node.js 下载与 Chrome 下载。
- 有些代理只返回服务器证书而不带根证书，此时 `--ca-cert auto` 会尝试按证书中的「颁发者地址」下载；仍失败时会提示改用文件或 `--insecure`。
- 这些设置保存在 `shared/deploy.conf`，之后的命令行更新和网页一键更新都会沿用，应用本身调用模型接口与下载 Chromium 也走同一代理与证书（`NODE_USE_ENV_PROXY`；`NODE_EXTRA_CA_CERTS` 指向系统根证书库，即使未指定 --ca-cert 也会信任 IT 已安装到系统中的公司根证书；`--insecure` 时为 `NODE_TLS_REJECT_UNAUTHORIZED=0`）。修改时可执行 `sudo roadshow-studio update --force --proxy ... --ca-cert ...`，或用 `--secure` 恢复证书校验。

**目录结构**（`/opt/roadshow-studio`）：`releases/` 各版本、`current` 当前版本、`shared/data` 数据库与素材、`shared/backups` 数据库备份、`shared/logs` 应用与部署日志、`shared/deploy.conf` 部署配置（可修改端口、更新源等后执行 `roadshow-studio restart`）、`shared/extra.env` 额外环境变量（如 `CHROME_PATH`）。

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

### PPT / PDF / HTML 逐页转图片

上传的演示文稿由 `server/scripts/slides-to-images.sh` 转换（LibreOffice 转 PDF → poppler `pdftoppm` 按页导出 JPEG，宽 1280px，每个文件最多 30 页），也可以单独使用：

```bash
bash server/scripts/slides-to-images.sh 输入.pptx 输出目录 [最多页数=30] [宽度=1280]
# 生成 输出目录/document.pdf、slide-001.jpg、slide-002.jpg……以及逐页文字 text.txt（以换页符分隔）
```

依赖 `libreoffice-impress`（PDF 输入无需）与 `poppler-utils`，`deploy.sh` 会自动安装；本地开发请自行安装（如 `sudo apt-get install --no-install-recommends libreoffice-impress poppler-utils`）。每次请求最多附带 24 张页面图（多个文件平均分配）、8 张可嵌入图片和 8 张参考图；修改时为 12 / 4 / 6 张。

**模型调用超时**在「模型接入 → 生成设置」中调整：模型连续「无响应超时」（默认 600 秒，含长输入的预填充阶段）没有返回任何数据才会中止，持续输出时不会中止；「单次调用上限」（默认 120 分钟）是一次调用的总时长上限。慢速的本地模型可按「最大输出 tokens ÷ 每秒 tokens 数」估算一次调用的耗时（32000 tokens 在 20 tokens/秒 下约 27 分钟）。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `9090` / `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `server/data` | 数据库与素材目录 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | 首次启动时创建的管理员 |
| `CHROME_PATH` | 自动探测 | Chrome 可执行文件 |
| `SESSION_DAYS` | `14` | 登录有效期 |

## 测试

```bash
npm --prefix server test        # 单元 + API 集成测试（vitest，使用内置的 OpenAI 兼容 mock 服务）
npm --prefix web run test:e2e   # 浏览器端到端测试（Playwright，自动启动带 mock 模型的测试服务）
```

- `server/test/deck.test.ts`：解析、元素 ID、页面替换/拆分/复制/移动/删除、diff。
- `server/test/llm.test.ts`：按用户的一致性哈希负载均衡（确定性、均匀性、权重、增删节点的最小迁移）。
- `server/test/api.test.ts`：登录/权限/用户管理、接入点与多模态联通测试、故障切换、模板与材料创建（含图片/文档素材）、元素/单页/整体修改的提示词内容、并发修改、页面操作、历史与恢复、重命名、HTML/PDF/PPTX 导出、用量统计、失败重试。
- `server/test/reference.test.ts`：PPTX/PDF/HTML 逐页转图片、参考图与可嵌入图片的角色、模板/材料创建时页面图送入模型、修改时附带参考文件、长文档只预览并通过只读工具读取（列表、分页图片、搜索、PPTX 内部 XML、HTML 源码、拒绝未知文件与不存在的写工具）、删除素材连带删除页面图。
- `server/test/selfcheck.test.ts`：布局检查（溢出/裁切/重叠/坏图/小字/空页）、缩略图总览、草稿工具（只读页保护、精确替换、拆页、应用到最新文档）、完整自检循环（发现溢出 → 渲染 → 读源码 → 修复 → 保存）、单页修改的自检、未修复时自动复查、关闭自检。
- `server/test/system.test.ts`：版本信息、系统更新接口（检查/启动更新/日志/并发保护/权限）、回滚后的数据库恢复。
- `deploy.sh`：在本机实际验证了 git 源与发布包源的安装、网页一键更新、命令行更新、构建失败不影响服务、新版本崩溃自动回滚并恢复数据库、手动回滚、非 root 安装、卸载；并在隔离网络（只能经 HTTPS 解密代理上网）中验证了连接检测的各类报错、`--ca-cert 文件/auto`、`--insecure`、完整安装、root 与服务用户两种更新方式，以及应用经代理调用模型接口。
- `web/e2e/app.spec.ts`：完整 UI 流程，包括单击/多选/选择上级/框选、三种修改范围、历史预览与恢复、导出下载、多用户协作归属。

推荐模型：OpenRouter 的 `deepseek/deepseek-v4.1-flash-1017`（支持图像输入），附加参数 `{"reasoning":{"effort":"low"}}` 可缩短等待。实测生成 8 页材料约 60–70 秒、约 $0.01；单元素修改约 8 秒、约 $0.003。
