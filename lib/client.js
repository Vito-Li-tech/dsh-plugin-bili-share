// dsh-plugin-bili-share — browser half.
//
// 提供：
//   1) 主面板「B站分享」：粘贴链接 → 短链 + 封面 + 一键复制图文
//   2) 斜杠命令 /bili：读取剪贴板里的 B 站链接，直接出结果（面板自动打开）
//
// 与 host 半的约定：/bili-share/api/resolve 与 /bili-share/api/image。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-bili-share',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const PANEL_ID = 'bili-share'
    const API = '/bili-share/api'
    const TOAST_MS = 2600

    // ------------------------------------------------------------ 共享状态

    const store = {
      url: '',
      seq: 0,
      status: 'idle', // idle | loading | done | error
      result: null,
      error: '',
      toast: '',
    }
    const listeners = new Set()
    let handledSeq = 0

    function emit() {
      for (const listener of [...listeners]) listener()
    }

    function patch(next) {
      Object.assign(store, next)
      emit()
    }

    let toastTimer = 0
    function toast(text) {
      patch({ toast: text })
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => patch({ toast: '' }), TOAST_MS)
    }

    function extractBiliUrl(text) {
      const source = String(text || '')
      const urls = source.match(/https?:\/\/[^\s"'<>，。；、]+/gi) || []
      for (const candidate of urls) {
        try {
          const host = new URL(candidate).hostname.toLowerCase()
          if (host === 'b23.tv' || host.endsWith('.b23.tv') || host.endsWith('bilibili.com') || host.endsWith('bili2233.cn')) {
            return candidate
          }
        } catch {}
      }
      const bare = source.match(/\bBV[0-9A-Za-z]{10}\b|\bav\d{1,12}\b/i)
      return bare ? bare[0] : ''
    }

    async function resolveShare(rawUrl) {
      const url = String(rawUrl || '').trim()
      if (url === '') return
      patch({ status: 'loading', error: '', result: null })
      try {
        const response = await fetch(`${API}/resolve?url=${encodeURIComponent(url)}`)
        if (response.status === 404) {
          throw new Error('本地接口 404：插件宿主还是旧模块，请完全退出并重启 DSH（只刷新页面不够）')
        }
        const data = await response.json().catch(() => null)
        if (!data) throw new Error(`接口返回异常（HTTP ${response.status}）`)
        if (data.ok !== true) throw new Error(data.error || '解析失败')
        patch({ status: 'done', result: data })
      } catch (error) {
        patch({ status: 'error', error: error && error.message ? error.message : String(error) })
      }
    }

    // ------------------------------------------------------------ 复制图文

    function formatText(result) {
      const lines = []
      if (result.title) lines.push(result.title)
      if (result.shortLink) lines.push(`短链：${result.shortLink}`)
      return lines.join('\n')
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function formatHtml(result, coverDataUrl) {
      const cover = coverDataUrl || result.coverUrl
      const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
      return (
        `<div style="font-family:${font};max-width:520px;color:#18191c">` +
        (cover
          ? `<img src="${escapeHtml(cover)}" alt="封面" style="display:block;width:100%;max-width:520px;border-radius:12px" />`
          : '') +
        `<div style="font-size:20px;font-weight:600;line-height:1.45;margin:14px 0 8px">${escapeHtml(result.title || 'B 站视频')}</div>` +
        `<div style="font-size:14px;line-height:1.6;color:#00a1d6">${escapeHtml(result.shortLink || '')}</div>` +
        '</div>'
      )
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
        reader.readAsDataURL(blob)
      })
    }

    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('封面加载失败'))
        image.src = src
      })
    }

    function wrapLines(context, text, maxWidth, maxLines) {
      const chars = Array.from(String(text || ''))
      const lines = []
      let line = ''
      let truncated = false
      for (const char of chars) {
        const candidate = line + char
        if (line !== '' && context.measureText(candidate).width > maxWidth) {
          lines.push(line)
          line = char
          if (lines.length === maxLines) {
            truncated = true
            break
          }
        } else {
          line = candidate
        }
      }
      if (lines.length < maxLines && line !== '') lines.push(line)
      if (truncated && lines.length > 0) {
        let last = lines[lines.length - 1] || ''
        while (last !== '' && context.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1)
        lines[lines.length - 1] = `${last}…`
      }
      return lines
    }

    async function renderCard(result, coverDataUrl) {
      const width = 720
      const pad = 40
      const coverHeight = coverDataUrl ? 405 : 0
      const titleFont = '600 30px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif'
      const linkFont = '500 22px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif'
      const brandFont = '500 18px "Microsoft YaHei", system-ui, sans-serif'

      const canvas = document.createElement('canvas')
      const probe = canvas.getContext('2d')
      probe.font = titleFont
      const titleLines = wrapLines(probe, result.title || 'B 站视频', width - pad * 2, 2)
      const titleBlock = titleLines.length * 42
      const height = coverHeight + pad + titleBlock + 18 + 32 + pad

      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')

      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)

      if (coverDataUrl) {
        const image = await loadImage(coverDataUrl)
        const scale = Math.max(width / image.width, coverHeight / image.height)
        const drawWidth = image.width * scale
        const drawHeight = image.height * scale
        ctx.drawImage(image, (width - drawWidth) / 2, (coverHeight - drawHeight) / 2, drawWidth, drawHeight)
      }

      let y = coverHeight + pad
      ctx.fillStyle = '#18191c'
      ctx.font = titleFont
      ctx.textBaseline = 'top'
      for (const line of titleLines) {
        ctx.fillText(line, pad, y)
        y += 42
      }

      y += 18
      ctx.fillStyle = '#00a1d6'
      ctx.font = linkFont
      ctx.fillText(result.shortLink || '', pad, y)

      ctx.fillStyle = '#8a8f99'
      ctx.font = brandFont
      ctx.textAlign = 'right'
      ctx.fillText('b23.tv · Bilibili', width - pad, height - pad + 6)

      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成图片失败'))), 'image/png')
      })
    }

    async function fetchCoverBlob(result) {
      if (!result.coverUrl) return null
      try {
        const response = await fetch(`${API}/image?url=${encodeURIComponent(result.coverUrl)}`)
        if (!response.ok) return null
        return await response.blob()
      } catch {
        return null
      }
    }

    // 只写文字 + HTML：聊天软件会取文字；Word/飞书这类富文本会带封面。
    async function copyTextWithCover() {
      const result = store.result
      if (!result) return
      const text = formatText(result)
      let coverDataUrl = ''
      const blob = await fetchCoverBlob(result)
      if (blob) {
        try {
          coverDataUrl = await blobToDataUrl(blob)
        } catch {
          coverDataUrl = ''
        }
      }
      const html = formatHtml(result, coverDataUrl)
      const item = { 'text/plain': new Blob([text], { type: 'text/plain' }) }
      if (html) item['text/html'] = new Blob([html], { type: 'text/html' })

      try {
        await navigator.clipboard.write([new ClipboardItem(item)])
        toast(coverDataUrl ? '已复制文字 + 封面（富文本才带图）' : '已复制文字和链接')
      } catch {
        try {
          await navigator.clipboard.writeText(text)
          toast('已复制文字')
        } catch (error) {
          toast(`复制失败：${error && error.message ? error.message : error}`)
        }
      }
    }

    // 只写 PNG：图片卡里已经排好封面、标题和短链，适合直接发聊天。
    async function copyImageCard() {
      const result = store.result
      if (!result) return
      const blob = await fetchCoverBlob(result)
      let coverDataUrl = ''
      if (blob) {
        try {
          coverDataUrl = await blobToDataUrl(blob)
        } catch {
          coverDataUrl = ''
        }
      }
      let png = null
      try {
        png = await renderCard(result, coverDataUrl)
      } catch {
        png = null
      }
      if (!png) {
        toast('生成图片卡失败，请改用「复制文字 + 封面」')
        return
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        toast('图片卡已复制（标题和短链都在图里）')
      } catch (error) {
        toast(`复制图片失败：${error && error.message ? error.message : error}`)
      }
    }

    async function copyShortLink() {
      const link = store.result && store.result.shortLink
      if (!link) return
      try {
        await navigator.clipboard.writeText(link)
        toast('短链已复制')
      } catch {
        toast('复制失败，请手动选中复制')
      }
    }

    async function copyCoverUrl() {
      const cover = store.result && store.result.coverUrl
      if (!cover) return
      try {
        await navigator.clipboard.writeText(cover)
        toast('封面地址已复制')
      } catch {
        toast('复制失败，请手动选中复制')
      }
    }

    // ------------------------------------------------------------ 面板 UI

    function Panel() {
      const [, force] = useState(0)
      const inputRef = useRef(null)

      useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])

      useEffect(() => {
        if (store.seq > handledSeq) {
          handledSeq = store.seq
          if (store.url) void resolveShare(store.url)
        }
        if (inputRef.current && inputRef.current.ownerDocument.activeElement !== inputRef.current) {
          inputRef.current.focus()
        }
      }, [store.seq])

      const result = store.result
      const loading = store.status === 'loading'

      return h(
        'div',
        { className: 'dsh-bili' },
        h(
          'div',
          { className: 'dsh-bili-inner' },
          h(
            'header',
            { className: 'dsh-bili-head' },
            h('div', { className: 'dsh-bili-logo' }, 'b23'),
            h(
              'div',
              null,
              h('h1', { className: 'dsh-bili-h1' }, 'B 站短链分享'),
              h('p', { className: 'dsh-bili-sub' }, '粘贴链接，生成 b23 短链和封面，一键复制可分享的图文卡。'),
            ),
          ),
          h(
            'div',
            { className: 'dsh-bili-form' },
            h('input', {
              ref: inputRef,
              className: 'dsh-bili-input',
              type: 'text',
              value: store.url,
              placeholder: 'https://www.bilibili.com/video/BV... 或 b23.tv/...',
              spellCheck: false,
              onChange: (event) => patch({ url: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void resolveShare(store.url)
              },
            }),
            h(
              'button',
              {
                className: 'dsh-bili-primary',
                type: 'button',
                disabled: loading,
                onClick: () => void resolveShare(store.url),
              },
              loading ? '生成中…' : '生成',
            ),
          ),
          store.error
            ? h('div', { className: 'dsh-bili-error' }, h('strong', null, '没成功：'), store.error)
            : null,
          result && result.ok
            ? h(
                'section',
                { className: 'dsh-bili-card' },
                result.coverUrl
                  ? h('img', {
                      className: 'dsh-bili-cover',
                      src: `${API}/image?url=${encodeURIComponent(result.coverUrl)}`,
                      alt: '视频封面',
                    })
                  : h('div', { className: 'dsh-bili-cover dsh-bili-cover--empty' }, '无封面'),
                h(
                  'div',
                  { className: 'dsh-bili-body' },
                  h('div', { className: 'dsh-bili-title' }, result.title || '（没有标题）'),
                  h(
                    'div',
                    { className: 'dsh-bili-row' },
                    h('span', { className: 'dsh-bili-label' }, '短链'),
                    h('a', { className: 'dsh-bili-link', href: result.shortLink, target: '_blank', rel: 'noopener noreferrer' }, result.shortLink),
                    h('button', { className: 'dsh-bili-ghost', type: 'button', onClick: () => void copyShortLink() }, '复制'),
                  ),
                  h(
                    'div',
                    { className: 'dsh-bili-row' },
                    h('span', { className: 'dsh-bili-label' }, '封面'),
                    h('span', { className: 'dsh-bili-cover-url', title: result.coverUrl }, result.coverUrl || '—'),
                    result.coverUrl
                      ? h('button', { className: 'dsh-bili-ghost', type: 'button', onClick: () => void copyCoverUrl() }, '复制')
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'dsh-bili-actions' },
                    h('button', { className: 'dsh-bili-primary dsh-bili-copy', type: 'button', onClick: () => void copyTextWithCover() }, '复制文字 + 封面'),
                    h('button', { className: 'dsh-bili-secondary', type: 'button', onClick: () => void copyImageCard() }, '复制图片卡'),
                  ),
                  h(
                    'div',
                    { className: 'dsh-bili-hint' },
                    '聊天软件一次只取一种格式：要可点链接的文字点左边（富文本编辑器里可能带封面），要分享图点右边（图里已排好标题和短链）。',
                  ),
                ),
              )
            : null,
          result && !result.ok && result.error
            ? h('div', { className: 'dsh-bili-error' }, result.error, result.shortLink ? h('div', null, '备用链接：', result.shortLink) : null)
            : null,
          store.toast ? h('div', { className: 'dsh-bili-toast' }, store.toast) : null,
        ),
      )
    }

    function LinkIcon(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }),
        h('path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }),
      )
    }

    // ------------------------------------------------------------ 命令

    async function openFromClipboard(ctx) {
      let text = ''
      try {
        text = await navigator.clipboard.readText()
      } catch {
        text = ''
      }
      const url = extractBiliUrl(text)
      if (url) patch({ url, seq: store.seq + 1 })
      try {
        ctx.layout.selectPanel(PANEL_ID)
      } catch {
        /* layout 不可用时静默：用户仍可从侧栏打开 */
      }
    }

    // ------------------------------------------------------------ 样式

    const CSS = `
.dsh-bili, .dsh-bili *, .dsh-bili *::before, .dsh-bili *::after { box-sizing: border-box; }
.dsh-bili {
  height: 100%;
  overflow: auto;
  padding: 36px 28px 96px;
  color: var(--dsw-alias-label-primary, #18191c);
  font-family: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
}
.dsh-bili-inner { max-width: 880px; margin: 0 auto; }
.dsh-bili-head { display: flex; gap: 16px; align-items: center; margin-bottom: 28px; }
.dsh-bili-logo {
  width: 46px; height: 46px; border-radius: 14px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #00a1d6, #00c3ff);
  color: #fff; font-weight: 700; font-size: 15px; letter-spacing: .02em;
}
.dsh-bili-h1 { margin: 0; font-size: 22px; line-height: 1.3; font-weight: 600; }
.dsh-bili-sub { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #8a8f99); }
.dsh-bili-form { display: flex; gap: 10px; }
.dsh-bili-input {
  flex: 1; min-width: 0; height: 44px; padding: 0 14px;
  border-radius: 10px; border: 1px solid rgba(127,127,127,.24);
  background: rgba(127,127,127,.06); color: inherit; font: inherit; font-size: 14px;
  outline: none;
}
.dsh-bili-input:focus { border-color: #00a1d6; box-shadow: 0 0 0 3px rgba(0,161,214,.14); }
.dsh-bili-primary {
  height: 44px; padding: 0 22px; border-radius: 10px; border: none; cursor: pointer;
  background: #00a1d6; color: #fff; font: inherit; font-size: 14px; font-weight: 600; flex: none;
}
.dsh-bili-primary:hover { background: #0090c0; }
.dsh-bili-primary:disabled { opacity: .6; cursor: default; }
.dsh-bili-error {
  margin-top: 16px; padding: 12px 14px; border-radius: 10px;
  background: rgba(229,77,66,.1); color: #e54d42; font-size: 13px; line-height: 1.6;
}
.dsh-bili-card {
  margin-top: 26px; border-radius: 16px; overflow: hidden;
  border: 1px solid rgba(127,127,127,.2); background: rgba(127,127,127,.05);
  display: flex; flex-direction: column;
}
.dsh-bili-cover { width: 100%; max-height: 420px; object-fit: cover; display: block; background: rgba(127,127,127,.12); }
.dsh-bili-cover--empty { height: 160px; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary, #8a8f99); }
.dsh-bili-body { padding: 20px 22px 22px; }
.dsh-bili-title { font-size: 17px; font-weight: 600; line-height: 1.5; margin-bottom: 16px; }
.dsh-bili-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 13px; min-width: 0; }
.dsh-bili-label { flex: none; width: 34px; color: var(--dsw-alias-label-secondary, #8a8f99); }
.dsh-bili-link { color: #00a1d6; text-decoration: none; word-break: break-all; }
.dsh-bili-link:hover { text-decoration: underline; }
.dsh-bili-cover-url {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #8a8f99);
}
.dsh-bili-ghost {
  flex: none; height: 26px; padding: 0 10px; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(127,127,127,.28); background: transparent; color: inherit; font: inherit; font-size: 12px;
}
.dsh-bili-ghost:hover { background: rgba(127,127,127,.12); }
.dsh-bili-actions { display: flex; align-items: center; gap: 14px; margin-top: 20px; flex-wrap: wrap; }
.dsh-bili-copy { height: 40px; padding: 0 26px; }
.dsh-bili-secondary {
  height: 40px; padding: 0 20px; border-radius: 10px; cursor: pointer;
  border: 1px solid rgba(127,127,127,.3); background: transparent; color: inherit;
  font: inherit; font-size: 14px; font-weight: 500;
}
.dsh-bili-secondary:hover { background: rgba(127,127,127,.12); }
.dsh-bili-hint { margin-top: 10px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f99); }
.dsh-bili-toast {
  position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%);
  padding: 10px 18px; border-radius: 999px; background: rgba(20,20,22,.88); color: #fff;
  font-size: 13px; line-height: 1.4; z-index: 60; pointer-events: none;
  box-shadow: 0 10px 30px rgba(0,0,0,.24);
}
@media (max-width: 640px) {
  .dsh-bili { padding: 22px 16px 90px; }
  .dsh-bili-form { flex-direction: column; }
  .dsh-bili-primary { width: 100%; }
}
`

    return {
      inject: ['slots', 'layout', 'commandUi'],
      apply(ctx) {
        if (typeof document !== 'undefined' && !document.getElementById('dsh-bili-style')) {
          const style = document.createElement('style')
          style.id = 'dsh-bili-style'
          style.textContent = CSS
          document.head.appendChild(style)
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel)),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 13, label: () => 'B站分享' },
            (props) => h(LinkIcon, { size: props && props.size }),
          ),
        )

        ctx.effect(
          () =>
            ctx.commandUi.decorate({
              name: 'bili',
              available: () => true,
              ui: {
                kind: 'action',
                run: () => {
                  void openFromClipboard(ctx)
                },
              },
            }),
          'bili-share: /bili action',
        )
      },
    }
  },
})
