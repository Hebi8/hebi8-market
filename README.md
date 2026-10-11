# hebi8/market

> hebi（蛇）首尾相衔，七天一个轮回；多出来的第八天，用来观测市场。

自己用的周度复盘工具，不是 TradingView 的替代品。每天收盘后自动拉日线；第八天打开时做三件事：

| 动作 | 页面 | 回答的问题 |
|---|---|---|
| 扫描 | `/` 总览：分组表格、我的警报、本周触发 | 我关心的东西现在各处于什么状态？ |
| 深看 | `/chart/[key]` 图表：K 线、指标、对比、画线、笔记 | 值得细看的几个，结构是什么样？和别的比呢？ |
| 记录 | `/review` 复盘：本周日志、上周日志、本周变化汇总 | 上周怎么想的，这周怎么想？ |

- **搜索**：页头搜索框，或在任何页面按 `/`、`Ctrl/Cmd+K`；图表页直接敲字母就开始搜。本地即时匹配自选、别名和一本约 65 条的内置字典（中文名、拼音、首字母：「腾讯」「tx」「maotai」都行），外部再查 Yahoo / TradingView / Binance。和 TradingView 一样，Enter 只是打开图表，不改自选（不在自选的标的，图表页会先拉一次日线进缓存）；加入自选是结果行上的「+」或 Shift+Enter，按推断的分组加入，Tab 换组，toast 可撤销。总览「+ 添加」和图表右侧自选面板的「+」打开的是添加模式，Enter 就是加入。
- **总览**：按 `hebi8.yaml` 里的分组列一张表，显示最新价、所选周期的涨跌、距高点（距历史高点的回撤，下面的短条是 52 周区间位置）、自己建的警报和近两年的周线迷你图；表头悬停有说明。表头点击对所有分组排序（降序 → 升序 → 默认）；整行可点，行尾「⋯」或右键：移到分组、改名、设基准、添加警报、移除（可撤销）。分组可以折叠（记在浏览器里）、重命名、删除（标的并入上一组）、新建；标的和分组都能拖动排序（触屏用行首手柄，键盘聚焦手柄后 ↑ ↓），顺序写回 `hebi8.yaml`。图表右侧的自选面板也一样。「警报」列用你起的名字显示这个标的上的警报：本周新触发的淡高亮带圆点，已触发或成立中的实线，未触发的灰色，已停止的虚线变淡；悬停看定义，点击编辑或删除，表头的「?」是图例。
- **图表**：基于 [KLineChart](https://github.com/klinecharts/KLineChart)，布局和快捷键照搬 TradingView：顶栏是商品搜索、`+` 比较商品、`日 周 月 季`、图表类型、`fx 指标`、刷新、全屏；左边画线工具栏；图内左上角图例（OHLC、各指标和对比的数值，悬停出现隐藏 / 设置 / 移除）；右边自选列表和笔记；底栏是 `1年 3年 5年 10年 全部` 范围按钮和 `ADJ`（含分红）、`%`、`log`、`自动`。内置指标、代码指标和公式指标都在「指标」弹窗里开关，参数在图例的设置里改，按周期保存。
- **对比**：把别的标的叠在主图上，用同百分比坐标——滚动、缩放时所有线从可见区间左边缘重新归零，和 TradingView 一致；单位不同的（比如美债收益率）放独立副图。
- **画线**：左边画线栏照 TradingView 分六组（趋势线、江恩和斐波那契、形态、预测和测量、几何形状、标注），每组一个按钮，点开选具体工具，记住上次用的；共 50 多种，只画在主图上。选中一条绘图出现浮动工具条：颜色、线宽、线型（文字类还有字号和内容）、设置、锁定、隐藏、删除，水平线还有添加警报；文字可以选中、拖动、双击改。斐波那契回撤和基于趋势的扩展照 TradingView 画：每档一种颜色、档位之间有背景带，设置里可以关背景、调透明度、向左 / 向右延长、改成单一颜色、把档位反向（从低点画到高点的回撤，勾上后 1 以上的扩展档在上方）。磁铁模式、锁定 / 隐藏 / 删除所有绘图。按时间戳保存，周线上画的线切到日线还在。`Delete` 删除选中，`Esc` 退出绘制。
- **测量**：在主图上按住 `Shift` 点一下（或点左边的尺子按钮再点主图），移动鼠标看涨跌幅、跨过多少根 K 线和多少天、区间成交量；再点一下固定，之后点击或 `Esc` 消失。不保存。
- **从 TradingView 搬家**：页头「设置」。自选列表：把 TradingView「导出列表…」得到的 .txt 传上来或贴进来，预览后合并进现有分组或整个替换（已经在自选里的标的不会重复）；也能把自选导出成 TradingView「导入列表…」认的 .txt。画线：填 `sessionid` / `sessionid_sign` 两个 cookie，「获取布局」列出账号下的布局，选一个由服务器去取（别人分享的布局手填链接；cookie 只用于这两次请求，不保存），或者从浏览器开发者工具里复制 `sources` 接口的响应贴进来；按标的追加到各自图表，重复导入不会多出来。映射规则和支持的画线类型见 [`docs/design.md`](docs/design.md) §5.5。
- **笔记与复盘**：每个标的一篇 markdown 笔记（thesis）；每周一篇复盘日志。都是自动保存：停止输入 1 秒后写盘，`Ctrl/Cmd+S` 立即保存，浏览器里留一份草稿兜底。复盘页列出本周触发的警报和有笔记的标的。
- **帮助与反馈**：页头最右的「?」（或按 `?`）打开帮助抽屉。「使用」页签有三步引导的入口、快捷键表、项目文档（本仓库）和隐私说明的链接；「反馈」页签把问题直接提交成 GitHub issue，自动附带当前页面、图表状态和最近的前端错误。界面上只放用的时候要看的东西，项目介绍、配置和运维都写在这份 README 和 [`docs/design.md`](docs/design.md) 里。
- **拍快照**：图表顶栏的相机按钮，照 TradingView：下载图片（`Ctrl/Cmd+Alt+S`）、复制图片（浏览器只在 HTTPS 页面允许，所以要从公网地址打开）、复制链接（`Alt+S`）、在 X 上分享（X 只能带链接和一行字），手机上还有系统分享。图片是当前看到的图表（画线、指标、对比都在），顶部一条信息栏写商品、周期、最后一根 K 线的开高低收和涨跌，底部是 hebi8/market 标识和这张图的公开地址；跟随明暗主题和涨跌配色。页面上的图表没有水印。
- **分享卡片**：链接贴到 X、Telegram 等处会展开成卡片：图表页是名称、最新收盘、近半年日线走势和 hebi8/market 标识，其他页面是站点卡片。卡片只读根 vault 和公共的 K 线缓存（抓取的一方没有登录），不会带出任何人的画线、笔记和自选。设置、复盘、使用情况页面标了 noindex，`robots.txt` 只挡接口，`sitemap.xml` 列出首页和根 vault 自选里的图表页。
- **合成标的**：在搜索框里直接输 `AAPL/MSFT`、`BTCUSDT/GOLD`、`2*(SPY-QQQ)` 这样的表达式，当作标的看图、对比、加自选、算统计、设警报，逐字段计算，和 TradingView 的 spread 一样。光标所在的操作数照常出搜索建议，选一个就替换它。
- **警报**：照搬 TradingView。顶栏「警报」或 `Alt+A`、主图右键「在 X 添加警报」、选中水平线后浮动工具条上的闹钟，总览的行菜单「添加警报…」，都打开同一个对话框：商品（这个标的或「全部自选」）、条件（穿过、上穿、下穿、大于、小于、进入 / 离开通道、在通道内 / 外、上涨 / 下跌 %，或自定义公式和它的周期）、触发（仅一次 / 每根 K 线一次）、名称、是否推送。图上画警报虚线，价格轴上的闹钟标签点了就是编辑；右侧栏「警报」列出全部警报，可编辑、暂停、删除。盘中每 5 分钟取一次最新价判断，触发时推到 Telegram 或 webhook。
- **对全部自选的警报**：不指定标的的警报（公式或涨跌 %）每次同步后对每个自选标的判断，在成立的标的上显示，新成立时推一条摘要到 Telegram 或 webhook（ntfy、Discord 等）；关掉推送就只是总览上的筛选标记。没有系统预置的，都是自己建、自己起名。

约束：默认单用户、无登录、只在内网用（局域网里几个人共用一台见[下文](#共用一台实例)）；只存日线，周 / 月 / 季线读时合成；读取永远不碰网络；通知只往外发，不开任何入口。

### 应用内反馈

`?` → 反馈：填好标题和描述，点「用 GitHub 登录」，抽屉里会显示一串代码，到 github.com/login/device 输入并授权，回来就能提交——issue 以**你自己的** GitHub 账号开在 `Hebi8/hebi8-market` 上。登录用的是公开 GitHub App「hebi8-market」的 device flow，只需要写在 `src/lib/app-info.ts` 里的 client id，任何人自己部署的 hebi8 都能用，不用配置任何密钥；登录会话存在服务器的 `~/.config/hebi8/market/sessions.json`（`HEBI8_SECRETS` 可改，权限 600）。实例配了[网页登录](#网页登录可选)的入口上，「用 GitHub 登录」是跳到 GitHub 再回来，不用输代码。不想登录、或者 App 还没配置（「反馈未启用」）时，「在 GitHub 网页上提交」会在 github.com 打开预填好同样内容的新 issue。

标签不由应用加（非协作者开 issue 时 GitHub 会丢掉标签），而是仓库里的 Actions 工作流 `.github/workflows/app-feedback.yml` 读 issue 正文里的 `hebi8-context` 块：加 `from-app` 和类型标签；勾了「可以自动修复」的，作者是仓库 owner / 组织成员 / 协作者才加 `auto-fix-ok`，其他人加 `auto-fix-requested`。

**仓库 owner 要做的一次性设置**（详见 [`docs/design.md`](docs/design.md) §5.8）：在 Hebi8 组织下注册公开的 GitHub App（[预填好的注册链接](https://github.com/organizations/Hebi8/settings/apps/new?name=hebi8-market&description=hebi8%20market%20%E7%9A%84%E5%BA%94%E7%94%A8%E5%86%85%E5%8F%8D%E9%A6%88%EF%BC%9A%E7%94%A8%E4%BD%A0%E8%87%AA%E5%B7%B1%E7%9A%84%20GitHub%20%E8%B4%A6%E5%8F%B7%E5%9C%A8%20Hebi8%2Fhebi8-market%20%E4%B8%8A%E6%8F%90%E4%BA%A4%20issue&url=https%3A%2F%2Fgithub.com%2FHebi8%2Fhebi8-market&public=true&webhook_active=false&issues=write)），在 App 设置里勾选 **Enable Device Flow**，只安装到 hebi8-market，把 client id 填进 `app-info.ts` 的 `GITHUB_APP_CLIENT_ID`。fork 想把反馈收到自己的仓库：建自己的 App，设环境变量 `HEBI8_GITHUB_CLIENT_ID` 和 `HEBI8_FEEDBACK_REPO`。

## 数据源

| source | 覆盖 | 说明 |
|---|---|---|
| `yahoo` | 美股、港股、A 股、指数、ETF | 经 [yahoo-finance2](https://github.com/gadicc/yahoo-finance2) 拉取完整日线历史。价格是拆股复权价，分红因子另存，`prices: total` 时折进价格。直接请求 Yahoo 接口会返回 429，所以必须走这个库。 |
| `binance` | 加密货币现货 | 公开 K 线接口，无需 key，增量拉取。 |
| `tv` | 指数、国债收益率、外汇、商品等 Yahoo 缺的品种 | 非官方的 [TradingView-API](https://github.com/Mathieu2301/TradingView-API)，无需登录，取该品种的全部日线（如 TVC:DJI 从 1896 年起）。属于逆向接口，TradingView 改动协议后可能失效。 |
| `data` | 自己的日线数据集，比如爬虫每天推送的显卡二手价 | 一个 git 仓库或本机目录，按下文的约定放 CSV。hebi8 只读不爬。 |

代码示例：`yahoo:AAPL`、`yahoo:0700.HK`、`yahoo:600519.SS`、`yahoo:^GSPC`、`binance:BTCUSDT`、`tv:TVC:US10Y`、`tv:HSI:HSTECH`、`tv:FX_IDC:USDCNH`、`data:gpu/4090-xianyu`、`=BTC/GOLD`。

各数据源的日线时间戳不同：美股记在开盘时刻，亚洲市场记在 01:30 UTC，外汇和 TVC 品种记在前一晚开盘时刻。入库前统一按交易所时区换算成交易日。

### 自定义数据集

任何按下面约定存放日线 CSV 的 git 仓库或本机目录，都能当数据源用。接进来以后，图表、公式、警报、对比、合成标的都和普通标的一样。

```yaml
# vault/hebi8.yaml
datasets:
  gpu: https://github.com/you/gpu-prices     # 也可以写 git@ / ssh:// / file:// 地址，或本机目录 ~/data/gpu-prices、./datasets/gpu
aliases:
  GPU4090: data:gpu/4090-xianyu
```

仓库根目录放清单 `hebi8-dataset.yaml`，每条序列一个 CSV：

```yaml
name: 显卡二手与零售价
series:
  - { id: 4090-xianyu, name: RTX 4090 咸鱼, currency: CNY, file: series/4090-xianyu.csv, description: 闲鱼上 RTX 4090 的每日中位成交价 }
  - { id: 4090-jd,     name: RTX 4090 京东, currency: CNY, file: series/4090-jd.csv }
```

```csv
date,open,high,low,close,volume
2026-10-05,,15800,11200,12900,184
2026-10-06,,15500,11000,12650,171
```

- key 是 `data:<数据集>/<序列 id>`，区分大小写。在合成表达式和 `close(...)` 里要用别名或带引号的 key，比如 `=GPU4090/tv:FX_IDC:USDCNH`、`="data:gpu/4090-xianyu"/tv:FX_IDC:USDCNH`。
- 远程仓库浅克隆到 `data/datasets/<name>/`，每次同步前拉一次。私有仓库用机器上的 SSH key。本机目录直接读，相对路径相对于 vault 目录。
- CSV 只要求 `date` 和 `close` 两列，日期写 `YYYY-MM-DD`。`open` 空着就用 `close`，`high`、`low` 空着就取开收的高低，`volume` 可以留空。格式错误会报行号，只影响这一个标的。
- 清单读到以后，搜索框输入序列名、id 或数据集名就能找到并加进自选；输入 `data:` 开头只查数据集。
- 序列可以带一段 `description`（可省），显示在图表页的「商品详情」里。

### 商品详情

图表页右侧的「商品详情」面板说明这个标的是什么：股票有简介、板块、行业、国家、员工、网站、市值、市盈率、每股收益、股息收益率、下一次财报；ETF 和基金有简介、发行商、类别、费率、规模、前十大持仓、行业分布；指数、外汇、商品、加密货币、债券没有这些资料，显示类型、交易所、币种、时区、交易时段。数据源没有的字段不显示。

- **相关链接**：每个标的至少一条去处。公司有官网和披露页（美股是 SEC EDGAR，港股是港交所，A 股是上交所 / 深交所）；ETF 和基金有发行商的页面（Vanguard、Invesco、Schwab 等能直达产品页，其余是发行商官网）；美债、汇率、商品、指数、比特币这类没有公司的，配了官方或公开的资料页（美国财政部和 FRED、各国央行、世界黄金协会、EIA、指数公司等）；最后一条总是数据源自己的行情页。链接由代码和类型现算，不联网；规则和那张表在 `src/lib/links.ts`，里面的地址都实际打开核对过，没覆盖到的标的只有行情页那一条。
- 资料来自标的自己的数据源（`yahoo` 和 `tv` 有，`binance` 没有，`data` 是清单里的 `description`），存在缓存里，每周在定时同步之后刷新一次，标的第一次拉日线时也取一次；面板底部写着更新日期。打开页面不联网。
- 市值、市盈率、股息收益率不存，用实际成交的最新价现算（有当前报价用报价，否则最后一根日线收盘），不受 `ADJ`（含分红）影响。下一次财报按交易所当地的日期显示，当天过完就不再显示。
- **翻译**：简介是数据源的原文，多半是英文。想要「翻译」按钮，在 `HEBI8_SECRETS` 目录（默认 `~/.config/hebi8/market`）里写 `llm.json`，`chmod 600`，填任何一个 OpenAI 兼容的 chat completions 接口：

  ```json
  { "base": "https://api.openai.com/v1", "key": "sk-...", "model": "gpt-4o-mini" }
  ```

  点了才翻译，译文存在缓存里，之后所有人打开都直接看到，可以切回原文；每周刷新后原文变了，按钮会重新出现。共用实例上只有登录的人能点，访客只能看已有的译文。没有这个文件就没有按钮。翻译失败时页面只说「稍后再试」，状态码和接口返回的内容在服务器日志里（`[hebi8m] translate:`）。

## 运行

```bash
npm install
npm run dev        # http://localhost:3000
```

首次打开会把 `vault.example/hebi8.yaml` 复制为 `vault/hebi8.yaml`，并在后台拉取全部历史，大约几秒。之后由应用内的调度器按 `sync.at` 的时间每天同步；应用停过一段时间再启动时会补跑一次。总览右上角的「刷新」强制全量同步。

生产模式 `npm run build && npm start`。

已经作为 systemd 用户服务跑着的实例，用 `scripts/deploy.sh <分支或 commit>` 更新：备份 `vault/`、密钥目录和数据库到 `~/backups/hebi8/<时间>-deploy/`，把 master 快进到这个分支，依赖有变就 `npm ci`，重新构建并重启，页面返回 200 后推送 master；构建或检查失败就退回原来的 commit 重新构建。分支必须是 master 的快进，线上目录必须干净。`HEBI8_LIVE`、`HEBI8_UNIT`、`HEBI8_HEALTH_URL` 可改目录、服务名和检查地址。

| 快捷键 | 作用 |
|---|---|
| `/`、`Ctrl/Cmd+K` | 打开搜索（图表页直接敲字母、数字也行） |
| `?` | 帮助与反馈（反馈里 `Ctrl/Cmd+Enter` 提交） |
| `↑ ↓ Enter Tab Esc` | 搜索里移动、打开（添加模式下是加入）、换分组、关闭 |
| `Shift+Enter` | 搜索里把高亮的标的加入自选 |
| `↑ ↓`（聚焦拖动手柄时） | 自选里把这个标的或分组上移 / 下移一格 |
| `Space`、`Shift+Space` | 图表页切自选列表下一只 / 上一只 |
| `← →`、`↑ ↓` | 图表滚动、缩放 |
| `Alt+T` `Alt+H` `Alt+J` `Alt+V` `Alt+F` | 趋势线、水平线、水平射线、垂直线、斐波那契回撤 |
| `Shift+点击` | 图表页测量：涨跌幅、K 线数、成交量 |
| `Delete`、`Backspace` | 删除选中的画线 |
| `Alt+A` | 新建警报（在主图上右键是「在该价位添加警报」） |
| `Alt+R` | 重置图表视图 |
| `Ctrl/Cmd+Alt+S`、`Alt+S` | 下载图表图片、复制图表链接 |
| `Esc` | 关闭弹窗、退出画线 |
| `Ctrl/Cmd+S` | 立即保存笔记 / 复盘 |

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `HEBI8_VAULT` | `./vault` | 用户内容目录 |
| `HEBI8_DB` | `./data/hebi8.db` | SQLite 缓存，删了会自动重建 |
| `BINANCE_API_URL` | `https://api.binance.com` | 换成 `https://data-api.binance.vision` 等镜像 |
| `HEBI8_SECRETS` | `~/.config/hebi8/market` | GitHub 登录会话 `sessions.json`、网页登录的 client `github-oauth.json`（手写，可选）、实例的通知设置 `notify.json`、每个人的通知通道 `notify-users.json`、网页推送的密钥 `vapid.json`（自动生成）、翻译简介用的模型 `llm.json`（手写，可选，见[商品详情](#商品详情)），权限 700 / 600 |
| `HEBI8_GITHUB_CLIENT_ID` | `app-info.ts` 的 `GITHUB_APP_CLIENT_ID` | 反馈登录用的 GitHub App client id（fork 用自己的 App 时设）；设为 `off` 关闭应用内登录，反馈只走 GitHub 网页 |
| `HEBI8_FEEDBACK_REPO` | `Hebi8/hebi8-market` | 反馈 issue 开在哪个仓库（`owner/name`） |
| `HEBI8_PUBLIC_URL` | `https://market-hebi8.dreaife.tokyo` | 实例的公开地址：页面元数据、分享卡片、`robots.txt`、`sitemap.xml`、复制和分享出去的图表链接、导出图片底部的地址都用它 |
| `HEBI8_OG_FONT` | 按常见路径找 Noto Sans CJK SC 的 `.otf` | 分享卡片用的中文字体（`.otf` / `.ttf`，不能是 `.ttc`）；找不到时卡片上只画拉丁字符 |

## 查看实例状态

帮助抽屉里不放这些，因为只有跑这台实例的人用得上：

| 想知道 | 共用实例的 owner | 单用户模式或在服务器上 |
|---|---|---|
| 跑的是哪个版本 | `/usage`「实例」：版本号、commit、构建时间 | `git log -1 --oneline`；构建时由 `next.config.ts` 注入 `HEBI8_VERSION` / `HEBI8_COMMIT` / `HEBI8_BUILT_AT` |
| 上次、下次同步 | `/usage`「实例」：上次同步、下次同步和每天的时间表 | 总览标题旁有上次同步时间；调度日志在 stdout（`journalctl -u <服务名>`），前缀 `[hebi8m]` |
| 缓存了多少标的、哪些同步出错 | `/usage`「实例」：缓存数和出错的标的及错误 | 总览上出错的行会显示错误；或 `sqlite3 data/hebi8.db "select key, sync_error from symbols where sync_error is not null"` |
| vault 在哪 | `/usage`「实例」 | `HEBI8_VAULT`，默认 `./vault`（见下文） |
| `hebi8.yaml` 写错了 | 页面直接显示错误和行号，改好刷新即可 | 同左 |

`/usage` 只有 owner 能打开（页头菜单「使用情况」），其他人和单用户模式都是 404，见 [`docs/design.md`](docs/design.md) §1.7。

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
- GitHub 登录只用来区分局域网里的人，不防恶意访问者，不要把实例开到公网。

### 网页登录（可选）

device flow 每次都要复制代码、去 GitHub 粘贴、等轮询。给实例配上 GitHub App 的 client secret，就可以改成跳到 GitHub 再回来：浏览器里已经登录 GitHub 的人点一下「登录」就完成。

1. 在反馈用的那个 GitHub App 的设置页（上面注册的 hebi8-market；fork 是自己的 App）里，往 **Callback URL** 加上 `<公开地址>/api/github/callback`，点 **Generate a new client secret**。Enable Device Flow 保持勾选。
2. 在 `HEBI8_SECRETS` 目录（默认 `~/.config/hebi8/market`）里写 `github-oauth.json`，`chmod 600`：

   ```json
   { "client_id": "Iv23li…", "client_secret": "…" }
   ```

   `client_id` 是 App 的 Client ID。还可以写 `origins`（提供网页登录的入口，默认只有 `HEBI8_PUBLIC_URL`；每个入口的 `<origin>/api/github/callback` 都要登记在 App 上）。文件每次用到时读，改了不用重启。

这样两种登录拿到的是同一个 App 的授权，都能在应用里提交反馈。GitHub 只跳回登记过的回调地址，所以网页登录只在 `origins` 里的入口提供；从别的入口（比如 Tailscale 的 http 地址）打开时，「登录」还是 device flow。没有这个文件时一切照旧。

也可以单独建一个 OAuth App，把它的 id 和 secret 填进去（`scope` 默认空）：这样的登录只确认身份，不能在应用里提交反馈，提交时会说明原因并给出「在 GitHub 网页上提交」。细节见 [`docs/design.md`](docs/design.md) §5.8。

## 通知

只有一个概念：**警报**，都推一条摘要（`notify: false` 的只在总览显示）。

- **一个标的的警报**：照搬 TradingView 的警报。自选里的标的（和警报用到的标的）都会定时取最新价（加密和正在交易的市场每 5 分钟，盘前盘后和休市每小时），把它当作今天还没收完的日线来判断；这根 K 线只在内存里，库里只有日线。日线同步收尾时也判断一遍。
- **判断时机**（对话框里的「盘中价格 / 日线收盘」，yaml 里的 `check: price | close`）：盘中价格就是上面这种，每次取到最新价都判断；日线收盘只在日线同步后判断，而且只看已经收盘的日线（当天还没走完的那根不算）。一个标的的警报默认盘中价格，对全部自选的默认日线收盘，都可以改成另一种。
- **对全部自选的警报**（不写 `key`）：每次定时同步或点「刷新」之后对每个自选标的检查，在界面上新建或改过时立刻按日线算一遍。公式**从不成立变成成立**的那一刻推送；规则第一次出现（新加的规则、新加的标的、删过缓存库）只记下当前状态；同一根 K 线只推一次，周线公式在本周内来回真假也只响一次。只能用公式或涨跌 %。

```yaml
alerts:
  - { label: 破200周, when: "close < sma(close, 200)", tf: W }        # 对每个自选标的检查
  - { label: 周线多头, when: "close > sma(close, 40)", tf: W, notify: false }  # 只在总览显示
  - { key: BTC, cond: crossing_up, value: 130000 }                     # 上穿 130,000，仅一次
  - { key: SPY, cond: entering, value: [500, 520], trigger: bar }      # 进入通道，每根 K 线一次
  - { key: NVDA, label: 跌破 200 日线, when: "close < sma(close, 200)" } # 自定义公式
  - { key: GPU4090, cond: less, value: 11000, enabled: false }         # 暂停中
```

| `cond` | 叫法 | `value` | 什么时候触发 |
|---|---|---|---|
| `crossing` / `crossing_up` / `crossing_down` | 穿过 / 上穿 / 下穿 | 价格 | 和上一次检查相比穿过了这条线（第一次检查只记录） |
| `entering` / `exiting` | 进入通道 / 离开通道 | `[低, 高]` | 和上一次检查相比进入 / 离开了通道 |
| `greater` / `less` | 大于 / 小于 | 价格 | 只要成立就触发，新建时已成立也会立刻触发 |
| `inside` / `outside` | 在通道内 / 在通道外 | `[低, 高]` | 同上 |
| `moving_up_pct` / `moving_down_pct` | 上涨 % / 下跌 % | `{ pct, bars }` | 最近 `bars` 根日线内涨跌超过 `pct`% |

- `trigger`：`once`（默认）触发后把这条写成 `enabled: false`（注释保留）；`bar` 每根日线最多一次。`enabled: false` 是暂停。
- `check`：`price`（盘中价格）或 `close`（日线收盘），不写就是默认值（有 `key` 的 `price`，没有的 `close`）。
  已触发的 `once` 手改 yaml 的 `enabled: true` 不会重新启用；重新启用请用界面上的恢复。
- `when` 公式「新成立才推送」，`tf` 默认 D；要明确的上穿下穿写 `cross(close, X)`。`label` 省了按条件自动生成。
- 以前的 `conditions: [{ id, label, formula, tf, notify }]` 照样能读，当作对全部自选的警报（`tf` 默认 W，没标 `notify` 的不推送）；第一次在界面上建、改、暂停或删除警报时，它们会被搬进 `alerts`。
- `data:` 数据集只有日线，跟着日线同步判断。
- 所有通道都发送失败时不记账，下次再试；没配通道时只写日志。

通道写在 `~/.config/hebi8/market/notify.json`（不在 vault 里，权限设成 600），两种可以同时开：

```json
{
  "telegram": { "token": "123456:ABC...", "chat": "123456789" },
  "webhook": "https://ntfy.sh/your-secret-topic",
  "link": "http://100.92.194.31:8808"
}
```

- `telegram`：找 @BotFather 建一个 hebi8/market 专用的 bot（用户名比如 `hebi8m_xxx_bot`）拿 token，给 bot 发一句话后从 `https://api.telegram.org/bot<token>/getUpdates` 里读 `chat.id`。用自建 Bot API 服务时加 `"api": "http://..."`。
- **共用实例的 owner 也可以在页面上设置 bot**：页头菜单「通知设置」里的「实例的 Telegram bot」，粘贴 token 后先用 `getMe` 校验，通过才写进 `notify.json`（只改 `telegram` 段，其他字段原样保留），之后只显示 `@bot 用户名`，不再显示 token；「移除」删掉整个 `telegram` 段。单用户模式没有登录，也就没有这个页面，bot 和通道都直接写 `notify.json`。
- `webhook`：字符串，或 `{ "url": ..., "format": "json" }`。默认 `text` 把摘要当正文 POST，带 `Title: hebi8` 头，ntfy 直接能用；`json` 发 `{ title, text, events }`。
- `link`：可选，有的话每条后面带图表页链接。

配好后用这条命令往每个通道发一条测试消息：

```bash
npm run notify:test
```

**共用实例**：`notify.json` 是实例的设置——bot 的 `token`、`api` 和 `link`；其中的 `chat` 和 `webhook` 是 owner（根 vault）的通道，可以不写。其他人登录后在页头菜单的「通知设置」里设置自己的通道，存在 `~/.config/hebi8/market/notify-users.json`（页面写入，权限 600，不用手改）：

- **绑定 Telegram**：点「绑定 Telegram」，打开链接在 Telegram 里点 Start，几秒后自动绑好，bot 会回一句「已绑定 hebi8：<login>」。链接里的一次性码 10 分钟有效。owner 也可以这样绑定，会替代 `notify.json` 里的 `chat`。
- **webhook**：填地址和格式（text / json）保存，同样替代 `notify.json` 里的 `webhook`。
- **推送**：勾上「在此设备上接收推送」，这台手机或浏览器就会收到系统通知，点开是对应的图表；每台设备各开一次，下面列着开过的设备，可以移除。只能在 HTTPS 地址上开（局域网、Tailscale 的 http 不行）；iPhone / iPad 要先在 Safari 里「分享 → 添加到主屏幕」，从主屏幕打开再开（iOS 16.4 及以上）。
- 「发测试消息」往自己的每个通道发一条，「解除绑定」「删除」去掉页面上设置的通道。
- 绑定时 hebi8 用 `getUpdates` 读 bot 收到的消息（只在有待绑定的码时，只往外连）。所以这个 bot 要给 hebi8 专用：同一个 token 被别的程序 `getUpdates` 时两边会抢消息。

## 让 agent 接入（MCP）

看不完所有标的时，把想法交给 agent：它经 MCP 读你的自选和行情、拿一条公式扫全部自选、回看这条公式过去哪些天成立，然后把它存成警报，之后由服务器每 5 分钟（或每次日线同步后）判断、触发时推到你的通知通道。只有日线及以上周期，没有日内 K 线。

1. 打开「设置」→「Agent 接入（MCP）」，起个名字，选「只读」或「可写」，点「生成令牌」。令牌只显示这一次，服务器上只存它的哈希（`~/.config/hebi8/market/mcp-tokens.json`）；丢了就吊销再生成一个。共用实例上要先登录，令牌就是你本人，只碰你自己的 vault。
2. 页面上同时给出可以直接复制的 Claude Code 命令：

   ```bash
   claude mcp add --transport http hebi8-market https://你的地址/mcp --header "Authorization: Bearer hebi8m_…"
   ```

   默认只在当前项目里可用，加 `--scope user` 在所有项目里可用。
3. 其他支持 MCP 的客户端：类型选 Streamable HTTP（有的叫 `http`），URL 填 `https://你的地址/mcp`，再加一个请求头 `Authorization: Bearer <令牌>`。接口是无状态的，每个请求都要带这个头；没带或令牌无效回 401。还不支持 OAuth，所以 claude.ai 网页版的连接器暂时接不上。

工具（agent 自己能列出来，这里是给人看的）：

| | 工具 |
|---|---|
| 读 | `overview` 总览 · `get_bars` K 线 · `get_profile` 标的资料（简介、行业、市值、基金持仓…）· `scan` 一条公式扫一批标的 · `test_formula` 一条公式在一个标的上的历史表现 · `formula_reference` 公式和警报的写法 · `search_symbols` 搜标的 · `list_alerts` · `read_note` · `read_journal` |
| 写（要可写令牌） | `save_alert` `delete_alert` `set_alert_enabled` · `add_symbol` `remove_symbol` · `append_note` `append_journal`（只追加，不改已有内容）· `save_indicator` `delete_indicator` |

两条规矩：

- agent 建的警报在警报面板上标「Agent」（yaml 里是 `by: agent`）。盯**一个标的**的直接生效。
- 对**全部自选**的警报，agent 只能存成草稿（yaml 里多一个 `draft: true`）：不判断、不推送，总览顶部和图表页的警报面板里显示「待确认」，你点「确认」才生效，不要就「丢弃」。agent 可以改自己的草稿，但不能改一条不是草稿的全部自选警报（它会被拒绝，原来的照常生效），想改只能另存一条新草稿等你确认；agent 也不能确认草稿、不能恢复一条已停止的全部自选警报。

读行情不联网，只看已经缓存的标的（自选、基准、被警报和公式引用到的）；agent 想看别的，先用 `add_symbol` 加进自选。分组的增删改、画线、图表偏好、通知通道、同步都不经 MCP。

## 公式

公式用在三处：图表页的公式指标、警报、对比。每一行（或用分号隔开的一段）画一条线，`name = 表达式` 可以给线命名，后面的行能引用它，`#` 后面是注释。

```text
# 均线乖离：价格偏离 40 周线多少 %
(close / sma(close, 40) - 1) * 100

# 相对基准
close / close(bench)

# 警报：趋势向上且创 52 周新高
close > sma(close, 40) and close >= highest(close, 52)

# 和纳指比，用别名或带引号的 key
close(QQQ) / close("yahoo:SPY")
```

| 类别 | 可用 |
|---|---|
| 变量 | `open` `high` `low` `close` `volume` `bench` `hl2` `hlc3` `tr` |
| 别的标的 | `close(QQQ)`（别名）、`close("yahoo:QQQ")`、`close(bench)`；open / high / low / volume 同理，按本标的交易日对齐并前向填充 |
| 运算 | `+ - * / ^`、括号；比较 `> < >= <= == !=`；逻辑 `and or not`（结果是 0/1，优先级 not > 比较 > and > or，都低于算术） |
| 滚动窗口 | `sma(x, n)` `ema(x, n)` `std(x, n)` `sum(x, n)` `highest(x, n)` `lowest(x, n)` `rsi(x, n)` `atr(n)` `corr(a, b, n)` `pctrank(x, n)` |
| 前值比较 | `ref(x, n)` `change(x, n=1)` `roc(x, n=1)` `cross(a, b)` `barssince(cond)` |
| 其他 | `iff(cond, a, b)` `cummax(x)` `cummin(x)` `max(a, b)` `min(a, b)` `abs` `sqrt` `log` `exp` |

窗口 `n` 按当前周期计数：周线上 `sma(close, 40)` 就是 40 周均线。

合成标的的表达式更简单：支持 `+ - * / ^`、数字和括号，逐字段（开高低收）计算，交易日取第一个操作数的。

- 在搜索框里输入时，含运算符就当表达式（以 `=` 开头也行）：`AAPL/MSFT`、`^GSPC/^DJI`、`2*(SPY-QQQ)`、`NASDAQ:AAPL/TVC:GOLD`。只有不带空格的 `-` 时还是一个代码（`BRK-B`），做减法要加空格（`SPY - QQQ`）。
- 光标所在的操作数照常出搜索建议，选一个就把它换成那个标的；其余操作数按固定规则解析，不看自选：别名或完整 key → 内置字典的代码和名字（`GOLD`、`BTC`、`SPX`、`黄金`）→ `…USDT` 在 Binance → 外部搜索里代码完全一样的那条（`PLTR`）；都没有就要从建议里选。中文名这类要搜的词得从建议里选。
- 选中后表达式存成操作数都是完整 key 的形式，比如 `=yahoo:AAPL/yahoo:MSFT`，图上显示 `AAPL/MSFT`。代码里有 `-` 或 `/` 的 key 要加引号：`="yahoo:BRK-B"/yahoo:SPY`。yaml 里手写时也可以用别名：`=BTC/GOLD`。

## 代码指标

公式写不出来的逻辑，可以写成代码：

1. 在 `src/indicators/calc.ts` 写纯计算函数（方便测试）。
2. 在 `src/indicators/custom.ts` 写一个 KLineChart 的 `IndicatorTemplate`，并加进 `customIndicators`。
3. 在 `src/indicators/catalog.ts` 的 `INDICATORS` 里登记：名称、主图或副图、各周期的默认参数。指标栏会自动出现对应的开关和参数编辑。

KLineChart 内置的 MA、EMA、BOLL、VOL、MACD、RSI、KDJ、SAR、OBV 等指标也可以直接登记进 `INDICATORS`。需要基准的指标（比如相对强弱）读每根 K 线上的 `bench` 字段，由 `/api/bars` 按交易日对齐并前向填充。

## 结构

```text
src/
├── app/
│   ├── page.tsx              总览（RSC，直接读 vault 和 SQLite）
│   ├── chart/[key]/page.tsx  图表页 /chart/yahoo%3ASPY
│   ├── review/page.tsx       复盘
│   ├── settings/page.tsx     设置：agent 的接入令牌；从 TradingView 导入自选和画线、导出自选
│   ├── claim/page.tsx        「在其他设备上登录」的确认页
│   ├── actions.ts            Server Actions：写 yaml / 笔记 / 日志 / 图表状态，刷新；和 agent 共用的写操作是 lib/ops.ts 的薄壳
│   ├── token-actions.ts      Server Actions：生成 / 吊销 agent 的令牌
│   ├── mcp/route.ts          MCP 入口（Streamable HTTP，带个人令牌）
│   ├── tv-actions.ts         Server Actions：TradingView 导入（tv-import.ts / tv-drawings.ts / tv-layout.ts 在 lib）
│   └── api/
│       ├── bars/             日/周/月/季 K 线 + 对齐好的引用标的
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
    ├── series.ts synth.ts    周/月/季线合成、对齐、合成标的
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

```bash
npm test           # 单元测试
npm run typecheck
npm run lint
npm run build
```

## License

Apache-2.0
