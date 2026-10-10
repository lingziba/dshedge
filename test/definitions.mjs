/**
 * dsh-edge-browser 定义自检：不启动浏览器，只检查插件交给 ctx.tools.register
 * 的那 11 份 ToolDefinition 是否合法。
 *
 * 这一步很重要：工具定义是在宿主进程里注册时校验的，schema 写错会导致整行
 * 插件激活失败（工具全都不出现）。所以改完定义先跑这个，再谈重启。
 *
 * 用法：
 *   node test/definitions.mjs
 *   node test/definitions.mjs --validator <json-schema.js 路径>   # 用 DSH 自己的校验器
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { __test, apply, inject, name } from '../lib/plugin.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/* ── DSH 支持的 JSON Schema 子集（照 lib/types/json-schema.js 的约束复刻） ── */

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function checkSchema(node, at, violations) {
  if (!isRecord(node)) {
    violations.push(`${at} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      violations.push(`${at}.${key} is not a supported keyword`)
    }
  }
  if ('type' in node && (typeof node.type !== 'string' || !TYPES.has(node.type))) {
    violations.push(`${at}.type must be one of ${[...TYPES].join('/')}`)
  }
  if ('oneOf' in node) {
    for (const sibling of ONE_OF_SIBLINGS) {
      if (sibling in node) violations.push(`${at}.${sibling} is not supported beside oneOf`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) violations.push(`${at}.oneOf must be a non-empty array`)
    else node.oneOf.forEach((branch, index) => checkSchema(branch, `${at}.oneOf[${index}]`, violations))
  }
  if ('properties' in node) {
    if (!isRecord(node.properties)) violations.push(`${at}.properties must be an object`)
    else {
      for (const [key, value] of Object.entries(node.properties)) checkSchema(value, `${at}.properties.${key}`, violations)
    }
  }
  if ('required' in node) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
      violations.push(`${at}.required must be an array of strings`)
    } else if (isRecord(node.properties)) {
      for (const key of node.required) {
        if (!(key in node.properties)) violations.push(`${at}.required names undeclared property "${key}"`)
      }
    }
  }
  if ('items' in node) checkSchema(node.items, `${at}.items`, violations)
  if ('additionalProperties' in node) {
    const value = node.additionalProperties
    if (typeof value !== 'boolean') checkSchema(value, `${at}.additionalProperties`, violations)
  }
}

function subsetViolations(schema, label) {
  const violations = []
  checkSchema(schema, label, violations)
  return violations
}

/* ── 采集定义 ── */

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: ok === true, detail })
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const captured = []
const ctx = {
  tools: {
    register(definition) {
      captured.push(definition)
      return () => {}
    },
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
}

check('插件导出 apply/inject/name', typeof apply === 'function' && Array.isArray(inject) && typeof name === 'string', `${name} inject=${JSON.stringify(inject)}`)

apply(ctx, { port: 9222, headless: true })
check('注册了 11 个工具', captured.length === 11, `实际 ${captured.length}: ${captured.map((d) => d.name).join(', ')}`)

const names = captured.map((definition) => definition.name)
check('工具名唯一', new Set(names).size === names.length)
check('未占用保留名 run_code', names.includes('run_code') === false)
check('全部以 edge_ 前缀命名', names.every((toolName) => toolName.startsWith('edge_')), names.join(', '))

let validator = undefined
const validatorArg = process.argv.indexOf('--validator')
if (validatorArg !== -1 && process.argv[validatorArg + 1] !== undefined) {
  validator = await import(pathToFileURL(process.argv[validatorArg + 1]).href)
  console.log(`（使用 DSH 校验器：${process.argv[validatorArg + 1]}）`)
}

for (const definition of captured) {
  const label = definition.name
  const problems = []
  if (typeof definition.description !== 'string' || definition.description.length < 20) problems.push('description 缺失或过短')
  if (!isRecord(definition.parameters)) problems.push('parameters 不是对象')
  if (!isRecord(definition.output) || typeof definition.output.render !== 'function') problems.push('output.render 不是函数')
  if (typeof definition.execute !== 'function') problems.push('execute 不是函数')
  if (validator !== undefined) {
    try {
      validator.assertObjectJsonSchema(definition.parameters)
      validator.assertSupportedJsonSchema(definition.output.schema)
    } catch (error) {
      problems.push(`DSH 校验器拒绝：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    problems.push(...subsetViolations(definition.parameters, `${label}.parameters`))
    problems.push(...subsetViolations(definition.output.schema, `${label}.output.schema`))
    if (definition.parameters.type !== 'object') problems.push('parameters 根必须是 object')
  }
  // 参数里出现的 targetId/port 等应由 properties 声明
  if (Array.isArray(definition.parameters.required)) {
    for (const key of definition.parameters.required) {
      if (!(key in definition.parameters.properties)) problems.push(`required 里的 ${key} 未声明`)
    }
  }
  check(`${label} 定义合法`, problems.length === 0, problems.join('；'))
}

/* ── render 输出形状（拿 edge_status 当代表） ── */

const status = captured.find((definition) => definition.name === 'edge_status')
const sample = {
  running: true,
  browser: 'Edg/155.0.0.0',
  port: 9222,
  executablePath: 'C:/msedge.exe',
  profileDir: 'C:/profile',
  pluginBuild: __test.PLUGIN_BUILD,
  tabs: [{ id: 'x', title: 't', url: 'u' }],
}
const rendered = status?.output.render({}, sample)
check(
  'edge_status.render 返回文本块',
  Array.isArray(rendered) && rendered.every((block) => block.type === 'text' && typeof block.text === 'string') && rendered[0].text.includes(__test.PLUGIN_BUILD),
  JSON.stringify(rendered).slice(0, 80),
)

/* ── 过期模块提示 ── */

const timedOut = await __test
  .withHint(async () => {
    throw new Error('CDP Page.enable timed out after 30000ms')
  })({}, {})
  .then(() => 'no-throw')
  .catch((error) => error.message)
check('超时错误附带过期模块提示', typeof timedOut === 'string' && timedOut.includes('提示：') && timedOut.includes('timed out'))

const unrelated = await __test
  .withHint(async () => {
    throw new Error('找不到标签页 abc')
  })({}, {})
  .then(() => 'no-throw')
  .catch((error) => error.message)
check('普通错误不被改写', unrelated === '找不到标签页 abc', unrelated)

const ok = await __test.withHint(async () => ({ value: 1 }))({}, {})
check('正常返回值原样透传', ok?.value === 1)

/* ── 汇总 ── */

const failed = results.filter((entry) => entry.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} checks passed   (插件构建 ${__test.PLUGIN_BUILD})`)
if (failed.length > 0) {
  console.log('failed:')
  for (const entry of failed) console.log(`  - ${entry.label}${entry.detail ? ` (${entry.detail})` : ''}`)
  process.exitCode = 1
}
