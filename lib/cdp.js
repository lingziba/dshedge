/**
 * Edge 控制层：CDP over HTTP + WebSocket。
 *
 * 设计要点
 * --------
 * - 不用 Playwright/Puppeteer：那些包要么需要下载浏览器，要么需要额外依赖；
 *   这里直接用 Edge 自带的 --remote-debugging-port，零依赖。
 * - 专用 user-data-dir：Chromium 136+ 拒绝在默认配置目录上开远程调试，
 *   而且独立目录不会碰到用户正在使用的 Edge 会话。
 * - 连接是懒加载的：只有真正操作浏览器时才连 WebSocket。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketClient } from './ws.js?b=1.0.4'

/* ─────────────────────────── HTTP /json 端点 ─────────────────────────── */

function requestText(port, pathname, options = {}) {
  const method = options.method ?? 'GET'
  const timeoutMs = options.timeoutMs ?? 5000
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== undefined && response.statusCode >= 400) {
            const error = new Error(`HTTP ${response.statusCode} from ${pathname}: ${body.slice(0, 200)}`)
            error.statusCode = response.statusCode
            reject(error)
            return
          }
          resolve(body)
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error(`Request to ${pathname} timed out after ${timeoutMs}ms`)))
    request.on('error', reject)
    request.end()
  })
}

async function requestJson(port, pathname, options) {
  const body = await requestText(port, pathname, options)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`Expected JSON from ${pathname}, got: ${body.slice(0, 200)}`)
  }
}

