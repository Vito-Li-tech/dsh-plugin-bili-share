// dsh-plugin-bili-share — host half.
//
// 1) 注册 `bili_short_link_with_cover` 工具（给 Agent 用）
// 2) 注册 loopback API `/bili-share/api`（给浏览器面板用）：
//      GET /resolve?url=...  → 短链 + 封面 + 标题
//      GET /image?url=...    → 封面字节代理（解决 CORS / 防盗链）
//
// 插件形态：export const name / inject / Config / apply
// （不要用 default export，Loader 会丢失 inject —— DSH postmortem 0001）

import { DEFAULTS, renderShareResult, shareBiliVideo } from './bili.js'

export const name = 'dsh-plugin-bili-share'
export const inject = ['tools']

const TOOL_NAME = 'bili_short_link_with_cover'
const TIMEOUT_MS = 25_000
const API_PREFIX = '/bili-share/api'
const IMAGE_MAX_BYTES = 8 * 1024 * 1024

// schemastery 解析不到时（插件 link: 到 profile 外）Config 退化为无 schema，
// 配置仍可通过 cordis.patch.yml 的 config 传入，apply 里会兜底合并默认值。
let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = undefined
}

export const Config = z
  ? z.object({
      apiBase: z
        .string()
        .default(DEFAULTS.apiBase)
        .description('B 站 API 根地址（一般不用改）'),
      shortLinkBase: z
        .string()
        .default(DEFAULTS.shortLinkBase)
        .description('短链前缀，默认 https://b23.tv'),
      apiTimeout: z
        .number()
        .default(DEFAULTS.apiTimeout)
        .description('视频详情接口超时（毫秒）'),
      resolveTimeout: z
        .number()
        .default(DEFAULTS.resolveTimeout)
        .description('b23.tv 短链解析超时（毫秒）'),
      userAgent: z
        .string()
        .default(DEFAULTS.userAgent)
        .description('请求 B 站时使用的 User-Agent'),
    })
  : undefined

// 输出结构：Agent 可稳定解析；失败时同样有完整字段，不抛异常。
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: {
      type: 'boolean',
      description: '是否同时拿到了短链和封面（false 时看 error）',
    },
    shortLink: {
      type: 'string',
      description: 'b23.tv 短链；解析失败时原样返回输入 URL 作为备用',
    },
    coverUrl: {
      type: 'string',
      description: '封面直链（已统一为 https）；取不到时为空字符串',
    },
    title: {
      type: 'string',
      description: '视频标题；取不到时为空字符串',
    },
    bvid: { type: 'string', description: 'BV 号（能识别时）' },
    aid: { type: 'integer', description: 'av 号（能识别时）' },
    resolvedUrl: { type: 'string', description: '短链还原后的长链接' },
    error: { type: 'string', description: '失败原因' },
    warning: { type: 'string', description: '非致命提示' },
  },
}

