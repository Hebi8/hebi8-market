# 自己部署与运维

给跑一台 hebi8/market 实例的人看：生产运行、更新、环境变量、vault、实例状态，以及局域网里几个人共用一台。各功能怎么用见 [usage.md](usage.md)。

默认单用户、无登录、只在内网用；只存日线，3 日 / 周 / 月 / 季线读时合成；读取永远不碰网络；通知只往外发，不开任何入口。

## 运行

```bash
npm install
npm run dev        # http://localhost:3000
```

首次打开会把 `vault.example/hebi8.yaml` 复制为 `vault/hebi8.yaml`，并在后台拉取全部历史，大约几秒。之后由应用内的调度器按 `sync.at` 的时间每天同步；应用停过一段时间再启动时会补跑一次。总览右上角的「刷新」强制全量同步。

生产模式 `npm run build && npm start`。

### 更新线上实例（`scripts/deploy.sh`）

已经作为 systemd 用户服务跑着的实例，用 `scripts/deploy.sh <分支或 commit>` 更新：备份 `vault/`、密钥目录和数据库到 `~/backups/hebi8/<时间>-deploy/`，把 master 快进到这个分支，依赖有变就 `npm ci`，重新构建并重启，页面返回 200 后推送 master；构建或检查失败就退回原来的 commit 重新构建。分支必须是 master 的快进，线上目录必须干净。构建用服务 unit 里 `PATH` 的 Node（没写就用当前的）。

实例和仓库可以不在一台机器上：在仓库所在的机器上跑，`HEBI8_LIVE_HOST=<user@host>` 时 commit 经 ssh 推进那台的线上目录，构建、重启、检查和回滚都在那台做，成功后才在本地快进 master 并推送；只在一台机器上就设 `HEBI8_LIVE_HOST=local`（脚本的默认值是本仓库线上实例的地址）。`HEBI8_REPO` 是本地仓库目录，`HEBI8_LIVE`（线上目录，相对那台的 home）、`HEBI8_UNIT`、`HEBI8_HEALTH_URL`、`HEBI8_SECRETS` 是线上那台的目录、服务名、检查地址和密钥目录。

