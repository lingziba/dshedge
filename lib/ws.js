/**
 * 最小 WebSocket 客户端（RFC 6455），只用 node:net / node:crypto。
 *
 * 为什么不用全局 WebSocket：插件跑在 Electron 宿主进程里，运行时的全局对象
 * 随版本变化；CDP 只连 127.0.0.1，手写客户端比依赖宿主全局更可控。
 *
 * 只实现 CDP 需要的部分：文本帧、掩码（客户端必须）、126/127 长度、
 * 分片续帧、ping/pong、close。
 */

import crypto from 'node:crypto'
import net from 'node:net'
import { EventEmitter } from 'node:events'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 128 * 1024 * 1024

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

export class WebSocketClient extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.fragmentOpcode = OP_TEXT
    this.handshake = false
    this.closed = false
    this.closeError = undefined
    this.pending = new Map()
    this.nextId = 0
    // 收到的文本帧：有 id 的当响应派发给等待者，其余当事件广播。
    this.on('message', (raw) => this.dispatch(raw))
  }

  /** 把一条 CDP 响应交给对应的 pending 请求。 */
  dispatch(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      this.emit('invalid', raw)
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error !== undefined && message.error !== null) {
        const detail = message.error.message ?? JSON.stringify(message.error)
        const error = new Error(`${entry.method} failed: ${detail}`)
        error.cdpError = message.error
        entry.reject(error)
        return
      }
      entry.resolve(message.result ?? {})
      return
    }
    if (typeof message.method === 'string') this.emit('event', message)
  }

  /** 建立连接并完成 HTTP Upgrade 握手。 */
  static connect(rawUrl, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000
    return new Promise((resolve, reject) => {
      let target
      try {
        target = new URL(rawUrl)
      } catch {
        reject(new Error(`Invalid WebSocket URL: ${rawUrl}`))
        return
      }
      if (target.protocol !== 'ws:') {
        reject(new Error(`Only ws:// WebSocket URLs are supported, got ${target.protocol}`))
        return
      }
      const host = target.hostname || '127.0.0.1'
      const port = Number(target.port || 80)
      const path = `${target.pathname || '/'}${target.search || ''}`
      const key = crypto.randomBytes(16).toString('base64')
      const expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')

      const socket = net.connect({ host, port })
      const client = new WebSocketClient(socket)
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new Error(`WebSocket handshake with ${rawUrl} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const fail = (error) => {
        if (settled) {
          client.finish(error)
          return
        }
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }

      socket.once('error', fail)
      socket.on('close', () => {
        client.finish(client.closeError ?? new Error('WebSocket closed'))
      })
      socket.on('data', (chunk) => {
        client.buffer = Buffer.concat([client.buffer, chunk])
        if (!client.handshake) {
          const end = client.buffer.indexOf('\r\n\r\n')
          if (end === -1) return
          const head = client.buffer.subarray(0, end).toString('latin1')
          client.buffer = client.buffer.subarray(end + 4)
          const statusLine = head.split('\r\n')[0] ?? ''
          if (!/ 101\b/.test(statusLine)) {
            fail(new Error(`WebSocket upgrade rejected: ${statusLine}`))
            return
          }
          const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
          if (accept !== expectedAccept) {
            fail(new Error('WebSocket upgrade returned an unexpected Sec-WebSocket-Accept'))
            return
          }
          client.handshake = true
          settled = true
          clearTimeout(timer)
          socket.off('error', fail)
          socket.on('error', (error) => client.finish(error))
          resolve(client)
        }
        client.drain()
      })
      socket.on('connect', () => {
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${host}:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        )
      })
    })
  }

  /** 发送一个文本帧。 */
  sendText(text) {
    this.sendFrame(OP_TEXT, Buffer.from(text, 'utf8'))
  }

  sendFrame(opcode, payload) {
    if (this.closed) throw new Error('WebSocket is closed')
    const mask = crypto.randomBytes(4)
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.allocUnsafe(2)
      header[1] = 0x80 | length
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.allocUnsafe(10)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode
    const masked = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }

  /** JSON-RPC 风格请求：按 id 匹配响应。 */
  request(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000
    const signal = options.signal
    if (this.closed) return Promise.reject(this.closeError ?? new Error('WebSocket is closed'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'))
    const id = (this.nextId = (this.nextId ?? 0) + 1)
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending?.delete(id)
        reject(signal.reason ?? new Error('Aborted'))
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending?.delete(id)
          signal?.removeEventListener('abort', onAbort)
          reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        : undefined
      this.pending ??= new Map()
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.sendText(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      this.sendFrame(OP_CLOSE, payload)
    } catch {
      // ignore: closing anyway
    }
    this.socket.end()
  }

  destroy() {
    this.finish(new Error('WebSocket destroyed'))
    this.socket.destroy()
  }

  finish(error) {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    const pending = this.pending ?? new Map()
    this.pending = new Map()
    for (const entry of pending.values()) entry.reject(error)
    this.emit('close', error)
  }

  drain() {
    for (;;) {
      const buffer = this.buffer
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < offset + 2) return
        length = buffer.readUInt16BE(offset)
        offset += 2
      } else if (length === 127) {
        if (buffer.length < offset + 8) return
        const big = buffer.readBigUInt64BE(offset)
        if (big > BigInt(MAX_PAYLOAD)) {
          this.finish(new Error('WebSocket frame exceeds the supported size'))
          this.socket.destroy()
          return
        }
        length = Number(big)
        offset += 8
      }
      let mask
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (masked && mask !== undefined) {
        for (let i = 0; i < length; i += 1) payload[i] ^= mask[i & 3]
      }
      this.buffer = buffer.subarray(offset + length)
      this.handleFrame(fin, opcode, payload)
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this.sendFrame(OP_PONG, payload)
      return
    }
    if (opcode === OP_PONG) return
    if (opcode === OP_CLOSE) {
      this.closeError = new Error('WebSocket closed by peer')
      this.socket.end()
      return
    }
    if (opcode === OP_CONT) {
      this.fragments.push(payload)
    } else {
      this.fragments = [payload]
      this.fragmentOpcode = opcode
    }
    if (!fin) return
    const full = Buffer.concat(this.fragments)
    this.fragments = []
    if (this.fragmentOpcode === OP_TEXT) this.emit('message', full.toString('utf8'))
    else this.emit('binary', full)
  }
}
