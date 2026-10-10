/**
 * dsh-edge-browser 冒烟测试：用与插件完全相同的 lib/cdp.js 驱动真实 Edge。
 *
 * 用法：
 *   node test/smoke.mjs [--port 9333] [--profile-dir <dir>] [--keep-open]
 *
 * 覆盖：启动 → 列标签 → 导航本地页面 → 读正文 → 执行 JS → 点击 → 输入 → 截图 → 关标签。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CdpSession,
  click,
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
  typeText,
} from '../lib/cdp.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const port = Number(arg('port', '9333'))
const profileDir = arg('profile-dir', path.join(here, 'tmp', 'profile'))
const keepOpen = process.argv.includes('--keep-open')

const results = []
function check(label, condition, detail = '') {
  results.push({ label, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>edge-browser smoke</title></head>
<body>
  <h1 id="title">Edge 控制冒烟测试</h1>
  <p class="lead">这是一段用于校验正文提取的段落。</p>
  <button id="counter" type="button">点击计数 0</button>
  <label for="q">搜索词</label>
  <input id="q" name="q" type="text" value="">
  <a id="link" href="#target">可见链接文本</a>
  <pre id="target">anchor</pre>
  <script>
    let count = 0;
    document.getElementById('counter').addEventListener('click', () => {
      count += 1;
      document.getElementById('counter').textContent = '点击计数 ' + count;
    });
    window.__state = { ready: true, tags: ['a', 'b'] };
  </script>
</body>
</html>`

const pageFile = path.join(here, 'tmp', 'page.html')
fs.mkdirSync(path.dirname(pageFile), { recursive: true })
fs.writeFileSync(pageFile, PAGE, 'utf8')
const pageUrl = `file:///${pageFile.replace(/\\/g, '/')}`

let launched

try {
  const executablePath = detectEdgePath()
  console.log(`edge: ${executablePath}`)
  console.log(`port: ${port}\nprofile: ${profileDir}\npage: ${pageUrl}\n`)
  check('自动探测到 msedge.exe', typeof executablePath === 'string' && executablePath.length > 0, executablePath ?? '')

  launched = await launchEdge({ port, executablePath, userDataDir: profileDir, headless: true, timeoutMs: 30000 })
  check('Edge 启动并暴露调试端口', (await probe(port)).running === true, `pid=${launched.pid ?? 0} ${String(launched.version?.Browser ?? '')}`)

  const opened = await newTab(port, 'about:blank')
  check('新建标签页返回 target id', typeof opened?.id === 'string' && opened.id.length > 0, String(opened?.id ?? ''))

  const targets = await listTargets(port)
  check('标签页列表包含 page 目标', targets.some((target) => target.id === opened.id))

  const session = await CdpSession.open(targets.find((target) => target.id === opened.id), { defaultTimeoutMs: 20000 })
  const nav = await navigate(session, pageUrl, { timeoutMs: 20000 })
  check('导航到本地页面并等到 readyState=complete', nav.readyState === 'complete', `${nav.title} | ${nav.url}`)

  const body = await pageText(session, { maxChars: 4000 })
  check('正文提取包含页面文字', body.text.includes('用于校验正文提取的段落'), JSON.stringify(body.text.slice(0, 40)))
  check('标题提取正确', body.title === 'edge-browser smoke', body.title)

  const evaluated = await evaluate(session, 'JSON.stringify(window.__state)')
  check('执行 JS 返回页面状态', typeof evaluated.value === 'string' && evaluated.value.includes('"ready":true'), String(evaluated.value))
  const awaited = await evaluate(session, 'Promise.resolve(6 * 7)', { awaitPromise: true })
  check('awaitPromise 可用', awaited.value === 42, String(awaited.value))

  const clicked = await click(session, { selector: '#counter' })
  const afterClick = await evaluate(session, 'document.getElementById("counter").textContent')
  check('按选择器点击生效', String(afterClick.value).includes('点击计数 1'), `${clicked.tag} | ${String(afterClick.value)}`)

  const clickedByText = await click(session, { text: '可见链接文本' })
  check('按可见文本点击生效', clickedByText.label.includes('可见链接文本'), clickedByText.label)

  const typed = await typeText(session, { selector: '#q', text: 'dsh edge 插件' })
  check('输入文本写入字段', typed.value === 'dsh edge 插件', typed.value)

  await typeText(session, { selector: '#q', text: '重新输入', submit: true })
  const typedSubmit = await evaluate(session, 'document.getElementById("q").value')
  check('submit 后字段值正确', String(typedSubmit.value) === '重新输入', String(typedSubmit.value))

  const viewport = await screenshot(session, { format: 'png' })
  const pngOk = viewport.buffer.length > 1000 && viewport.buffer.subarray(1, 4).toString('latin1') === 'PNG'
  check('视口截图是合法 PNG', pngOk, `${viewport.width}x${viewport.height} ${viewport.buffer.length}B`)

  const full = await screenshot(session, { format: 'png', fullPage: true })
  const shotPath = path.join(here, 'tmp', 'fullpage.png')
  fs.writeFileSync(shotPath, full.buffer)
  check('整页截图写出文件', fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000, `${shotPath} ${full.width}x${full.height}`)

  const jpeg = await screenshot(session, { format: 'jpeg', quality: 70 })
  check('JPEG 截图可用', jpeg.buffer.length > 500 && jpeg.buffer[0] === 0xff && jpeg.buffer[1] === 0xd8, `${jpeg.buffer.length}B`)

  await closeTarget(port, opened.id)
  const remaining = (await listTargets(port)).filter((target) => target.id === opened.id).length
  check('关闭标签页生效', remaining === 0)

  session.close()
} catch (error) {
  check('冒烟流程未抛异常', false, error instanceof Error ? `${error.message}` : String(error))
} finally {
  const version = await probe(port).catch(() => ({ running: false }))
  if (version.running && keepOpen !== true) {
    try {
      const { WebSocketClient } = await import('../lib/ws.js')
      const socket = await WebSocketClient.connect(version.version.webSocketDebuggerUrl, { timeoutMs: 5000 })
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
