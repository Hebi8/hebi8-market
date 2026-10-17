# 维护者说明

给改这个仓库的人看：文档放哪、反馈用的 GitHub App、issue 的标签、分支与发版、正式环境、dev 实例、源码结构和验证命令。数据模型和各模块的设计见 [design.md](design.md)，给 agent 的约定见 [`AGENTS.md`](../AGENTS.md)。

## 文档放哪

| 文件 | 写什么 |
|---|---|
| [`README.md`](../README.md) | 给第一次来的人：一句话介绍、核心功能各一两句、快速开始、数据源概览、文档索引。不写操作细节 |
| [`docs/usage.md`](usage.md) | 每项功能的完整操作、快捷键、公式、警报和通知、代码指标、MCP 接入 |
| [`docs/self-hosting.md`](self-hosting.md) | 生产运行、`deploy.sh`、GitHub Actions 自动部署、环境变量、vault、实例状态、多人共用、网页登录 |
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

- **`dev`**：日常开发和每日 issue 巡检的修复都经 PR 合进这里，不上线；[dev 实例](#dev-实例)每分钟自己看一次 origin 的 dev，合并后最多约一分钟（加上构建的时间）就更新上去。**进 dev 的 PR** 由巡检协调者在 Codex + Argon 两份审查都通过后自己合并（`gh pr merge <n> --merge --delete-branch`，用户的 gh 身份），用户也可以随时手动合。dev 在 GitHub 上合并，本地的 `dev` 分支会落后：要「基于 dev」或「和 dev 比」的地方一律先 `git fetch origin`，再用 `origin/dev`（脚本都这样做），不要 checkout 或更新本地的 `dev`。
- **`master`**：线上版本，只经两种 PR 进来：Release PR（`release/vX.Y.Z` → master）和热补丁 PR（`hotfix/vX.Y.Z` → master），**只由用户手动合并**（协调者和 agent 不合），**都用 Create a merge commit 合并**（squash / rebase 会让 master 不再是 dev 的祖先）。**合并就是批准**：推到 master 就触发 Deploy 工作流部署到线上，没有额外的审批。**master 是 dev 的祖先**是发版的前提，但不是时时成立：PR 的合并提交进了 master、还没合回 dev 的这段时间不成立，部署成功后工作流把 master 合回 dev 才恢复。部署失败（或合回卡住）时不会自动合回，要手动补（见下面「部署失败时」），不然下一次 `release.sh` 会因为「origin/master 有 origin/dev 没有的提交」拒绝。GitHub 默认分支仍是 master，提交里的 `Fixes #n` 在合进 master 时关掉 issue。
- **版本号**：semver 0.x。minor（`0.Y.0`）= 有新功能，或 vault / `hebi8.yaml` / 密钥目录 / MCP 工具有变化；patch（`0.y.Z`）= 只有修复，热补丁总是 patch。版本号只写在 `package.json`：设置页底部、`/usage`、MCP 的 `serverInfo.version` 和页头「更新」的小圆点都读它。小圆点只为 minor 版本亮，记在浏览器的 localStorage 里，第一次来不亮。
- **tag 和 Release**：每个版本一个带注释的 tag `vX.Y.Z`，打在部署上线的那个提交上（PR 的合并提交），一个 GitHub Release，正文是 `CHANGELOG.md` 的那一节。由工作流在部署成功后做，身份是 github-actions。
- **issue 标签 `status:next-release`**：修复合进 dev 时巡检 bot 打上，并评论「已修复，下个版本上线」；发版部署成功后，工作流对**修复确实在这次发布里**的（从上一个 tag 到发布的提交，有提交信息写着 `Fixes #n` / `closes #n` 等）评论「已在 vX.Y.Z 上线」、还开着的关掉、去掉标签；Release PR 切出之后才合进 dev 的修复不在发布里，标签留着，日志里写一行 `kept #n`，等下一个版本。所以修复的提交信息里要有 `Fixes #n`（巡检的修复都有），只写在 PR 正文里不算。
- **用谁的身份**：开 PR、PR 上的评论（包括审查结论）、合并 PR 都用用户自己的 gh；issue 的标签和评论用巡检 bot（GitHub App「hebi8/market triage」，只有 Issues 读写，不加 Contents / Pull requests 权限；工作流里用 Secrets 里的私钥现取 token，本机用 `~/.local/share/hebi8/triage-token.sh`）。部署工作流里的 tag、Release、合回 dev（含它开的 master → dev PR）用工作流自己的 `GITHUB_TOKEN`。

### 部署工作流

`.github/workflows/deploy.yml`，只在 push 到 master 和对 master 手动运行（Actions 页的 Run workflow）时跑，**从不在 pull_request 上跑**，只部署到 `production`（工作流里判断分支，不只靠 Environment 的分支限定）；仓库设置里没有 `production` 这个 Environment 就跳过，所以 fork 里推送不报错，也不连任何人的机器。dev 不经工作流：[dev 实例](#dev-实例)自己拉，没有任何东西从外面连进来部署它。配置（Environment 的 variables / secrets、Tailscale、forced command）见 [self-hosting.md](self-hosting.md#用-github-actions-自动部署可选)。

| 触发 | job | 做什么 |
|---|---|---|
| push 到 master（合并 Release / 热补丁 PR） | `production` | GitHub 托管的 runner ssh 到线上机器（Environment 里有 Tailscale 的 secret 时先以 `tag:ci` 临时加入 tailnet），部署 key 的 forced command 是 `scripts/deploy-gate.sh`：线上机器自己 `git fetch origin master`，确认这个 commit 在 master 上，再用这个 commit 的 `deploy.sh live <commit>`（备份、快进、构建、重启、健康检查、失败回滚，见[正式环境](#正式环境)）→ 成功后：版本没有 tag 就打 tag、发 Release、处理 issue → 把 master 合回 dev |

- **版本从提交里读**：部署成功后读这个提交的 `package.json`。这个版本还没有 tag（或 tag 就在这个提交上：重跑）才打 tag、发 Release、处理 issue；已经在别的提交上（不是 Release / 热补丁 PR 的普通推送）就只部署。版本提交是 `chore(hotfix): vX.Y.Z` 的按热补丁处理（只认提交里的 `Fixes #n`，不碰 `status:next-release`），其余按发版。
- **同时只部署一个**：production 的 `concurrency` 不取消正在跑的，后来的排队（GitHub 每组只留一个排队的，连续几次推送时中间的会被最新的那次替掉；最新的提交包含它们）。
- **合回 dev**：先用 `GITHUB_TOKEN` 直接推 dev（能快进就快进，否则一个 `Merge master (vX.Y.Z) into dev` 合并提交）。dev 开了「只能经 PR」的保护、推送被拒时，自动开一个 master → dev 的 PR 并开启 auto-merge，GitHub 说不需要等就直接合并（merge commit）；两样都不允许时留一条警告，下次发版前自己用 merge commit 合掉（`release.sh` 会因为 master 不是 dev 的祖先拒绝开 Release PR）。合并有冲突时 job 标红：从 dev 开分支 `git merge origin/master`，解决后经 PR 合进 dev。合回 dev 之后 dev 实例照常在一分钟内自己拉到。改了 `.github/workflows/` 的热补丁，`GITHUB_TOKEN` 推不进 dev（它没有 workflows 权限），也走 PR。

**部署失败时**（GitOps 的正常取舍）：master 已经合进去了，比线上新。

- 退出码 1（`deploy.sh` 确认没部署：构建或检查失败，线上已退回原来的版本）：job 标红，tag、Release、issue、合回 dev 都没做。master 上已经有这个版本号（`package.json`），但它没有 tag、没上线。往前修，二选一：
  - **热补丁**（快）：`scripts/hotfix.sh start <下一个 patch>`，从 master 修，合并后它带着没上线的那个版本的内容一起上线，issue 按从上一个 tag 起的提交公告，部署成功后照常合回 dev。
  - **修在 dev 上、再发一个版本**：先 `scripts/hotfix.sh merge-back` 把 master 合回 dev（dev 只收 PR 时它开 master → dev 的 PR，用 merge commit 合掉），再把修复经 PR 合进 dev，然后 `release.sh <更大的版本>`（同一个版本号会被拒绝：master 上已经是它了）。
  - 或者在 GitHub 上 revert 那个 PR 再合，回到原来的版本号；之后同样先合回再发版。

  下一次推送会从线上跑着的版本直接快进过去。
- 退出码 3（不知道结果：ssh 断了、事后也问不到，或者问到的状态说不清）：job 标红，日志里写着续跑方法：**等线上机器连得上，在这次运行的页面上 Re-run failed jobs**。线上那边是幂等的：已经部署完的认出来直接返回，没做完的从进行中标记接着做或重做。
- 部署成功、后面的步骤停了（打 tag、Release、issue、合回 dev，比如 GitHub 请求失败）：同样 Re-run failed jobs，部署那一步认出已经在跑，做过的步骤跳过（issue 的公告评论带隐藏标记，有了就不再评论；评论和关闭都成功后才去标签）。GitHub 请求失败（不是「没有这个 issue」或「这是 PR」）就停下，不当成做完。

**线上真正跑的是哪个版本**以线上机器上线上目录的 `refs/hebi8/live` 为准，GitHub 上看仓库的 Deployments（production 最后一次成功的部署），不看 master。

### 审查

每个分支——issue 修复、手动协调的改动、热补丁分支——合进 dev 之前、开热补丁 PR 之前，都要过两份只读审查。Release PR 不用：它的内容都已经在 dev 上审过，只多了版本提交。

| 审查者 | Lody 里的配置 |
|---|---|
| Codex | agent config `b5021347-c361-4f9d-ba50-e3526aa4d3cd`，模型 `gpt-6.1-sol`，reasoning high，模式 `agent-auto-review` |
| Argon | Google Antigravity，agent config `e641018b-df01-4323-a4d8-84c57d48acbe`，`model: gemini-4-argon-high`，`mode: yolo`（default 模式会卡在权限确认上，只读靠提示词：不改文件、不 commit、不 push、不跑部署脚本） |

- **谁开**：每日巡检里由执行 session 开两个子会话（`useCurrentSessionAsParent`，共用它的 worktree）；自己协调的分支由协调者各开一个独立会话（`worktree: true`），两边用同一份审查提示词。
- **审什么**：先 `git fetch origin`，审分支相对 `origin/dev` 的改动（热补丁相对 `origin/master`），按 blocking / suggestion 分级，结论原样交给协调者。
- **怎么处理意见**：协调者把两份合在一起，筛掉只是「多加防御性检查」的意见；真问题修完后，由提出它的那个审查者复审，直到两边都没有 blocking。
- **结论贴在 PR 上**：两份审查（最后一轮的结论，以及修过什么）作为 PR 评论贴上，用户的 gh 身份（`gh pr comment <n> --body-file …`）。
- **谁合并**：进 dev 的 PR，两边都没有 blocking 后协调者 `gh pr merge <n> --merge --delete-branch`；用户也可以随时自己合。合并后 dev 实例约一分钟内自己拉到（加上构建的几分钟），到没到看 dev 实例那台上的 `journalctl --user -u hebi8-dev-poll`（见 [dev 实例](#dev-实例)）。热补丁 PR 和 Release PR 进 master，只由用户手动合并。

### 发版

在仓库的任意一个 checkout 里：

```bash
scripts/release.sh notes    # origin/dev 上一个 tag 以来的 feat / fix、可能要写「升级注意」的提交、等着上线的 issue、建议的版本号
# 改写成 CHANGELOG.md 顶部的「## vX.Y.Z — 日期」一节，经 PR 合进 dev
scripts/release.sh 0.3.0    # 开 Release PR
# 在 GitHub 上看一遍 PR，用 Create a merge commit 合并 → Deploy 工作流部署、发布
```

`release.sh 0.3.0` 先 `git fetch`，检查：origin 的 master 是 dev 的祖先、tag 还不存在、版本号比 master 上的 `package.json` 大、origin 的 dev 上 CHANGELOG 有这一节。然后在一个临时 worktree 里从 origin/dev 切 `release/v0.3.0`，做版本提交 `chore(release): v0.3.0`（`package.json` 和 lockfile 的版本，这一节的日期填成今天），推这个分支，用你自己的 gh 开 PR → master，正文是 CHANGELOG 那一节，末尾提醒用 merge commit 合并。你的 checkout 一个都不动；推送或开 PR 失败了再跑一次，它认出分支上已有的版本提交接着做；但只在这个分支还是「当前的 origin/dev + 版本提交」时：dev 之后又动过（比如 PR 关掉了、过几天再发），它停下来让你先删掉旧的 `release/v0.3.0`（本地和 origin 上的），免得发出去的漏掉 dev 后来的提交。

切分支而不是在 dev 上做版本提交：dev 只经 PR 进东西，没审过的提交不直接推上去；不想发了关掉 PR、删掉分支就行，dev 上什么都不用撤；版本提交在部署后随合回 dev 进入 dev。PR 开着的时候 dev 照常往前走，这次发的就是切分支时的 dev，之后的进下一个版本。CHANGELOG 的日期是开 PR 那天，隔几天才合就在 release 分支上改一下。

### 热补丁

线上的急 bug 不等发版：

```bash
scripts/hotfix.sh start 0.3.1   # 在一个干净的 checkout 里：从 origin/master 切 hotfix/v0.3.1 并切过去
# 在那里修，CHANGELOG.md 顶部加「## v0.3.1」一节（一行就够），提交
# 先过 Codex + Argon 双审（见上面「审查」），没有 blocking 了再跑
scripts/hotfix.sh 0.3.1         # 版本提交 chore(hotfix): v0.3.1，推分支，开 PR → master
# 用 Create a merge commit 合并 → 同一个 Deploy 工作流
```

急也不跳过审查。版本必须正好是 master 上版本的下一个 patch（0.3.0 之后是 0.3.1），分支要基于当前的 origin/master。合并后工作流部署、打 tag、发 Release、给提交里 `Fixes #n` 的 issue 评论并关掉，再把 master 合回 dev。

### 不用 Actions 部署

`release.sh --deploy 0.3.0` / `hotfix.sh --deploy 0.3.1` 是有工作流之前的路：在本机做版本提交、调 `scripts/deploy.sh`（部署到 `deploy.env` 里的那台，见[正式环境](#正式环境)）、成功后推 master、打 tag、发 Release、处理 issue（热补丁再合回 dev）。给不用 Actions 的自部署者；本仓库只在工作流跑不了时应急用，推 master 之后工作流照样会对同一个提交跑一遍：部署那一步认出已经在跑，tag 和 Release 已经有了就跳过。master 平时只在 GitHub 上动，所以先把仓库主目录的 master 快进到 origin/master（`git -C ~/dev/hebi8-market merge --ff-only origin/master`），不然脚本会因为「origin/master 有本地缺的提交」拒绝。

`--deploy` 发版和 Release PR 一样从 origin/dev 切 `release/vX.Y.Z`（临时 worktree 里，任意 checkout 都能跑；检查同上，再加上主目录的 master 有 origin/master 的全部提交），部署的是这个分支；热补丁在热补丁分支上跑。合回 dev 也和工作流一样：合进 origin/dev 推上去，dev 只收 PR 时改开 master → dev 的 PR（用你自己的 gh）。停下来时脚本都会说停在哪一步、接下来跑什么：

- **构建或健康检查失败**：`deploy.sh` 已经把线上退回原来的版本，脚本撤掉版本提交，什么都没推，修好再跑一次。
- **不知道线上成没成**（`deploy.sh` 退出码 3）：版本提交**保留**在 release / 热补丁分支上，什么都没推，master 没动，因为线上可能已经跑着它了。等那台连得上，**再跑一次同样的命令**（`scripts/release.sh --deploy 0.3.0` / `scripts/hotfix.sh --deploy 0.3.1`）：它认出分支上的版本提交接着用，`deploy.sh` 已经部署完的就只快进、推 master，没部署完的重新做一遍。这期间别在版本提交下面再提交，也别手动撤掉它。
- **构建、重启都成功，只是 `deploy.sh` 最后推 master 失败**：线上已经是新版本，本地 master 和版本提交都保留。在仓库的主目录里手动 `git push origin master`，再跑 `publish`。
- **部署成功之后的步骤停了**（打 tag、推送、Release、issue、合回 dev）：跑 `scripts/release.sh publish 0.3.0`（热补丁 `scripts/hotfix.sh publish 0.3.1`），做完再合回 dev。它按版本找发布的那个提交（有 tag 用 tag，没有就用 master 上的版本提交），从那个提交读 `package.json` 和 CHANGELOG 核对版本，所以在哪个目录跑都行；版本号对不上或没部署过就拒绝，做过的步骤跳过。只差合回 dev 时跑 `scripts/hotfix.sh merge-back`。

### CHANGELOG 怎么写

- `CHANGELOG.md` 是唯一的更新记录：`/changelog` 页和 GitHub Release 的正文都取它。
- 中文，站在用的人的角度，一行一条：现在能做什么、什么不再出错；不写实现、不写 commit 号，不逐条抄 commit。
- 每个版本一节 `## vX.Y.Z — YYYY-MM-DD`，最新的在最上面，日期发版时由脚本填；按需分「新功能」「修复」「升级注意」小节。
- 「升级注意」写给自己部署的人：vault / `hebi8.yaml` 的格式、要手动迁移的东西、密钥目录里的文件、MCP 工具的增删改。
- 不写相对链接：在 `/changelog` 页上会指错地方。

## 正式环境

线上实例跑在一台 VPS 上（下面叫「线上机器」）：**https://market-hebi8.dreaife.tokyo**，经 Cloudflare Tunnel 进来。应用只听本机的 `127.0.0.1:8808`，不为它开任何入站端口；对外只有 SSH（只认 key），部署和维护都从这里进。实际的主机、地址、用户名不写进仓库：部署工作流从 `production` Environment 读，手动部署从仓库主目录的 `deploy.env` 读。以前它在开发机上（agent 在上面构建、会重启），后来在家里的小机上，2026-10-17 搬到了 VPS。

| 在哪（线上机器） | 是什么 |
|---|---|
| `~/dev/hebi8-market` | 线上目录：master 的 checkout（`origin` 是 GitHub 上的这个仓库，https），`vault/`、`data/hebi8.db` 在里面 |
| `~/.config/hebi8/market/` | 密钥目录（700 / 600） |
| systemd 用户服务 `hebi8-market` | `next start -H 127.0.0.1 -p 8808`（linger 开着，开机自己起来）；Node 22 来自 unit 里的 `PATH`（`~/.local/share/hebi8/node` 链到旁边 nodejs.org 官方的 v22 二进制包），`deploy.sh` 构建时也用它；better-sqlite3 要现场编译，机器上要有 make 和 g++ |
| `~/services/hebi8-tunnel` | 只管这个域名的 Cloudflare Tunnel（`hebi8-market`，容器 `hebi8-tunnel`，`network_mode: host`，ingress 指向 `http://127.0.0.1:8808`）；凭据 JSON 在它的 `credentials/` 里，DNS 是在开发机上用域名的 origin cert 建的 |
| `~/dev/hebi8-gpu-prices` | 数据集 `cnCDIY` 的 clone；用户 timer `hebi8-gpu-prices-pull`（06:50 / 08:50 JST）从开发机拉，OCR 更新在开发机上跑。用的 key 在开发机的 `authorized_keys` 里是 `command="git-upload-pack <那个仓库>",restrict`：只能读这一个仓库，推不进去，也拿不到 shell |
| `~/.local/share/hebi8/dev-export.mjs` | [dev 实例](#dev-实例)每天同步时在这里跑的 `export.mjs`（固定的一份） |
| `~/backups/hebi8/` | 每次部署前的备份 |
| `~/.ssh/authorized_keys` | `hebi8-deploy` 那一行：部署工作流的 key，forced command 锁在 `~/dev/hebi8-market/scripts/deploy-gate.sh`；dev 实例那台的 key：forced command 只在线上目录里跑 `dev-export.mjs` |

防火墙默认拒绝入站，只放 22。线上机器也在 tailnet 里，但只用来**主动连开发机**（下面的 Telegram 转发和数据集），部署、dev 同步、日常维护都走公网 SSH，Tailscale 断了线上照常。这台以后还会放别的服务：hebi8 的东西都在这个用户的 home 和用户级 systemd 里，不开新的入站端口。

还留在开发机上的：仓库的主目录 `~/dev/hebi8-market`（各个 worktree 都挂在它上面；里面不进 git 的 `deploy.env` 让手动的 `deploy.sh` 部署到线上机器）；Telegram 用开发机上共用的本地 Bot API，由开发机的 `hebi8-telegram-forward` 把它在 tailnet 上的 18081 端口转给本地的服务，只放线上机器的 tailnet 地址进来。线上 `notify.json` 的 `telegram.api` 写两个地址（这个转发和 `https://api.telegram.org`），按测速选，开发机不在线时走云端。

**部署**：合并进 master 的 PR 触发[部署工作流](#部署工作流)的 production job：

1. GitHub 托管的 runner 用 Environment 里的部署 key ssh 到 `DEPLOY_HOST`（线上机器的公网 SSH），命令只能是 `live <40 位 commit>` 或 `status <40 位 commit>`：那把 key 在 `authorized_keys` 里是 forced command，只跑线上目录里的 `scripts/deploy-gate.sh`，其它一律拒绝（退出 2，什么都不跑）。**Tailscale 是可选的**：机器有公网 SSH 就不需要；只在 tailnet 里连得到的机器，在 Environment 里放 `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`，runner 先以 `tag:ci` 临时加入 tailnet、ping `DEPLOY_HOST` 的主机（这时写 tailnet 地址），见 [self-hosting.md](self-hosting.md#用-github-actions-自动部署可选)。本仓库现在不放这两个 secret（放着的话 runner 会去 ping 公网地址，失败）。
2. `deploy-gate.sh` 在线上目录 `git fetch origin master`（GitHub，公开仓库，不用凭据），确认这个 commit 在 origin 的 master 上（只按 commit 取的话，GitHub 连 fork 里的提交都给），再把**这个 commit 的** `scripts/deploy.sh` 读到临时文件里跑 `deploy.sh live <commit>`：备份 → 快进 master → 依赖有变就 `npm ci` → 构建 → 重启 → 健康检查（默认是 unit 里 `next start -H … -p …` 的地址，即 http://127.0.0.1:8808/，在线上机器本机查），通过后把这个 commit 记进线上目录的 `refs/hebi8/live`；构建或检查失败就退回上一个记下的 commit 重新构建。`status` 一律用线上目录 HEAD 的 `deploy.sh`，从不执行被查询的那个 commit（对象库里可能有还没进 master 的提交）。
3. `deploy-gate.sh` 本身用的是线上目录里那份，也就是线上在跑的版本：改了它，从带着它上线的那次**之后**的部署才生效，所以 `live` / `status` 的接口要跨一个版本兼容。

手动部署（工作流跑不了时应急，或者 `--deploy`）：开发机的 `~/dev/hebi8-market/deploy.env` 写着 `HEBI8_LIVE_HOST=<ssh 别名或 user@host>`（指向线上机器），`scripts/deploy.sh <分支>` 用自己的 ssh key（不受 forced command 限制）把 commit 经 git 直接推进线上目录的 `refs/hebi8/deploy`，上传自己跑 `deploy.sh live`，成功后在开发机快进 master 并推送，见 [self-hosting.md](self-hosting.md#更新线上实例scriptsdeploysh)。

**线上跑的是哪个版本看 `refs/hebi8/live`，不看 HEAD**：HEAD 在快进时就动了，那时还没构建、没检查。线上目录的 `.git` 里有三样：

- `refs/hebi8/live`：最后一次确认在跑的 commit，部署的健康检查通过、或者回滚后旧版本的检查通过才写。**新机器第一次部署前要手动设基线**：确认实例正在跑而且页面 200，在线上目录 `git update-ref refs/hebi8/live <它跑的完整 commit>`。没有基线时部署照常走（每次都 `npm ci`），但不会跳过，`status` 也只说「不清楚」。
- `hebi8-deploy.pending`（进行中标记）：动 HEAD 之前写下（写临时文件再改名，不会只写了一半），内容是目标、从哪个版本出发、这次的备份目录、开始时间；只有两种情况才删：新版本检查通过并写好记录之后，或者回滚完、旧版本检查通过之后。它还在，就说明有一次部署或回滚没做完，不管 HEAD 和记录是什么都当作说不清。
- `hebi8-deploy.lock`：同一时间只有一个部署，`status` 也看它。

`deploy.sh`（工作流里是 `deploy.sh ci <commit>`）的退出码：0 已部署（手动时 master 已快进；之后推送失败是 git 自己的退出码）；1 没部署，线上跑的还是原来的；3 不知道。线上那边只要不是正常返回 0（不管是部署失败、gate 拒绝、ssh 断了、还是 ssh 包装自己出错），都再连一次问 `deploy.sh status`，由它定：

| `status` | 条件 | `deploy.sh` |
|---|---|---|
| done | 没有标记、没人持锁、记录是这个 commit、HEAD 也是、页面 200 | 0，工作流接着发布；手动时快进、推 master |
| not-live | 没有标记、没人持锁、有记录且不是这个 commit、HEAD 等于记录、页面 200 | 1，工作流标红；`--deploy` 撤掉版本提交 |
| busy / unclear / 连不上 | 有人持锁、有标记、没有记录、页面不通、HEAD 和记录对不上，或者问不到 | 3，工作流标红、写着重跑；`--deploy` 保留版本提交 |

回滚时旧版本也起不来、或者新版本已经是记录里的那个却不通（没有更早的可退），都留着标记退出 3。续跑同一个部署：没有标记、记录和 HEAD 都是它、页面 200 才跳过构建；没有标记就从记录的版本正常走一遍。**有标记就是接着那次没做完的**：出发的版本和备份都用标记里的，不再备份（那次的 `npm ci` 可能已经清空了 `node_modules`，加载不了 better-sqlite3 也不影响续跑），一律 `npm ci`；目标相同就不动标记，换了目标（之后又有新提交）才整个换掉，出发的版本和备份照旧。上一次断线后还在跑的会先等它跑完（最多 15 分钟）。手动时 `HEBI8_LIVE_HOST`（默认 `local` = 在本机部署，开发机的 `deploy.env` 设成线上机器）、`HEBI8_LIVE`（线上目录，相对线上机器的 home）、`HEBI8_UNIT`、`HEBI8_HEALTH_URL`、`HEBI8_SECRETS` 可改，后四个设了会一起带到线上机器；工作流里这些写在 `authorized_keys` 那一行的 command 里（本仓库的线上机器用默认值，什么都不用写）。

**日志**：在线上机器上 `journalctl --user -u hebi8-market -f`（`[hebi8m]` 是调度和同步）；隧道 `docker logs hebi8-tunnel`。从别的机器：`ssh <user>@<host> 'journalctl --user -u hebi8-market -n 100'`。

**临时退回上一个版本**（新版本有急问题、热补丁一时出不来；能等的话 revert 那个 PR 再合更省事）：只动线上机器上跑的版本，**GitHub 上的 master 不动**。

整段拿着部署锁，按和部署一样的规则写进行中标记（这期间 `status` 只会说「说不清」），旧版本检查通过后才写记录、删标记：

```bash
# 在线上机器上
cd ~/dev/hebi8-market
export PATH=$HOME/.local/share/hebi8/node/bin:$PATH   # 服务用的 Node 22；用别的版本 npm ci 会弄坏 better-sqlite3
exec 9>.git/hebi8-deploy.lock && flock 9
old=$(git rev-parse 'v0.3.0^{commit}')               # 上一个版本；^{commit}：tag 本身是附注 tag 对象，不是 commit
printf 'target %s\nfrom %s\nbackup\nstarted %s\n' "$old" "$(git rev-parse refs/hebi8/live)" "$(date -Is)" > .git/hebi8-deploy.pending.tmp
mv .git/hebi8-deploy.pending.tmp .git/hebi8-deploy.pending
git reset --hard "$old"
systemctl --user stop hebi8-market && npm ci && npm run build && systemctl --user start hebi8-market
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8808/   # 200 才做下一行；不是 200 就先修，标记留着
git update-ref refs/hebi8/live "$old" && rm .git/hebi8-deploy.pending
exec 9>&-
```

数据也要退回就先停服务，从 `~/backups/hebi8/<时间>-deploy/` 拷回 `vault/`、密钥目录，`hebi8.db` 放回 `data/`。

这之后是一段临时状态：线上跑旧版本（`/usage` 的版本号是旧的），master、tag 和 GitHub Release 还是新版本。修复在最新发布的提交上做：`scripts/hotfix.sh start 0.4.1`，合并热补丁 PR 时线上从旧版本直接快进到热补丁。不修、只想回到 master 上的版本：在 Actions 页对 master 手动跑一次 Deploy（Run workflow），或者重跑最近那次 production 部署。

## dev 实例

平时的开发合进 `dev`，发版时才进 master 上线。在那之前想先用上新功能，就开 dev 实例：**http://<那台的 Tailscale 地址>:8809/**（家里的小机，和线上不是同一台；只在 Tailscale 上，没有公网入口）。它每分钟自己看一次 origin 的 dev，PR 合进 dev 后最多约一分钟就开始构建、建好就换上；每天用线上 owner 的 vault 覆盖一遍，所以看到的是自己的自选、警报和画线。

- **单用户模式**：yaml 里的 `owner` 去掉了，经 Tailscale 打开就能改，不用登录。改动第二天被覆盖，这是有意的：只单向从线上到 dev。
- **不发通知**：密钥目录是它自己的、空的（`~/hebi8-dev/secrets`），没有任何通道，警报照常判断但不发出，不会和线上重复推送。不要把线上的 `~/.config/hebi8/market` 拷过去。
- **行情自己去拉**：每 5 分钟的报价轮询没有开关，和线上各轮询一遍（每个源每天约 300 次，2026-10 从没被限流过；和线上在同一台、同一个出口 IP 时请求量就是翻倍）；K 线同步改成每天一次（`APP_SYNC_AT`，默认 08:00，同步 vault 时写进 yaml 的 `sync.at`），反正每天还会拿到线上的缓存快照。

脚本在 `scripts/dev-instance/`，那台上用的是装进 `~/hebi8-dev/bin/` 的那份，由 systemd 用户服务托管（linger 已开，开机自己起来）：

| unit | 做什么 |
|---|---|
| `hebi8-dev` | `next start`，从 `current` 指向的版本跑；`Restart=always` |
| `hebi8-dev-poll.timer` → `hebi8-dev-poll.service` | 每分钟看一次 origin 的分支，动了才拉取、构建、切换 |
| `hebi8-dev-sync.timer` → `hebi8-dev-sync.service` | 每天 `SYNC_AT`（默认 04:30 Asia/Tokyo，避开线上 07:30 / 17:30 的同步）从线上同步一次；关机错过了开机补；失败半小时后再试 |

三个都比线上低一档：`Nice=10`、`CPUWeight=20`（线上是默认的 100，抢 CPU 时 dev 只分到约六分之一）、`IOSchedulingClass=best-effort` + `IOSchedulingPriority=7`；`MemoryHigh` 应用 1G、构建和同步 3G，超了先回收它自己的内存。`IOWeight=20` 也写了，但 Ubuntu 的用户 systemd 没有 io 控制器，不起作用，靠 IO 调度优先级。unit 由 `hebi8-dev.sh install` 按 `config.env` 生成，改了 `SYNC_AT` / `SYNC_TZ` 要再 install 一次。

| 路径（`~/hebi8-dev/`） | 是什么 |
|---|---|
| `config.env` | 这台机器的值（不进仓库）：`HOST`、`PORT`、`BRANCH`、`LIVE_DIR`（线上目录）、`NODE_BIN`（Node 22 的 bin，和线上服务同一个大版本；系统默认的 node 是别的版本时 better-sqlite3 不认），以及 `SYNC_AT` / `SYNC_TZ`、`APP_SYNC_AT`、`LIVE_SHELL`（线上在别的机器时，在那边跑命令的前缀，如 `(ssh <user>@<host>)`；空 = 本机。远程时 `LIVE_DIR` 相对那边的 home，`LIVE_NODE` 要写成那边线上服务的 Node 的路径：`NODE_BIN` 只管本机的 `PATH`），以及 `LIVE_NODE`；缺省值在脚本开头 |
| `repo/` | 仓库的 clone；每个版本是它的一个 worktree |
| `releases/<commit>/`、`current` | 构建好的版本，`current` 指向正在跑的那个；保留最近 3 个 |
| `vault/`、`data/hebi8.db`、`datasets/` | 每天从线上换进来的 vault、缓存快照和本机数据集 |
| `secrets/` | 它自己的密钥目录，空的 |
| `logs/build-<commit>.log` | 每次构建的输出（`npm ci`、`next build`） |
| `state/failed` | 构建失败或起不来的 commit，分支动了之前不再重试 |

**自动更新**：timer 每分钟用 `git ls-remote origin refs/heads/<分支>` 看分支指向哪个 commit（只问一句，不下载对象）。和正在跑的一样、或者是 `state/failed` 里那个，就什么都不做；不一样才 fetch 并在 `releases/<新 commit>/` 里另建一份：`package-lock.json` 和正在跑的版本一样就硬链接它的 `node_modules`，否则 `npm ci`；`npm run build` 的时候旧版本照常服务。构建成功才切换、重启 `hebi8-dev`，60 秒内首页不返回 200 就切回旧的。构建或启动失败都记进 `state/failed`，旧版本一直在跑。不推送，不备份。构建要几分钟，这期间 poll 服务一直在跑，timer 不会再起一个；这期间又合进来的几个提交，下一次看时一起看到，只建最新的那一个。同步和更新拿同一把锁，不会同时重启应用。

**每天同步**：在线上目录里用 `LIVE_NODE`（本机时默认就是 `NODE_BIN` 里的 node）跑 `export.mjs`（只读），带回三样，换进去后重启。只复制普通文件和目录：vault 和数据集目录里的**符号链接一律跳过**，不管它指向哪里（同一台机器上，留着链接就等于 dev 直接读写线上的文件，跟着链接复制又会把 vault 外的东西、`users/` 带过来），跳过的在同步日志里列成 `sync: skipped symbolic link <路径>`；vault 目录本身、数据集目录本身是链接的照常按它的真实位置复制。带回来的东西里要是还有符号链接，就整个停下、什么都不换：

- 根 vault（owner 的）：`hebi8.yaml`、`notes/`、`journal/`、`charts/`。**`users/` 不带**，别人的 vault 不离开线上。换进来前由 `prepare-vault.mjs` 去掉 `owner`、把 `sync.at` 换成 `APP_SYNC_AT`、把本机数据集改指 `datasets/<名字>`。
- 数据库快照（`db.backup()`），省得冷启动全量拉：`stats`、`alert_state` 只留根 vault（`vault = ''`）的行，`traffic`、`visitors`、`upstream`、`usage_alerts` 清空；K 线、标的、报价、标的资料原样。
- 本机目录数据集（如 `cnCDIY`）的清单和 CSV；远端仓库的数据集 dev 自己克隆。清单 `hebi8-dataset.yaml` 本身是符号链接的，整次同步失败（不去读它指向的清单），dev 保留原来的数据。dev 的 yaml 里每个本机数据集都改指 `datasets/<名字>`，没带回副本的也一样，不会留着线上的目录。

**线上在别的机器时**（本仓库现在就是）：`config.env` 里写 `LIVE_SHELL=(ssh -i ~/.ssh/<专用 key> -o IdentitiesOnly=yes -o BatchMode=yes <user>@<host>)`，走线上机器的公网 SSH（`known_hosts` 里记那个地址的主机 key），`LIVE_DIR`、`LIVE_NODE` 写成那边的值。这把专用 key 在线上机器的 `authorized_keys` 里是 forced command，只在线上目录里跑一份固定的 `export.mjs`：

```text
command="cd /home/<user>/dev/hebi8-market && exec /home/<user>/.local/share/hebi8/node/bin/node /home/<user>/.local/share/hebi8/dev-export.mjs",restrict ssh-ed25519 AAAA… hebi8-dev-export
```

`hebi8-dev.sh` 发过去的命令（里面带着它自己的 `export.mjs`）被忽略，跑的是线上机器上那份，dev 那台只拿得到导出的结果，拿不到 shell：线上机器上有所有人的 vault 和密钥目录。代价是 `scripts/dev-instance/export.mjs` 改了、dev 实例 `install` 了新脚本之后，要用自己的 key 把它拷过去一次，比如在开发机上 `ssh <user>@<host> 'cat > ~/.local/share/hebi8/dev-export.mjs' < scripts/dev-instance/export.mjs`（用和 dev 实例同一个版本的 checkout）。

没同步的：线上的密钥目录（会话、通知通道、Telegram、网页推送、GitHub App、MCP 令牌）一概不碰。

**合并之后看它到了没有**：`journalctl --user -u hebi8-dev-poll -f`（`update dev: <旧> -> <新>`、`running <新>`，或者 `build of <新> failed` / `did not answer 200`），或者 `hebi8-dev.sh status`（正在跑的 commit、应用状态、两个 timer 上次和下次的时间）。

常用命令（在 dev 实例那台上；从别的机器是 `ssh <user>@<host> '~/hebi8-dev/bin/hebi8-dev.sh status'`）：

```bash
H=~/hebi8-dev/bin/hebi8-dev.sh
$H status                       # 地址、分支、正在跑的 commit、timer
journalctl --user -u hebi8-dev-poll -u hebi8-dev-sync -n 50   # 更新、回滚、同步
journalctl --user -u hebi8-dev -f                             # next start 的输出（[hebi8m] 是调度和同步）
$H branch dev                   # 改跟踪的分支（写进 config.env）并立刻更新；也可以填某个 commit
$H update [--force]             # 不等下一分钟，立刻 fetch 并更新；--force 连 state/failed 里的也重试
$H sync                         # 立刻从线上同步一次
systemctl --user restart hebi8-dev                            # 只重启应用
# 全停：timer、正在跑的构建 / 同步（含等着重试的）、应用；只停应用和 timer 的话，跑到一半的构建结束时会把应用再拉起来
systemctl --user stop hebi8-dev-poll.timer hebi8-dev-sync.timer hebi8-dev-poll.service hebi8-dev-sync.service hebi8-dev
systemctl --user start hebi8-dev hebi8-dev-poll.timer hebi8-dev-sync.timer                 # 恢复
```

`update`、`sync`、`branch` 都是去启动对应的 unit 并等它跑完（输出来自 journal），所以和 timer 触发的一样低优先级、一样进日志；正在构建时 `update` / `branch` 先等这一轮跑完，再自己跑一轮（那一轮开始时还没看到新的要求）。

脚本本身不随分支自动更新（timer 不替换自己）。改了 `scripts/dev-instance/`、dev 实例跑上那个版本之后：`$H install ~/hebi8-dev/current/scripts/dev-instance`（重写 unit，`daemon-reload`）；改的是 `export.mjs` 而线上在别的机器上，再照上面拷一份过去。

**从头搭一个**（新机器，或者整个重来）：要有 Node 22（和线上服务同一个）、g++（better-sqlite3 要编译）、`loginctl enable-linger`。

```bash
git clone https://github.com/Hebi8/hebi8-market.git ~/hebi8-dev/repo
git -C ~/hebi8-dev/repo checkout -q --detach origin/dev
cat > ~/hebi8-dev/config.env <<'CFG'
HOST=<这台机器的 Tailscale IP>
PORT=8809
LIVE_DIR=$HOME/dev/hebi8-market
NODE_BIN=$HOME/.local/share/hebi8/node/bin
CFG
~/hebi8-dev/repo/scripts/dev-instance/hebi8-dev.sh install ~/hebi8-dev/repo/scripts/dev-instance
# 一分钟内 poll 第一次构建并起应用；之后同步一次，换成 owner 的 vault
~/hebi8-dev/bin/hebi8-dev.sh sync
```

2026-10-16 到 10-17 它在一台云端 microVM 上（没有 systemd，脚本自己当看门狗），掉线太多，搬到了家里的小机（当时线上也在那台，10-17 线上搬去了 VPS）。

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
