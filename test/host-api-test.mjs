// host 半的 API 自测：伪造 ctx.webServer + req/res，验证 /resolve、/image、SSRF 拦截。
// 运行：node test/host-api-test.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../lib/index.js'

let registered = null
let hostCommand = null
let tools = []
let fakeConnection

const ctx = {
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
  inject(deps, callback) {
    const effect = (fn) => fn()
    if (deps[0] === 'webServer') {
      callback({
        effect,
        get(name) {
          return name === 'connection' ? fakeConnection : undefined
        },
        webServer: {
          register(options) {
            registered = options
            return () => {}
          },
        },
      })
      return
    }
    if (deps[0] === 'commands') {
      callback({
        effect,
        commands: {
          register(definition) {
            hostCommand = definition
            return () => {}
          },
        },
      })
      return
    }
    throw new Error(`unexpected inject: ${deps.join(',')}`)
  },
}

apply(ctx, {})

assert.equal(tools.length, 1, '必须注册工具')
assert.equal(tools[0].name, 'bili_short_link_with_cover')
assert.ok(registered, '必须注册 webServer 路由')
assert.equal(registered.kind, 'prefix')
assert.equal(registered.path, '/bili-share/api')

assert.ok(hostCommand, '必须注册 /bili 宿主命令')
assert.equal(hostCommand.name, 'bili')
assert.equal(hostCommand.input.hint, '<B站链接 / BV 号>')

function makeRes() {
  const emitter = new EventEmitter()
  const res = {
    headersSent: false,
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body
      emitter.emit('finish')
    },
    destroy() {
      emitter.emit('finish')
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
  }
  return res
}

function call(pathname, { remoteAddress = '127.0.0.1', method = 'GET' } = {}) {
  const res = makeRes()
  const req = { method, url: pathname, socket: { remoteAddress } }
  const done = new Promise((resolve) => res.once('finish', resolve))
  registered.handler(req, res)
  return done.then(() => res)
}

// 1) 非 loopback 拒绝
{
  const res = await call('/bili-share/api/resolve?url=BV1GJ411x7h7', { remoteAddress: '10.0.0.7' })
  assert.equal(res.status, 403)
  assert.match(JSON.parse(res.body).error, /loopback/)
}

// 2) 缺参数
{
  const res = await call('/bili-share/api/resolve')
  assert.equal(res.status, 400)
}

// 3) 正常 resolve（真实 B 站接口）
{
  const res = await call('/bili-share/api/resolve?url=https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1GJ411x7h7')
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.shortLink, 'https://b23.tv/BV1GJ411x7h7')
  assert.match(data.coverUrl, /^https:\/\/i\d\.hdslb\.com\//)
  assert.match(data.title, /Never Gonna Give You Up/)
}

// 4) 图片代理：只允许 B 站图床
{
  const res = await call('/bili-share/api/image?url=https%3A%2F%2Fexample.com%2Fx.jpg')
  assert.equal(res.status, 502)
  assert.match(JSON.parse(res.body).error, /B 站图床/)
}

// 5) 图片代理：mock 图床返回
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://i0.hdslb.com/bfs/archive/a.jpg',
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  })
  const res = await call('/bili-share/api/image?url=https%3A%2F%2Fi0.hdslb.com%2Fbfs%2Farchive%2Fa.jpg')
  globalThis.fetch = originalFetch
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/jpeg')
  assert.equal(res.body.length, 4)
}

// 6) 未知路径
{
  const res = await call('/bili-share/api/nope')
  assert.equal(res.status, 404)
}

// 7) 宿主信任栅栏：拒绝码透传、异常 fail-closed、放行不拦截
{
  fakeConnection = { requestRejection: () => 403 }
  let res = await call('/bili-share/api/resolve?url=BV1GJ411x7h7')
  assert.equal(res.status, 403)
  assert.match(JSON.parse(res.body).error, /host trust fence/)

  fakeConnection = { requestRejection: () => 401 }
  res = await call('/bili-share/api/resolve?url=BV1GJ411x7h7')
  assert.equal(res.status, 401)

  fakeConnection = {
    requestRejection() {
      throw new Error('gate exploded')
    },
  }
  res = await call('/bili-share/api/resolve?url=BV1GJ411x7h7')
  assert.equal(res.status, 403)

  fakeConnection = { requestRejection: () => undefined }
  res = await call('/bili-share/api/resolve?url=BV1GJ411x7h7')
  assert.equal(res.status, 200)

  fakeConnection = undefined
}

// 8) /bili 宿主命令：直接返回结果文本
{
  const ok = await hostCommand.handler({ rawInput: 'BV1GJ411x7h7' })
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /b23\.tv\/BV1GJ411x7h7/)
  assert.match(ok.text, /Never Gonna Give You Up/)

  const empty = await hostCommand.handler({ rawInput: '' })
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /用法/)
}

console.log('PASS: host API 路由、信任栅栏、/bili 命令、SSRF 拦截、图片代理均正常')
