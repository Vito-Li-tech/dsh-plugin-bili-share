# dsh-plugin-bili-share

Bilibili link → b23.tv short link + cover for DeepSeek Harness. Ships a `bili_short_link_with_cover` tool, a `/bili` slash command, and a sidebar share-card panel with one-click copy.

[![npm](https://img.shields.io/npm/v/dsh-plugin-bili-share)](https://www.npmjs.com/package/dsh-plugin-bili-share)
[![license](https://img.shields.io/npm/l/dsh-plugin-bili-share)](LICENSE)

![share card](docs/share-card.png)

Bilibili 视频链接 → **b23.tv 短链** + **封面直链**，并且提供：

- 工具 `bili_short_link_with_cover`（Agent 调用）
- 侧栏面板「B站分享」（粘贴链接 → 结果卡片 → 复制文字 / 复制图片卡）
- 斜杠命令 `/bili`（读剪贴板直接出结果）与 `/bili <链接>`（直接返回文字结果）

```
输入：https://www.bilibili.com/video/BV1GJ411x7h7
输出：https://b23.tv/BV1GJ411x7h7
      https://i1.hdslb.com/bfs/archive/....jpg
      【官方 MV】Never Gonna Give You Up - Rick Astley
```

## 怎么用

### 斜杠命令

- **先复制**一个 B 站链接，然后在输入框敲 `/bili` 回车：自动解析并打开「B站分享」面板，按需要点「复制文字 + 封面」或「复制图片卡」。
- 也可以直接敲 `/bili <链接或BV号>` 回车：不经过模型，直接在对话里返回短链、封面和标题。

### 面板

侧栏「B站分享」→ 粘贴链接 → 生成 → 结果卡片：

- **复制文字 + 封面**：写 `text/plain` + `text/html`（封面以 data URL 内嵌）。聊天软件会取文字（标题 + 短链）；Word/飞书这类富文本编辑器里会带封面图。
- **复制图片卡**：只写 `image/png`，生成 720px 分享卡（封面 + 标题 + 短链），图里已经排好文字，直接发微信 / QQ 就是一张完整图文。
- 「短链」「封面」旁的「复制」按钮只复制对应内容。

复制出来的文字长这样：

```
🔗 短链： https://b23.tv/BV1GJ411x7h7

📺 标题： 【官方 MV】Never Gonna Give You Up - Rick Astley
```

> 剪贴板一次只能让目标应用挑一种格式：微信 / QQ 会优先取图片。所以要「可点链接的文字」就点左边，要「图」就点右边；不存在一次粘贴同时得到两种的通用做法。

### Agent 工具

新会话里直接说：

> 帮我把 https://www.bilibili.com/video/BV1GJ411x7h7 转成 b23 短链，顺便给我封面。

## 功能

- 支持 `bilibili.com/video/BV...`、`m.bilibili.com`、`av` 号、裸 `BV`/`av`，以及 `b23.tv` 短链。
- `b23.tv` 短链先跟随重定向还原（`Location` → 最终 URL → HTML 正文，三层兜底）。
- 封面来自 `api.bilibili.com/x/web-interface/view` 的 `data.pic`，`http://` 自动升级为 `https://`。
- 短链直接拼官方稳定格式 `https://b23.tv/<BV号>`，不调用已失效的 `api.biliapi.net/x/share/click`。
- 所有预期内失败都返回 `ok:false` + `error`（并原样回传输入 URL 作为备用短链），不会抛异常打断会话。
- 浏览器端通过本地接口 `/bili-share/api` 取数据；封面走 `/image` 代理（只允许 B 站图床，防 SSRF），画布生成分享卡时不受 CORS 限制。

## 文件结构

```
dsh-plugin-bili-share/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 把插件 insert 进 profile
├── lib/
│   ├── index.js          # 宿主：工具 + /bili 命令 + /bili-share/api
│   ├── client.js         # 浏览器：面板、侧栏入口、/bili 装饰、复制图文
│   └── bili.js           # 纯逻辑：URL 解析、b23 还原、详情 API、封面规整
└── test/
    ├── self-test.mjs     # 离线单测（mock fetch）
    ├── host-api-test.mjs # 宿主 API / 命令 / SSRF 测试
    └── client-test.mjs   # 客户端注册契约测试
```

## 配置项（`Config`，均有默认值）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBase` | `https://api.bilibili.com` | B 站 API 根地址 |
| `shortLinkBase` | `https://b23.tv` | 短链前缀 |
| `apiTimeout` | `8000` | 视频详情接口超时（ms） |
| `resolveTimeout` | `8000` | b23 短链解析超时（ms） |
| `userAgent` | 桌面 Chrome UA | 请求 B 站使用的 UA |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: bili-share
  config:
    apiTimeout: 5000
```

## 本地测试

```powershell
cd dsh-plugin-bili-share
node test/self-test.mjs     # 离线单测
node test/host-api-test.mjs # 宿主 API + /bili 命令（会真实请求 B 站）
node test/client-test.mjs   # 客户端注册契约
node test/smoke.mjs         # 联网冒烟
```

## 安装 / 更新

插件以 tgz 包安装进 profile（DSH 的模块解析只对 profile 内的包生效，`link:` 到工作区会拿不到 `@deepseek-ai/*`）。

```powershell
cd C:\path\to\dsh-plugin-bili-share
Remove-Item *.tgz -Force
npm pack --pack-destination .
```

然后把新的 `.tgz` 通过插件管理器安装（或让 agent 调 `plugin_manager` 的 `install_bundle`）。

> 宿主代码更新后需要**重启一次 DSH** 才会加载新模块；浏览器端更新后刷新页面即可。

## 已知边界

- 仅支持视频稿件；番剧/直播/专栏链接一般识别不出 BV/av，会走「无法解析」降级。
- 接口成功但 `data.pic` 为空时，`ok:true`、`coverUrl` 为空并带 `warning`。
- 剪贴板读取需要浏览器授权；被拒绝时 `/bili` 仍会打开面板，手动粘贴即可。
