// dsh-plugin-bili-share — 核心逻辑（不依赖 DSH，可独立测试）
//
// 把 Bilibili 视频链接变成：
//   1) b23.tv 短链（官方稳定格式：https://b23.tv/<BV号>）
//   2) 视频封面直链（来自 api.bilibili.com 的 data.pic）
//
// 关键约束（来自需求）：
//   - 不调用 api.biliapi.net/x/share/click（需要 App 专用参数，且基本失效）
//   - 不引入第三方 SDK，只用原生 fetch + 正则
//   - 封面 http:// 统一升级为 https://
//   - 任何预期内的失败（无法解析、接口报错、超时）都返回结构化结果，不抛未处理异常

const BVID_RE = /([Bb][Vv])([0-9A-Za-z]{10})(?![0-9A-Za-z])/
const AID_RE = /(?:^|[/=?&])[aA][vV](\d+)/
const SHORT_HOSTS = new Set([
  'b23.tv',
  'www.b23.tv',
  'bili2233.cn',
  'www.bili2233.cn',
  'bili22.cn',
])

const API_VIEW_PATH = '/x/web-interface/view'

// B 站接口常见错误码的人话解释（只覆盖高频的几个，其余原样透出）
const API_CODE_HINTS = {
  '-400': '请求参数错误',
  '-403': '没有访问权限',
  '-404': '视频不存在或已被删除',
  '-412': '请求被 B 站风控拦截，请稍后重试',
  '-352': '请求被 B 站风控拦截，请稍后重试',
  62002: '稿件不可见（可能已删除或设为私密）',
  62004: '稿件审核中',
  62012: '仅 UP 主自己可见',
}

export const DEFAULTS = Object.freeze({
  apiBase: 'https://api.bilibili.com',
  shortLinkBase: 'https://b23.tv',
  apiTimeout: 8000,
  resolveTimeout: 8000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
})

/** 补全协议：裸域名/短码加 https://，协议相对地址补 https: */
export function normalizeInputUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  if (text.startsWith('//')) return `https:${text}`
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return text
  return `https://${text}`
}

/** 从任意文本里识别 BV 号或 av 号；识别不了返回 null */
export function parseVideoRef(input) {
  const text = String(input ?? '')
  const bv = text.match(BVID_RE)
  if (bv) return { bvid: `BV${bv[2]}` }
  const av = text.match(AID_RE)
  if (av) return { aid: Number(av[1]) }
  return null
}