/** Edge 是否已在该端口上暴露调试接口。 */
export async function probe(port, timeoutMs = 1500) {
  try {
    const version = await requestJson(port, '/json/version', { timeoutMs })
    return { running: true, version }
  } catch (error) {
    return { running: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 等待调试端口就绪，返回 /json/version 结果。 */
export async function waitForPort(port, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    const result = await probe(port, 1500)
    if (result.running) return result.version
    lastError = result.error
    if (Date.now() >= deadline) {
      throw new Error(`Edge debug port ${port} did not become ready within ${timeoutMs}ms (last error: ${lastError})`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 列出可操作的目标（默认只要 page）。 */
export async function listTargets(port, options = {}) {
  const targets = await requestJson(port, '/json/list', { timeoutMs: options.timeoutMs ?? 5000 })
  const list = Array.isArray(targets) ? targets : []
  return options.includeAll === true ? list : list.filter((target) => target.type === 'page')
}

/** 新开标签页（Chromium 111+ 要求 PUT）。 */
export async function newTab(port, url) {
  const suffix = `?url=${encodeURIComponent(url)}`
  try {
    return await requestJson(port, `/json/new${suffix}`, { method: 'PUT', timeoutMs: 10000 })
  } catch (error) {
    if (error.statusCode === 405 || error.statusCode === 400) {
      return await requestJson(port, `/json/new${suffix}`, { method: 'GET', timeoutMs: 10000 })
    }
    throw error
  }
}

export async function closeTarget(port, targetId) {
  return requestText(port, `/json/close/${encodeURIComponent(targetId)}`, { timeoutMs: 5000 })
}

export async function activateTarget(port, targetId) {
  return requestText(port, `/json/activate/${encodeURIComponent(targetId)}`, { timeoutMs: 5000 })
}

/* ───────────────────────────── Edge 启动 ───────────────────────────── */

/**
 * 找到 Microsoft Edge 可执行文件。
 *
 * 先看显式覆盖（config.executablePath 由插件传入，或环境变量 DSH_EDGE_PATH），
 * 再按平台探测常见安装位置，最后在 PATH 里找一遍——
 * 这样 Windows / macOS / Linux 上装完就能用，不需要用户手填路径。
 */
export function detectEdgePath() {
  const linuxNames = ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-beta', 'microsoft-edge-dev']
  const candidates = [
    process.env.DSH_EDGE_PATH,
    // Windows
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    // macOS
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(os.homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    // Linux
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/msedge',
    '/snap/bin/microsoft-edge',
  ].filter((value) => typeof value === 'string' && value.length > 0)

  // PATH 兜底：Windows 上找 msedge.exe，其它平台找 microsoft-edge*
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue
    candidates.push(path.join(dir, process.platform === 'win32' ? 'msedge.exe' : linuxNames[0]))
    if (process.platform !== 'win32') {
      for (const name of linuxNames) candidates.push(path.join(dir, name))
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore and keep looking
    }
  }
  return undefined
}

/** 插件专用配置目录（不碰用户自己的 Edge 配置），按平台选合适的位置。 */
export function defaultProfileDir() {
  let base
  if (process.platform === 'win32') {
    base = process.env.LOCALAPPDATA
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support')
  } else {
    base = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state')
  }
  if (typeof base !== 'string' || base.length === 0) base = process.env.DSH_HOME ?? os.tmpdir()
  return path.join(base, 'dsh-edge-browser', 'profile')
}

const EDGE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-features=Translate,OptimizationHints',
  '--remote-debugging-address=127.0.0.1',
]

/**
 * 启动（或复用）一个带调试端口的 Edge。
 * @returns {{ reused: boolean, pid?: number, executablePath: string, userDataDir: string, version: unknown }}
 */
export async function launchEdge(options) {
  const port = options.port
  const existing = await probe(port)
  if (existing.running) {
    return {
      reused: true,
      executablePath: options.executablePath,
      userDataDir: options.userDataDir,
      version: existing.version,
    }
  }
  const executablePath = options.executablePath
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      `Microsoft Edge executable not found${executablePath ? ` at ${executablePath}` : ''}. `
      + 'Set config.executablePath or the DSH_EDGE_PATH environment variable.',
    )
  }
  fs.mkdirSync(options.userDataDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.userDataDir}`,
    ...EDGE_ARGS,
  ]
  if (options.headless === true) args.push('--headless=new')
  if (typeof options.windowSize === 'string' && options.windowSize.length > 0) args.push(`--window-size=${options.windowSize}`)
  args.push('about:blank')

  const child = spawn(executablePath, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  const version = await waitForPort(port, options.timeoutMs ?? 25000)
  return { reused: false, pid: child.pid, executablePath, userDataDir: options.userDataDir, version }
}

/* ───────────────────────────── CDP 会话 ───────────────────────────── */

/** 一个 page target 的 CDP 会话。 */
export class CdpSession {
  constructor(target, socket, defaultTimeoutMs) {
    this.targetId = target.id
    this.socket = socket
    this.defaultTimeoutMs = defaultTimeoutMs
    this.enabled = new Set()
  }

  static async open(target, options = {}) {
    const url = target.webSocketDebuggerUrl
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`Target ${target.id} has no webSocketDebuggerUrl; is it a page target?`)
    }
    const socket = await WebSocketClient.connect(url, { timeoutMs: options.timeoutMs ?? 10000 })
    return new CdpSession(target, socket, options.defaultTimeoutMs ?? 30000)
  }

  send(method, params = {}, options = {}) {
    return this.socket.request(method, params, {
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      signal: options.signal,
    })
  }

  /** 幂等地启用某个 CDP domain。 */
  async ensure(domain) {
    if (this.enabled.has(domain)) return
    await this.send(`${domain}.enable`)
    this.enabled.add(domain)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      this.socket.destroy()
    }
  }
}

/* ─────────────────────────── 高层页面操作 ─────────────────────────── */

function describeException(details) {
  const description = details?.exception?.description ?? details?.exception?.value
  if (typeof description === 'string' && description.length > 0) return description
  const text = details?.text
  return typeof text === 'string' && text.length > 0 ? text : 'JavaScript evaluation failed'
}

/** 在页面里执行 JS。 */
export async function evaluate(session, expression, options = {}) {
  const response = await session.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: options.awaitPromise === true,
      returnByValue: options.returnByValue !== false,
      userGesture: true,
      ...(options.expressionTimeoutMs !== undefined ? { timeout: options.expressionTimeoutMs } : {}),
    },
    options,
  )
  if (response.exceptionDetails) throw new Error(describeException(response.exceptionDetails))
  const result = response.result ?? {}
  return {
    type: result.type ?? 'undefined',
    value: result.value,
    unserializable: result.unserializableValue,
    description: result.description,
  }
}

/** 导航并等待文档就绪。 */
export async function navigate(session, url, options = {}) {
  await session.ensure('Page')
  const response = await session.send('Page.navigate', { url }, options)
  if (response.errorText) throw new Error(`Navigation to ${url} failed: ${response.errorText}`)
  const timeoutMs = options.timeoutMs ?? 20000
  const deadline = Date.now() + timeoutMs
  let readyState = 'unknown'
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted')
    try {
      const probeResult = await evaluate(session, 'document.readyState', { timeoutMs: 3000 })
      readyState = String(probeResult.value ?? 'unknown')
      if (readyState === 'complete') break
    } catch {
      // navigation may be swapping the execution context; retry until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const title = await evaluate(session, 'document.title', { timeoutMs: 5000 }).catch(() => ({ value: '' }))
  const href = await evaluate(session, 'location.href', { timeoutMs: 5000 }).catch(() => ({ value: url }))
  return { url: String(href.value ?? url), title: String(title.value ?? ''), readyState }
}

/** 取页面可见文本。 */
export async function pageText(session, options = {}) {
  const result = await evaluate(
    session,
    `(() => {
      const body = document.body;
      const text = body ? (body.innerText || body.textContent || '') : '';
      return { title: document.title, url: location.href, text };
    })()`,
    options,
  )
  const value = result.value ?? {}
  const maxChars = options.maxChars ?? 12000
  const full = typeof value.text === 'string' ? value.text : ''
  const collapsed = full.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return {
    url: String(value.url ?? ''),
    title: String(value.title ?? ''),
    text: collapsed.slice(0, maxChars),
    truncated: collapsed.length > maxChars,
  }
}

/** 截图，返回 PNG/JPEG 字节。 */
export async function screenshot(session, options = {}) {
  await session.ensure('Page')
  const params = { format: options.format ?? 'png' }
  if (params.format === 'jpeg') params.quality = options.quality ?? 85
  if (options.fullPage === true) {
    const metrics = await session.send('Page.getLayoutMetrics', {}, options)
    const size = metrics.cssContentSize ?? metrics.contentSize
    if (size) {
      params.captureBeyondViewport = true
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    }
  }
  const response = await session.send('Page.captureScreenshot', params, options)
  const buffer = Buffer.from(response.data ?? '', 'base64')
  if (buffer.length === 0) throw new Error('Page.captureScreenshot returned no image data')
  let width
  let height
  if (params.format === 'png' && buffer.length > 24) {
    width = buffer.readUInt32BE(16)
    height = buffer.readUInt32BE(20)
  }
  return { buffer, format: params.format, width, height }
}

/** 元素定位脚本：优先 CSS 选择器，其次可点击元素的可见文本。 */
function locateExpression(options) {
  const selector = options.selector ?? null
  const text = options.text ?? null
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const wanted = ${JSON.stringify(text)};
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    let element = null;
    if (selector) {
      const matches = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      element = matches[0] ?? null;
    } else if (wanted) {
      const candidates = Array.from(document.querySelectorAll(
        'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], summary, label, [onclick]'
      )).filter(isVisible);
      const needle = wanted.toLowerCase();
      element = candidates.find((node) => {
        const label = (node.innerText || node.value || node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
        return label.length > 0 && label.includes(needle);
      }) ?? null;
    }
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      label: (element.innerText || element.value || element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 120),
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  })()`
}

/** 点击：CSS 选择器或可见文本。 */
export async function click(session, options = {}) {
  const located = await evaluate(session, locateExpression(options), options)
  const element = located.value
  if (element === null || element === undefined) {
    throw new Error(
      options.selector
        ? `No visible element matched selector ${options.selector}`
        : `No visible clickable element contained the text ${JSON.stringify(options.text ?? '')}`,
    )
  }
  const x = Number(element.x)
  const y = Number(element.y)
  if (Number.isFinite(x) && Number.isFinite(y) && element.width > 0 && element.height > 0) {
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, options)
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, options)
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, options)
  } else {
    await evaluate(
      session,
      `(() => {
        const el = document.querySelector(${JSON.stringify(options.selector ?? '')}) || null;
        if (!el) throw new Error('element not found');
        el.click();
        return true;
      })()`,
      options,
    )
  }
  return { label: String(element.label ?? ''), tag: String(element.tag ?? ''), x, y }
}

/** 聚焦元素并输入文本。 */
export async function typeText(session, options = {}) {
  const located = await evaluate(
    session,
    `(() => {
      const selector = ${JSON.stringify(options.selector)};
      const element = document.querySelector(selector);
      if (!element) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      if (typeof element.select === 'function' && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) element.select();
      return {
        tag: element.tagName.toLowerCase(),
        value: typeof element.value === 'string' ? element.value : '',
        editable: element.isContentEditable === true || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA',
      };
    })()`,
    options,
  )
  const element = located.value
  if (element === null || element === undefined) throw new Error(`No element matched selector ${options.selector}`)
  if (element.editable !== true) throw new Error(`Element ${options.selector} is not an editable input`)
  if (options.clear !== false && typeof element.value === 'string' && element.value.length > 0) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, options)
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, options)
  }
  await session.send('Input.insertText', { text: String(options.text ?? '') }, options)
  if (options.submit === true) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, options)
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, options)
  }
  const after = await evaluate(session, `(() => { const el = document.querySelector(${JSON.stringify(options.selector)}); return el ? String(el.value ?? '') : ''; })()`, options)
  return { tag: String(element.tag), value: String(after.value ?? ''), submitted: options.submit === true }
}

export const internals = { requestText, requestJson }
