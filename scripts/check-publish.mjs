// npm publish 前的检查：占位符没换掉就中止，避免把 OWNER 发上 npm。
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const repo = pkg.repository && pkg.repository.url ? pkg.repository.url : ''

if (repo === '' || repo.includes('OWNER')) {
  console.error('')
  console.error('[npm publish] package.json 里的 OWNER 还没换成你的 GitHub 用户名。')
  console.error('             需要改 repository / homepage / bugs 三处，例如 your-github-name。')
  console.error('')
  process.exit(1)
}

if (pkg.private === true) {
  console.error('[npm publish] package.json 还是 private:true，不能发布。')
  process.exit(1)
}

console.log(`准备发布 ${pkg.name}@${pkg.version} → ${repo}`)
