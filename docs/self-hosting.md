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

默认在本机部署：线上目录就是仓库的主目录（`git worktree` 挂着的那个；`HEBI8_LIVE` 可以改）。实例在另一台机器上时，在仓库所在的机器上跑，设 `HEBI8_LIVE_HOST=<user@host>`：commit 经 ssh 推进那台的线上目录，构建、重启、检查和回滚都在那台做，成功后才在本地快进 master 并推送。这时 `HEBI8_REPO` 是本地仓库目录（默认主目录），`HEBI8_LIVE`（线上目录，相对那台的 home，默认 `dev/hebi8-market`）、`HEBI8_UNIT`（默认 `hebi8-market`）、`HEBI8_SECRETS` 是线上那台的目录、服务名和密钥目录。检查地址 `HEBI8_HEALTH_URL` 默认取服务 unit 里 `next start -H … -p …` 的地址。这些设置可以每次写在命令前面，也可以写进仓库主目录的 `deploy.env`（照 `deploy.env.example`，`KEY=value` 一行一个、不加引号；不进 git），环境变量优先。

退出码 0 是部署了，1 是没部署（线上还是原来的），3 是连不上、不知道结果：等那台连得上再跑一次同样的部署，做完了的它会认出来。它靠线上目录 `.git` 里的记录 `refs/hebi8/live` 认出线上跑的是哪个版本，第一次部署前要在实例正常运行时设好：`git update-ref refs/hebi8/live <正在跑的完整 commit>`（细节见 [maintainers.md](maintainers.md#正式环境)）。

自己部署的实例跟着 `master` 更新就是跟着发布过的版本，每个版本的 tag 和变化见 [CHANGELOG.md](../CHANGELOG.md)。本仓库的线上实例由合并进 master 的 PR 经 GitHub Actions 部署（见下一节和 [maintainers.md](maintainers.md#分支与发版)）；不用 Actions 时，`scripts/release.sh --deploy <x.y.z>` / `scripts/hotfix.sh --deploy <x.y.z>` 在本机做版本提交、调 `deploy.sh`、打 tag 和发 Release。

### 用 GitHub Actions 自动部署（可选）

`.github/workflows/deploy.yml`：push 到 `master`（合并 PR）部署到 GitHub Environment `production`。只在 push 到 master 和对 master 手动运行（Actions 页的 Run workflow）时跑，从不在 pull_request 上跑。**仓库设置里没有 `production` 这个 Environment 就直接跳过**，所以不配置就什么都不发生，fork 里推送也不会连任何机器。合并就是批准，Environment 不需要审批人。想再跑一个跟着 `dev` 的实例先试新功能，不用工作流：照 `scripts/dev-instance/hebi8-dev.sh` 那样让它自己每分钟看一次分支（systemd 用户 timer 跑 `git ls-remote`），动了才拉取、构建、切换；它可以和线上在同一台机器上，单独的目录、数据库和空的密钥目录，优先级调低。

production 做的事：ssh 到线上那台跑 `deploy.sh live <commit>`（同上：备份、构建、重启、检查、回滚），成功后，这个提交的 `package.json` 版本还没有 tag 的话，打带注释的 tag `v<版本>`、用 `CHANGELOG.md` 那一节发 GitHub Release、给修好的 issue 评论并关掉（从上一个 tag 到这个提交、提交信息里写着 `Fixes #n` 一类的；带 `status:next-release` 标签但修复不在这次发布里的不动），最后把 master 合回 dev。合回之前 master 不是 dev 的祖先；部署失败时不会合回，下次发版前先 `scripts/hotfix.sh merge-back`。

**线上那台的部署 key 只能部署**：`authorized_keys` 里那一行是 forced command，只跑线上目录里的 `scripts/deploy-gate.sh`。它只接受 `live <40 位 commit>` 和 `status <40 位 commit>`，其它（短 commit、多余参数、`;`、换行、空命令、`git` 命令、shell）一律拒绝；`live` 时由线上那台自己 `git fetch origin master`、确认这个 commit 在 master 上，再跑这个 commit 自己的 `deploy.sh`。所以线上目录的 `origin` 要是 GitHub 上的这个仓库（公开仓库用 https 就行，不用凭据）。

1. **先让线上目录里有 `deploy-gate.sh`**：它跟着代码走，用 `scripts/deploy.sh` 手动部署一次含它的版本（或者第一次 clone 的就是），并设好 `refs/hebi8/live` 基线（见上一节）。
2. **生成部署 key**（在任何一台机器上，用完删掉本地那份）：

   ```bash
   ssh-keygen -t ed25519 -N '' -C hebi8-deploy -f hebi8-deploy
   ```

3. **在线上那台的 `~/.ssh/authorized_keys` 加一行**（一行，路径是线上目录的绝对路径；服务名、检查地址、密钥目录不是默认值时写在路径前面，比如 `command="HEBI8_UNIT=my-unit /home/me/hebi8/scripts/deploy-gate.sh"`）：

   ```text
   command="/home/<user>/dev/hebi8-market/scripts/deploy-gate.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… hebi8-deploy
   ```

   试一下（`-o IdentitiesOnly=yes`：不然 ssh 可能先用了你自己的 key）：`ssh -o IdentitiesOnly=yes -i hebi8-deploy <user>@<host> status 0000000000000000000000000000000000000000` 应该回答 `unclear …` 或 `not-live`，同样的参数换成 `ls` 应该是 `deploy-gate: refused`。
4. **主机指纹**：`ssh-keyscan -t ed25519 <host>`，和那台上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的指纹对一下。
5. **建 Environment**（仓库 Settings → Environments → New environment）：`production`，Deployment branches and tags 选 Selected branches and tags，只加 `master`，不加 Required reviewers。填：

   | 名字 | 种类 | 值 |
   |---|---|---|
   | `DEPLOY_HOST` | variable | `<user>@<host>` |
   | `DEPLOY_KNOWN_HOSTS` | variable | 第 4 步的那一行 |
   | `DEPLOY_SSH_KEY` | secret | 第 2 步的私钥（`hebi8-deploy` 文件的全部内容） |
   | `DEPLOY_URL` | variable | 可选，部署记录上显示的地址 |

6. **只在 tailnet 里连得到时**（能直连 ssh 的不需要）：在 Tailscale 后台建 OAuth client（Settings → OAuth clients，scope 选 Auth Keys 的 Write，tag 选 `tag:ci`），在 `production` 里放 secret `TS_OAUTH_CLIENT_ID`、`TS_OAUTH_SECRET`（放仓库级也能用，但 Environment 的 secret 只给限定分支上的 job，别的分支里改过的工作流拿不到；tag 不叫 `tag:ci` 时加变量 `TS_TAGS`）。runner 以 `tag:ci` 临时加入 tailnet，job 结束就下线。策略里要有 `"tagOwners": {"tag:ci": [...]}`，并让 `tag:ci` 只能连到线上那台的 22 端口，别的哪里都不行。
7. **issue 用谁的名义**：不配时用 github-actions。想用自己的 GitHub App：App 只要 Issues 的读写，装到这个仓库，在 `production` 里加变量 `TRIAGE_APP_CLIENT_ID`（App 设置页的 Client ID）和 secret `TRIAGE_APP_PRIVATE_KEY`（生成的私钥 `.pem` 的全部内容）。
8. **dev 只能经 PR 时**（分支保护或 ruleset）：合回 dev 的推送会被拒，工作流改开一个 master → dev 的 PR 并开启 auto-merge。要在 Settings → Actions → General 勾选 **Allow GitHub Actions to create and approve pull requests**，在 Settings → General 勾选 **Allow auto-merge**；master → dev 的 PR 只能用 merge commit 合并。

**部署失败时**，master 已经比线上新（合并在前、部署在后）：退出码 1 是确认没部署、线上已退回，往前修（新 PR）或 revert 那个 PR；退出码 3 是不知道结果，等那台连得上，在那次运行上点 **Re-run failed jobs**（线上那台是幂等的：做完了的认出来，没做完的接着做）。部署后面的步骤（tag、Release、issue、合回 dev）停了也是重跑。线上真正在跑的版本以线上目录的 `refs/hebi8/live` 和仓库的 Deployments 页（最后一次成功的部署）为准。

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