本仓库的线上实例不直接调它：发版用 `scripts/release.sh`，热补丁用 `scripts/hotfix.sh`，两者都经 `deploy.sh` 部署（见 [maintainers.md](maintainers.md#分支与发版)）。自己部署的实例跟着 `master` 更新就是跟着发布过的版本，每个版本的 tag 和变化见 [CHANGELOG.md](../CHANGELOG.md)。

## 环境变量

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `HEBI8_VAULT` | `./vault` | 用户内容目录 |
| `HEBI8_DB` | `./data/hebi8.db` | SQLite 缓存，删了会自动重建 |
| `BINANCE_API_URL` | `https://api.binance.com` | 换成 `https://data-api.binance.vision` 等镜像 |
| `HEBI8_SECRETS` | `~/.config/hebi8/market` | GitHub 登录会话 `sessions.json`、网页登录的 client `github-oauth.json`（手写，可选，见[网页登录](#网页登录可选)）、实例的通知设置 `notify.json`、每个人的通知通道 `notify-users.json`（见[通知通道](usage.md#通知通道)）、网页推送的密钥 `vapid.json`（自动生成）、翻译简介用的模型 `llm.json`（手写，可选，见[商品详情](usage.md#商品详情)）、agent 令牌的哈希 `mcp-tokens.json`，权限 700 / 600 |
| `HEBI8_GITHUB_CLIENT_ID` | `app-info.ts` 的 `GITHUB_APP_CLIENT_ID` | 反馈登录用的 GitHub App client id（fork 用自己的 App 时设，见 [maintainers.md](maintainers.md#反馈用的-github-app)）；设为 `off` 关闭应用内登录，反馈只走 GitHub 网页 |
| `HEBI8_FEEDBACK_REPO` | `Hebi8/hebi8-market` | 反馈 issue 开在哪个仓库（`owner/name`） |
| `HEBI8_PUBLIC_URL` | `https://market-hebi8.dreaife.tokyo` | 实例的公开地址：页面元数据、分享卡片、`robots.txt`、`sitemap.xml`、复制和分享出去的图表链接、导出图片底部的地址都用它 |
| `HEBI8_OG_FONT` | 按常见路径找 Noto Sans CJK SC 的 `.otf` | 分享卡片用的中文字体（`.otf` / `.ttf`，不能是 `.ttc`）；找不到时卡片上只画拉丁字符 |

## vault

**`vault/` 是我的，`data/hebi8.db` 是缓存。** vault 不进 git，放到自己的同步盘或者单独的仓库里。

```text
vault/
  hebi8.yaml                  自选分组、别名、公式指标、警报、同步时间表、图表偏好
  notes/<fileKey>.md          每个标的的笔记，frontmatter 里的 key 是权威
  journal/<YYYY>-W<ww>.md     每周复盘（ISO 周）
  charts/<fileKey>.json       每个标的的对比列表和画线
  users/<login>/              共用实例里其他人的 vault，结构同上
```

`hebi8.yaml` 的样子见 `vault.example/hebi8.yaml`。界面上改周期、涨跌色、图表偏好、添加 / 移除 / 移动 / 改名标的、拖动排序、新建 / 重命名 / 删除分组、设基准、编辑公式指标、建改警报时会写回这个文件，注释和顺序都保留；同步时间、别名、数据集直接改文件，不用重启；界面上不再提示文件路径，因为共用实例的其他人和访客改不了服务器上的文件。搜索时用中文词添加的标的，这个词会记进 `aliases`。

- 标的引用（分组、`bench`、公式里的 `close(X)`、合成表达式、对比、搜索）先查 `aliases`，查不到就当完整 key。
- 显示名：yaml 里的 `name` > 内置字典的中文名 > 数据源的名字。
- `bench` 是相对强弱和 `close(bench)` 的默认基准。
- `conditions` 在每次同步后按周线计算，`prev != now` 就是本周的变化。
- `fileKey`：`tv:TVC:US10Y → tv_TVC_US10Y`，`=BTC/GOLD → expr_BTC_GOLD`。

警报（`alerts`）和数据集（`datasets`）的写法见 [usage.md](usage.md#在-yaml-里写) 和[自定义数据集](usage.md#自定义数据集)；字段的完整定义见 [design.md](design.md) §1.1。

## 查看实例状态

帮助抽屉里不放这些，因为只有跑这台实例的人用得上：

| 想知道 | 共用实例的 owner | 单用户模式或在服务器上 |
|---|---|---|
| 跑的是哪个版本 | `/usage`「实例」：版本号、commit、构建时间 | `git log -1 --oneline`；构建时由 `next.config.ts` 注入 `HEBI8_VERSION` / `HEBI8_COMMIT` / `HEBI8_BUILT_AT` |
| 上次、下次同步 | `/usage`「实例」：上次同步、下次同步和每天的时间表 | 总览标题旁有上次同步时间；调度日志在 stdout（`journalctl -u <服务名>`），前缀 `[hebi8m]` |
| 缓存了多少标的、哪些同步出错 | `/usage`「实例」：缓存数和出错的标的及错误 | 总览上出错的行会显示错误；或 `sqlite3 data/hebi8.db "select key, sync_error from symbols where sync_error is not null"` |
| vault 在哪 | `/usage`「实例」 | `HEBI8_VAULT`，默认 `./vault`（见[上文](#vault)） |
| `hebi8.yaml` 写错了 | 页面直接显示错误和行号，改好刷新即可 | 同左 |

`/usage` 只有 owner 能打开（页头菜单「使用情况」），其他人和单用户模式都是 404，见 [`design.md`](design.md) §1.7。

## 共用一台实例

在根 vault 的 `hebi8.yaml` 里写 `owner: <你的 GitHub 用户名>`（几个账号都是你的就写列表 `owner: [dreaife, dreaifekks]`，任何一个登录都用根 vault），局域网里的几个人就能共用这台 hebi8：K 线缓存、同步和数据集是共享的，自选、别名、公式、警报、图表偏好、笔记、复盘、画线和通知是各人的。不写 `owner` 就是单用户模式，和以前完全一样。

| 访问者 | 看到 | 能改 |
|---|---|---|
| owner 登录 | 根 vault | 根 vault，含实例设置 |
| 其他人登录 | `vault/users/<login>/` | 自己的 vault |
| 未登录 | owner 的总览和图表（含画线） | 不能改；笔记和复盘要登录后看自己的 |

- 页头右侧的「登录」打开登录抽屉，走 GitHub device flow（和反馈共用会话，用着就一直有效，连续 30 天不用才过期）；配了[网页登录](#网页登录可选)的入口上是跳到 GitHub、授权后回到原来的页面；登录后显示头像和用户名，菜单里有「通知设置」、「在其他设备上登录」、owner 才有的「使用情况」和「退出」。「通知设置」打开的是同一个抽屉，登录后它就是设置通知的地方。退出只删会话，不动 vault。
- 换一台设备、换一个浏览器不用再登录一遍：在已登录的设备上点页头的头像，选「在其他设备上登录」，用另一台设备扫二维码或打开链接（2 分钟内有效，只能用一次），在打开的页面上确认即可。这样带过去的登录没有 GitHub 的授权，要在应用里提交反馈时再用 GitHub 登录一次。
- 第一次登录的人从根 vault 的 `hebi8.yaml` 复制一份起点，去掉 `owner`、`sync`、`datasets`、`alerts`（以及旧的 `conditions`），警报不会替谁预置；笔记、复盘、画线从空开始。之后两边互不影响。
- `owner`、`sync`、`datasets` 是实例设置，只认根 vault 的；写在自己 yaml 里会被忽略，总览上会提示。
- 同步拉的是所有人引用到的标的的并集；同步后每个人的统计和通知各算各的。
- 每个人的通知通道在「通知设置」里各自设置，见[通知通道](usage.md#通知通道)。
- GitHub 登录只用来区分局域网里的人，不防恶意访问者，不要把实例开到公网。

### 网页登录（可选）

device flow 每次都要复制代码、去 GitHub 粘贴、等轮询。给实例配上 GitHub App 的 client secret，就可以改成跳到 GitHub 再回来：浏览器里已经登录 GitHub 的人点一下「登录」就完成。

1. 在反馈用的那个 GitHub App 的设置页（[maintainers.md](maintainers.md#反馈用的-github-app) 里注册的 hebi8-market；fork 是自己的 App）里，往 **Callback URL** 加上 `<公开地址>/api/github/callback`，点 **Generate a new client secret**。Enable Device Flow 保持勾选。
2. 在 `HEBI8_SECRETS` 目录（默认 `~/.config/hebi8/market`）里写 `github-oauth.json`，`chmod 600`：

   ```json
   { "client_id": "Iv23li…", "client_secret": "…" }
   ```

   `client_id` 是 App 的 Client ID。还可以写 `origins`（提供网页登录的入口，默认只有 `HEBI8_PUBLIC_URL`；每个入口的 `<origin>/api/github/callback` 都要登记在 App 上）。文件每次用到时读，改了不用重启。

这样两种登录拿到的是同一个 App 的授权，都能在应用里提交反馈。GitHub 只跳回登记过的回调地址，所以网页登录只在 `origins` 里的入口提供；从别的入口（比如 Tailscale 的 http 地址）打开时，「登录」还是 device flow。没有这个文件时一切照旧。

也可以单独建一个 OAuth App，把它的 id 和 secret 填进去（`scope` 默认空）：这样的登录只确认身份，不能在应用里提交反馈，提交时会说明原因并给出「在 GitHub 网页上提交」。细节见 [`design.md`](design.md) §5.8。
