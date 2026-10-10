/**
 * 构建一致性自检（不需要浏览器，秒级）。
 *
 * "改代码不重启 DSH"依赖五处对齐：package.json 版本、入口文件名、入口里的 `?b=`、
 * 实现里的 PLUGIN_BUILD、补丁里的行名。漏改任何一处，reload 后跑的还是旧代码——
 * 这个脚本就是用来在提交/上传前抓这种漏改的。
 *
 * 用法：node test/build-check.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const libDir = path.join(root, 'lib')

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: ok === true })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const build = pkg.version
const entryFile = path.join(libDir, `entry-${build}.js`)
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
const pluginSource = fs.readFileSync(path.join(libDir, 'plugin.js'), 'utf8')
const cdpSource = fs.readFileSync(path.join(libDir, 'cdp.js'), 'utf8')

check('package.json version 形如 x.y.z', /^\d+\.\d+\.\d+$/.test(build), build)
check(`入口文件 lib/entry-${build}.js 存在`, fs.existsSync(entryFile))
check('补丁行名指向当前构建的入口', patch.includes(`./lib/entry-${build}.js`), /name: '([^']+)'/.exec(patch)?.[1] ?? '(未找到)')
check('入口里的 ?b= 与构建号一致', fs.existsSync(entryFile) && fs.readFileSync(entryFile, 'utf8').includes(`?b=${build}`))
check('cdp.js 对 ws.js 的依赖带 ?b= 构建号', cdpSource.includes(`./ws.js?b=${build}`))
check('plugin.js 对 cdp.js/ws.js 的依赖都带 ?b=', pluginSource.includes(`./cdp.js?b=${build}`) && pluginSource.includes(`./ws.js?b=${build}`))
check('plugin.js 的 PLUGIN_BUILD 与版本一致', pluginSource.includes(`PLUGIN_BUILD = '${build}'`))

const staleEntries = fs.readdirSync(libDir).filter((name) => /^entry-.*\.js$/.test(name) && name !== `entry-${build}.js`)
check('没有遗留的旧入口文件', staleEntries.length === 0, staleEntries.join(', ') || '(无)')

// 真正加载一遍，确认模块身份与内容都对
const entry = await import(pathToFileURL(entryFile).href)
check('入口可加载且导出 apply/inject/name', typeof entry.apply === 'function' && Array.isArray(entry.inject) && typeof entry.name === 'string', Object.keys(entry).join(','))
check('加载后的 PLUGIN_BUILD 与版本一致', entry.__test?.PLUGIN_BUILD === build, String(entry.__test?.PLUGIN_BUILD))

const ws = await import(`${pathToFileURL(path.join(libDir, 'ws.js')).href}?b=${build}`)
check('ws.js 含消息派发（否则所有 CDP 调用都会超时）', ws.WebSocketClient.prototype.constructor.toString().includes("on('message'"))

const failed = results.filter((entry) => entry.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} checks passed   (构建 ${build})`)
if (failed.length > 0) {
  console.log('failed:')
  for (const entry of failed) console.log(`  - ${entry.label}`)
  process.exitCode = 1
}
