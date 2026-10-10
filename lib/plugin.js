/**
 * dsh-edge-browser — Host 插件：把本机 Microsoft Edge 交给 DSH 的 agent 使用。
 *
 * 工具面（11 个）：edge_status / edge_launch / edge_tabs / edge_open /
 * edge_navigate / edge_eval / edge_text / edge_screenshot / edge_click /
 * edge_type / edge_close。
 *
 * 为什么手工写 ToolDefinition 而不 import defineTool：
 * 本包是工作区里的本地 bundle，Node 的 ESM 解析不会从 app.asar 里解析
 * `@deepseek-ai/*` 裸包名。因此这里只依赖 node: 内置模块，并按
 * defineTool 归一化后的形状（parameters 为 JSON Schema、
 * output 为 { schema, render }）直接交给 ctx.tools.register。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  CdpSession,
  click,
  closeTarget,
  defaultProfileDir,
  detectEdgePath,
  evaluate,
  launchEdge,
  listTargets,
  navigate,
  newTab,
  pageText,
  probe,
  screenshot,
  typeText,
} from './cdp.js?b=1.0.3'
import { WebSocketClient } from './ws.js?b=1.0.3'

export const name = 'dsh-edge-browser'

/** 只用到工具注册表。 */
export const inject = ['tools']

/** 构建标识：edge_status 会回报它，用来确认宿主加载的是哪一代模块。 */
const PLUGIN_BUILD = '1.0.3'

/**
 * 所有 CDP 调用都超时，最常见的原因不是页面慢，而是宿主进程仍在跑旧版插件 JS：
 * DSH 只热替换它监视目录内的模块，linked 到工作区的包不在监视范围。
 * 把这个诊断挂到超时类错误上，省掉一次盲猜。
 */
const STALE_MODULE_HINT =
  '\n提示：若每个 CDP 调用都超时，通常说明宿主进程仍在运行旧版插件 JS。'
  + 'DSH 只热替换它监视目录内的模块，工作区里的 linked 包不在监视范围；'
  + '改完插件代码后需要重启 DSH（可用 edge_status 的 pluginBuild 字段确认已加载哪一代）。'

function withHint(execute) {
  return async (args, exec) => {
    try {
      return await execute(args, exec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/timed out|WebSocket is closed|WebSocket closed|closed by peer/.test(message)) {
        const wrapped = new Error(`${message}${STALE_MODULE_HINT}`)
        wrapped.cause = error
        throw wrapped
      }
      throw error
    }
  }
}

const DEFAULTS = {
  port: 9222,
  headless: false,
  executablePath: undefined,
  userDataDir: undefined,
  defaultTimeoutMs: 30000,
  launchTimeoutMs: 25000,
  windowSize: undefined,
}

/* ─────────────────────────── schema 小工具 ─────────────────────────── */

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const int = (description) => ({ type: 'integer', description })
const bool = (description) => ({ type: 'boolean', description })
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) })

const TARGET_ID = str('Edge 标签页 id（edge_tabs 可列出）。省略时用当前标签页，没有就取第一个页面标签。')
const PORT = int('Edge 调试端口，默认取插件配置（9222）。')

function text(value) {
  return [{ type: 'text', text: value }]
}

/* ─────────────────────────────── 插件 ─────────────────────────────── */

