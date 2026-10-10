/**
 * 入口（构建 1.0.4）。
 *
 * 为什么入口要按构建号换文件名：DSH 的 Loader 以模块身份缓存插件模块，
 * 同一个 specifier 不会因为文件内容变了就重新 import。于是"不重启换代码"的做法是
 * 让行名指向一个新文件：本文件用带 `?b=` 的 import 载入实现，
 * 使 plugin.js / cdp.js / ws.js 也一起获得新的模块身份。
 *
 * 改实现后的热重载步骤（`node test/build-check.mjs` 会替你校验这几处是否对齐）：
 *   1) 改 lib/*.js，把里面的 `?b=` 升到新构建号，并同步 PLUGIN_BUILD 与 package.json version
 *   2) 新入口文件 lib/entry-<新构建号>.js（本文件改名），内容里的 `?b=` 同步
 *   3) cordis.patch.yml 的行名改成 './lib/entry-<新构建号>.js'
 *   4) plugin_manager：set_bundle 关一次再开一次
 */

export * from './plugin.js?b=1.0.4'
