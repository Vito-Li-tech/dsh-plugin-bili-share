// 离线自测：不联网、不依赖 DSH，mock 掉 globalThis.fetch。
// 运行：node test/self-test.mjs
import assert from 'node:assert/strict'
import {
  buildShortLink,
  isShortLink,
  normalizeCoverUrl,
  normalizeInputUrl,
  parseVideoRef,
  renderShareResult,
  shareBiliVideo,
} from '../lib/bili.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL  ${name}\n      ${error?.stack || error}`)
  }
}

function jsonResponse(body, { status = 200, url = '' } = {}) {
  return {
    status,
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  }
}

function redirectResponse(location, status = 302) {
  return {
    status,
    url: '',
    headers: new Headers({ location }),
    text: async () => '',
  }
}

function htmlResponse(body, { status = 200, url = '' } = {}) {
  return {
    status,
    url,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => body,
  }
}

const API_RE = /^https:\/\/api\.bilibili\.com\/x\/web-interface\/view\?/
const SAMPLE_BV = 'BV1GJ411x7h7'
const SAMPLE_AID = 80433022
const SAMPLE_PIC = 'http://i1.hdslb.com/bfs/archive/5242750857121e05146d5d5b13a47a2a6dd36e98.jpg'

function apiPayload(overrides = {}) {
  return {
    code: 0,
    message: 'OK',
    data: {
      bvid: SAMPLE_BV,
      aid: SAMPLE_AID,
      title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
      pic: SAMPLE_PIC,
      ...overrides,
    },
  }
}

const originalFetch = globalThis.fetch

console.log('parseVideoRef / URL 解析')
await test('识别普通视频长链接', () => {
  assert.deepEqual(parseVideoRef(`https://www.bilibili.com/video/${SAMPLE_BV}/?spm_id_from=333`), { bvid: SAMPLE_BV })
})
await test('识别手机版链接', () => {
  assert.deepEqual(parseVideoRef(`https://m.bilibili.com/video/${SAMPLE_BV}`), { bvid: SAMPLE_BV })
})
await test('识别 av 号', () => {
  assert.deepEqual(parseVideoRef(`https://www.bilibili.com/video/av${SAMPLE_AID}?p=2`), { aid: SAMPLE_AID })
})
await test('裸 BV 号也能识别', () => {
  assert.deepEqual(parseVideoRef(`  ${SAMPLE_BV}  `), { bvid: SAMPLE_BV })
})
await test('小写 bv 前缀会规范成 BV', () => {
  assert.deepEqual(parseVideoRef('bv1GJ411x7h7'), { bvid: SAMPLE_BV })
})
await test('普通外链不会被误判成 av', () => {
  assert.equal(parseVideoRef('https://example.com/nav123'), null)
})
await test('非 B 站链接返回 null', () => {
  assert.equal(parseVideoRef('https://example.com/hello'), null)
})
await test('normalizeInputUrl 补协议', () => {
  assert.equal(normalizeInputUrl('b23.tv/abc'), 'https://b23.tv/abc')
  assert.equal(normalizeInputUrl('//b23.tv/abc'), 'https://b23.tv/abc')
  assert.equal(normalizeInputUrl('https://b23.tv/abc'), 'https://b23.tv/abc')
})
await test('isShortLink 判断短链域名', () => {
  assert.equal(isShortLink('https://b23.tv/abc1234'), true)
  assert.equal(isShortLink('https://www.bilibili.com/video/BV1xx411c7mD'), false)
})

console.log('短链 / 封面规整')
await test('buildShortLink 用 BV 号', () => {
  assert.equal(buildShortLink({ bvid: SAMPLE_BV }), `https://b23.tv/${SAMPLE_BV}`)
})
await test('buildShortLink 用 av 号', () => {
  assert.equal(buildShortLink({ aid: SAMPLE_AID }), `https://b23.tv/av${SAMPLE_AID}`)
})
await test('buildShortLink 去掉末尾斜杠', () => {
  assert.equal(buildShortLink({ bvid: SAMPLE_BV }, 'https://b23.tv/'), `https://b23.tv/${SAMPLE_BV}`)
})
await test('封面 http 升级为 https', () => {
  assert.equal(normalizeCoverUrl(SAMPLE_PIC), SAMPLE_PIC.replace('http://', 'https://'))
})
await test('封面协议相对地址补 https', () => {
  assert.equal(normalizeCoverUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg')
})
await test('封面 https 保持不变', () => {
  const https = SAMPLE_PIC.replace('http://', 'https://')
  assert.equal(normalizeCoverUrl(https), https)
})

console.log('shareBiliVideo 主流程')
await test('长链接 → 短链 + https 封面 + 标题', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers })
    assert.match(String(url), API_RE)
    assert.match(String(url), /bvid=BV1GJ411x7h7/)
    assert.equal(init.headers.referer, 'https://www.bilibili.com/')
    return jsonResponse(apiPayload())
  }
  const result = await shareBiliVideo(`https://www.bilibili.com/video/${SAMPLE_BV}?spm_id_from=333`, {
    apiTimeout: 500,
    resolveTimeout: 500,
  })
  assert.equal(calls.length, 1)
  assert.equal(result.ok, true)
  assert.equal(result.shortLink, `https://b23.tv/${SAMPLE_BV}`)
  assert.equal(result.coverUrl, SAMPLE_PIC.replace('http://', 'https://'))
  assert.match(result.title, /Never Gonna Give You Up/)
  assert.equal(result.bvid, SAMPLE_BV)
  assert.equal(result.aid, SAMPLE_AID)
  assert.equal(result.error, undefined)
})