/**
 * @param ctx - Cordis 上下文（含 tools 服务）。
 * @param config - bundle 行配置，全部字段可省略。
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  if (!Number.isInteger(settings.port) || settings.port <= 0 || settings.port > 65535) {
    throw new Error(`dsh-edge-browser: config.port must be a valid TCP port, got ${settings.port}`)
  }
  const runtime = {
    child: undefined,
    sessions: new Map(),
    currentTargetId: undefined,
    profileDir: settings.userDataDir ?? defaultProfileDir(),
  }

  ctx.effect(() => () => {
    for (const session of runtime.sessions.values()) session.close()
    runtime.sessions.clear()
  })

  /* ── 内部辅助 ── */

  const portOf = (input) => (Number.isInteger(input?.port) && input.port > 0 ? input.port : settings.port)

  function sessionCwd(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  }

  async function requireRunning(port) {
    const status = await probe(port)
    if (!status.running) {
      throw new Error(
        `Edge 没有在 127.0.0.1:${port} 上暴露调试接口。先调用 edge_launch 启动一个带调试端口的 Edge`
        + `（用独立配置目录，不影响你正在用的 Edge），或者自己用 --remote-debugging-port=${port} 启动 Edge。`,
      )
    }
    return status.version
  }

  function pickTarget(targets, wantedId) {
    if (wantedId !== undefined && wantedId !== null && String(wantedId).length > 0) {
      const found = targets.find((target) => target.id === wantedId)
      if (found === undefined) {
        throw new Error(`找不到标签页 ${wantedId}；用 edge_tabs 看当前可用的 id。`)
      }
      return found
    }
    if (runtime.currentTargetId !== undefined) {
      const current = targets.find((target) => target.id === runtime.currentTargetId)
      if (current !== undefined) return current
    }
    const first = targets[0]
    if (first === undefined) {
      throw new Error('当前没有可操作的页面标签页；用 edge_open 打开一个网址，或 edge_launch 启动 Edge。')
    }
    return first
  }

  /** 取（或建立）某个标签页的 CDP 会话。 */
  async function sessionFor(port, wantedId, options = {}) {
    await requireRunning(port)
    const targets = await listTargets(port)
    const target = pickTarget(targets, wantedId)
    runtime.currentTargetId = target.id
    const existing = runtime.sessions.get(target.id)
    if (existing !== undefined && existing.socket.closed !== true) return existing
    if (existing !== undefined) runtime.sessions.delete(target.id)
    const session = await CdpSession.open(target, {
      timeoutMs: options.timeoutMs ?? 10000,
      defaultTimeoutMs: settings.defaultTimeoutMs,
    })
    runtime.sessions.set(target.id, session)
    return session
  }

  const define = (definition) => ctx.tools.register({ ...definition, execute: withHint(definition.execute) })

  /** 新开一个标签页并导航到 url，等文档就绪后返回落定信息。 */
  async function openAndSettle(port, url, signal) {
    const target = await newTab(port, 'about:blank')
    const targetId = String(target.id ?? '')
    runtime.currentTargetId = targetId
    const session = await sessionFor(port, targetId, { timeoutMs: settings.defaultTimeoutMs })
    const settled = await navigate(session, url, { signal, timeoutMs: settings.defaultTimeoutMs })
    return { targetId, url: settled.url, title: settled.title, readyState: settled.readyState }
  }

  /* ── 1. edge_status ── */

  define({
    name: 'edge_status',
    description:
      'Report whether a Microsoft Edge instance is exposing a CDP debug port, plus its version, executable, profile directory, and open tabs. Read-only: it never launches or changes anything. Call it first when you are unsure whether the browser is controllable.',
    parameters: obj({ port: PORT }),
    output: {
      schema: obj(
        {
          running: bool('调试接口是否可达'),
          browser: str('浏览器版本字符串，未运行时为空'),
          port: int('实际探测的端口'),
          executablePath: str('解析到的 msedge.exe 路径，未解析到则为空'),
          profileDir: str('插件专用配置目录'),
          pluginBuild: str('插件构建标识，用于确认宿主加载的是哪一代模块'),
          tabs: arr(
            obj({ id: str('标签页 id'), title: str('标题'), url: str('地址') }, ['id', 'title', 'url']),
            '当前页面标签页',
          ),
        },
        ['running', 'browser', 'port', 'executablePath', 'profileDir', 'pluginBuild', 'tabs'],
      ),
      render: (_args, value) =>
        text(
          (value.running
            ? `Edge 可控制：${value.browser}\n端口 ${value.port}｜配置目录 ${value.profileDir}\n打开中的标签页（${value.tabs.length}）：\n`
              + value.tabs.map((tab, index) => `${index + 1}. ${tab.title} — ${tab.url}`).join('\n')
            : `Edge 当前不可控制：端口 ${value.port} 上没有调试接口。\n可执行文件：${value.executablePath || '(未解析到)'}\n配置目录：${value.profileDir}\n调用 edge_launch 可以启动一个可控制的 Edge。`)
          + `\n插件构建：${value.pluginBuild}`,
        ),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const status = await probe(port)
      const tabs = status.running
        ? (await listTargets(port)).map((target) => ({
          id: String(target.id ?? ''),
          title: String(target.title ?? ''),
          url: String(target.url ?? ''),
        }))
        : []
      return {
        running: status.running === true,
        browser: status.running ? String(status.version?.Browser ?? '') : '',
        port,
        executablePath: settings.executablePath ?? detectEdgePath() ?? '',
        profileDir: runtime.profileDir,
        pluginBuild: PLUGIN_BUILD,
        tabs,
      }
    },
  })

  /* ── 2. edge_launch ── */

  define({
    name: 'edge_launch',
    description:
      'Start a controllable Microsoft Edge with a CDP debug port, or reuse one already listening on that port. Uses a dedicated profile directory, so the Edge the user is browsing with is untouched. Safe to call repeatedly; returns reused=true when a controllable Edge already exists.',
    parameters: obj({
      url: str('启动后在新标签页打开的网址，可省略'),
      headless: bool('true 则无头运行，默认用配置值（可见窗口）'),
      port: PORT,
      windowSize: str('窗口尺寸，例如 1440,900'),
      timeoutMs: int('等待调试端口就绪的最长毫秒数'),
    }),
    output: {
      schema: obj(
        {
          reused: bool('是否复用了已在监听的实例'),
          pid: int('新启动进程的 pid，复用时为 0'),
          executablePath: str('使用的 msedge.exe'),
          profileDir: str('专用配置目录'),
          browser: str('浏览器版本'),
          url: str('启动后打开的网址，未指定则为空'),
          targetId: str('新标签页 id，未指定 url 则为空'),
        },
        ['reused', 'pid', 'executablePath', 'profileDir', 'browser', 'url', 'targetId'],
      ),
      render: (_args, value) =>
        text(
          `${value.reused ? '复用' : '启动'}了可控制的 Edge（${value.browser}）\n可执行文件 ${value.executablePath}\n配置目录 ${value.profileDir}`
          + (value.url ? `\n已打开 ${value.url}（标签页 ${value.targetId}）` : ''),
        ),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const result = await launchEdge({
        port,
        executablePath: settings.executablePath ?? detectEdgePath(),
        userDataDir: runtime.profileDir,
        headless: args.headless === true ? true : settings.headless === true,
        windowSize: args.windowSize ?? settings.windowSize,
        timeoutMs: args.timeoutMs ?? settings.launchTimeoutMs,
      })
      runtime.child = result.reused ? runtime.child : { pid: result.pid }
      let targetId = ''
      let url = ''
      if (typeof args.url === 'string' && args.url.length > 0) {
        const opened = await openAndSettle(port, args.url, exec.signal)
        targetId = opened.targetId
        url = opened.url
      }
      return {
        reused: result.reused === true,
        pid: typeof result.pid === 'number' ? result.pid : 0,
        executablePath: String(result.executablePath ?? ''),
        profileDir: String(result.userDataDir ?? runtime.profileDir),
        browser: String(result.version?.Browser ?? ''),
        url,
        targetId,
      }
    },
  })

  /* ── 3. edge_tabs ── */

  define({
    name: 'edge_tabs',
    description:
      'List the tabs of the controllable Edge. Use it to find a tab id for the other edge_* tools. includeAll also lists non-page targets (service workers, iframes, extensions).',
    parameters: obj({ port: PORT, includeAll: bool('连非 page 目标一起列出，默认 false') }),
    output: {
      schema: obj(
        {
          tabs: arr(
            obj(
              { id: str('标签页 id'), type: str('目标类型'), title: str('标题'), url: str('地址'), current: bool('是否为当前默认标签页') },
              ['id', 'type', 'title', 'url', 'current'],
            ),
            '目标列表',
          ),
        },
        ['tabs'],
      ),
      render: (_args, value) =>
        text(
          value.tabs.length === 0
            ? '当前没有标签页。'
            : value.tabs
              .map((tab, index) => `${index + 1}.${tab.current ? ' [当前]' : ''} ${tab.title || '(无标题)'}\n   ${tab.url}\n   id=${tab.id} type=${tab.type}`)
              .join('\n'),
        ),
    },
    async execute(args, exec) {
      const port = portOf(args)
      await requireRunning(port)
      const targets = await listTargets(port, { includeAll: args.includeAll === true })
      return {
        tabs: targets.map((target) => ({
          id: String(target.id ?? ''),
          type: String(target.type ?? ''),
          title: String(target.title ?? ''),
          url: String(target.url ?? ''),
          current: target.id === runtime.currentTargetId,
        })),
      }
    },
  })

  /* ── 4. edge_open ── */

  define({
    name: 'edge_open',
    description:
      'Open a URL in a new tab of the controllable Edge and make it the default target for later edge_* calls. Returns the new tab id.',
    parameters: obj({ url: str('要打开的网址，含协议，例如 https://example.com'), port: PORT }, ['url']),
    output: {
      schema: obj({ targetId: str('新标签页 id'), url: str('实际地址'), title: str('标题') }, ['targetId', 'url', 'title']),
      render: (_args, value) => text(`已打开 ${value.url}\n标题：${value.title}\n标签页 id：${value.targetId}`),
    },
    async execute(args, exec) {
      const port = portOf(args)
      await requireRunning(port)
      const opened = await openAndSettle(port, args.url, exec.signal)
      return { targetId: opened.targetId, url: opened.url, title: opened.title }
    },
  })

  /* ── 5. edge_navigate ── */

  define({
    name: 'edge_navigate',
    description:
      'Navigate an existing tab to a URL and wait until the document is ready. Omit targetId to use the current tab. Returns the settled URL, title, and readyState.',
    parameters: obj({ url: str('目标网址'), targetId: TARGET_ID, port: PORT, timeoutMs: int('等待就绪的最长毫秒数') }, ['url']),
    output: {
      schema: obj(
        { targetId: str('标签页 id'), url: str('最终地址（含跳转）'), title: str('标题'), readyState: str('document.readyState') },
        ['targetId', 'url', 'title', 'readyState'],
      ),
      render: (_args, value) => text(`${value.url}\n标题：${value.title}\ndocument.readyState=${value.readyState}`),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const session = await sessionFor(port, args.targetId, { timeoutMs: settings.defaultTimeoutMs })
      const result = await navigate(session, args.url, {
        signal: exec.signal,
        timeoutMs: args.timeoutMs ?? settings.defaultTimeoutMs,
      })
      return {
        targetId: session.targetId,
        url: result.url,
        title: result.title,
        readyState: result.readyState,
      }
    },
  })

  /* ── 6. edge_eval ── */

  define({
    name: 'edge_eval',
    description:
      'Evaluate a JavaScript expression in the page and return its value as JSON text. Use it to read DOM state, extract structured data, or drive the page. Set awaitPromise when the expression returns a promise.',
    parameters: obj(
      {
        expression: str('要执行的 JS 表达式（可以是 IIFE，返回值会被 JSON 序列化）'),
        targetId: TARGET_ID,
        awaitPromise: bool('表达式返回 Promise 时等待其解决，默认 false'),
        maxChars: int('返回文本上限，默认 20000'),
        port: PORT,
      },
      ['expression'],
    ),
    output: {
      schema: obj(
        { resultType: str('JS 类型'), resultText: str('JSON 文本形式的结果'), truncated: bool('是否被截断') },
        ['resultType', 'resultText', 'truncated'],
      ),
      render: (_args, value) => text(`[${value.resultType}] ${value.resultText}${value.truncated ? '\n…(已截断)' : ''}`),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const session = await sessionFor(port, args.targetId, { timeoutMs: settings.defaultTimeoutMs })
      const result = await evaluate(session, args.expression, {
        signal: exec.signal,
        awaitPromise: args.awaitPromise === true,
      })
      let serialized
      if (result.value !== undefined) {
        try {
          serialized = JSON.stringify(result.value)
        } catch {
          serialized = String(result.value)
        }
      } else {
        serialized = result.unserializable ?? result.description ?? 'undefined'
      }
      const maxChars = Number.isInteger(args.maxChars) && args.maxChars > 0 ? args.maxChars : 20000
      const value = String(serialized ?? 'null')
      return {
        resultType: result.type,
        resultText: value.slice(0, maxChars),
        truncated: value.length > maxChars,
      }
    },
  })

  /* ── 7. edge_text ── */

  define({
    name: 'edge_text',
    description:
      'Read the visible text of a page (document.body.innerText) together with its title and URL. Use it as the cheap first read before pulling HTML or writing a selector.',
    parameters: obj({ targetId: TARGET_ID, maxChars: int('正文上限，默认 12000'), port: PORT }),
    output: {
      schema: obj(
        { url: str('地址'), title: str('标题'), text: str('可见正文'), truncated: bool('是否截断') },
        ['url', 'title', 'text', 'truncated'],
      ),
      render: (_args, value) =>
        text(`# ${value.title}\n${value.url}\n\n${value.text}${value.truncated ? '\n\n…(正文已截断)' : ''}`),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const session = await sessionFor(port, args.targetId, { timeoutMs: settings.defaultTimeoutMs })
      const result = await pageText(session, {
        signal: exec.signal,
        maxChars: Number.isInteger(args.maxChars) && args.maxChars > 0 ? args.maxChars : 12000,
      })
      return result
    },
  })

  /* ── 8. edge_screenshot ── */

  define({
    name: 'edge_screenshot',
    description:
      'Capture a screenshot of a tab into a file and return its path. The image is written as a real file, so a vision-capable agent can read it with the read_image tool. Defaults to the current tab and a timestamped PNG in the session working directory.',
    parameters: obj(
      {
        targetId: TARGET_ID,
        path: str('保存路径，可为相对路径（相对会话工作目录）；省略则自动命名'),
        fullPage: bool('true 截取整个页面而不是视口，默认 false'),
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png' },
        quality: int('jpeg 质量 0-100，默认 85'),
        port: PORT,
      },
      [],
    ),
    output: {
      schema: obj(
        { path: str('写入的绝对路径'), format: str('格式'), bytes: int('字节数'), width: int('像素宽，未知为 0'), height: int('像素高，未知为 0') },
        ['path', 'format', 'bytes', 'width', 'height'],
      ),
      render: (_args, value) =>
        text(`截图已保存：${value.path}\n格式 ${value.format}｜${value.width}×${value.height}｜${value.bytes} 字节\n需要看图时用 read_image 读取该路径。`),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const session = await sessionFor(port, args.targetId, { timeoutMs: settings.defaultTimeoutMs })
      const format = args.format === 'jpeg' ? 'jpeg' : 'png'
      const shot = await screenshot(session, {
        signal: exec.signal,
        format,
        fullPage: args.fullPage === true,
        quality: Number.isInteger(args.quality) ? args.quality : undefined,
      })
      const cwd = sessionCwd(exec)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const requested = typeof args.path === 'string' && args.path.trim().length > 0
        ? args.path.trim()
        : `edge-screenshot-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`
      const absolute = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, shot.buffer)
      return {
        path: absolute,
        format: shot.format,
        bytes: shot.buffer.length,
        width: Number.isFinite(shot.width) ? shot.width : 0,
        height: Number.isFinite(shot.height) ? shot.height : 0,
      }
    },
  })

  /* ── 9. edge_click ── */

  define({
    name: 'edge_click',
    description:
      'Click an element in the page, located by a CSS selector or by visible text. Real mouse events are dispatched at the element centre after scrolling it into view, so the click behaves like a user click.',
    parameters: obj({
      selector: str('CSS 选择器，与 text 二选一，selector 优先'),
      text: str('可点击元素上的可见文本（包含匹配）'),
      targetId: TARGET_ID,
      port: PORT,
    }),
    output: {
      schema: obj(
        { tag: str('元素标签'), label: str('元素文本'), x: num('点击位置 x'), y: num('点击位置 y') },
        ['tag', 'label', 'x', 'y'],
      ),
      render: (_args, value) => text(`已点击 <${value.tag}> 「${value.label}」 at (${Math.round(value.x)}, ${Math.round(value.y)})`),
    },
    async execute(args, exec) {
      if ((args.selector === undefined || args.selector === '') && (args.text === undefined || args.text === '')) {
        throw new Error('edge_click 需要 selector 或 text 之一。')
      }
      const port = portOf(args)
      const session = await sessionFor(port, args.targetId, { timeoutMs: settings.defaultTimeoutMs })
      const result = await click(session, { signal: exec.signal, selector: args.selector, text: args.text })
      return { tag: result.tag, label: result.label, x: result.x, y: result.y }
    },
  })

  /* ── 10. edge_type ── */

  define({
    name: 'edge_type',
    description:
      'Type text into an input matched by a CSS selector: focuses (and selects existing text, then clears it), inserts the text, and optionally presses Enter. Returns the field value after typing.',
    parameters: obj(
      {
        selector: str('输入框的 CSS 选择器'),
        text: str('要输入的文本'),
        submit: bool('输入后按 Enter，默认 false'),
        clear: bool('先清空已有内容，默认 true'),
        targetId: TARGET_ID,
        port: PORT,
      },
      ['selector', 'text'],
    ),
    output: {
      schema: obj({ selector: str('使用的选择器'), value: str('输入后的字段值'), submitted: bool('是否按了 Enter') }, ['selector', 'value', 'submitted']),
      render: (_args, value) => text(`已输入到 ${value.selector}，当前值：${value.value}${value.submitted ? '（已回车提交）' : ''}`),
    },
    async execute(args, exec) {
      const port = portOf(args)
      const session = await sessionFor(port, args.targetId, { timeoutMs: settings.defaultTimeoutMs })
      const result = await typeText(session, {
        signal: exec.signal,
        selector: args.selector,
        text: args.text,
        submit: args.submit === true,
        clear: args.clear !== false,
      })
      return { selector: args.selector, value: result.value, submitted: result.submitted }
    },
  })

  /* ── 11. edge_close ── */

  define({
    name: 'edge_close',
    description:
      'Close one tab (targetId, or the current tab) or, with shutdown=true, ask the whole controllable Edge instance to exit. Closing tabs keeps the browser running for later calls.',
    parameters: obj({
      targetId: TARGET_ID,
      shutdown: bool('true 则关闭整个可控制的 Edge 实例，默认 false'),
      port: PORT,
    }),
    output: {
      schema: obj({ closed: str('被关闭的标签页 id，未关标签则为空'), shutDown: bool('是否请求了退出'), remaining: int('剩余的页面标签页数') }, [
        'closed',
        'shutDown',
        'remaining',
      ]),
      render: (_args, value) =>
        text(
          value.shutDown
            ? '已请求可控制的 Edge 退出。'
            : `已关闭标签页 ${value.closed || '(无)'}，剩余页面标签页 ${value.remaining} 个。`,
        ),
    },
    async execute(args, exec) {
      const port = portOf(args)
      await requireRunning(port)
      if (args.shutdown === true) {
        const targets = await listTargets(port)
        for (const target of targets) {
          await closeTarget(port, target.id).catch(() => undefined)
        }
        for (const session of runtime.sessions.values()) session.close()
        runtime.sessions.clear()
        runtime.currentTargetId = undefined
        // Edge 在最后一个标签页被关闭后会自行退出；这里再显式收尾一次。
        const version = await probe(port).then((status) => status.version).catch(() => undefined)
        if (version?.webSocketDebuggerUrl) {
          const socket = await WebSocketClient.connect(version.webSocketDebuggerUrl, { timeoutMs: 5000 }).catch(() => undefined)
          if (socket !== undefined) {
            await socket.request('Browser.close', {}, { timeoutMs: 3000 }).catch(() => undefined)
            socket.close()
          }
        }
        return { closed: '', shutDown: true, remaining: 0 }
      }
      const status = await probe(port)
      const targets = await listTargets(port)
      const target = pickTarget(targets, args.targetId)
      const session = runtime.sessions.get(target.id)
      if (session !== undefined) {
        session.close()
        runtime.sessions.delete(target.id)
      }
      await closeTarget(port, target.id)
      if (runtime.currentTargetId === target.id) runtime.currentTargetId = undefined
      // /json/close 只是"开始关闭"：目标要过一小会儿才从列表消失。
      // 立刻数会报出偏大的 remaining，所以等它真正消失（最多 2 秒）。
      const deadline = Date.now() + 2000
      let remaining = (await listTargets(port)).length
      while (Date.now() < deadline) {
        const current = await listTargets(port)
        remaining = current.length
        if (current.some((entry) => entry.id === target.id) === false) break
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return { closed: target.id, shutDown: false, remaining }
    },
  })

  // 启动时预热一次目标指针，便于日志与后续调用（失败不抛错）。
  void requireRunning(settings.port)
    .then(() => listTargets(settings.port))
    .then((targets) => {
      if (runtime.currentTargetId === undefined && targets[0] !== undefined) runtime.currentTargetId = targets[0].id
    })
    .catch(() => undefined)
}

/** 仅供 test/definitions.mjs 使用，不参与插件契约。 */
export const __test = { PLUGIN_BUILD, withHint }
