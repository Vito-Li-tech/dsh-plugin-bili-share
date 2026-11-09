# 发布与上架

目标：代码在 GitHub，包在 npm，条目在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，这样 dshmarket / DSH Discover 才能搜到。

## 0. 准备

- GitHub 仓库名：`dsh-plugin-bili-share`
- npm 包名：`dsh-plugin-bili-share`（已确认未被占用）
- 仓库 topic：`dsh-plugin`（收录要求）

## 1. 填真实仓库地址

把 `package.json` 里三处 `OWNER` 换成你的 GitHub 用户名：

- `repository.url`
- `homepage`
- `bugs.url`

`npm publish` 前会跑 `scripts/check-publish.mjs`，没换会直接中止。

## 2. 推到 GitHub

```sh
git init
git add .
git commit -m "feat: Bilibili short link + cover plugin"
git branch -M main
git remote add origin https://github.com/<owner>/dsh-plugin-bili-share.git
git push -u origin main
```

然后在 GitHub 仓库页 Settings → Topics 添加 `dsh-plugin`。

## 3. 发布到 npm

```sh
npm login
npm publish --access public
npm view dsh-plugin-bili-share version
```

`repository` 必须指回这个仓库——市场靠它把 npm 包和列表条目关联起来，否则不会显示下载量。

## 4. 满 1 天后提交精选列表

仓库创建必须满 **1 天**（CI 自动检查），否则 PR 会被打回，过几小时再提即可。

1. Fork <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
2. 新增 `data/plugins/<owner>__dsh-plugin-bili-share.yml`：

```yaml
url: https://github.com/<owner>/dsh-plugin-bili-share
name: <owner>/dsh-plugin-bili-share
category: tools
description:
  en: Turn Bilibili links into b23.tv short links with covers, with a tool, a /bili command, and a share-card panel.
  zh: 把 B 站链接转成 b23.tv 短链并取封面，提供工具、/bili 命令和分享卡片面板。
```

3. 提 PR。合并后站点和市场会在一天内自动收录。

可选：

- 图标：`icon: https://raw.githubusercontent.com/<owner>/dsh-plugin-bili-share/main/assets/icon-180.png`（GitHub 托管的 PNG/JPG，方形最清楚）
- 预构建包：把 `npm pack` 出的 tgz 作为 GitHub Release 附件，资产名**不带版本**（如 `dsh-plugin-bili-share.tgz`），再加
  `tarball: https://github.com/<owner>/dsh-plugin-bili-share/releases/latest/download/dsh-plugin-bili-share.tgz`
- 截图：仓库根已有 `screenshots.json`，市场会读取（`docs/share-card.png`）

## 更新版本

1. 改 `package.json` 的 `version`
2. `npm publish`
3. 市场会按 npm 版本提示更新；列表条目不用改
