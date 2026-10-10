# dsh-edge-browser

> 项目仓库：https://github.com/lingziba/dshedge （包名 `dsh-edge-browser`，项目名 `dshedge`）

让 DSH 直接驱动**本机 Microsoft Edge**：启动/接管浏览器、开标签页、导航、执行 JS、
读正文、截图、点击、输入。零第三方依赖（只用 `node:` 内置模块 + 自实现的 WebSocket 客户端）。

## 它怎么工作

```
DSH agent  ──edge_* 工具──▶  插件（Host 进程）  ──CDP──▶  Edge (--remote-debugging-port)
                                     │                        ▲
                                     └── 专用 user-data-dir ───┘
```

- 走 Edge 自带的 DevTools 协议（CDP）：HTTP `/json/*` 管目标，WebSocket 发命令。
- **专用配置目录**（默认 `%LOCALAPPDATA%\dsh-edge-browser\profile`）：既满足 Chromium 136+
  "远程调试必须使用非默认 profile" 的要求，也不会碰到你日常在用的那个 Edge 会话。
- 懒加载：只有真正操作浏览器时才建立 WebSocket；关掉标签页不会退出浏览器。
- 不用 Playwright/Puppeteer：不下载浏览器、不带额外依赖，直接用已安装的 Edge。

## 工具

| 工具 | 作用 |
| --- | --- |
| `edge_status` | 只读探测：调试端口是否可达、版本、可执行文件、配置目录、当前标签页 |
| `edge_launch` | 启动（或复用）可控制的 Edge，可选直接打开一个网址；`headless: true` 无头运行 |
| `edge_tabs` | 列出标签页，拿到 `targetId` |
| `edge_open` | 新标签页打开网址，并设为后续调用的默认目标 |
| `edge_navigate` | 让已有标签页跳转，并等到 `document.readyState === 'complete'` |
| `edge_eval` | 在页面里执行 JS 表达式，返回 JSON 文本（支持 await Promise） |
| `edge_text` | 取 `document.body.innerText` 正文 + 标题 + 地址 |
| `edge_screenshot` | 截图落盘（PNG/JPEG、可整页），返回路径供 `read_image` 看图 |
| `edge_click` | 按 CSS 选择器或可见文本点击；滚动到可见处后发真实鼠标事件 |
| `edge_type` | 聚焦输入框、清空、输入文本，可 `submit: true` 回车 |
| `edge_close` | 关某个标签页；`shutdown: true` 退出整个可控制实例 |

典型用法：`edge_launch` → `edge_navigate` → `edge_text` / `edge_eval` → 需要看图时 `edge_screenshot` + `read_image`。

## 安装

拿到代码（二选一）：

```powershell
git clone https://github.com/lingziba/dshedge.git D:\dsh-plugins\dshedge
# 或网页上 Code → Download ZIP，解压到同一位置
```

装进 DSH profile：

```text
plugin_manager  install_bundle  target=D:\dsh-plugins\dshedge
```

装完让 agent 跑一次 `edge_status`：看到 `插件构建：1.0.4` 和 Edge 版本就成了。
不想启动浏览器也可以先跑 `node test/definitions.mjs`（期望 20/20，秒级，会校验 schema 是否被当前 DSH 接受）。

目录请放在**之后不会移动**的位置——profile 里记录的是该目录的绝对 link 路径，移动后重新安装一次即可。
卸载：`plugin_manager remove_bundle target=dsh-edge-browser`（target 是**包名**，不是仓库名）。

## 配置（bundle 行 `config`，全部可省略）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `9222` | Edge 调试端口 |
| `executablePath` | 自动探测 | Windows / macOS / Linux 常见安装位置 + `PATH`；也可用环境变量 `DSH_EDGE_PATH` 覆盖 |
| `userDataDir` | 按平台 | Windows `%LOCALAPPDATA%`、macOS `~/Library/Application Support`、Linux `$XDG_STATE_HOME` 下的 `dsh-edge-browser/profile` |
| `headless` | `false` | 默认弹可见窗口 |
| `windowSize` | — | 例如 `1440,900` |
| `defaultTimeoutMs` | `30000` | 单个 CDP 操作默认超时 |
| `launchTimeoutMs` | `25000` | 等待调试端口就绪上限 |

## 自带测试

```powershell
node test/definitions.mjs      # 工具定义自检：不启动浏览器，秒级
node test/build-check.mjs      # 入口与依赖的模块身份是否都升到当前构建号
node test/smoke.mjs            # 端到端：真实启动 Edge 跑完整链路（需要非受限进程）
node test/live.mjs --url https://example.com   # 真实站点：HTTPS 导航 / 正文 / 截图
```

`definitions.mjs` 用假的 `ctx` 采集插件注册的 11 份 ToolDefinition，检查
参数/输出 schema、`render`、`execute`、命名唯一性，并验证"超时附带过期模块提示"。
它内置了 DSH 支持子集的复刻校验；要改用 DSH 自己的校验器：

```powershell
node test/definitions.mjs --validator <.../dsh-tools/lib/types/json-schema.js>
```

