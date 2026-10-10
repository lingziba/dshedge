/**
 * 入口（构建 1.0.3）。
 *
 * 为什么入口要按构建号换文件名：DSH 的 Loader 以模块身份缓存插件模块，
 * 同一个 specifier 不会因为文件内容变了就重新 import。于是"不重启换代码"的做法是
 * 让行名指向一个新文件：本文件用带 `?b=` 的 import 载入实现，
 * 使 plugin.js / cdp.js / ws.js 也一起获得新的模块身份。
 *
 * 改实现后的热重载步骤：
 *   1) 改 lib/*.js，并把里面的 `?b=` 与新文件名一起升到新构建号；
 *   2) 本文件改名为 entry-<新构建号>.js，内容里的 `?b=` 同步；
 *   3) cordis.patch.yml 的行名改成 './lib/entry-<新构建号>.js'，PLUGIN_BUILD 同步；
 *   4) plugin_manager：set_bundle 关一次再开一次。
 */

export * from './plugin.js?b=1.0.3'