await test('av 输入 → 接口返回 BV 后短链用 BV', async () => {
  globalThis.fetch = async () => jsonResponse(apiPayload())
  const result = await shareBiliVideo(`https://www.bilibili.com/video/av${SAMPLE_AID}`, {
    apiTimeout: 500,
    resolveTimeout: 500,
  })
  assert.equal(result.ok, true)
  assert.equal(result.shortLink, `https://b23.tv/${SAMPLE_BV}`)
  assert.equal(result.bvid, SAMPLE_BV)
})

await test('b23.tv 短链 → 跟随 302 还原长链', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    seen.push({ url: text, redirect: init?.redirect })
    if (text.startsWith('https://b23.tv/abc1234')) {
      return redirectResponse(`https://www.bilibili.com/video/${SAMPLE_BV}?share_source=copy_web`)
    }
    if (API_RE.test(text)) return jsonResponse(apiPayload())
    throw new Error(`unexpected request: ${text}`)
  }
  const result = await shareBiliVideo('https://b23.tv/abc1234', { apiTimeout: 500, resolveTimeout: 500 })
  assert.equal(seen[0].redirect, 'manual')
  assert.equal(result.ok, true)
  assert.equal(result.shortLink, `https://b23.tv/${SAMPLE_BV}`)
  assert.equal(result.resolvedUrl, `https://www.bilibili.com/video/${SAMPLE_BV}?share_source=copy_web`)
})

await test('b23.tv 短链 → 无 Location 时从最终 URL 兜底识别', async () => {
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.startsWith('https://b23.tv/xyz')) return htmlResponse('<html>middle page</html>', { url: 'https://www.bilibili.com/video/BV1xx411c7mD' })
    if (API_RE.test(text)) return jsonResponse(apiPayload({ bvid: 'BV1xx411c7mD' }))
    throw new Error(`unexpected request: ${text}`)
  }
  const result = await shareBiliVideo('https://b23.tv/xyz', { apiTimeout: 500, resolveTimeout: 500 })
  assert.equal(result.ok, true)
  assert.equal(result.shortLink, 'https://b23.tv/BV1xx411c7mD')
})

await test('b23.tv 短链 → 从 HTML 正文兜底识别', async () => {
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.startsWith('https://b23.tv/xyz')) {
      return htmlResponse(`<meta http-equiv="refresh" content="0;url=https://www.bilibili.com/video/${SAMPLE_BV}">`)
    }
    if (API_RE.test(text)) return jsonResponse(apiPayload())
    throw new Error(`unexpected request: ${text}`)
  }
  const result = await shareBiliVideo('https://b23.tv/xyz', { apiTimeout: 500, resolveTimeout: 500 })
  assert.equal(result.ok, true)
  assert.equal(result.shortLink, `https://b23.tv/${SAMPLE_BV}`)
})

console.log('降级 / 错误路径')
await test('无法识别 BV/av → ok:false，原样返回输入 URL', async () => {
  const input = 'https://example.com/hello'
  const result = await shareBiliVideo(input, { apiTimeout: 500, resolveTimeout: 500 })
  assert.equal(result.ok, false)
  assert.equal(result.shortLink, input)
  assert.match(result.error, /无法从链接中识别 BV 号或 av 号/)
})

await test('B 站接口 code !== 0 → ok:false，但仍给出短链', async () => {
  globalThis.fetch = async () => jsonResponse({ code: 62002, message: '稿件不可见' })
  const result = await shareBiliVideo(`https://www.bilibili.com/video/${SAMPLE_BV}`, { apiTimeout: 500, resolveTimeout: 500 })
  assert.equal(result.ok, false)
  assert.equal(result.shortLink, `https://b23.tv/${SAMPLE_BV}`)
  assert.match(result.error, /code=62002/)
  assert.match(result.error, /稿件不可见/)
})

await test('接口网络失败 → ok:false，不抛异常', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  const result = await shareBiliVideo(`https://www.bilibili.com/video/${SAMPLE_BV}`, { apiTimeout: 500, resolveTimeout: 500 })
  assert.equal(result.ok, false)
  assert.match(result.error, /获取视频信息失败：网络请求失败/)
})

await test('接口超时 → ok:false，error 带超时信息', async () => {
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  const result = await shareBiliVideo(`https://www.bilibili.com/video/${SAMPLE_BV}`, { apiTimeout: 20, resolveTimeout: 20 })
  assert.equal(result.ok, false)
  assert.match(result.error, /请求超时/)
})

await test('调用方取消 → 抛 AbortError（交给 DSH 记为取消）', async () => {
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason)
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    shareBiliVideo(`https://www.bilibili.com/video/${SAMPLE_BV}`, { apiTimeout: 500, resolveTimeout: 500 }, controller.signal),
    (error) => error.name === 'AbortError',
  )
})

console.log('renderShareResult')
await test('成功结果包含短链、封面和 Markdown 图片', () => {
  const text = renderShareResult({
    ok: true,
    shortLink: `https://b23.tv/${SAMPLE_BV}`,
    coverUrl: SAMPLE_PIC.replace('http://', 'https://'),
    title: '标题',
  })
  assert.match(text, /b23 短链：https:\/\/b23\.tv\/BV1GJ411x7h7/)
  assert.match(text, /!\[封面\]\(https:\/\/i1\.hdslb\.com/)
  assert.match(text, /标题：标题/)
})
await test('失败结果包含错误与备用链接', () => {
  const text = renderShareResult({ ok: false, shortLink: 'https://example.com/x', coverUrl: '', title: '', error: '解析失败' })
  assert.match(text, /未能完整生成 b23 短链：解析失败/)
  assert.match(text, /备用链接：https:\/\/example\.com\/x/)
})

globalThis.fetch = originalFetch
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