`smoke.mjs` 用与插件完全相同的 `lib/cdp.js` 跑一遍：启动 → 开标签 → 导航本地页面 →
读正文 → 执行 JS → 点击 → 输入 → 截图（PNG 视口/整页 + JPEG）→ 关标签。

`live.mjs` 打真实站点：HTTPS 导航（等 `readyState=complete`）、标题与正文提取、
页内 JS、视口/整页 PNG，并打印站点信息（协议、链接数、图片数、视口）。

> 注意：如果在受限沙箱（如 DSH 的 workspace-write 沙箱）里跑 `smoke.mjs`，Edge 的渲染进程
> 可能因受限令牌而崩溃（HTTP 端点正常、一连页面 WS 就 RST）。插件本身运行在不受限的
> Host 进程里，因此正常路径不受影响。

## 生效方式与热重载

- 安装后由 bundle 行 `edge-browser` 提供这 11 个工具；新会话立即可见。
- **改代码不必重启 DSH**。DSH 只热替换它监视目录下的模块，工作区里的 linked 包不在监视
  范围内，因此"同一个 specifier"永远不会被重新 import（改文件内容也没用）。本包用两条
  规则绕开它：
  1. **行名用相对 specifier** 指向按构建号命名的入口（`./lib/entry-<构建号>.js`）——
     Loader 对以 `.` 开头的名字按本 bundle 目录解析，新文件名 = 新的模块身份 = 必然重新 import；
  2. **入口内部用 `?b=<构建号>` 载入实现**（`plugin.js` / `cdp.js` / `ws.js`），
     让依赖也一起换身份，否则它们会命中旧模块缓存。
- 热重载步骤（四步，已实测）：

  ```
  1) 改 lib/*.js，把里面的 ?b= 升到新构建号，并同步 PLUGIN_BUILD
  2) 新入口文件 lib/entry-<新构建号>.js（内容一行：export * from './plugin.js?b=<新构建号>'）
  3) cordis.patch.yml 的行名改为 './lib/entry-<新构建号>.js'
  4) plugin_manager: set_bundle 关一次、再开一次（两次调用）
  ```

  然后 `edge_status` 会回报新的 `插件构建`，旧代际的插件被正常 dispose。
- **受限沙箱里跑不通**：如果在 DSH 的 workspace-write 沙箱内启动 Edge，浏览器进程的 HTTP
  端点正常，但渲染进程会因受限令牌崩溃（一连页面 WebSocket 就被 RST）。插件本身在宿主
  进程内运行，不受此影响；只有在受限 shell 里手工调 `lib/cdp.js` 时才会遇到。

## 验证状态

当前插件构建：**1.0.3**（`edge_status` 的 `pluginBuild` 字段会回报它）。

- **宿主进程内 11/11 工具实测通过**（真实 Edge 155，non-headless）：
  `edge_status`（探测到端口/版本/标签页）→ `edge_launch`（启动并 CDP 导航到本地验证页）→
  `edge_text`（正文提取）→ `edge_eval`（取 `window.__state`，并调用页内函数 `__sum([1,2,3,4])=10`）→
  `edge_click #counter`（计数 0→1，日志同步更新）→ `edge_type #q`（字段值写入）→
  `edge_screenshot`（整页 PNG 1241×1288 落盘，`read_image` 能看到点击/输入后的真实画面）→
  `edge_navigate https://example.com`（HTTPS 到 `readyState=complete`）→ `edge_text`（多语言正文）→
  `edge_open https://www.baidu.com`（标题「百度一下，你就知道」）→ `edge_tabs`（4 个标签页，
  当前页标记正确）→ `edge_close shutdown=true`（实例退出）。
- **工具定义 20/20 通过**（`test/definitions.mjs`）：11 份定义全部合法，其中参数与输出 schema
  通过 **DSH 自己的校验器**（`assertObjectJsonSchema` / `assertSupportedJsonSchema`，取自
  `dsh-tools/lib/types/json-schema.js`）——保证宿主注册时不会因 schema 失败而整行不激活。
- **端到端 17/17 通过**（`test/smoke.mjs`，非受限进程）：启动 → 开标签 → 导航本地页面 →
  `readyState=complete` → 正文 → 执行 JS（含 awaitPromise 返回 42）→ 按选择器点击（计数 0→1）→
  按可见文本点击 → 输入 → 回车提交 → 视口 PNG（756×488 校验）→ 整页截图落盘 → JPEG →
  关标签 → Browser.close。
- **真实站点 9/9 通过**（`test/live.mjs`，非受限进程）：
  - `https://example.com` → 标题 `Example Domain`、正文 917 字符、整页截图 741×713；
  - `https://www.baidu.com` → 标题 `百度一下，你就知道`、71 个链接 / 20 张图片、整页截图 741×696。
- **关闭时序已修**：`/json/close` 只表示"开始关闭"，目标会稍后才从列表消失；
  `edge_close` 现在等它真正消失（最多 2 秒）再报 `remaining`，测试也改成轮询断言。



## 卸载

```text
plugin_manager  remove_bundle  target=dsh-edge-browser
```