/** 是否是 b23.tv 一类的短链域名 */
export function isShortLink(input) {
  try {
    return SHORT_HOSTS.has(new URL(normalizeInputUrl(input)).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** 短链：https://b23.tv/BVxxxx（av 输入则为 https://b23.tv/av123） */
export function buildShortLink(ref, base = DEFAULTS.shortLinkBase) {
  if (!ref) return ''
  const id = ref.bvid || (ref.aid ? `av${ref.aid}` : '')
  if (!id) return ''
  return `${String(base).replace(/\/+$/, '')}/${id}`
}

/** 封面地址统一为 https，兼容协议相对地址 */
export function normalizeCoverUrl(pic) {
  const text = String(pic ?? '').trim()
  if (text === '') return ''
  if (text.startsWith('//')) return `https:${text}`
  if (/^http:\/\//i.test(text)) return `https://${text.slice('http://'.length)}`
  return text
}

/**
 * 解析 b23.tv 短链。
 * 先手动跟一次 302 读 Location；拿不到再跟随重定向读最终 URL；最后兜底扫 HTML 里的 BV 号。
 * @returns {Promise<{url: string, ref: {bvid?: string, aid?: number}} | null>}
 */
export async function resolveShortLink(input, config = {}, signal) {
  const cfg = { ...DEFAULTS, ...config }
  const url = normalizeInputUrl(input)
  const headers = baseHeaders(cfg)
  let candidate = ''

  const first = await request(url, {
    timeoutMs: cfg.resolveTimeout,
    headers,
    redirect: 'manual',
    signal,
  })
  const location = first.headers.get('location') || ''
  if (first.status >= 300 && first.status < 400 && location !== '') {
    try {
      candidate = new URL(location, url).href
    } catch {
      candidate = ''
    }
    const ref = parseVideoRef(candidate)
    if (ref) return { url: candidate, ref }
  }

  // 跟随重定向（有些短链会先跳到中间页）
  const target = candidate || url
  const followed = await request(target, {
    timeoutMs: cfg.resolveTimeout,
    headers,
    redirect: 'follow',
    signal,
  })
  const finalUrl = followed.url || target
  const refFromUrl = parseVideoRef(finalUrl)
  if (refFromUrl) return { url: finalUrl, ref: refFromUrl }

  // 兜底：HTML 里通常带有 canonical / "bvid" 字段
  const refFromBody = parseVideoRef(followed.text.slice(0, 200_000))
  if (refFromBody) return { url: finalUrl, ref: refFromBody }

  return null
}

/** 调 B 站视频详情接口，返回标题、封面、bvid/aid */
export async function fetchVideoInfo(ref, config = {}, signal) {
  const cfg = { ...DEFAULTS, ...config }
  if (!ref || (!ref.bvid && !ref.aid)) {
    throw new Error('缺少 BV 号或 av 号，无法查询视频详情')
  }
  const query = ref.bvid
    ? `bvid=${encodeURIComponent(ref.bvid)}`
    : `aid=${ref.aid}`
  const endpoint = `${String(cfg.apiBase).replace(/\/+$/, '')}${API_VIEW_PATH}?${query}`

  const res = await request(endpoint, {
    timeoutMs: cfg.apiTimeout,
    headers: { ...baseHeaders(cfg), referer: 'https://www.bilibili.com/' },
    signal,
  })

  let payload
  try {
    payload = JSON.parse(res.text)
  } catch {
    throw new Error(`B 站接口返回了非 JSON 内容（HTTP ${res.status}）`)
  }
  if (!payload || payload.code !== 0) {
    throw new Error(describeApiError(payload?.code, payload?.message))
  }

  const data = payload.data || {}
  if (!data.bvid && !data.aid) throw new Error('B 站接口没有返回视频信息')
  return {
    bvid: typeof data.bvid === 'string' ? data.bvid : '',
    aid: Number(data.aid) || 0,
    title: typeof data.title === 'string' ? data.title.trim() : '',
    coverUrl: normalizeCoverUrl(data.pic),
    shareUrl: data.bvid ? `https://www.bilibili.com/video/${data.bvid}` : '',
  }
}

/**
 * 主入口：输入任意 B 站链接，返回 { ok, shortLink, coverUrl, title, ... }。
 * 预期内失败都返回 ok:false + error；只有在调用方取消（signal.aborted）时才抛出。
 */
export async function shareBiliVideo(rawInput, config = {}, signal) {
  const cfg = { ...DEFAULTS, ...config }
  const input = String(rawInput ?? '').trim()
  const fallback = { ok: false, shortLink: input, coverUrl: '', title: '' }

  if (input === '') {
    return { ...fallback, error: '输入为空：请提供 Bilibili 视频链接（例如 https://www.bilibili.com/video/BV1xx411c7mD）' }
  }

  let ref = parseVideoRef(input)
  let resolvedUrl = ''

  if (!ref) {
    const normalized = normalizeInputUrl(input)
    if (!isShortLink(normalized)) {
      return {
        ...fallback,
        error: '无法从链接中识别 BV 号或 av 号：请传入 bilibili.com 视频页或 b23.tv 短链',
      }
    }
    let resolved
    try {
      resolved = await resolveShortLink(normalized, cfg, signal)
    } catch (error) {
      throwIfAborted(signal, error)
      return { ...fallback, error: `解析 b23.tv 短链失败：${error.message}` }
    }
    if (!resolved) {
      return { ...fallback, error: 'b23.tv 短链没有指向可识别的 B 站视频页面' }
    }
    resolvedUrl = resolved.url
    ref = resolved.ref
  }

  const shortLink = buildShortLink(ref, cfg.shortLinkBase)

  let info
  try {
    info = await fetchVideoInfo(ref, cfg, signal)
  } catch (error) {
    throwIfAborted(signal, error)
    return {
      ok: false,
      shortLink: shortLink || fallback.shortLink,
      coverUrl: '',
      title: '',
      ...(ref.bvid ? { bvid: ref.bvid } : {}),
      ...(ref.aid ? { aid: ref.aid } : {}),
      ...(resolvedUrl ? { resolvedUrl } : {}),
      error: `获取视频信息失败：${error.message}`,
    }
  }

  const finalRef = info.bvid ? { bvid: info.bvid } : ref
  const result = {
    ok: true,
    shortLink: buildShortLink(finalRef, cfg.shortLinkBase),
    coverUrl: info.coverUrl,
    title: info.title,
    ...(info.bvid || ref.bvid ? { bvid: info.bvid || ref.bvid } : {}),
    ...(info.aid || ref.aid ? { aid: info.aid || ref.aid } : {}),
    ...(resolvedUrl || info.shareUrl ? { resolvedUrl: resolvedUrl || info.shareUrl } : {}),
  }
  if (info.coverUrl === '') result.warning = '接口没有返回封面字段（data.pic），封面可能已失效'
  return result
}

/** 工具结果的纯文本渲染（成功/失败共用，便于单测） */
export function renderShareResult(value) {
  const result = value || {}
  if (result.ok !== true) {
    const lines = [`⚠️ 未能完整生成 b23 短链：${result.error || '未知错误'}`]
    if (result.shortLink) lines.push(`🔗 备用链接：${result.shortLink}`)
    if (result.title) lines.push(`📺 标题：${result.title}`)
    if (result.coverUrl) {
      lines.push(`🖼 封面：${result.coverUrl}`)
      lines.push(`![封面](${result.coverUrl})`)
    }
    return lines.join('\n')
  }
  const lines = [
    `🔗 b23 短链：${result.shortLink}`,
    `🖼 封面：${result.coverUrl || '（接口未返回封面）'}`,
  ]
  if (result.title) lines.push(`📺 标题：${result.title}`)
  if (result.coverUrl) lines.push(`![封面](${result.coverUrl})`)
  if (result.warning) lines.push(`提示：${result.warning}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- 内部实现

function baseHeaders(cfg) {
  return {
    'user-agent': cfg.userAgent,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: 'https://www.bilibili.com/',
  }
}

function describeApiError(code, message) {
  const key = String(code)
  const hint = API_CODE_HINTS[key] ? `：${API_CODE_HINTS[key]}` : ''
  const detail = message && message !== '0' ? `（${message}）` : ''
  return `B 站接口返回 code=${key}${hint}${detail}`
}

function throwIfAborted(signal, error) {
  if (signal?.aborted) {
    const aborted = new Error('请求已取消')
    aborted.name = 'AbortError'
    throw aborted
  }
  if (error?.name === 'AbortError') throw error
}

/**
 * 带超时 + 外部取消的 fetch 包装。
 * 超时抛普通 Error（会被上层转成结构化错误）；外部取消抛 AbortError（向上传播）。
 */
async function request(url, { timeoutMs, headers, redirect = 'follow', signal }) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`请求超时（${timeoutMs}ms）`))
  }, timeoutMs)
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect,
      headers,
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, url: res.url || '', headers: res.headers, text }
  } catch (error) {
    if (signal?.aborted) {
      const aborted = new Error('请求已取消')
      aborted.name = 'AbortError'
      throw aborted
    }
    if (controller.signal.aborted) {
      throw new Error(controller.signal.reason?.message || `请求超时（${timeoutMs}ms）`)
    }
    throw new Error(`网络请求失败：${error?.message || error}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
