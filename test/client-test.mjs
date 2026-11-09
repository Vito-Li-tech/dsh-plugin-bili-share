// 客户端半的接口自测：模拟 __ModuleLoader__ / require('react') / DSH 服务，
// 验证 apply 注册了主面板、侧栏入口和 /bili 命令，且命令能读剪贴板并打开面板。
// 运行：node test/client-test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded = module
    },
  },
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}

const styleNodes = []
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: {
    appendChild: (node) => styleNodes.push(node),
  },
}

globalThis.document = fakeDocument

const require = (id) => {
  if (id === 'react') return fakeReact
  throw new Error(`unexpected require: ${id}`)
}

await import(pathToFileURL(path.resolve(import.meta.dirname, '../lib/client.js')).href)
assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-plugin-bili-share')
assert.equal(typeof loaded.factory, 'function')

// 工厂执行不应抛错
const plugin = loaded.factory(require)
assert.ok(plugin, 'factory 必须返回插件对象')
assert.deepEqual(plugin.inject, ['slots', 'layout', 'commandUi'])

const slots = []
let command = null
let selectedPanel = ''
let clipboard = '看这个：https://www.bilibili.com/video/BV1GJ411x7h7 超好听'

const ctx = {
  slots: {
    inject(name, fn) {
      fn()
    },
    register(options, render) {
      slots.push({ options, render })
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
  commandUi: {
    decorate(decoration) {
      command = decoration
      return () => {}
    },
  },
  layout: {
    selectPanel(id) {
      selectedPanel = id
    },
  },
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      readText: async () => clipboard,
    },
  },
})

plugin.apply(ctx)

const main = slots.find((entry) => entry.options.name === 'main')
assert.ok(main, '必须注册 main 面板')
assert.equal(main.options.key, 'bili-share')

const sidebar = slots.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(sidebar, '必须注册侧栏入口')
assert.equal(sidebar.options.id, 'bili-share')
assert.equal(sidebar.options.order, 13)
assert.equal(sidebar.options.label(), 'B站分享')

// 图标 render 不抛错
const icon = sidebar.render({ size: 18 })
assert.equal(typeof icon.type, 'function')
const svg = icon.type(icon.props)
assert.equal(svg.type, 'svg')
assert.equal(svg.props.width, 18)

assert.ok(command, '必须注册 /bili 装饰')
assert.equal(command.name, 'bili')
assert.equal(command.ui.kind, 'action')
assert.equal(command.available(), true)

await command.ui.run({})
assert.equal(selectedPanel, 'bili-share', '/bili 应该打开 bili-share 面板')

// 剪贴板里没有 B 站链接时也要能打开面板
clipboard = 'hello world'
selectedPanel = ''
await command.ui.run({})
assert.equal(selectedPanel, 'bili-share')

assert.equal(styleNodes.length, 1, '样式只注入一次')
assert.match(styleNodes[0].textContent, /\.dsh-bili/)

console.log('PASS: client 半注册了 main 面板、侧栏入口、/bili 命令，并能打开面板')
