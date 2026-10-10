/**
 * dsh-edge-browser 真实站点测试：验证 HTTPS 导航、真实页面正文/标题提取、
 * 真实页面截图（视口 + 整页）。与插件共用 lib/cdp.js，因此这就是插件的真实路径。
 *
 * 用法：
 *   node test/live.mjs [--url https://example.com] [--port 9337] [--profile-dir <dir>]
 *
 * 判定：导航到 readyState=complete、标题非空、PNG 合法 → 硬性通过；
 * 正文长度、链接数等只作报告（站点可能改版或有反爬）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CdpSession,
  closeTarget,
  detectEdgePath,
  evaluate,
  launchEdge,
  listTargets,
  navigate,
  newTab,
  pageText,
  probe,
  screenshot,
} from '../lib/cdp.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const url = arg('url', 'https://example.com')
const port = Number(arg('port', '9337'))
const profileDir = arg('profile-dir', path.join(here, 'tmp', 'profile-live'))

const results = []
function check(label, condition, detail = '') {
  results.push({ label, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const t0 = Date.now()
let launched
let session
let opened

try {
  console.log(`url:   ${url}`)
  console.log(`port:  ${port}\nprofile: ${profileDir}\n`)

  launched = await launchEdge({
    port,
    executablePath: detectEdgePath(),
    userDataDir: profileDir,
    headless: true,
    timeoutMs: 30000,
  })
  check('Edge 启动并暴露调试端口', (await probe(port)).running === true, launched.version?.Browser ?? '')

  opened = await newTab(port, 'about:blank')
  const target = (await listTargets(port)).find((entry) => entry.id === opened.id)
  session = await CdpSession.open(target, { defaultTimeoutMs: 45000 })

  const tNav = Date.now()
  const nav = await navigate(session, url, { timeoutMs: 45000 })
  check('HTTPS 导航到 readyState=complete', nav.readyState === 'complete', `${Date.now() - tNav}ms → ${nav.url}`)
  check('标题非空', typeof nav.title === 'string' && nav.title.trim().length > 0, JSON.stringify(nav.title))

  const body = await pageText(session, { maxChars: 4000 })
  check('正文可提取', typeof body.text === 'string' && body.text.trim().length > 20, `${body.text.length} 字符（截取上限内）`)

  const meta = await evaluate(
    session,
    `JSON.stringify({
      title: document.title,
      url: location.href,
      protocol: location.protocol,
      readyState: document.readyState,
      links: document.querySelectorAll('a').length,
      images: document.images.length,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    })`,
  )
  const info = JSON.parse(String(meta.value ?? '{}'))
  check('页内 JS 可执行', info.readyState === 'complete' && typeof info.url === 'string', JSON.stringify(info))
  check('HTTPS 生效', info.protocol === 'https:', info.protocol)

  const viewport = await screenshot(session, { format: 'png' })
  const pngSignature = viewport.buffer.subarray(1, 4).toString('latin1') === 'PNG'
  check('视口截图是合法 PNG', pngSignature && viewport.width > 0 && viewport.height > 0, `${viewport.width}x${viewport.height} ${viewport.buffer.length}B`)

  const full = await screenshot(session, { format: 'png', fullPage: true })
  const shotPath = path.join(here, 'tmp', `live-${new URL(url).hostname.replace(/[^a-z0-9.]/gi, '_')}.png`)
  fs.mkdirSync(path.dirname(shotPath), { recursive: true })
  fs.writeFileSync(shotPath, full.buffer)
  check('整页截图写出文件', fs.statSync(shotPath).size > 5000, `${shotPath} ${full.width}x${full.height}`)

  await closeTarget(port, opened.id)
  // /json/close 只表示"开始关闭"，目标会晚一点从列表消失，因此轮询而不是立刻断言。
  let gone = false
  const closeDeadline = Date.now() + 5000
  while (Date.now() < closeDeadline) {
    gone = (await listTargets(port)).some((entry) => entry.id === opened.id) === false
    if (gone) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  check('关闭标签页生效', gone)

  console.log(`\n站点信息：${JSON.stringify(info)}`)
  console.log(`总耗时：${Date.now() - t0}ms`)
} catch (error) {
  check('真实站点流程未抛异常', false, error instanceof Error ? error.message : String(error))
} finally {
  try {
    session?.close()
  } catch {
    // ignore
  }
  const status = await probe(port).catch(() => ({ running: false }))
  if (status.running) {
    try {
      const { WebSocketClient } = await import('../lib/ws.js')
      const socket = await WebSocketClient.connect(status.version.webSocketDebuggerUrl, { timeoutMs: 5000 })
      await socket.request('Browser.close', {}, { timeoutMs: 3000 }).catch(() => undefined)
      socket.close()
    } catch {
      // ignore
    }
  }
  const failed = results.filter((entry) => entry.ok !== true)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:')
    for (const entry of failed) console.log(`  - ${entry.label}${entry.detail ? ` (${entry.detail})` : ''}`)
    process.exitCode = 1
  }
}