const DESCRIPTION =
  '把 Bilibili（B 站）视频链接转换成 b23.tv 短链，并取回视频封面直链和标题。' +
  '输入支持 bilibili.com 长链接、b23.tv 短链（会自动跟随重定向还原）、BV 号或 av 号。' +
  '返回 shortLink（https://b23.tv/<BV号>）、coverUrl（封面，已升级为 https）、title；' +
  '解析失败或接口报错时返回 ok:false 与 error，不会中断会话。' +
  '当用户要求“把这个 B 站链接变成短链 / 要这个视频的封面 / 分享这个视频”时使用。'

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }

  ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Bilibili 视频网页链接，例如 https://www.bilibili.com/video/BV1xx411c7mD；也接受 b23.tv 短链、手机版链接，或直接给 BV 号 / av 号',
        },
      },
      required: ['url'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: renderShareResult(value) }]
      },
    },
    timeoutMs: TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return shareBiliVideo(args?.url, settings, exec?.signal)
    },
  })

  // /bili 面板用的本地接口。仅 loopback 可访问。
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(
      () =>
        sctx.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => {
            void handleApi(req, res, settings)
          },
        }),
      'bili-share: share api',
    )
  })

  // 宿主斜杠命令 /bili <链接>：不经过模型，直接返回结果。
  // 裸调用 /bili 时由 client 半的 decoration 接管（读剪贴板并打开面板）。
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(
      () =>
        cctx.commands.register({
          name: 'bili',
          description: 'B站链接转 b23 短链和封面',
          input: { hint: '<B站链接 / BV 号>' },
          async handler({ rawInput, signal }) {
            const target = String(rawInput || '').trim()
            if (target === '') return { kind: 'error', text: '用法：/bili <B站链接或BV号>' }
            const result = await shareBiliVideo(target, settings, signal)
            if (result.ok !== true) return { kind: 'error', text: result.error || '解析失败' }
            return {
              kind: 'success',
              text: [result.title, result.shortLink, result.coverUrl].filter(Boolean).join('\n'),
            }
          },
        }),
      'bili-share: /bili command',
    )
  })
}

// ---------------------------------------------------------------- HTTP API

async function handleApi(req, res, settings) {
  if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback access only' })
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'method not allowed' })
  }

  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
  let path = requestUrl.pathname
  if (path === API_PREFIX) path = '/'
  else if (path.startsWith(`${API_PREFIX}/`)) path = path.slice(API_PREFIX.length)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), 20_000)
  const onClose = () => controller.abort(new Error('连接已关闭'))
  res.on('close', onClose)

  try {
    if (path === '/resolve') {
      const target = (requestUrl.searchParams.get('url') || '').trim()
      if (target === '') return sendJson(res, 400, { ok: false, error: '缺少 url 参数' })
      const result = await shareBiliVideo(target, settings, controller.signal)
      return sendJson(res, 200, result)
    }

    if (path === '/image') {
      const target = (requestUrl.searchParams.get('url') || '').trim()
      if (target === '') return sendJson(res, 400, { ok: false, error: '缺少 url 参数' })
      const image = await proxyImage(target, settings, controller.signal)
      res.writeHead(200, {
        'content-type': image.type,
        'content-length': image.body.length,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      })
      res.end(image.body)
      return
    }

    return sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    return sendJson(res, 502, { ok: false, error: messageOf(error) })
  } finally {
    clearTimeout(timer)
    res.off('close', onClose)
  }
}

/** 只代理 B 站图床，避免变成任意 URL 代理（SSRF）。 */
async function proxyImage(rawUrl, settings, signal) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('封面地址不合法')
  }
  if (url.protocol !== 'https:' || !isBiliImageHost(url.hostname)) {
    throw new Error('只允许代理 B 站图床的 https 地址')
  }

  const res = await fetch(url.href, {
    headers: {
      'user-agent': settings.userAgent,
      referer: 'https://www.bilibili.com/',
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    redirect: 'follow',
    signal,
  })
  if (!res.ok) throw new Error(`封面下载失败（HTTP ${res.status}）`)

  // 跟随重定向后再校验一次最终地址，防止跳去内网。
  let finalUrl
  try {
    finalUrl = new URL(res.url)
  } catch {
    finalUrl = url
  }
  if (finalUrl.protocol !== 'https:' || !isBiliImageHost(finalUrl.hostname)) {
    throw new Error('封面重定向到了不受支持的地址')
  }

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!type.startsWith('image/')) throw new Error('返回内容不是图片')

  const body = Buffer.from(await res.arrayBuffer())
  if (body.length === 0) throw new Error('封面内容为空')
  if (body.length > IMAGE_MAX_BYTES) throw new Error('封面图片过大')
  return { type, body }
}

function isBiliImageHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'hdslb.com' || host.endsWith('.hdslb.com') || host === 'bilibili.com' || host.endsWith('.bilibili.com')
}

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
