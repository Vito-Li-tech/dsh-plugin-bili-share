// 联网冒烟测试：真实请求 B 站接口与 b23.tv。
// 运行：node test/smoke.mjs
import { shareBiliVideo, renderShareResult } from '../lib/bili.js'

const cases = [
  { label: '视频长链接', input: 'https://www.bilibili.com/video/BV1GJ411x7h7' },
  { label: 'av 长链接', input: 'https://www.bilibili.com/video/av80433022' },
  { label: 'b23.tv BV 形式', input: 'https://b23.tv/BV1GJ411x7h7' },
  { label: 'b23.tv av 形式', input: 'https://b23.tv/av80433022' },
  { label: '无效短码（应降级不崩）', input: 'https://b23.tv/zzzzzzz' },
  { label: '非 B 站链接（应报错）', input: 'https://example.com/hello' },
]

let failed = 0

for (const item of cases) {
  const started = Date.now()
  try {
    const result = await shareBiliVideo(item.input, { apiTimeout: 8000, resolveTimeout: 8000 })
    const ms = Date.now() - started
    console.log(`\n=== ${item.label} (${ms}ms) ===`)
    console.log(JSON.stringify(result, null, 2))
    console.log('--- render ---')
    console.log(renderShareResult(result))

    const expectOk = ['视频长链接', 'av 长链接', 'b23.tv BV 形式', 'b23.tv av 形式'].includes(item.label)
    if (expectOk && result.ok !== true) {
      console.error('!! expected ok:true')
      failed++
    }
    if (!expectOk && result.ok !== false) {
      console.error('!! expected ok:false')
      failed++
    }
    if (result.ok && result.coverUrl) {
      const head = await fetch(result.coverUrl, { method: 'HEAD' })
      console.log(`cover HEAD -> ${head.status} ${head.headers.get('content-type') || ''}`)
      if (!head.ok) failed++
    }
    if (result.ok && !result.coverUrl.startsWith('https://')) {
      console.error('!! cover is not https')
      failed++
    }
  } catch (error) {
    console.error(`\n=== ${item.label} -> THREW ===\n${error?.stack || error}`)
    failed++
  }
}

console.log(`\n${cases.length - failed}/${cases.length} cases behaved as expected`)
if (failed > 0) process.exitCode = 1
