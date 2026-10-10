// 1.0.3 入口与依赖身份自检
const base = 'file:///D:/ai/dshwork/%E8%A7%86%E9%A2%91/dsh-edge-browser/lib'
const entry = await import(`${base}/entry-1.0.3.js`)
console.log('entry exports:', Object.keys(entry).join(', '))
console.log('entry build  :', entry.__test.PLUGIN_BUILD)

const ws = await import(`${base}/ws.js?b=1.0.3`)
const ctorSource = ws.WebSocketClient.prototype.constructor.toString()
console.log('ws 修复在位  :', ctorSource.includes("on('message'"))
console.log('ws dispatch  :', typeof ws.WebSocketClient.prototype.dispatch === 'function')

const cdp = await import(`${base}/cdp.js?b=1.0.3`)
console.log('cdp exports  :', Object.keys(cdp).length)

// 入口 -> plugin.js -> cdp.js -> ws.js 都应拿到 1.0.3 身份
const graphEntry = await import(`${base}/plugin.js?b=1.0.3`)
console.log('plugin build :', graphEntry.__test.PLUGIN_BUILD)
