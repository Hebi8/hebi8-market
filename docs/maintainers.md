# 维护者说明

给改这个仓库的人看：文档放哪、反馈用的 GitHub App、issue 的标签、分支与发版、正式环境、dev 实例、源码结构和验证命令。数据模型和各模块的设计见 [design.md](design.md)，给 agent 的约定见 [`AGENTS.md`](../AGENTS.md)。

## 文档放哪

| 文件 | 写什么 |
|---|---|
| [`README.md`](../README.md) | 给第一次来的人：一句话介绍、核心功能各一两句、快速开始、数据源概览、文档索引。不写操作细节 |
| [`docs/usage.md`](usage.md) | 每项功能的完整操作、快捷键、公式、警报和通知、代码指标、MCP 接入 |
| [`docs/self-hosting.md`](self-hosting.md) | 生产运行、`deploy.sh`、环境变量、vault、实例状态、多人共用、网页登录 |
| `docs/maintainers.md`（本文） | 文档约定、GitHub App、反馈标签、分支与发版、正式环境、dev 实例、源码结构、验证 |
| [`docs/design.md`](design.md) | 设计：数据模型、同步、接口、页面行为的规格 |
| [`CHANGELOG.md`](../CHANGELOG.md) | 每个版本的更新记录，给用的人看；写法见[分支与发版](#分支与发版) |

新功能或改了行为时，操作说明写进 `usage.md`（运维相关写进 `self-hosting.md`），规格写进 `design.md`；README 只在功能列表需要多一行、或快速开始变了时才改。

## 反馈用的 GitHub App

应用内反馈和登录（见 [usage.md](usage.md#帮助与反馈)）用的是公开 GitHub App「hebi8-market」，代码里只有 client id。**仓库 owner 要做的一次性设置**（详见 [`design.md`](design.md) §5.8）：在 Hebi8 组织下注册公开的 GitHub App（[预填好的注册链接](https://github.com/organizations/Hebi8/settings/apps/new?name=hebi8-market&description=hebi8%20market%20%E7%9A%84%E5%BA%94%E7%94%A8%E5%86%85%E5%8F%8D%E9%A6%88%EF%BC%9A%E7%94%A8%E4%BD%A0%E8%87%AA%E5%B7%B1%E7%9A%84%20GitHub%20%E8%B4%A6%E5%8F%B7%E5%9C%A8%20Hebi8%2Fhebi8-market%20%E4%B8%8A%E6%8F%90%E4%BA%A4%20issue&url=https%3A%2F%2Fgithub.com%2FHebi8%2Fhebi8-market&public=true&webhook_active=false&issues=write)），在 App 设置里勾选 **Enable Device Flow**，只安装到 hebi8-market，把 client id 填进 `app-info.ts` 的 `GITHUB_APP_CLIENT_ID`。

fork 想把反馈收到自己的仓库：建自己的 App，设环境变量 `HEBI8_GITHUB_CLIENT_ID` 和 `HEBI8_FEEDBACK_REPO`（见 [self-hosting.md](self-hosting.md#环境变量)）。网页登录要的 client secret 见 [self-hosting.md](self-hosting.md#网页登录可选)。

## 反馈 issue 的标签

标签不由应用加（非协作者开 issue 时 GitHub 会丢掉标签），而是仓库里的 Actions 工作流 `.github/workflows/app-feedback.yml` 读 issue 正文里的 `hebi8-context` 块：加 `from-app` 和类型标签；勾了「可以自动修复」的，作者是仓库 owner / 组织成员 / 协作者才加 `auto-fix-ok`，其他人加 `auto-fix-requested`。

所有新 issue 还会由 `.github/workflows/issue-triage.yml` 分诊（模型走 OpenAI 兼容接口，项目背景在 `.github/triage-context.md`）：打一个类型、`area:*`，以及 `triage:simple` 或 `triage:judgment`。

## 分支与发版

- **`dev`**：日常开发和每日 issue 巡检的修复都合进这里，不上线。
- **`master`**：线上版本，只进两种东西：发版（dev 快进进来）和热补丁。master 永远是 dev 的祖先，所以发版总能快进；`deploy.sh` 的快进检查保证这一点。GitHub 默认分支仍是 master，提交里的 `Fixes #n` 在推到 master 时关掉 issue。
- **版本号**：semver 0.x。minor（`0.Y.0`）= 有新功能，或 vault / `hebi8.yaml` / 密钥目录 / MCP 工具有变化；patch（`0.y.Z`）= 只有修复，热补丁总是 patch。版本号只写在 `package.json`：设置页底部、`/usage`、MCP 的 `serverInfo.version` 和页头「更新」的小圆点都读它。小圆点只为 minor 版本亮，记在浏览器的 localStorage 里，第一次来不亮。
- **tag 和 Release**：每个版本一个带注释的 tag `vX.Y.Z`，打在发布时的 master 上，一个 GitHub Release，正文是 `CHANGELOG.md` 的那一节。
- **issue 标签 `status:next-release`**：修复合进 dev 时巡检 bot 打上，并评论「已修复，下个版本上线」；发版时脚本去掉标签、评论「已在 vX.Y.Z 上线」、还开着的关掉。issue 的标签和评论都用巡检 bot 的身份（`GH_TOKEN=$(~/.local/share/hebi8/triage-token.sh)`），推送和 Release 用自己的 gh。

### 审查

每个分支——issue 修复、手动协调的改动、热补丁分支——合进 dev 或跑 `hotfix.sh` 之前，都要过两份只读审查：

| 审查者 | Lody 里的配置 |
|---|---|
| Codex | agent config `b5021347-c361-4f9d-ba50-e3526aa4d3cd`，模型 `gpt-6.1-sol`，reasoning high，模式 `agent-auto-review` |
| Argon | Google Antigravity，agent config `e641018b-df01-4323-a4d8-84c57d48acbe`，`model: gemini-4-argon-high`，`mode: yolo`（default 模式会卡在权限确认上，只读靠提示词：不改文件、不 commit、不 push、不跑部署脚本） |

- **谁开**：每日巡检里由执行 session 开两个子会话（`useCurrentSessionAsParent`，共用它的 worktree）；自己协调的分支由协调者各开一个独立会话（`worktree: true`），两边用同一份审查提示词。
- **审什么**：分支相对 dev 的改动（热补丁相对 master），按 blocking / suggestion 分级，结论原样交给协调者。
- **怎么合并**：协调者把两份合在一起，筛掉只是「多加防御性检查」的意见；真问题修完后，由提出它的那个审查者复审，直到两边都没有 blocking。

### 发版

在 checkout 了 dev 的那个目录里：

```bash
scripts/release.sh notes    # 上一个 tag 以来的 feat / fix、可能要写「升级注意」的提交、等着上线的 issue、建议的版本号
# 改写成 CHANGELOG.md 顶部的「## vX.Y.Z — 日期」一节，在 dev 上提交
scripts/release.sh 0.3.0
```

先检查：在 dev 上、工作区干净、master 是 dev 的祖先、origin 上没有本地缺的提交、tag 还不存在、版本号比 `package.json` 的大、CHANGELOG 有这一节。然后改 `package.json` 和 lockfile 的版本、把这一节的日期填成今天，提交 `chore(release): vX.Y.Z` → `deploy.sh dev`（在 homeN100 上快进、构建、重启，成功后本地 master 快进到 dev 并推送，见[正式环境](#正式环境)）→ 打 tag、推 dev 和 tag → `gh release create` → 处理 issue。

停下来时分三种情况，脚本都会说停在哪一步、接下来跑什么：

- **构建或健康检查失败**：`deploy.sh` 已经把线上退回原来的版本，脚本撤掉版本提交，什么都没推，修好再跑一次。
- **不知道线上成没成**（`deploy.sh` 退出码 3：和 N100 的 ssh 断了，事后也问不到，或者问到的状态说不清）：版本提交**保留**，什么都没推，master 没动，因为 N100 可能已经跑着它了。等 N100 连得上，在同一个目录里再跑一次 `scripts/deploy.sh dev`（热补丁是那个分支）：已经部署完的就只快进、推 master，没部署完的重新做一遍；然后跑 `scripts/release.sh publish 0.3.0`（热补丁是 `scripts/hotfix.sh publish 0.3.1`）。这期间 dev 上多着一个还没推的版本提交，别在它下面再提交，也别手动撤掉它。
- **构建、重启都成功，只是 `deploy.sh` 最后推 master 失败**：线上已经是新版本，本地 master 和 dev 上的版本提交都保留。在 devNuc 的 `~/dev/hebi8-market`（仓库的主目录）里手动 `git push origin master`，再跑 `scripts/release.sh publish 0.3.0`。
- **部署成功之后的步骤停了**（打 tag、推送、Release、issue）：跑 `scripts/release.sh publish 0.3.0`。它按版本找发布的那个提交（有 tag 用 tag，没有就用 master 上的 `chore(release): v0.3.0`），从那个提交读 `package.json` 和 CHANGELOG 核对版本，所以在哪个目录跑都行，dev 之后又有新提交也不影响；版本号对不上或没部署过就拒绝。做过的步骤会跳过：issue 的公告评论带一个隐藏标记，有了就不再评论；评论和关闭都成功后才去掉 `status:next-release`，所以中途停下的 issue 下次还会被找到。GitHub 请求失败（不是「没有这个 issue」或「这是 PR」）就停下，不会当成做完。

### 热补丁

线上的急 bug 不等发版：

```bash
git worktree add -b hotfix/<名字> <目录> master
# 在那里修，CHANGELOG.md 顶部加「## v0.3.1」一节（一行就够），提交
# 先过 Codex + Argon 双审（见上面「审查」），没有 blocking 了再跑
scripts/hotfix.sh 0.3.1
```

急也不跳过审查：跑 `hotfix.sh` 之前，分支相对 master 的改动要先过两份审查。

在热补丁分支上跑，版本必须正好是线上版本的下一个 patch（0.3.0 之后是 0.3.1）。版本提交 → `deploy.sh <这个分支>` → 打 tag、推 tag、Release，给提交里 `Fixes #n` 的 issue 评论并关掉 → **把 master 合回 dev 并推 dev**（在 checkout 了 dev 的目录里合，没有就开一个临时 worktree）。合并有冲突时脚本停下，说在哪个目录手动合；只差合回这一步时跑 `scripts/hotfix.sh merge-back`，部署之后别的步骤停了跑 `scripts/hotfix.sh publish 0.3.1`（同上，绑定版本提交，做完再合回）；推 master 失败的恢复和发版一样。

### CHANGELOG 怎么写

- `CHANGELOG.md` 是唯一的更新记录：`/changelog` 页和 GitHub Release 的正文都取它。
- 中文，站在用的人的角度，一行一条：现在能做什么、什么不再出错；不写实现、不写 commit 号，不逐条抄 commit。
- 每个版本一节 `## vX.Y.Z — YYYY-MM-DD`，最新的在最上面，日期发版时由脚本填；按需分「新功能」「修复」「升级注意」小节。
- 「升级注意」写给自己部署的人：vault / `hebi8.yaml` 的格式、要手动迁移的东西、密钥目录里的文件、MCP 工具的增删改。
- 不写相对链接：在 `/changelog` 页上会指错地方。

## 正式环境

线上实例跑在 **homeN100**（家里的 N100 小机，Ubuntu 24.04）：**https://market-hebi8.dreaife.tokyo**，Tailscale 上是 http://100.102.150.101:8808。2026-10-16 之前在 devNuc（开发机，agent 在上面构建、会重启），所以搬了出来。

| 在哪（homeN100） | 是什么 |
|---|---|
| `~/dev/hebi8-market` | 线上目录：master 的 checkout，`vault/`、`data/hebi8.db` 在里面 |
| `~/.config/hebi8/market/` | 密钥目录（700 / 600） |
| systemd 用户服务 `hebi8-market` | `next start -H 100.102.150.101 -p 8808`；Node 22 来自 unit 里的 `PATH`（`~/.local/share/hebi8/node` 链到 nvm 的 v22.22.3），`deploy.sh` 构建时也用它，better-sqlite3 是给它编译的 |
| `~/services/hebi8-tunnel` | 只管这个域名的 Cloudflare Tunnel（`hebi8-market`，容器 `hebi8-tunnel`），和 N100 自己的 `cloudflared.service` 互不相干 |
| `~/dev/hebi8-gpu-prices` | 数据集 `cnCDIY` 的 clone；用户 timer `hebi8-gpu-prices-pull`（06:50 / 08:50 JST）从 devNuc 拉，OCR 更新仍在 devNuc 上跑 |
| `~/backups/hebi8/` | 每次部署前的备份 |

还留在 devNuc 上的：仓库的主目录 `~/dev/hebi8-market`（各个 worktree 都挂在它上面，它的 master 就是发布过的版本；服务已停用）；Telegram 走 devNuc 上共用的本地 Bot API（`~/services/telegram-bot-api`），由 devNuc 的 `hebi8-telegram-forward` 把 100.92.194.31:18081 转给它，只放 N100 的地址进来，所以 **Telegram 推送依赖 devNuc 在线**；旧地址 http://100.92.194.31:8808 由 `hebi8-old-address` 308 到新地址（过渡用）。两个都在 devNuc 的 `~/services/hebi8-n100-bridge/`。

**部署**：只经 `release.sh` / `hotfix.sh`，它们在 devNuc 的 dev（或热补丁）checkout 里调同目录的 `scripts/deploy.sh <分支>`：

1. 在 devNuc 的 `~/dev/hebi8-market`（`HEBI8_REPO`）检查：在 master、干净、分支是 master 的快进。
2. 把那个 commit 用 git 经 ssh 直接推进 N100 线上目录的 `refs/hebi8/deploy`（不经 GitHub，没上线的版本提交不会出现在 origin），再用 ssh 在 N100 上跑**同一个** `deploy.sh live <commit>`（上传的是发版 checkout 里的这份，不是主目录里的旧版）：备份 → 快进 master → 依赖有变就 `npm ci` → 构建 → 重启 → 健康检查（默认是 unit 里 `next start -H … -p …` 的地址，即 http://100.102.150.101:8808/），通过后把这个 commit 记进线上目录的 `refs/hebi8/live`；构建或检查失败就退回上一个记下的 commit 重新构建。
3. N100 成功后，devNuc 的 master 快进到这个 commit，由 devNuc 推 master（推送只在 devNuc，用自己的身份）。

**线上跑的是哪个版本看 `refs/hebi8/live`，不看 HEAD**：HEAD 在快进时就动了，那时还没构建、没检查。N100 线上目录的 `.git` 里有三样：

- `refs/hebi8/live`：最后一次确认在跑的 commit，部署的健康检查通过、或者回滚后旧版本的检查通过才写。**新机器第一次部署前要手动设基线**：确认实例正在跑而且页面 200，在线上目录 `git update-ref refs/hebi8/live <它跑的完整 commit>`。没有基线时部署照常走（每次都 `npm ci`），但不会跳过，`status` 也只说「不清楚」。
- `hebi8-deploy.pending`（进行中标记）：动 HEAD 之前写下（写临时文件再改名，不会只写了一半），内容是目标、从哪个版本出发、这次的备份目录、开始时间；只有两种情况才删：新版本检查通过并写好记录之后，或者回滚完、旧版本检查通过之后。它还在，就说明有一次部署或回滚没做完，不管 HEAD 和记录是什么都当作说不清。
- `hebi8-deploy.lock`：同一时间只有一个部署，`status` 也看它。

`deploy.sh` 的退出码：0 已部署（master 已快进；之后推送失败是 git 自己的退出码）；1 没部署，线上跑的还是原来的；3 不知道。N100 那边只要不是正常返回 0（不管是部署失败、ssh 断了、还是 ssh 包装自己出错），都再连一次问 `deploy.sh status`，由它定：

| `status` | 条件 | `deploy.sh` |
|---|---|---|
| done | 没有标记、没人持锁、记录是这个 commit、HEAD 也是、页面 200 | 0，接着快进、推 master |
| not-live | 没有标记、没人持锁、有记录且不是这个 commit、HEAD 等于记录、页面 200 | 1，`release.sh` / `hotfix.sh` 撤掉版本提交 |
| busy / unclear / 连不上 | 有人持锁、有标记、没有记录、页面不通、HEAD 和记录对不上，或者问不到 | 3，版本提交保留 |

回滚时旧版本也起不来、或者新版本已经是记录里的那个却不通（没有更早的可退），都留着标记退出 3。续跑同一个部署：没有标记、记录和 HEAD 都是它、页面 200 才跳过构建；没有标记就从记录的版本正常走一遍。**有标记就是接着那次没做完的**：出发的版本和备份都用标记里的，不再备份（那次的 `npm ci` 可能已经清空了 `node_modules`，加载不了 better-sqlite3 也不影响续跑），一律 `npm ci`；目标相同就不动标记，换了目标（之后又有新提交）才整个换掉，出发的版本和备份照旧。上一次断线后还在跑的会先等它跑完（最多 15 分钟）。`HEBI8_LIVE_HOST`（默认 `dreaife@100.102.150.101`，`local` = 在本机部署）、`HEBI8_LIVE`（线上目录，相对 N100 的 home）、`HEBI8_UNIT`、`HEBI8_HEALTH_URL`、`HEBI8_SECRETS` 可改；后四个设了会一起带到 N100。

**日志**：在 N100 上 `journalctl --user -u hebi8-market -f`（`[hebi8m]` 是调度和同步）；隧道 `docker logs hebi8-tunnel`。从 devNuc：`ssh dreaife@100.102.150.101 'journalctl --user -u hebi8-market -n 100'`。

**临时退回上一个版本**（新版本有急问题、热补丁一时出不来）：只动 N100 上跑的版本，**devNuc 的 master 不动，一直等于 origin/master**（不然之后 `release.sh` / `hotfix.sh` 会因为「origin/master 有本地缺的提交」拒绝）。

整段拿着部署锁，按和部署一样的规则写进行中标记（这期间 `status` 只会说「说不清」），旧版本检查通过后才写记录、删标记：

```bash
# 在 N100 上
cd ~/dev/hebi8-market
export PATH=$HOME/.local/share/hebi8/node/bin:$PATH   # 服务用的 Node 22；用别的版本 npm ci 会弄坏 better-sqlite3
exec 9>.git/hebi8-deploy.lock && flock 9
old=$(git rev-parse 'v0.3.0^{commit}')               # 上一个版本；^{commit}：tag 本身是附注 tag 对象，不是 commit
printf 'target %s\nfrom %s\nbackup\nstarted %s\n' "$old" "$(git rev-parse refs/hebi8/live)" "$(date -Is)" > .git/hebi8-deploy.pending.tmp
mv .git/hebi8-deploy.pending.tmp .git/hebi8-deploy.pending
git reset --hard "$old"
systemctl --user stop hebi8-market && npm ci && npm run build && systemctl --user start hebi8-market
curl -s -o /dev/null -w '%{http_code}\n' http://100.102.150.101:8808/   # 200 才做下一行；不是 200 就先修，标记留着
git update-ref refs/hebi8/live "$old" && rm .git/hebi8-deploy.pending
exec 9>&-
```

数据也要退回就先停服务，从 `~/backups/hebi8/<时间>-deploy/` 拷回 `vault/`、密钥目录，`hebi8.db` 放回 `data/`。

这之后是一段临时状态：N100 跑旧版本（`/usage` 的版本号是旧的），master、tag 和 GitHub Release 还是新版本。修复在最新发布的提交上做：从 master 开热补丁分支，`scripts/hotfix.sh 0.4.1`，部署时 N100 从旧版本直接快进到热补丁。不修、只想回到 master 上的版本：在 devNuc 的 `~/dev/hebi8-market` 里 `scripts/deploy.sh master`。

## dev 实例

平时的开发合进 `dev`，`dev` 快进到 master 才上线。在那之前想先用上新功能，就开 dev 实例：**http://100.107.245.93:8809/**（memoh-codex 的 Tailscale 地址，没有公网入口）。它跟着 `dev` 分支自动更新，每天用线上 owner 的 vault 覆盖一遍，所以看到的是自己的自选、警报和画线。

- **单用户模式**：yaml 里的 `owner` 去掉了，经 Tailscale 打开就能改，不用登录。改动第二天被覆盖，这是有意的：只单向从线上到 dev。
- **不发通知**：密钥目录是它自己的、空的（`/data/hebi8-dev/secrets`），没有任何通道，警报照常判断但不发出，不会和线上重复推送。不要把线上的 `~/.config/hebi8/market` 拷过去。
- **行情自己同步**：按 yaml 里的 `sync.at` 自己拉 K 线、每 5 分钟取报价，走的是 memoh 的出口 IP，不占线上的配额。

脚本在 `scripts/dev-instance/`，memoh 上用的是装进 `/data/hebi8-dev/bin/` 的那份。memoh 没有 systemd 和 cron，`hebi8-dev.sh daemon` 自己当看门狗：每 15 秒看一眼应用，没在跑就拉起来；每 10 分钟 fetch 一次；到了每天的同步时间就同步。开机时 memoh 的自启项（`~/.config/autostart` → `/data/services/start.sh`）最后一步调 `hebi8-dev.sh start`。

| 路径（`/data/hebi8-dev/`） | 是什么 |
|---|---|
| `config.env` | 跟踪的分支 `BRANCH`，以及 `HOST`、`PORT`、`SYNC_AT` / `SYNC_TZ`（默认 04:30 Asia/Tokyo，避开线上 07:30 / 17:30 的同步）、`UPDATE_EVERY`；缺省值在脚本开头 |
| `repo/` | 仓库的 clone；每个版本是它的一个 worktree |
| `releases/<commit>/`、`current` | 构建好的版本，`current` 指向正在跑的那个；保留最近 3 个 |
| `vault/`、`data/hebi8.db`、`datasets/` | 每天从线上换进来的 vault、缓存快照和本机数据集 |
| `logs/daemon.log` | 更新、回滚、同步、重启，一行一件事 |
| `logs/app.log`、`logs/build-<commit>.log` | `next start` 的输出（`[hebi8m]` 调度日志也在这里）；每次构建的输出 |
| `state/failed` | 构建失败或起不来的 commit，分支动了之前不再重试 |

**自动更新**：分支动了，就在 `releases/<新 commit>/` 里另建一份：`package-lock.json` 和正在跑的版本一样就硬链接它的 `node_modules`，否则 `npm ci`（better-sqlite3 要现场编译，缺编译器时自动 `apt-get install build-essential`）；`npm run build` 的时候旧版本照常服务。构建成功才停旧的、起新的，60 秒内首页不返回 200 就切回旧的。构建或启动失败都记进 `state/failed`，旧版本一直在跑。不推送，不备份。

**每天同步**：由 memoh 拉，经 `lody-lan lan shell homeN100` 在线上目录里用线上服务的 Node（`~/.local/share/hebi8/node`）跑 `export.mjs`（只读），带回三样，换进去后重启：

- 根 vault（owner 的）：`hebi8.yaml`、`notes/`、`journal/`、`charts/`。**`users/` 不带**，别人的 vault 不离开线上。到了 dev 上由 `prepare-vault.mjs` 去掉 `owner`、把本机数据集改指 `datasets/<名字>`。
- 数据库快照（`db.backup()`），省得冷启动全量拉：`stats`、`alert_state` 只留根 vault（`vault = ''`）的行，`traffic`、`visitors`、`upstream`、`usage_alerts` 清空；K 线、标的、报价、标的资料原样。
- 本机目录数据集（如 `cnCDIY`）的清单和 CSV；远端仓库的数据集 dev 自己克隆。

没同步的：线上的密钥目录（会话、通知通道、Telegram、网页推送、GitHub App、MCP 令牌）一概不碰。memoh 那时不在线就在它回来后补一次；失败了半小时后再试。

常用命令（在 memoh 上；从 devNuc 是 `lody-lan lan shell memoh-codex -- /data/hebi8-dev/bin/hebi8-dev.sh status`）：

```bash
H=/data/hebi8-dev/bin/hebi8-dev.sh
$H status                       # 地址、分支、正在跑的 commit、上次检查和同步
tail -f /data/hebi8-dev/logs/daemon.log
$H branch dev                   # 改跟踪的分支（写进 config.env）并立刻更新；也可以填某个 commit
$H update [--force]             # 立刻 fetch；--force 连 state/failed 里的也重试
$H sync                         # 立刻从线上同步一次
$H restart                      # 只重启应用
$H stop | start                 # 停 / 起看门狗和应用；stop 之后到下次开机或 start 之前都不会自己起来
```

脚本本身不随分支自动更新（看门狗不替换自己）。改了 `scripts/dev-instance/`、dev 实例跑上那个版本之后：`$H install /data/hebi8-dev/current/scripts/dev-instance && $H stop && $H start`。

## 源码结构

```text
src/
├── app/
│   ├── page.tsx              总览（RSC，直接读 vault 和 SQLite）
│   ├── chart/[key]/page.tsx  图表页 /chart/yahoo%3ASPY
│   ├── review/page.tsx       复盘
│   ├── settings/page.tsx     设置：agent 的接入令牌；从 TradingView 导入自选和画线、导出自选
│   ├── changelog/page.tsx    更新记录：渲染仓库根的 CHANGELOG.md（页头「更新」和它的小圆点是 ChangelogLink）
│   ├── claim/page.tsx        「在其他设备上登录」的确认页
│   ├── actions.ts            Server Actions：写 yaml / 笔记 / 日志 / 图表状态，刷新；和 agent 共用的写操作是 lib/ops.ts 的薄壳
│   ├── token-actions.ts      Server Actions：生成 / 吊销 agent 的令牌
│   ├── mcp/route.ts          MCP 入口（Streamable HTTP，带个人令牌）
│   ├── tv-actions.ts         Server Actions：TradingView 导入（tv-import.ts / tv-drawings.ts / tv-layout.ts 在 lib）
│   └── api/
│       ├── bars/             日/3日/周/月/季 K 线 + 对齐好的引用标的
│       ├── search/           外部搜索（Yahoo / TradingView / Binance），本地匹配在浏览器里
│       ├── help/             帮助与登录抽屉的数据：登录状态、反馈设置（只读本地）
│       ├── notify/           当前登录者的通知通道：摘要、Telegram 绑定、webhook、推送订阅、测试消息
│       └── github/           网页登录（login、callback）、device flow 登录、把登录带到另一台设备（claim）、退出、提交 / 列出反馈 issue
├── instrumentation.ts        启动应用内调度器
├── components/               AgentTokens（设置页的令牌）/ TvImport（设置页的导入导出）/ UiProvider（搜索浮层、帮助与登录抽屉、toast、快捷键）/ HelpPanel（使用、反馈）/ AccountPanel（登录、通知设置）/ Guide / SymbolSearch / Overview / RowMenu / ChartView / KChart / ChartLegend / IndicatorDialog / CompareDialog / WatchlistPanel / FormulaEditor / NotesPanel …
├── indicators/               指标目录、代码指标、公式引擎（formula.ts）、纯计算函数
└── lib/
    ├── search.ts wellknown.ts 搜索的纯函数（匹配、过滤、去重、排序、分组推断）与内置字典
    ├── use-autosave.ts       笔记 / 复盘的自动保存
    ├── github.ts secrets.ts  GitHub 调用（网页登录、device flow 登录、刷新、issue）与 ~/.config/hebi8/market 里的登录会话、agent 令牌的哈希
    ├── claim.ts              「在其他设备上登录」的一次性码（只在内存里，2 分钟）
    ├── feedback.ts           反馈 issue 的正文、hebi8-context 格式与 GitHub 网页预填链接
    ├── sources/              yahoo / binance / tradingview / dataset（自定义数据集）适配器
    ├── vault.ts config.ts    vault 的读写层（按目录，根 vault 或 users/<login>/）、hebi8.yaml 的类型与校验
    ├── viewer.ts             这次请求是谁、看哪个 vault、能不能写（共用实例）；令牌也在这里变成同一个 viewer
    ├── ops.ts                页面和 agent 共用的写操作（自选、警报、公式指标、追加笔记和日志），入参是 viewer
    ├── mcp/                  MCP 入口：server.ts（SDK 的无状态 transport、令牌校验）、tools.ts（工具）、reference.ts（公式和警报的说明）
    ├── scan.ts               一条公式扫一批标的、回看历史上哪些天成立（只读缓存）
    ├── search-external.ts    外部搜索的联网部分，/api/search 和 MCP 共用
    ├── db.ts store.ts        SQLite 缓存（symbols、bars、stats、alert_state）
    ├── sync.ts scheduler.ts  同步、同步后算 stats 和通知、每日定时
    ├── series.ts synth.ts    3日/周/月/季线合成、对齐、合成标的
    ├── stats.ts conditions.ts 总览统计与公式警报的求值
    ├── alerts.ts notify.ts   通知：规则判定与状态（按 vault）、每个人的通道、Telegram / webhook / 推送投递
    ├── push.ts push-client.ts 网页推送：VAPID 密钥、发往推送服务；浏览器端的订阅和不能开的原因
    ├── alert-conds.ts        价格警报的九种条件（纯函数，图表的警报对话框也用）
    ├── quotes.ts             盘中轮询：5 分钟 / 1 小时取最新价，内存里拼今天的日线，判断警报
    ├── profile.ts profiles.ts 标的资料（商品详情）：到期判断和现算的市值 / PE（纯函数）；缓存表、每周刷新、译文
    ├── links.ts              商品详情的相关链接：披露页的拼接规则、基金发行商表、宏观资产的官方页面表（纯函数）
    ├── translate.ts          把简介翻成中文：服务端唯一的模型调用，配置在 llm.json
    ├── telegram.ts           Telegram 绑定：一次性码、getMe、有待绑定码时才长轮询 getUpdates
    └── time.ts tz.ts week.ts 交易日换算、时区、ISO 周
public/sw.js                  service worker：显示推送、点通知打开图表、连不上时的一页说明；什么都不缓存
vault.example/hebi8.yaml      首次运行的起点
tests/                        vitest
```

## 验证

```bash
npm test           # 单元测试
npm run typecheck
npm run lint
npm run build
```
