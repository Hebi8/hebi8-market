# hebi8 market v2 设计

> hebi（蛇）首尾相衔，七天一个轮回；多出来的第八天，用来观测市场。

hebi8 是一个**周度复盘工具**，不是 TradingView 的替代品。每天收盘后自动拉日线；第八天打开时做三件事：

| 动作 | 页面 | 回答的问题 |
|---|---|---|
| 扫描 | `/` 总览：分组表格、我的警报徽标、本周触发 | 我关心的东西现在各处于什么状态？ |
| 深看 | `/chart/[key]` 图表：K 线、指标、对比、画线、笔记 | 值得细看的几个，结构是什么样？和别的比呢？ |
| 记录 | `/review` 复盘：本周日志、上周日志、本周变化汇总 | 上周怎么想的，这周怎么想？ |

约束：本体只绑定 Tailscale IP，另经 Cloudflare Tunnel 公开（`https://market-hebi8.dreaife.tokyo`，cloudflared 转发到 Tailscale 地址），暂时完全公开、不限流，只做流量监控（§1.7）；只存日线，周/月/季线读时合成；**读取永远不碰网络**。默认单用户、无登录；在 yaml 里设了 `owner` 之后，几个人可以共用一台实例，每人用 GitHub 登录后看到自己的自选、画线、笔记和通知（§1.6）。

第八天之外只有一种打扰：自己建的**警报**触发，推到 Telegram、webhook 或开了网页推送的设备（§2.5–§2.7）。警报可以盯一个标的，也可以对全部自选；每条警报有一个「判断时机」：盘中价格（每 5 分钟取一次最新价来判断，盯一个标的时的默认）或日线收盘（每次同步后只看已收盘的日线，对全部自选时的默认）。系统不预置任何警报。只存日线，不存日内 K 线。

看不完所有标的时，可以让 agent 代劳：它经 `/mcp`（§6）读行情、拿公式扫自选，把想法写成公式或警报，之后由服务器算和盯。agent 建的对全部自选的警报先是草稿，等人在页面上确认（§2.5）。

本文是 v2 的实施规范。v1 的代码可以参考（`tradingDay`、公式引擎、指标目录、统计定义都保留），但不需要兼容：目录、schema、接口都按本文重做。

---

## 1. 数据：缓存与内容分开

**一句话心智模型：`vault/` 是我的，`data/hebi8.db` 是缓存，删了会自动重建。**

```
data/hebi8.db                 SQLite 缓存：bars、symbols 元数据与同步状态、stats、告警状态、标的资料与简介译文
data/datasets/<name>/         自定义数据集仓库的浅克隆（§2.4），删了下次同步重新克隆
vault/                        用户内容，gitignore；HEBI8_VAULT 环境变量可改位置
  hebi8.yaml                  自选分组、别名、公式指标、警报、同步时间表、图表偏好；owner 的
  notes/<fileKey>.md          每个标的的笔记（thesis）
  journal/<YYYY>-W<ww>.md     每周复盘（ISO 周）
  charts/<fileKey>.json       每个标的的图表状态：对比列表、画线
  users/<login>/              共用实例里其他人的 vault（§1.6），结构同上，没有实例级设置
vault.example/hebi8.yaml      首次运行时若 vault/ 不存在，复制为 vault/hebi8.yaml
```

### 1.1 `hebi8.yaml`

```yaml
owner: [dreaife, dreaifekks]   # 可省；写了就是共用实例，这些 GitHub 账号共用根 vault（§1.6），也可以只写一个字符串
sync:
  at: ["07:30", "17:30"]       # 本地时间，按 tz 解释；美股收盘后、亚洲收盘后各一次
  tz: Asia/Tokyo
prices: split                  # split = 拆股复权（默认，和 TradingView 一致）；total = 含分红的总回报
periods: [1W, 1M, 1Y]          # 总览显示的涨跌周期，最多 4 个：1W 1M 3M YTD 1Y 3Y 5Y
updown: green-up               # green-up | red-up

aliases:                       # 公式、警报、对比、合成标的里可用的短名
  SPY: yahoo:SPY
  QQQ: yahoo:QQQ
  HSI: yahoo:^HSI
  CSI300: tv:SSE:000300
  BTC: binance:BTCUSDT
  GOLD: tv:TVC:GOLD
  GPU4090: data:gpu/4090-xianyu

groups:                        # 顺序就是总览和图表右侧自选的顺序，页面上拖动会改写
  - name: 美股
    symbols:
      - SPY                                      # 字符串：别名或完整 key
      - { key: QQQ, bench: SPY }                 # bench：相对强弱、close(bench) 的默认基准
      - { key: yahoo:NVDA, name: 英伟达, bench: QQQ }
  - name: 宏观
    symbols: [GOLD, tv:TVC:US10Y, tv:TVC:DXY]
  - name: 加密
    symbols:
      - BTC
      - { key: binance:ETHUSDT, bench: BTC }
  - name: 港 A
    symbols:
      - { key: yahoo:0700.HK, name: 腾讯控股, bench: HSI }
      - { key: yahoo:600519.SS, name: 贵州茅台, bench: CSI300 }
  - name: 比价
    symbols:
      - { key: "=BTC/GOLD", name: 比特币/黄金 }   # 以 = 开头的是合成标的，见 §3.3

indicators:                    # 公式指标，图表页可开关；语法见 §4
  - { id: dev40, label: 均线乖离, pane: sub, formula: "(close / sma(close, 40) - 1) * 100" }
  - { id: vs_bench, label: 对基准比价, pane: sub, formula: "close / close(bench)" }

alerts:                        # 警报（§2.6）：总览「警报」列按名字显示；图表和总览上建的写成这样，也可以手写
  - { key: BTC, cond: crossing_up, value: 130000, trigger: once }            # BTC 上穿 130,000，仅一次
  - { key: SPY, cond: entering, value: [500, 520], trigger: bar }            # 进入通道，每根 K 线一次
  - { key: NVDA, label: 跌破 200 日线, when: "close < sma(close, 200)" }   # 自定义公式；tf 默认 D
  - { key: GPU4090, label: 4090 咸鱼跌破 1.1 万, cond: less, value: 11000, enabled: false }  # 暂停中
  - { label: 周线多头, when: "close > sma(close, 40) and sma(close, 10) > sma(close, 40)", tf: W, notify: false }  # 不写 key：对全部自选；只在总览显示
  - { label: 破200周, when: "close < sma(close, 200)", tf: W }              # 对全部自选，新成立时推送
  - { key: ETH, cond: less, value: 1500, by: agent }                        # agent 经 MCP 建的（§2.5），盯一个标的的直接生效
  - { label: 放量突破, when: "cross(close, highest(ref(high, 1), 50))", by: agent, draft: true }  # agent 建的对全部自选的警报：草稿，页面上确认（去掉 draft）后才判断

datasets:                      # 自定义数据集（§2.4）：名字 → git 地址或本机目录
  gpu: https://github.com/dreaife/gpu-prices

usage:                         # 可省；超过时给 owner 发一条提醒，每天每种最多一次（§1.7）；只提醒，不限流
  visitors: 200                # 每日公网独立访客
  limited: 20                  # 每日上游疑似限流次数（所有源合计）

chart:                         # 全局图表偏好（UI 改动会写回这里）
  tf: W                        # D | W | M | Q
  log: true
  style: candle_solid          # candle_solid | candle_up_stroke | ohlc | area
  indicators: [MA, VOL]        # 默认开启的指标名（内置 / 代码 / 公式 id）
  params:                      # 按周期覆盖指标参数；没写的用目录里的默认值
    W: { MA: [10, 40, 200] }
  panes: { VOL: main }         # 可省；图例 ⋯「移动到」换过窗格的指标（main / sub），没写的在目录里的默认窗格
```

规则：

- 标的引用（groups、bench、公式里的 `close(X)`、合成表达式、对比列表）一律先查 `aliases`，查不到就当完整 key `source:ticker`。
- `key` 格式：`yahoo:AAPL`、`yahoo:0700.HK`、`yahoo:^GSPC`、`binance:BTCUSDT`、`tv:TVC:US10Y`、`tv:FX_IDC:USDCNH`、`data:gpu/4090-xianyu`，或 `=表达式`。`data:` 的 key 区分大小写，在合成表达式和 `close(...)` 里要用别名或带引号（§3.3）。
- 一个标的只出现在一个组里；`groups` 只有一份，就是唯一的自选列表，组是列表里的分区（TV 的 section）。显示名：`name` > 内置字典（`src/lib/wellknown.ts`）的中文名 > 数据源返回的名字。
- yaml 由 UI 写回时必须保留注释和顺序：用 `yaml` 包的 `parseDocument` 修改后 `toString()`，原子写入（写临时文件再 rename）。
- yaml 解析失败时页面显示错误（含行号），服务不崩。
- **旧的 `conditions`**（`{ id, label, formula, tf, notify }`，以前的示例配置给每个人都预置了一组）照样能读，读成对全部自选的警报：`formula` 当 `when`，`tf` 缺省 W，`label` 缺省是 id，没标 `notify: true` 的读成 `notify: false`。id 沿用原来的；`alerts` 里已经有同名 id 时改成 `cond-<id>`（现有警报的 id 不变）；不是字母数字下划线横线的 id 去掉，改用哈希。
  - **状态跟着走**：旧状态行是 `cond:<id>`，`Config.conditionRules` 记着它们各自变成哪条警报。每次判断（含盘中轮询）、总览读徽标、界面改警报之前，先把这个 vault 的 `cond:<id>` 行改名过去（`adoptConditionState`，`state`、`fired_bar`、`fired_at` 原样保留，改过一次就是空操作），所以本周已触发的仍显示「本周新触发」，升级前为假、升级后为真照样推送。
  - **yaml 搬家**：第一次在界面上建、改、暂停或删除警报时（`editAlerts`），每个条目**原样**（节点本身，注释和别名都在）搬到 `alerts` 末尾：`formula` 键改名为 `when`，id 按上面的规则改，缺省值写明（`label`、`tf: W`、`notify: false`），`conditions:` 行和第一个条目上方的注释跟着第一个条目走，然后删掉 `conditions`。
- `vault.example` 不再预置任何警报或条件。

### 1.2 `notes/<fileKey>.md` 与 `journal/`

```markdown
---
key: yahoo:NVDA
---
# 为什么看
...
```

- frontmatter 的 `key` 是权威，文件名只是派生。
- `fileKey(key)`：`key.replace(/[^A-Za-z0-9.\-]/g, "_")`；合成标的去掉 `=` 后加前缀 `expr_`。例：`tv:TVC:US10Y → tv_TVC_US10Y`，`=BTC/GOLD → expr_BTC_GOLD`。冲突时追加 6 位 hash。
- journal 文件名用 ISO 周：`2026-W41.md`。新建时给模板：`## 市场` / `## 持仓与自选` / `## 变动` / `## 下周看什么`。
- markdown 渲染用 `marked`（单用户本地工具，直接 `dangerouslySetInnerHTML` 即可）。

### 1.3 `charts/<fileKey>.json`

```json
{
  "compare": [{ "key": "yahoo:QQQ", "mode": "percent", "color": "#e8891d" }],
  "overlays": [{ "name": "horizontalStraightLine", "points": [{ "timestamp": 1700000000000, "value": 123.4 }] }]
}
```

- `overlays` 是 KLineChart overlay 的可序列化字段：`name`、`points`、`styles?`（颜色 / 线宽 / 线型 / 字号，绘图工具栏改过才有）、`lock?`、`hidden?`（单条隐藏）、`extendData?`（文字类绘图的文字；斐波那契回撤 / 扩展的设置，见下）、`tvId?`（从 TradingView 导入的，见下）、`scale?`（画的时候主图的价格坐标，见下）。点是 `{timestamp, value}`，所以周线上画的线在日线/月线上也在。
- 趋势线的「向左延长 / 向右延长」不另存字段，用工具名表示，和 TradingView 导入的映射一样：都不延长 `segment`，两边 `straightLine`，只向右 `rayLine`（先早后晚两个点），只向左 `rayLine`（先晚后早：射线从后一个点画向前一个点并越过它）。左右按图上的方向（时间早晚）算。
- 斐波那契回撤（`fibonacciLine`）和基于趋势的斐波那契扩展（`fibExtension`）的 `extendData` 是一个对象 `{ background, transparency, extendLeft, extendRight, oneColor, reverse }`（`fib.ts` 的 `FibSettings`）：档位之间填不填背景、背景的透明度（0–100，照 TradingView 的算法，80 即 alpha 0.2）、档位线向左 / 向右延长到窗格边缘、所有档位用画线自己的颜色（`styles.line`）还是每档一种颜色、档位方向是否反过来（点不变）。没改过设置的画线没有这个字段，按默认值画（有背景、80%、不延长、多色、不反向）；以前存的回撤也是这样，对象里缺的字段同样取默认值，不迁移。
- 平行通道（`parallelChannel`）的三个点：第一条线的两端，加第二条线的起点（和第一个点同一时间）；第二条线和第一条在画线自己的价格坐标（`scale`，旧画线是当前坐标）里平行，终点由此推出。以前存的第三个点可以在第二条线的任意位置，照样画；第一次拖它的任何手柄时改存成第二条线的起点。
- `compare[].mode`：`percent`（主图叠加，同百分比坐标）或 `pane`（独立副图）。
- `overlays[].tvId?`：从 TradingView 导入的画线带着它在 TradingView 的 id（§5.5），再导入时跳过文件里已有这个 id 的。id 挂在每条画线上，图表页随画线一起读写（KLineChart 的 overlay 没有这个字段，`KChart` 把它和单条的 lock / hidden 放在一起，按 overlay id 记着），所以画线在图上删掉了，或者被一个过时的图表页保存冲掉了，它的 id 也跟着没了，再导入一次就回来。没有这个字段的旧画线照常读写。
- `overlays[].scale?`：`"log"` 或 `"linear"`，画完时主图是对数坐标还是普通坐标（百分比坐标算 `linear`）。只有几何随坐标变的工具记（`chart-types.ts` 的 `SCALED_DRAWINGS`：线段 / 射线 / 延长线、信息线、趋势角、平行 / 价格通道、回归趋势、音叉、斐波那契回撤 / 扩展 / 通道 / 扇、江恩方箱 / 扇、形态和艾略特、三角形、弧形、曲线、路径、折线、箭头）。和 `tvId` 一样放在 `KChart` 按 overlay id 记着的那份旁路里。没有这个字段的旧画线（和 TradingView 导入的）跟着当前坐标：在当前轴上画直线、档位按当前轴的空间算，不迁移。

### 1.4 SQLite 缓存

```sql
PRAGMA user_version;           -- 迁移：一个 migrations 数组，按版本依次执行
CREATE TABLE symbols (
  key        TEXT PRIMARY KEY,  -- 不含合成标的
  source     TEXT NOT NULL, ticker TEXT NOT NULL,
  name       TEXT, exchange TEXT, currency TEXT, timezone TEXT, kind TEXT,  -- 来自数据源的元数据
  hours      TEXT,              -- 常规交易时段，交易所当地时钟：HHMM-HHMM（1700-1600 是跨夜）或 24x7；倒计时用（§5.2）
  holidays   TEXT,              -- 交易日历（§2.6）：休市日 20261126,20261225
  corrections TEXT,             -- 交易日历：改了时段的日子（半日市）0930-1300:20261127,20261224;dayoff:20250109
  synced_at  INTEGER, sync_error TEXT, first_t INTEGER, last_t INTEGER
);
CREATE TABLE bars (
  key TEXT NOT NULL, t INTEGER NOT NULL,    -- t：交易日 UTC 零点的 unix 秒（同 v1）
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL,
  adj REAL NOT NULL DEFAULT 1,              -- 分红复权因子；o/h/l/c 本身只做拆股复权
  PRIMARY KEY (key, t)
) WITHOUT ROWID;
CREATE TABLE stats (
  vault TEXT NOT NULL,                      -- §1.6：'' 是根 vault，其他是 GitHub login（小写）
  key TEXT NOT NULL,                        -- 含合成标的
  computed_at INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (vault, key)                  -- 按 vault 存：自选、prices 模式都是各人的
);
CREATE TABLE alert_state (                  -- §2.5；删库后第一次同步只记录、不推送；总览的徽标也从这里读（§5.1）
  vault TEXT NOT NULL,
  rule TEXT NOT NULL, key TEXT NOT NULL,    -- rule：alert:<id 或 hash>；对全部自选的警报每个自选标的一行。旧的 cond:<id> 行先改名成对应警报的行（§1.1），改不过去的在下一次判断时清掉
  state INTEGER,                            -- 上次同步看到的结果 0/1
  fired_bar INTEGER,                        -- 上次推送时那根 K 线的 t，同一根只推一次
  fired_at INTEGER,
  PRIMARY KEY (vault, rule, key)
) WITHOUT ROWID;
CREATE TABLE quotes (                       -- §2.6：盘中轮询拿到的最新价，所有人共用；不是 K 线
  key TEXT PRIMARY KEY,
  price REAL NOT NULL, time INTEGER NOT NULL,          -- 数据源报的成交时间（unix 秒）
  day_open REAL, day_high REAL, day_low REAL, day_volume REAL,  -- 数据源报的当天开、高、低、量，有就记
  session TEXT NOT NULL,                                -- open | closed | pre | post | always
  fetched_at INTEGER NOT NULL
);
CREATE TABLE traffic (                      -- §1.7：按天聚合的请求计数，保留 90 天；行数有上限
  day INTEGER NOT NULL,                     -- 实例时区（sync.tz）的日期，UTC 零点的 unix 秒，同 bars.t
  origin TEXT NOT NULL,                     -- public（隧道）| tailnet
  kind TEXT NOT NULL,                       -- page | prefetch | action | api
  path TEXT NOT NULL,                       -- 路由：本应用的路由、/chart/<有人有的 key>、/chart/[key] 或 (其他)
  n INTEGER NOT NULL,
  PRIMARY KEY (day, origin, kind, path)
) WITHOUT ROWID;
CREATE TABLE visitors (                     -- §1.7：每天每个 origin 最多 2000 个访客，之后的合进 visitor = '(其他)'
  day INTEGER NOT NULL, origin TEXT NOT NULL,
  visitor TEXT NOT NULL,                    -- 客户端 IP 的加盐 HMAC 前 16 位，不存明文 IP
  login TEXT NOT NULL,                      -- 有会话时的 GitHub login（小写），否则 ''
  n INTEGER NOT NULL, last INTEGER NOT NULL,-- 请求数；最近一次的 unix 秒
  PRIMARY KEY (day, origin, visitor, login)
) WITHOUT ROWID;
CREATE TABLE upstream (                     -- §1.7：按天、按源的上游调用
  day INTEGER NOT NULL, source TEXT NOT NULL,
  requests INTEGER NOT NULL, failures INTEGER NOT NULL, limited INTEGER NOT NULL,  -- failures 含 limited
  PRIMARY KEY (day, source)
) WITHOUT ROWID;
CREATE TABLE usage_alerts (kind TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (kind, day)) WITHOUT ROWID;  -- 哪天哪种阈值已经提醒过
CREATE TABLE profiles (                     -- §2.8：标的的基础资料，每周从数据源取一次，所有人共用
  key TEXT PRIMARY KEY,                     -- 不含合成标的；数据源没有资料接口的（binance）没有行
  json TEXT,                                -- 最近一次成功取到的 SourceProfile；只有慢变的事实，没有市值 / PE / 股息率
  fetched_at INTEGER,                       -- 那次成功的时间（ms），面板上的「资料更新于」
  tried_at INTEGER NOT NULL, error TEXT     -- 最近一次尝试的时间和失败原因（成功时为空）；失败不动 json
);
CREATE TABLE translations (                 -- §2.8：简介的简体中文译文，有人点「翻译」时才生成，所有人共用
  key TEXT PRIMARY KEY,
  hash TEXT NOT NULL,                       -- 被翻译的那段原文的 SHA-256；和现在的简介对不上就不再显示
  text TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL
);
```

`symbols`、`bars`、`profiles` 和 `translations` 里只有缓存和元数据，**没有任何用户字段**（名字、分组、基准、排序都在 yaml），所有人共用；`stats` 和 `alert_state` 按 vault 分开。两表加 `vault` 列的迁移直接删表重建，下次同步重算。

### 1.5 用户配置目录（`HEBI8_SECRETS`，默认 `~/.config/hebi8/market`，目录 700、文件 600）

不在 vault、不在 data、不进 git：`sessions.json`（GitHub 登录，§5.8）、`mcp-tokens.json`（agent 用的个人令牌，只有哈希，§1.6、§5.5）、`github-oauth.json`（网页登录的 client id 和 secret，手写，§5.8）、`notify.json`（实例的通知设置，§2.5）、`notify-users.json`（每个人绑定的通道，§2.5）、`vapid.json`（网页推送的 VAPID 密钥对，首次用到时生成，§2.7）、`traffic-salt.json`（访客哈希的盐，首次用到时生成，§1.7）、`llm.json`（翻译简介用的模型，手写，可省，§2.8）。

### 1.6 多人共用一台实例

几个人共用一台 hebi8：K 线缓存、同步、数据集是共享的；**自选、别名、公式指标、警报、图表偏好、笔记、复盘、画线和通知都是各人的**。

**开关**：根 vault 的 `hebi8.yaml` 写 `owner: <GitHub login>`，或者一个列表 `owner: [dreaife, dreaifekks]`（同一个人的几个账号）。列表里任何一个账号登录都用根 vault，页面上称呼第一个。没写就是单用户模式，行为和现在完全一样（不用登录，谁都能改根 vault）。

**命名**：`hebi8` 以后是一组东西的总名，这个应用对外叫 **hebi8/market**（页面标题、通知标题、Telegram 确认消息、webhook 的 `Title` 头），不能带斜杠的地方用 **hebi8m**（会话 cookie `hebi8m_session`、日志前缀 `[hebi8m]`）。cookie 不分端口，同一台机器上别的 hebi8 应用不会和它抢；配置目录也放在 `~/.config/hebi8/market/` 下。

**谁看哪个 vault**（每个请求从 `hebi8m_session` cookie 解析出 viewer，`src/lib/viewer.ts`）：

| 访问者 | 看到 | 能改 |
|---|---|---|
| 单用户模式，任何人 | 根 vault | 根 vault |
| owner 登录 | 根 vault | 根 vault，含实例设置 |
| 其他人登录 | `vault/users/<login>/` | 自己的 vault |
| 未登录 | 根 vault 的总览和图表（含画线） | 不能改；笔记、复盘页提示「登录后看自己的」 |

- login 一律转小写作为目录名和 `vault` 列的值（GitHub login 只有字母数字和 `-`，大小写不敏感）。根 vault 的 `vault` 值是 `''`。
- **实例级设置只认根 vault**：`owner`、`sync`、`datasets`、`usage`。用户 yaml 里写了也忽略（页面上提示一次）。
- **第一次登录**的非 owner：复制根 vault 的 `hebi8.yaml` 作为起点，去掉 `owner`、`sync`、`datasets`、`usage`、`alerts` 和旧的 `conditions`（不替任何人预置警报），分组按「美股、宏观、加密」在前、其余按 owner 原来的顺序排（`vault.example` 也是这个顺序）；notes / journal / charts 为空。之后两边互不影响。
- **所有写操作**（Server Actions、写文件的 Route Handler）都先取 viewer，`canWrite` 为假就返回「请先登录」；写入路径只来自 viewer 的 vault 目录，不接受客户端传来的目录或 login。读操作同样只读 viewer 的 vault。
- **agent 的身份是个人令牌**，不是 cookie。令牌在设置页生成（§5.5），`mcp-tokens.json` 里以令牌的 SHA-256 为键记一条 `{ name, login, write, created_at, used_at }`，明文只在生成时显示一次。`/mcp` 的每个请求带 `Authorization: Bearer <令牌>`，由 `tokenViewer()`（`src/lib/viewer.ts`，令牌变成 viewer 的唯一一处；以后别的途径发的令牌也接到这里）解析成**和这个人登录后一样的 viewer**：owner 的令牌是根 vault，其他人的是 `vault/users/<login>/`，单用户模式下是根 vault；只读令牌的 `canWrite` 为假。令牌不存在、已吊销，或者是实例改成共用之前生成的（`login` 为空，不属于任何人），都解析不出 viewer。`used_at` 和会话的 `seen_at` 一样一天最多写一次。令牌不过期，不用了就吊销；每人最多 20 个。
- **同步**：要同步的 key 是所有 vault 的并集（各自的 groups、bench、公式引用、告警、charts 对比列表）。同步后对每个 vault 算一遍 stats 和告警。
- **页头**：右侧显示当前身份。未登录是「登录」按钮：当前入口提供网页登录时整页跳到 GitHub、授权后回到原来的页面，否则打开登录抽屉开始 device flow（§5.8）；登录后是头像 + login，菜单里有「通知设置」（同一个抽屉，§2.5）、「在其他设备上登录」（同一个抽屉，打开就生成链接，§5.8）、owner 才有的「使用情况」（§1.7）和「退出」。owner 模式下未登录时，总览标题是「示例列表」（内容就是 owner 的列表）。
- **怎么用**：第一次打开总览时弹出一个三步引导面板（扫描 / 深看 / 记录），每步一张循环小动画，←/→ 翻页；关掉后记在浏览器 localStorage，不再自动出现，帮助抽屉「使用」页签里的「打开三步引导」可以再打开。访客的最后一步是「用 GitHub 登录」和「先看看示例」。
- 登录会话和反馈共用（§5.8）；退出只删会话，不动 vault。
- **在其他设备上登录**（只在共用模式有）：已登录的人从页头的头像菜单（或账号抽屉里用户名下面的按钮）生成一个 2 分钟有效、只能用一次的链接（也画成二维码），另一台设备打开、在页面上确认后，以同一个人的身份得到一条自己的会话，不用再过一遍 GitHub（§5.8）。
- **会话滑动续期**：会话连续 30 天（`SESSION_DAYS`）没用过才过期，按最后使用时间 `seen_at` 算，不看登录时间，也不看 GitHub token（token 过期只影响应用内提交，§5.8）。续期在 proxy 里做（`src/proxy.ts`，和流量计数同一处，§1.7）：请求带着有效会话、`seen_at` 距今超过一天时，把 `seen_at` 写成现在，并在响应上把 cookie 重新设成 30 天。所以一条会话一天最多写一次 `sessions.json`；没带会话 cookie 的请求不读这个文件。`/api/github/*` 不续：这些接口自己设置或清除会话 cookie。
- 会话 cookie 经 HTTPS 来的请求（隧道，`X-Forwarded-Proto: https`）带 `Secure`；Tailscale 直连是 http，不带，照样能登录。两边 Host 不同，cookie 各存各的；网页登录只在登记了回调地址的入口提供（默认只有公开地址），其他入口用 device flow。

### 1.7 流量监控

公开以后先做到「看得见」：谁在用、用了多少、上游被问了多少次。**不限流、不封禁、不加访问控制**；人多了再决定策略。

- **记录挂在 proxy**（`src/proxy.ts`）。这版 Next 的 proxy 默认跑 Node.js runtime，在同一个进程里 `require`，路由之前执行，所以页面、Server Action（对页面的 POST，带 `Next-Action` 头）和 API 路由都经过它；matcher 排除 `_next/static`、`_next/image`、favicon、`icon.svg`、`apple-icon`、`manifest.webmanifest`、`opengraph-image` 和带静态扩展名的文件（`robots.txt`、`sitemap.xml` 也在其中）。proxy 只往 `globalThis` 上的内存表里加计数（`src/lib/traffic.ts`），不碰数据库；带会话 cookie 的请求还在这里滑动续期（§1.6）。
- **来源**按 Host 判断：公网域名是隧道（`public`）；IP、单标签名、`localhost`、`*.ts.net` 是 Tailscale（`tailnet`）。**类型**：`/api/*` 和 `/mcp` 是 api，带 `Next-Action` 是 action，带 `Next-Router-Prefetch` 是 prefetch（路由预取，不算浏览，热门路径里不列），其余是 page。
- **路径归一**（行数不能被扫描器撑大）：proxy 把路径换成本应用真实存在的路由（`traffic.ts` 的 `ROUTES`，测试对照 `src/app` 下的文件保持同步）；`/chart/<key>` 统一成一种编码，落库时只有 `symbols` 或 `stats` 表里有的 key（也就是有人在看、在同步的品种，含合成标的）才保留，其他归到 `/chart/[key]`；匹配不到任何路由的一律是 `(其他)`。所以 `traffic` 每天的行数 ≤ 2 个 origin × 4 种类型 ×（路由数 + 已有品种数 + 2）。
- **访客**：公网取 `CF-Connecting-IP`，Tailscale 取 Next 填进 `X-Forwarded-For` 的 socket 地址；存 `HMAC-SHA256(盐, IP)` 的前 16 位，盐在配置目录的 `traffic-salt.json`。访客单独一张表（`visitors`），不和路径交叉：每天每个 origin 最多 `MAX_VISITORS = 2000` 个不同访客，已存的照常累加，新来的超出上限就合进 `(其他)` 这一行，页面上那天的访客数显示成「2000+」。代价是热门路径不再有「每个路径多少访客」。**登录名**：proxy 只记会话 cookie，落库时整批只读一次 `sessions.json`，在内存里查；伪造的 cookie 查不到就是未登录。
- **落库**（`src/lib/usage.ts`，从 `instrumentation` 启动，`globalThis` 防重复）：每 30 秒一次，或内存里攒到 5000 个不同的键时提前；同一天、同一组维度的行累加。写库失败（锁超时、磁盘满）时这一批合并回内存缓冲，下次再写。进程退出丢最后几十秒的计数，可以接受。每小时删一次 90 天以前的行。监控数据只在 `data/hebi8.db`，不进 vault。
- **上游压力**：`src/lib/sources/index.ts` 把 yahoo、binance、tv 三个适配器的 `fetchDaily` / `search` / `quotes` / `profile` 包一层，每次调用记一次请求（Binance 的 `search` 除外：它读缓存一天的交易对列表，由 `usdtBases()` 在真正去取列表时自己记，失败时照样回退到旧列表）；抛错记失败，错误里有 HTTP 429 / 403 / 418、Too Many Requests、rate limit 的另记「疑似限流」。`data` 源平时读本地文件，只在真正 `git fetch` / `clone` 远端数据集时记一次。按调用计数：Binance 全量拉取的分页算一次。
- **页面 `/usage`**：只有 `viewer.isOwner` 能看，其他人（包括单用户模式）404；入口是页头账号菜单里的「使用情况」。最上面是「实例」：版本（`APP_INFO`：version · commit · 构建时间）、上次同步、下次同步（调度器 `scheduledNextSync()`，没启动时按 `sync.at` 推算）和每天的时间表、缓存的标的数、上次同步出错的标的和错误（所有 vault 的，名字按根 vault 解析）、根 vault 的绝对路径。这些原来在帮助抽屉里给所有人看，对用的人是噪音，只留给 owner。然后是最近 30 天每天的请求数（页面 / 预取 / Action / API）、公网和 Tailscale 的独立访客、登录用户数；今天的热门路径；最近 30 天访客按请求量排行（只显示哈希前 8 位）；各 vault 的品种数、告警数、最近活跃时间；各数据源每天的请求 / 失败 / 疑似限流。打开页面时先落一次库。
- **阈值提醒**：根 yaml 的 `usage.visitors`（每日公网独立访客）、`usage.limited`（每日上游疑似限流次数），正整数，可省；`/usage` 页面上也能改（Server Action `setUsageLimits`，parseDocument 写回）。每 5 分钟落库后检查一次，查今天和昨天（午夜前最后几分钟超过的，过了午夜照样补发，消息里写「昨天（10-06）」），超过（严格大于）且还没提醒过的合成一条消息，发到根 vault 的通道（§2.5 的 `channelsFor('')`）；有通道发送成功才按那一天记进 `usage_alerts`；全部失败或没有通道时只打日志、不记，下次检查再试，当天补好通道也能收到。每天每种最多一次。
- **隐私说明 `/privacy`**：公开页面，页脚（`SiteFooter`，图表页不显示，帮助抽屉的「使用」页签也有入口）链过去。逐条写明收集什么、存哪里、留多久：访问统计、VibeCafé 作品统计、Cloudflare、GitHub 登录与令牌、各自的 vault 与通知通道、公开的反馈 issue、浏览器本地存储、行情由服务器代取。收集的东西变了就同步改这一页和它的更新日期。
- **VibeCafé 作品统计**：唯一的第三方统计脚本，根布局 `<head>` 里的一个 `<script defer>`（`vibecafe.ai/telemetry/v1.js`，带作品 id 和只在公网域名下有效的浏览器接入标识）。每次打开或切换页面上报一次「浏览」和本地存储里的随机访客编号，不带页面地址；浏览器开了 DNT / GPC 时不上报。和上面的流量监控互不相干，本应用不读它的数据。

---

## 2. 数据源与同步

### 2.1 适配器接口

```ts
interface SourceAdapter {
  fetchDaily(ticker: string, since: number | null): Promise<{
    bars: Bar[];                     // 含 adj
    meta: { name?: string; exchange?: string; currency?: string; timezone?: string; kind?: string };
    mode: "replace" | "merge";
  }>;
  search?(query: string): Promise<{ key: string; name: string; exchange?: string; kind?: string }[]>;
  quotes?(tickers: string[]): Promise<Record<string, SourceQuote>>;   // 盘中最新价，§2.6
  profile?(ticker: string): Promise<SourceProfile>;                   // 基础资料，§2.8；数据源认得这个标的但没什么可说时是 {}
}
```

| 源 | 价格 | adj | 增量 | 搜索 | 备注 |
|---|---|---|---|---|---|
| `yahoo` | `chart()` 的 open/high/low/close 本身是拆股复权，**原样存** | `adjclose / close` | 全量 replace | `new YahooFinance().search(q)` | 直接请求 Yahoo 会 429，必须走 yahoo-finance2 |
| `tv` | `setMarket(ticker, { timeframe: "D", range: 100_000, adjustment: "splits" })` | 1 | 全量 replace | `symbol-search.tradingview.com/symbol_search/v3`（库的 `searchMarketV3` 丢了 logo 和 typespecs，自己请求） | 一次同步共用一个 `Client`，顺序开 chart；30s 超时；逆向接口可能失效，错误只记在该标的上 |
| `binance` | `/api/v3/klines` 1d | 1 | 增量 merge（回拉 3 天覆盖未收盘的那根） | 静态：`/^[A-Z0-9]{2,12}USDT$/` 命中即给候选 | 00:00 UTC 开盘，无需时区换算 |
| `data` | 数据集仓库里的 CSV（§2.4） | 1 | 全量 replace | 列出 yaml 里各数据集清单中的序列 | 日期直接是 UTC 零点，不经 `tradingDay` |

- 时间戳 → 交易日的映射沿用 v1 的 `tradingDay(tsSec, timeZone)`（+12h 后取交易所时区的日期）和 `tests/time.test.ts`，原样保留。各源的约定：美股记在开盘 13:30 UTC，亚洲记在 01:30 UTC，FX/TVC 记在前一晚的开盘。
- 已知数据事实：现库 12 个标的 73,543 根日线；`tv:TVC:US10Y` 2013 年以前没有周一的数据（源本身缺），周线合成能正常处理。

### 2.2 调度器（应用内，不依赖 systemd timer）

- `src/instrumentation.ts` 导出 `register()`，仅在 `process.env.NEXT_RUNTIME === "nodejs"` 时启动调度；用 `globalThis` 守卫防止 dev 模式重复启动。
- 按 `sync.at × sync.tz` 算下一个时刻（用 `Intl.DateTimeFormat` 处理时区与夏令时，不引入日期库），`setTimeout` 链式调度。
- 启动时：若 `max(symbols.synced_at)` 早于最近一个已过去的时刻，延迟 5s 后补跑一次（等价 systemd 的 `Persistent=true`）。
- 每次调度的同步跑完（K 线、stats、警报之后），再刷新到期的标的资料（§2.8）。资料自己在后面跑，**不等它**：同步一完就照常排下一次，数据源再慢（TV 的会话一个要等 20 秒超时）也不会把下一个时刻拖过去；它出错只记一行日志。同步本身失败的那一轮不刷资料。手动「刷新」不带这一步。
- 日志打到 stdout（journalctl 能看）。

### 2.3 `syncAll(force?)` / `syncOne(key, force?)`

- 要同步的 key 集合 = groups 里的 + 所有 `bench` + 公式/警报/合成表达式/各 `charts/*.json` 对比列表引用到的；共用实例时取所有 vault 的并集（§1.6）。别名本身不触发同步。
- 并发 4，同 key 去重，单个失败不影响其他；失败写 `sync_error`，页面上显示。
- 同步完成后立刻对**每个标的（含合成）**计算 `stats` 并写表（§3.4）。
- 读取路径（页面、API）**只读库**。首次运行库为空时，总览显示「首次拉取中…」并每 3s 刷新一次，同时后台触发 `syncAll`。
- 「刷新」按钮是 Server Action：`await syncAll(true)` 后 `revalidatePath`，按钮期间显示 pending（手动动作，阻塞 3–30s 可以接受）。
- 新增标的时立即 `syncOne(key, true)`，失败则不写入 yaml 并报错（首次拉取兼做校验）。
- **打开不在自选里的标的**（搜索选中、直接输网址）：页面照样只读库；图表页挂载后调 Server Action `loadSymbol(key)`，对它（合成标的是各操作数）`syncOne`，一小时内拉过就跳过，只进缓存、不写 yaml，完成后重新取 `/api/bars`。它不在任何 vault 的引用里，所以定时同步不会更新它，下次打开时再补。访客不能触发（和添加一样要登录），只能看到已经缓存的。
- `syncOne` 只在真的拉到新数据时重算各 vault 的 stats。它成功后顺带看一眼这个标的的资料（§2.8）：还没有，或者到期了，就发起一次，**不等它回来**：日线到了就返回，加自选和打开图表不多等一次资料请求。资料晚一两秒落库，面板自己再读（§5.2）；取资料失败不算同步失败。
- `syncAll` 算完 stats 后跑一次通知（§2.5）；`syncOne` 不通知。

### 2.4 自定义数据集（`data` 源）

任何按约定放日线 CSV 的 git 仓库或本机目录都是一个数据源，比如爬虫每天推送的显卡二手价。**hebi8 只读，不爬。** 仓库就是两边的契约。

```yaml
# 仓库根目录 hebi8-dataset.yaml
name: 显卡二手与零售价
description: 每天从闲鱼和京东抓取的显卡价格            # 可省：没有自己 description 的序列用它
links:                                              # 可省：对所有序列都适用的链接（数据出处），排在序列自己的后面
  - { name: 数据出处, url: https://github.com/dreaife/gpu-prices }
series:
  - id: 4090-xianyu
    name: RTX 4090 咸鱼
    currency: CNY
    file: series/4090-xianyu.csv
    description: 闲鱼上 RTX 4090 的每日中位成交价      # 可省
    links:                                          # 可省
      - { name: 闲鱼搜索页, url: "https://www.goofish.com/search?q=4090" }
  - { id: 4090-jd, name: RTX 4090 京东, currency: CNY, file: series/4090-jd.csv }
```

```csv
date,open,high,low,close,volume
2026-10-05,,15800,11200,12900,184
2026-10-06,,15500,11000,12650,171
```

- key：`data:<数据集>/<序列 id>`。数据集名在 yaml 的 `datasets` 里映射到地址，key 里不写地址，仓库搬家不影响图表和笔记。数据集名和序列 id 只能用 `[A-Za-z0-9._-]`，并以字母或数字开头。
- 地址是 `https://`、`git@`、`ssh://`、`file://` 时浅克隆到 `data/datasets/<name>/`，之后每次同步 `git fetch --depth 1` 再 `reset --hard`；私有仓库直接用机器上的 SSH key。以 `/`、`~/`、`./`、`../` 开头时当本机目录直接读，相对路径相对于 vault 目录。同一次同步里一个数据集只拉一次。
- CSV：表头必须有 `date` 和 `close`，其余列可选、可留空。`open` 空时用 `close`；`high`/`low` 空时取 `open`/`close` 的较大/较小值；`volume` 空为 null。`date` 是 `YYYY-MM-DD`，映射到当天 UTC 零点。同一天出现两次取后一行；空行和 `#` 开头的行跳过。格式错误报行号，只记在这个标的上。
- 元数据：`name`、`currency` 来自清单，`exchange` 是清单的 `name`，`kind` 是 `dataset`。
- **详情和链接由数据集自己提供**（§2.8）：序列可以带 `description` 和 `links`（`{ name, url }` 的列表），数据集一级也可以各带一份，对所有序列适用。「商品详情」里这条序列的简介是它自己的 `description`，没有就用数据集的；「相关链接」是它自己的 `links` 接上数据集的（同一个地址只列一次）。清单没给就没有这一节：hebi8 不替数据集配链接，也不拿仓库地址兜底。
- 清单是别人仓库里的内容，`url` 会被渲染成 `href`：解析清单时只留 `http:` / `https:` 的，其它协议（`javascript:`、`data:`、`file:`、相对路径）和没有地址的条目直接丢掉，不报错；`name` 没写就用域名。
- 比价数据的用法建议：`close` 放当天中位价，`high`/`low` 放区间，`volume` 放有效挂单数。

### 2.5 同步后通知

**只有一个概念：警报。** 以前总览的「条件」（全局公式，示例配置给每个人预置了一组）和图表上的「价格警报」是两套相似的东西：都是布尔规则、都按 `alert_state` 判定新成立、都走同一条推送路径，区别只在作用范围和名字从哪来。合并后警报多一个作用范围（一个标的 / 全部自选）和一个 `notify` 开关，条件能做的事都能做，名字永远是用户自己起的，界面上只有一个对话框、一个列表。

在 `syncAll` 收尾、stats 写完之后对**全部警报**跑一遍（§2.6 的盘中轮询只看判断时机是「盘中价格」的警报）。规则只有一种，`alerts` 里的每一项，按作用范围求值：

- 写了 `key`：只对这一个标的求值。
- 没写 `key`：对每个自选标的（含合成）分别求值，`bench` 是各自的基准。只能是 `when` 公式或涨跌 %（价格和通道离开具体标的没有意义，解析时报错）；`trigger` 固定是每根 K 线最多一次。在界面上新建、修改或恢复这样一条时，保存后立刻只把这些警报算一遍（`runAlerts(…, "watchlist")`，日线收盘的按已收盘日线，盘中价格的按带今日 K 线的日线），总览不用等下一次同步。

**草稿和来源**（agent 经 `/mcp` 建的警报，§6）：

- `by: agent`：这条警报是 agent 建的或最后改过的，警报面板上名字旁边标「Agent」。人在页面上编辑不去掉它。
- `draft: true`：草稿。**不判断、不推送、不进轮询、总览上不显示徽标**，`alert_state` 里也没有它的行；警报面板里状态是「待确认」，按钮是「确认 / 丢弃」，总览表格上方另有一块「待确认的警报」列出它们（总览没有警报列表，徽标又不显示草稿，不列出来就没人知道有东西在等）。「确认」（Server Action `confirmAlert`）去掉 `draft` 和 `enabled: false`，状态清零，对全部自选的立刻判断一次，之后和页面上新建的一条没有区别；「丢弃」就是删除。手改 yaml 把 `draft: true` 删掉等于确认。草稿在页面上编辑后仍是草稿。
- **规则**：盯一个标的（有 `key`）的警报，agent 保存后直接生效。对全部自选（没 `key`）的警报，agent 只能存成草稿：新建是草稿，编辑一条草稿仍是草稿；**不是草稿的那些 agent 不能编辑**（带它的 id 保存会报错「这条对全部自选的警报不是草稿，agent 不能改：不带 id 另存一条新的…」，原警报原样继续生效；不让它变回草稿，是因为那样用户确认过的监控会一直断到下次确认），要改就另存一条新草稿，用户确认后再删旧的；已停止的不能由 agent 恢复（「对全部自选的警报只能由用户在页面上恢复」），草稿也没有经 MCP 确认的办法。停止和删除不受限制。理由：盯一个标的的警报最多打扰一次、范围看得见；对全部自选的一条公式写错了会在几十个标的上一起推送，所以要人看过。
- 两个字段都不参与 id（§2.5 的哈希只看范围和条件），确认前后是同一条警报。`draft` 可以手写在任何警报上；`by` 只认 `agent`，其他值忽略。

**判断时机**（`check`，每条警报一个）决定什么时候判断、看不看今天还没收完的那根日线；`tf`、触发方式、`fired_bar`、「新成立才推送」都不受它影响，切换它也不换 id（状态保留）：

| `check` | 界面叫法 | 什么时候判断 | 看哪些日线 |
|---|---|---|---|
| `price` | 盘中价格 | 每轮报价之后（§2.6），日线同步收尾时也判断一遍 | 库里的日线接上报价拼出的今日 K 线（同步收尾时就是同步回来的日线，含当天那根） |
| `close` | 日线收盘 | 只在日线同步收尾时 | 只看已经收盘的日线：最后一根的交易日还没走完就不算它，看前一根 |

- 默认值：写了 `key` 的是 `price`，没写的是 `close`，等于默认值时不写进 yaml（所以以前的 yaml 一个字不用改）。两种警报都可以改成另一种：对全部自选选「盘中价格」，就每轮对每个自选标的判断（自选都在轮询里）；盯一个标的选「日线收盘」，它的标的不为它进轮询。
- 「已经收盘」怎么判断（`closedReader()`、`dayCloseAt()`）：全天交易的（`hours` 是 `24x7`）到那个 UTC 日结束；交易所的到那一天的收盘时刻（交易日历里那天的时段，半日市就是提前的那个时刻，§2.6；交易所时区）；`hours` 还没同步出来的，到交易所日历上那一天结束；假日没有新 K 线，不影响判断（库里真有一根落在日历写的假日上，就按平常那个星期的时段算）；`data:` 数据集的行是发布出来的值，全部算已收盘。合成标的和公式里引用的别的标的（`close(QQQ)`、`bench`）各按自己的已收盘日线。
- 和以前的差别：以前对全部自选的警报在同步收尾时用的是库里全部日线，同步时还没收完的那根也算。现在（它们默认是日线收盘）不算。实际受影响的是同步时正在交易的品种：加密（07:30 / 17:30 同步时 UTC 日都没走完，以前看的是当天到同步那一刻的价，现在看前一个 UTC 日的收盘）、跨夜的期货 / 外汇 / 贵金属（早上同步时新的交易日刚开始），以及盘中手动点「刷新」时的任何品种。同步时已经收盘的股票不变。

`when` 就是布尔公式，能用别名、`close(X)`、`bench`，tf 默认 D。

**判定**（`when` 公式）：每条警报、每个标的在 `alert_state` 里记上次看到的布尔值。

1. 第一次见到（新警报、新标的、删过库）：只记录，不推送。
2. 这次为真、上次不为真、且最后一根 K 线的 `t` 不等于 `fired_bar`：触发，`fired_bar` 记成这根的 `t`，`fired_at` 记成触发时间。周线公式在本周反复真假时只触发一次。
3. 结果为 null（数据不够、公式出错）：不改状态。

**不推送的警报**（`notify: false`）照样判定、照样记 `fired_at`（总览靠它显示「本周新触发」），只是不进摘要；投递失败时它们的状态照常提交。

**清理**：每次判断后，删掉 `alert_state` 里不再被 yaml 覆盖的行（警报删了、标的不在自选里了、没对上任何警报的旧 `cond:` 行）。

**按人**：每个 vault 各自判定、各自投递，状态表按 `vault` 分开。

**投递**：一个 vault 一次同步的所有事件合成一条纯文本摘要，同时发到这个人的每个通道（Telegram、webhook、推送并列，一个失败不影响别的）；有一个通道成功就提交状态，全部失败则不提交，下次同步再试。没有配置通道时只打日志、照常提交。

```json
{
  "telegram": { "token": "123:abc", "chat": "123456789", "api": "https://api.telegram.org" },
  "webhook": { "url": "https://ntfy.sh/hebi8-xxxx", "format": "text" },
  "link": "http://100.92.194.31:8808"
}
```

- `notify.json` 是**实例**的设置，由部署的人手写：bot 的 `token`、`api`，以及 `link`。其中 `telegram.chat` 和 `webhook` 是根 vault（单用户模式或 owner）的通道，和以前兼容。
- owner 有几个账号时，根 vault 的通道记在第一个 owner 名下，用哪个账号登录绑定都是同一份。
- 其他人的通道在 `notify-users.json`：`{ "<login>": { "telegram": { "chat": "..." }, "webhook": { "url": "...", "format": "text" }, "push": [{ "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." }, "label": "Chrome · Android", "added": 1760000000000 }] } }`，由页面写入（原子写、600），不手改。`push` 是开了推送的设备（§2.7），只有页面能加，`notify.json` 里没有对应的段。owner 也可以在页面上绑定，写进这里时优先于 `notify.json` 里的 chat / webhook。
- `telegram.api` 可省，指向自建 Bot API 服务时改它。
- `webhook.format`：`text`（默认，正文就是摘要，带 `Title` 头，适合 ntfy）或 `json`（`{ title, text, events }`）。
- `link` 可省；有的话每条事件后面带图表页链接。
- `npm run notify:test` 往 `notify.json` 里的通道发一条测试消息。
- **owner 在页面上设置 bot**：「通知设置」抽屉里，owner 多一块「实例的 Telegram bot」：显示「未配置」或 `@<bot 用户名>`；粘贴 token 后服务端先用 `getMe` 校验，通过才写进 `notify.json`（保留文件里的其他字段，原子写、600），「移除」删掉 telegram 段。token 写进去以后不再回显，只显示 bot 用户名。接口 `PUT /api/notify/bot`、`DELETE /api/notify/bot`，非 owner 返回 403。

**通知设置抽屉**（`AccountPanel`，和帮助抽屉同样的位置和尺寸，但不是它的页签：通知设置只有这一个入口）。页头的「登录」和账号菜单的「通知设置」都打开它：未登录时标题是「登录」，显示 device flow（从「登录」打开时直接开始）；登录后标题是「通知设置」，顶部是头像 + login +「退出」，下面是这个人的通道，owner 再多一块实例的 bot。只有共用实例有登录，所以单用户模式没有这个抽屉，通道和 bot 都手写 `notify.json`（README「通知」）。

- **绑定 Telegram**：服务端生成一次性码（10 分钟有效，内存里），用 `getMe` 拿 bot 用户名，返回 `https://t.me/<bot>?start=<码>`；面板显示「打开 Telegram 点 Start」和等待状态。有待绑定的码时，服务端用 `getUpdates` 长轮询（timeout 25 秒，只往外连）读 bot 收到的消息；私聊里收到 `/start <码>` 就把这个 chat id 记到对应 login，回一句「已绑定 hebi8：<login>」，确认 update 的 offset。没有待绑定的码时不轮询。
- 实例的 bot 必须是 hebi8 专用的：同一个 token 被别的程序（比如 Hermes 网关）`getUpdates` 时两边会抢消息。
- **webhook**：输入地址和格式，保存前校验 http(s)。
- **推送**：「在此设备上接收推送」开关和已开启的设备列表，见 §2.7。
- **发测试消息**、**解除绑定**。状态行显示已绑定的通道（chat id 只显示后 4 位，webhook 只显示主机名）。
- 接口：`GET /api/notify`（当前 viewer 的通道摘要）、`POST /api/notify/telegram`（开始绑定，返回链接）、`POST /api/notify/telegram/poll`（查绑定结果）、`PUT /api/notify/webhook`、`PUT /api/notify/push`（这个浏览器的订阅）、`DELETE /api/notify/push?id=`、`DELETE /api/notify/<channel>`、`POST /api/notify/test`。都要求登录，只作用于 viewer 自己。

### 2.6 价格警报与盘中轮询

照搬 TradingView 的警报模型，但只看日线：判断时把最新价当作今天这根还没收完的日线（股票按交易所当地日期归日，加密按 UTC 日，跨夜品种按交易时段归日，见下），接在库里的日线后面。这根 K 线优先用数据源随报价给的当天数字：`o` 是数据源的开盘价（没有就用库里同一天那根的开盘，再没有就是轮询见到的第一个价），`h`/`l` 取数据源报的日内高低、库里同一天那根的高低和轮询见过的最高最低，`c` 是最新价，`v` 是数据源的当天成交量和库里同一天那根的成交量里较大的那个（当天的量只增不减，报价比已同步的日线慢时不让它倒退；都没有就是没有）。**这根 K 线只在内存里，绝不写进 `bars`**；下一次日线同步拿到真正的日线后自然替换。

报价归到哪个交易日（`quoteDay()`）：加密按 UTC 日；Yahoo 按交易所当地日期（它的日线就是日历日）；TradingView 的品种按它自己的交易日历（`tradingDayAt()`，日历见下文「交易日历」）。跨夜的时段（`1800-1700` 的贵金属、`1700-1700` 的外汇、`1900-1730` 的美债收益率，或开始时间后带 `F` 的 `1700F-1900`）算在它结束的那一天：往后找最近的一个「时段已经开始」的交易日，报价就是那一天的，和日线一致。平时是前一晚开盘的明天那一节；跨假日时 TradingView 把假日的交易并进下一个交易日（周一假日后周二的 `1800F2-1430F1,1800-1700`，从两天前的周日晚上开始），一样找得到。归到的日期是**库里那根日线的日期**，不是 TradingView 日历上的日期：日线记在时段开始的时刻，`tradingDay()` 把它存成开始那晚的第二天，所以上面那根从周日晚上到周二收盘的合并日线存在周一名下，周一、周二白天的报价都接到它上面（实测 ES、黄金、原油在 2026-01-19、2026-07-03 两个假日都是这样）。今天按一周的时段本来就不交易（周日晚上，开盘比写的时间早一点）也算明天。**后面没有已经开始的时段时不往后推**：周五收盘后还会来几笔报价（黄金到纽约 19 点多），它们仍是周五的，假日前一晚同理；否则周末会在图上多出一根和周五一模一样的周六 K 线。时段不跨夜的（布伦特 `0100-2300`，伦敦时间）整天都算当天。不按固定的「17:00 之后算第二天」推：各品种的开盘时间不一样，布伦特根本不跨夜。还没同步到 `hours` 的品种按当地日期。

**警报的写法**（`alerts` 里每一项二选一）：

| 字段 | 说明 |
|---|---|
| `key` | 标的（别名或完整 key，合成标的也行）；不写就是对全部自选（§2.5） |
| `cond` + `value` | 图表上建的结构化条件，见下表 |
| `when` | 自定义公式（布尔），和条件公式一样；`tf` 默认 D |
| `trigger` | `once`（仅一次，默认）或 `bar`（每根 K 线一次） |
| `check` | 判断时机（§2.5）：`price` 盘中价格或 `close` 日线收盘；可省，写了 `key` 默认 `price`，没写默认 `close` |
| `label` | 可省，省了按条件自动生成，比如「BTC 上穿 130,000」；总览徽标上显示的就是它 |
| `enabled` | 可省，默认 true；`false` 是已停止 |
| `notify` | 可省，默认 true；`false` 只在总览显示，不推送 |
| `draft` | 可省；`true` 是待确认的草稿，不判断（§2.5） |
| `by` | 可省；`agent` 表示经 MCP 建的或改的（§2.5） |
| `id` | 可省，见 §2.5 |

| `cond` | TradingView 叫法 | `value` | 类型 |
|---|---|---|---|
| `crossing` | 穿过 | 价格 | 事件 |
| `crossing_up` / `crossing_down` | 上穿 / 下穿 | 价格 | 事件 |
| `greater` / `less` | 大于 / 小于 | 价格 | 状态 |
| `entering` / `exiting` | 进入通道 / 离开通道 | `[低, 高]` | 事件 |
| `inside` / `outside` | 在通道内 / 在通道外 | `[低, 高]` | 状态 |
| `moving_up_pct` / `moving_down_pct` | 上涨 % / 下跌 % | `{ pct, bars }`：最近 `bars` 根日线内涨跌超过 `pct`% | 状态 |

- **事件**类比较的是相邻两次检查，定义和公式的 `cross()` 一样严格：上穿是这次 > 线、上次 ≤ 线；下穿是这次 < 线、上次 ≥ 线；穿过是二者之一。进入通道是这次严格在通道内（低 < 价 < 高）、上次不是；离开通道是这次严格在通道外（价 < 低 或 价 > 高）、上次不是。停在线上或通道边上什么都不触发。第一次检查只记录，不触发。
- **状态**类只要条件成立就触发；新建的警报如果当时已经成立，第一次检查就会触发，和 TradingView 一样。
- **`when` 公式**沿用 §2.5 的「新成立才推送」，所以 `close > X` 的效果接近上穿；要明确的上穿下穿可以写 `cross(close, X)` / `cross(X, close)`。
- **触发方式**：`once` 触发后把这条警报写成 `enabled: false`（写回对应的人的 yaml，注释保留），列表里显示「已触发」；`bar` 同一根日线最多触发一次（`alert_state.fired_bar`）。「同一根」按时间比：只有比 `fired_bar` 更新的 K 线才能再触发；在更旧的 K 线上判断（两轮报价之间来了一次失败的、或没带回当天那根的日线同步）既不触发，也不把 `fired_bar` 改回去，`when` 公式的「同一根只推一次」同理。
  已触发的 `once` 手改 yaml 的 `enabled: true` 不会重新启用；重新启用请用界面上的恢复。
- 状态记在 `alert_state`（§1.4），事件类的上一次结果也在这里。

**谁被轮询**（标配，不用建警报）：所有 vault 的自选标的和它们的 `bench`，加上 `enabled`、不是草稿且判断时机是「盘中价格」的警报的标的和它们 `when` 公式引用到的标的；合成标的展开成操作数；`data:` 标的只有日线，不轮询，跟着日线同步判断。判断时机是「日线收盘」的警报（对全部自选的默认）不为轮询添标的，报价轮次也不判断它们。

**规模**：请求数按「每轮每个源一次」算，不随标的数涨：到期的标的每个源每 100 个一个请求（`CHUNK`），同一个源的几个请求并发。实测 Yahoo 155 个一次 0.8 秒，TradingView 一个 quote 会话 155 个 1.6 秒（100 个 0.9 秒，远在 20 秒超时内），Binance `tradingDay` 一次最多 100 个、权重每个 4（封顶 200，限额 6000/分钟），100 个交易对的 URL 约 1.7 KB。`upstream` 按实际请求数记（每块一次）。一块失败时别的块照常入库，失败那块的标的下一轮再取；一个源整轮没有一块成功才算一次失败。

**节奏**（`src/lib/quotes.ts` 的轮询器，和调度器一样从 `instrumentation` 启动、`globalThis` 防重复）：每 5 分钟醒一次，每个标的按上一次拿到的 `session` 决定这次要不要取：

- `always`（加密）和 `open`（交易所在常规交易时段）：每 5 分钟。
- `pre` / `post` / `closed`：每小时。
- 新加进来的标的立刻取一次。连续 3 轮没有任何回应的源退避到每小时，日志里记一次，不刷屏。
- 同一个源的标的一次批量请求：Yahoo 用 `quote()`（开盘 `regularMarketOpen`、成交量 `regularMarketVolume`），Binance 用 `/api/v3/ticker/tradingDay?symbols=…`（UTC 自然日的开高低量，和它的日线一致；滚动 24 小时的 `ticker/24hr` 不能当日线用），TradingView 用库的 quote 会话（`open_price`、`volume`；一轮开一个客户端，取完就关）。源报不出时段（盘中 / 休市）时适配器不填，由轮询器按这个标的的交易日历填：所属交易日是交易日算 `open`，周末和假日算 `closed`（`scheduledSession()`）。交易日按交易所当地时钟定：跨夜时段（`1700-1600`）从前一晚开盘起就算第二天的，到当天收盘为止，所以周日晚上算周一、假日当晚算下一个交易日、周五收盘后的晚上不算谁的（`closed`）；白天的时段整个当地自然日都算（和以前一样只到天，不到小时）；`24x7` 每天都是交易日；连交易时段都不知道的，工作日算 `open`。成交量为 0（外汇、CFD）或 TradingView 的 1e100（收益率）按没有记。
- **交易时段**（`symbols.hours`）在日线同步时存：Yahoo 取 chart meta 的 `currentTradingPeriod.regular` 换成交易所当地的 `HHMM-HHMM`，TradingView 取 symbol info 的 `session`（`0930-1600`、跨夜的 `1700-1600`、`24x7`），Binance 固定 `24x7`。
- **交易日历**（`symbols.holidays`、`symbols.corrections`，和 `hours`、`timezone` 一起是 `TradingCalendar`，`src/lib/session.ts`）也在日线同步时存，不用人工每年维护：
  - **TradingView 的标的**用自己 symbol info 里的两张表：`session_holidays`（休市日，`20261126,20261225`）和常规时段那个 subsession 的 `session-correction`（改了时段的日子，`0930-1300:20261127,20261224;dayoff:20250109`）。原样存，只留去年 1 月 1 日以后的日期；`session` 里带日期的历史版本（`A#20070312/B#…`，布伦特原油每次夏令时切换一个）同样只留去年以后的。
  - **Yahoo 的标的**没有假日表（chart meta 只有当天的时段），按 Yahoo 的交易所代码借 TradingView 上同一交易所一个代表标的的日历（`src/lib/sources/calendar.ts` 的 `EXCHANGE_SYMBOL`：美股各板块和指数 → `NASDAQ:AAPL`，`HKG` → `HKEX:700`，`SHH` / `SHZ` → `SSE:600519` / `SZSE:000001`，`JPX` / `OSA` → `TSE:7203`，另有伦敦、法兰克福、巴黎、多伦多、悉尼、首尔、台北、印度、新加坡）。每个交易所一次请求（symbol info 一到就结束；库的 `setMarket` 会顺带要 K 线，所以请求里带一根日线，不等它），进程里缓存 6 小时，计入 `upstream` 的 tv。外汇、加密、期货（`CCY` / `CCC` / `CME`）和表里没有的交易所没有日历。
  - **取不到时**（这台机器连不上 TradingView，或那次请求失败）不报错：这次同步不写这两列，原来存的留着；从来没有的就是不知道假日，每个工作日都当完整交易日，和接日历之前一样。
  - **覆盖范围**取决于 TradingView：美股系（股票、指数、TVC 的贵金属 / 原油 / 美债 / 美元指数、CME 期货）到明年年底，港股、日本、欧洲多数到今年年底，A 股到已经公布的假期；每天同步都重读，新一年的表 TradingView 有了就有。外汇只有圣诞节。港股的半日市（平安夜、除夕、农历除夕）TradingView 没有，按全天算。
  - **读法**（`sessionsOn()`）：某一天先看 `corrections` 有没有这一天（有就用它的时段，`dayoff` 是休市；它压过假日表：CME 期货在多数假日照常或缩短交易，就是这么表示的），再看是不是 `holidays`，最后按星期取 `hours` 里的时段；周末没有点名就不交易。用在四处：倒计时（§5.2）、「日线收盘」警报的已收盘判断（§2.5）、源不报时段时的兜底（上一条）、报价归到哪个交易日（本节开头）。轮询节奏不看日历，照旧跟着数据源报的时段走。

**适配器接口**加一个可选方法：

```ts
interface Quote { price: number; time: number; dayOpen?: number; dayHigh?: number; dayLow?: number; dayVolume?: number; session: "open" | "closed" | "pre" | "post" | "always" }
interface SourceAdapter {
  // …
  quotes?(tickers: string[]): Promise<Record<string, Quote>>;
}
```

**每轮之后**：最新价写 `quotes` 表，然后对每个 vault 判断它的「盘中价格」警报，事件按 vault 合成一条摘要投递（§2.5 的投递规则：全部通道失败不提交，下一轮再试），最后把每个 vault 总览要的统计算好放进内存（见下面「总览」），已经不存在的 vault 的那份顺手删掉。日线同步收尾时也照常判断一遍，用的是真实日线。

**页面读 `quotes`**，不碰网络：图表上的警报线、警报列表里的「当前价 · 3 分钟前」、图表底部状态条的时段和新鲜度都从这张表来。价格和「当前」分开判断：

- **价格**只有一条规则（`withQuote()`，判断在 `quoteDayIn()`）：报价比该标的最后一次日线同步新、交易日不早于最后一根日线，就用它拼今日 K 线，直到下一次同步拿到真日线。图表、总览、警报判断、警报列表的当前价都是这一个数。
- **当前**（`symbolStatus()`）只决定标不标时段：开盘和加密是三轮（15 分钟）内取到的，其余时段一小时加两轮内取到的。过了窗口不标时段，但新鲜度仍写报价多久前（不退回同步时间）。
- **图表**：`/api/bars` 用 `liveReader()` 读日线（主标的、合成标的的操作数、对比和基准都一样），所以最后一根 K 线就是报价拼出的今日 K 线。未闭合的周 / 月 / 季 K 线收盘就是该标的的最新价，对比和基准各自取本周期内自己的最新值（股票对比特币的周线，周六时比特币这一周收在周六的价，和 TradingView 一样）；日线按主标的的日期对齐，主标的没有的日子本来就对不上。图表不为此重新拉 bars（会重置缩放），换标的、换周期时自然读到最新的。
- **总览**：价格来自报价的行（同上面的价格规则），各涨跌幅、距高点、52 周位置、两年走势用今日 K 线重算（`liveStats()`，不写回 `stats`），价格旁边标时段和多久前（§5.1）。自选全部有报价以后，每次打开页面都现读全部日线太贵（51 个标的、40 万根日线约 250 ms），所以结果按 vault 缓存在内存里：缓存的戳是「最新的报价时间、最新的同步时间、`prices`、自选列表、别名」，任何一个变了才重算；每轮报价收尾时先算好，页面只读缓存（约 0.5 ms，不读 `bars`）。时段标签每次读的时候按当前时间判断，不进缓存。
- **合成标的**（`=BTC/GOLD`）没有自己的报价和同步：操作数里只要有一个的报价被采用，它就用操作数的今日 K 线现算，总览和图表一致；新鲜度取被采用的操作数报价里最旧的那个时间，不标时段（操作数可能一个盘中一个休市），也没有倒计时。图表的状态条同理：「按需合成 · 最新 10/9 · 3 分钟前报价」，并和普通标的一样每轮读 `/api/status` 更新最后一根。

### 2.7 安装与网页推送（PWA）

**安装**：`manifest.ts`（standalone、`id`/`scope` 都是 `/`）列出 `icon.svg`、192 和 512 的 PNG、同尺寸的 maskable 版和 `apple-icon`，安卓 Chrome 据此弹安装提示，iOS 用 Safari 的「添加到主屏幕」。PNG 由 `src/app/pwa-icon/[file]/route.tsx` 在 build 时画好：`192.png` / `512.png` 是 icon.svg 原样（自带圆角，角外透明）；`maskable-*.png` 是铺满的深色方块，logo 缩到 80%，落在启动器可能裁成圆形的安全区里。

**service worker**（`public/sw.js`，作用范围 `/`，每个页面在安全上下文里由 `ServiceWorker` 组件注册，`updateViaCache: "none"`，响应头 `Cache-Control: no-cache`）。**它什么都不缓存**：页面是 `force-dynamic`，缓存会显示旧价格。它只做三件事：

- `push`：显示通知，标题、正文来自推送，图标是 `/pwa-icon/192.png`。
- `notificationclick`：已经开着这个地址的窗口就聚焦它，否则把一个已开的窗口导航过去，没有窗口就开新窗口。
- 导航请求照常走网络；网络失败时返回写在 sw.js 里的一页「连不上服务器」（503，带「重试」），不读任何缓存。其他请求不经过它。

**推送渠道**（`src/lib/push.ts`）：

- **VAPID**：第一次用到时（打开通知设置或投递）用 `web-push` 生成密钥对，写进 secrets 目录的 `vapid.json`（600），之后一直用它；删掉这个文件等于让所有设备的订阅作废。`subject` 是公开地址（`HEBI8_PUBLIC_URL`）；它不是 https 时用仓库地址（`REPO_URL`），因为 Apple 和 `web-push` 只接受 https: 或 mailto:。
- **订阅**：每台设备（浏览器）一条，存在这个人在 `notify-users.json` 里的 `push` 数组（§2.5，和 Telegram、webhook 同一个人同一个条目；owner 的记在第一个 owner 名下）；同一个 endpoint 再订阅一次是替换；一个浏览器只属于最后在它上面开启推送的人（别人在这个浏览器上登录后开启，它就从上一个人的列表里移走）。退出登录不退订。设备名取订阅时的 User-Agent（「Chrome · Android」）。页面上一台设备用 endpoint 的 SHA-256 前 16 位十六进制表示，endpoint 本身不回到页面，也不进日志（错误里只有推送服务的主机名）。
- **投递**：加密交给 `web-push` 的 `generateRequestDetails`（aes128gcm），请求用 fetch 发出（15 秒超时，`TTL` 一天，`Urgency: high`），所有设备同时发。推送服务回 404 / 410 的订阅从文件里删掉。有一台设备收到就算这个通道成功；一台都没收到时这个通道失败，原因是各设备的错误加「N 台设备的订阅已失效，已移除」。
- **内容**：和 Telegram 同一条摘要：标题就是摘要标题，正文是摘要里每个事件那一行（不带链接；按事件生成，不受 Telegram 4000 字截断的影响），没有事件的消息（使用量提醒）是正文去掉标题行和链接行；整条 JSON 的 UTF-8 超过 3993 字节（RFC 8291 给 4096 字节的推送消息留的明文上限，超了 Apple 回 413）时，从正文末尾整行去掉，最后一行写「…还有 N 条」；点开去哪里由事件决定：都是同一个标的就是它的图表页（`/chart/<key>`），几个标的就是总览，没有事件的消息（使用量提醒）也是总览。地址是相对路径，所以从哪个地址订阅就回到哪个地址。

**通知设置里的「推送」**（`PushSettings`）：一个「在此设备上接收推送」复选框和已开启的设备列表（设备名、「此设备」、开启日期、「移除」）。打开时先在点击里要通知权限，再用 VAPID 公钥 `pushManager.subscribe`，把订阅 `PUT /api/notify/push`；关掉或移除「此设备」时也在浏览器里 `unsubscribe`。不能开的时候复选框置灰，旁边写原因：

- 不是安全上下文（局域网、Tailscale 的 http）：浏览器只在 HTTPS 下允许推送，附「用 HTTPS 地址打开」链接（公开地址是 https 时）。
- iPhone / iPad 不是从主屏幕打开的：要先「分享 → 添加到主屏幕」再从图标打开（iOS 16.4 及以上）。
- 浏览器没有 service worker / Push API / Notification（包括 16.4 以前的 iOS）：不支持网页推送。
- 通知权限已被拒绝：去浏览器的网站设置里允许。

单用户模式没有登录，也就没有这个开关（§2.5），推送只在共用实例上可用。

### 2.8 标的资料（商品详情）

每个标的是什么：公司 / 基金的简介、行业、规模。图表页右侧的「商品详情」面板（§5.2）和 MCP 的 `get_profile`（§6）读它。

**慢变的事实和跟价格走的数字分开。** 存下来的只有事实（`SourceProfile`，`src/lib/sources/types.ts`）：

| 字段 | 说明 |
|---|---|
| `description` | 简介，数据源的原文（多半是英文） |
| `sector` `industry` `country` `employees` `website` | 公司 |
| `links` | 数据源自己列的链接（`{ name, url }`）；只有 `data` 源有，来自数据集清单（§2.4） |
| `shares` `eps` `dividend` | 总股本（加密货币是流通量）、最近十二个月摊薄每股收益、每股年分红 |
| `earningsAt` | 下次财报的时刻（unix 秒）。显示的是它在**交易所时区**（`symbols.timezone`，没有就按 UTC）里的那个日历日（`nextEarnings()`）：财报当天一直显示，那一天在交易所当地过完就不显示了（按日历日比，不是滚动 24 小时） |
| `brand` | 基金的品牌名（TV 才有：`issuer` 是母公司，`brand` 才是 SPDR、iShares、ChinaAMC 这样的名字）；不显示，只用来配发行商的链接 |
| `issuer` `category` `expenseRatio` `netAssets` | 基金：发行商、类别、费率（0.0009 = 0.09%；0 是有效值，零费率的基金照样显示 0.00%）、资产规模 |
| `holdings` `sectors` | 基金：前十大持仓（`name`、数据源里的 `key`、`weight`）和行业分布 |

**市值、市盈率、股息收益率不存**，读的时候用最新价现算（`profile.ts` 的 `valuation()`：`shares × 价`、`价 / eps`（亏损时没有）、`dividend / 价`）。最新价是**实际成交的价**（`quotes.ts` 的 `tradedPrice()`）：有比日线同步新的报价用报价（和图表、警报采用报价是同一个判断），否则库里最后一根日线的收盘，**不乘分红因子**。它不跟图表的 `prices` 模式走：`total`（ADJ）下图表画的是含分红的价，最后一根的因子不是 1 时（除息后新一天的日线还没进来）会比成交价低，拿它算市值和 PE 就错了。面板的价来自页面渲染时的 `tradedPrice()`，之后随每轮报价从 `/api/status` 的 `price` 更新；MCP 直接调 `tradedPrice()`。一周前的 PE 不会摆在实时价格旁边。数据源没有的字段不存、不显示，面板上没有一排「—」。

**各源实际拿到的**（2026-10-11 实测）：

| 源 | 怎么取 | 股票 | ETF / 基金 | 其余 |
|---|---|---|---|---|
| `yahoo` | yahoo-finance2 的 `quoteSummary`（`assetProfile`、`summaryDetail`、`defaultKeyStatistics`、`calendarEvents`、`fundProfile`、`topHoldings`），不过库的 schema 校验（基金模块常对不上，要的几个字段逐个检查） | 简介、板块、行业、国家、员工、网站、股本（`impliedSharesOutstanding`，Yahoo 自己算市值用的那个）、EPS、每股分红、下次财报日 | 简介、发行商、类别、费率、规模、每股分红、前十大持仓、行业分布（11 个板块 id 译成中文） | 指数、外汇、期货什么都没有（存 `{}`）；加密货币有简介、网站、流通量 |
| `tv` | 报价会话多要一组字段（`tradingview.ts` 的 `PROFILE_FIELDS`，和取价是同一个逆向 websocket，每个标的一个会话） | 简介、板块、行业、国家、员工、网站、股本、EPS、下次财报日；每股分红由它给的股息率乘同一批数据里的价格还原 | 简介、发行商、费率、规模、前十大持仓；类别和行业分布只有内部 id，不取；每只基金都有的占位板块 / 行业不要 | 指数、商品、债券收益率、外汇、加密、期货只回类型，没有资料（存 `{}`）；完全不应答的（不认识的代码、接口变了）算失败 |
| `binance` | 没有资料接口 | — | — | 只显示已有元数据 |
| `data` | 读已经在磁盘上的清单（§2.4），不联网 | — | — | 清单给的 `description`（序列的，没有就用数据集的）和 `links`（序列的接上数据集的）；清单没给就什么都没有 |

合成标的没有资料，面板列出它的各个操作数并链到各自的图表。

**相关链接**（`src/lib/links.ts` 的 `profileLinks()`，纯函数）：每个标的去哪里读更多，面板的「相关链接」一节（§5.2）和 `get_profile` 的 `links`（§6）用。**读取时现算，不联网、不入库**：由 key、`symbols` 里的 `kind` / `exchange` 和存下的资料算出来；只有数据源给的事实（官网、基金的品牌名）跟着资料存。按下面的顺序排，同一个地址只出现一次，后面的链接和官网是同一个站点时去掉（基金官网已经是产品页时，不再给发行商首页）：

1. **数据源给的**：官网（`website`）和它自己列的链接（`links`，只有数据集清单有，§2.4）。官网：公司是「官网」，基金是「基金官网」（TV 给基金的多半是产品页）。只认 http(s)。Yahoo 的 `irWebsite`（投资者关系）**不取**：实测 6 个里 2 个是坏的（NVDA 的是 404，000001.SZ 的跳到企业网银登录页）。
2. **基金发行商**（`ISSUERS`，一行一家）：按资料里的 `brand` 和 `issuer` 匹配（TV 的 `issuer` 是母公司，比如盈富基金是 HSBC、华夏的 ETF 是中信证券，所以 TV 另存一个 `brand`），分市场。能按代码直达产品页的直达：Vanguard（ETF 和共同基金两种路径）、Invesco、Schwab、ARK、Global X（后四家只对 ETF）；不能直达的给首页：道富 SPDR、iShares、ProShares、VanEck、Direxion；香港：恒生投资管理、南方东英、华夏基金（香港）、iShares 香港；内地：华夏、南方、易方达、嘉实、华安、华泰柏瑞；日本：野村 NEXT FUNDS。匹配不上就没有这一条。
3. **交易所 / 监管机构的披露页**，按代码直达的才给（市场由代码看：Yahoo 的后缀 `.HK` `.SS` `.SZ`，TV 的前缀 `NASDAQ` `NYSE` `AMEX` `HKEX` `SSE` `SZSE`）：
   - 美股：SEC EDGAR `browse-edgar?action=getcompany&CIK=<代码>`（接受代码；`BRK.B` 要写成 `BRK-B`）。**只给交易所上市的股票**：ETF 大多按代码查不到（实测 SPY、QQQ、GLD 能查到，VOO、IVV、TLT、SCHD、VTI、IWM、ARKK 都是「No matching Ticker Symbol」），OTC 的 ADR（TCEHY、NSRGY）也查不到。
   - 港股：港交所的证券页 `Equities-Quote?sym=<去掉前导 0 的代码>`（带公告）；ETF 是另一条路径 `Exchange-Traded-Products-Quote`。
   - A 股：上交所的公司公告页（`60` / `68` 开头）、深交所的个股页（`00` / `30` 开头）。按代码段判断，因为 Yahoo 把那里的 ETF 也叫 equity。巨潮资讯要 `orgId`，猜不出来，不用。
   - 日股：没有能按代码直达的官方页（JPX 的行情页 401，上市公司检索不认网址参数），不给。
4. **没有「公司」的资产**（`ASSETS`，一行一个资产：它在各源的 key，`*` 代表一个以上的字符；和它的链接）：美债 2 / 5 / 10 / 30 年（美国财政部每日收益率 + FRED 对应序列）、日 / 中 / 德国债（财务省、中债、德国联邦银行）、美元指数（ICE、FRED 广义美元指数）、美元兑日元 / 人民币、欧元兑美元（日本银行、中国货币网、欧洲央行、FRED）、黄金、白银、原油、铜（世界黄金协会、LBMA、白银协会、EIA、LME、国际铜业研究组织）、标普 500、道指、纳指 100、纳斯达克综合、VIX、恒指、恒生科技、沪深 300、上证综指、日经 225、TOPIX（各自的指数公司；标普和道指的官方页对脚本和 headless 浏览器都是 403，确认不了，改用 FRED 的序列页）、比特币和以太坊（项目官网）。跨源的同一资产是同一行（`tv:TVC:US10Y` 和 `yahoo:^TNX`）。表里没有的就没有这一类链接，不凑数。
5. **数据源自己的行情页**，排在最后，所以 yahoo / tv / binance 的每个标的至少有一条：Yahoo Finance 的 quote 页、TradingView 中文站的商品页、Binance 的交易页。**`data:` 序列没有兜底**：它的链接只有清单给的那些（第 1 类），清单没给就没有这一节，不拿仓库地址凑数。合成标的没有链接（面板已经列了各操作数）。

**链接必须是真的**：表里的每个地址和每条拼接规则在写进去之前都实际打开看过（2026-10-11，headless Chrome；SEC 对没有声明身份的脚本回 403，浏览器正常）。加新的照此办理：404、落在搜索页、被重定向到首页的不放。运行时不检查链接是否还活着。

**刷新**（`src/lib/profiles.ts`）：

- 资料进 `profiles` 表（§1.4）。**页面和 MCP 只读这张表，不联网。**
- 到期（`profileDue()`）：从没取过；上次成功是 7 天以前；上次失败是 1 天以前。失败后隔一天再试，不是每次同步都试，也不用等一周。
- 调度器每次同步之后（§2.2）对所有 vault 引用到的标的（和日线同步同一个集合）取到期的，并发 2，结束打一行日志（取了几个、哪些失败）。它不挡调度：下一次同步在资料开始之前就排好了。
- `syncOne` 成功后也发起一次（§2.3），不等结果，所以加自选、按需打开的标的第一次拉日线后一两秒资料就到；不在任何自选里的标的不进每周的刷新，下次打开时到期了再取。
- **`data:` 序列是例外，跟着每次同步更新**：它的资料就是磁盘上清单里的几行，读它不花上游请求，所以 `sync.ts` 里一条 `data:` 序列的日线同步成功后就地重读一次（定时同步、手动「刷新」、加自选、按需打开都算），改了清单不用等一周。每周的到期规则对它照旧成立，只是总是已经新了。
- 没人等的请求不能留下未处理的拒绝：取到了写不进库（锁超时、磁盘满）时只打一行日志。
- 失败只把错误和时间记在该标的的行上（`error`、`tried_at`），上一次取到的事实原样留着，同步不受影响。同一个标的同时触发几次只发一个请求。
- 上游调用照 §1.7 记进 `upstream`（yahoo、tv 各算在自己名下）。
- 面板底部写「资料更新于 YYYY-MM-DD」（`fetched_at`）；数据源对这个标的没有任何资料时（`{}`）不写。

**翻译**（`src/lib/translate.ts`、`profiles.ts` 的 `translateDescription()`）：

- 简介原样显示。原文不是中文（汉字不到字母的三分之一，`isChinese()`）、实例配了模型、viewer 能写时，简介下面有「翻译」按钮；**点了才调模型**，不自动翻，只翻成简体中文。
- 译文存进 `translations` 表，带原文的 SHA-256，所有人共用：之后任何人（包括访客）打开这个标的都直接显示译文，旁边「显示原文 / 显示译文」切换。每周刷新后原文变了，哈希对不上，旧译文不再显示，按钮重新出现；再翻一次覆盖旧的。
- **译文只代表它译的那段原文**，在哪一层都一样：`translateDescription()` 和 `translateProfile` 返回的是 `{ source, text }`（原文和译文），面板把刚译出来的这一对留在页面状态里，只在 `source` 和现在的简介一字不差时才显示。所以页面开着的时候每周刷新换了原文，刚才那份译文不会挂在新简介下面。
- **谁能点**：和其它写操作一样要 `canWrite`。共用实例上只有登录的人能点，访客看得到已有的译文、没有按钮（实例经隧道公开、不限流，匿名访问者不能花模型额度）；单用户模式谁都能点。入口是 Server Action `translateProfile(key)`（§6），只有页面这一路：agent 自己就是模型，读原文就够了，MCP 不提供触发翻译的工具。
- 同一个标的的同一段原文同时点多次只发一次请求（进程内按 key + 原文哈希去重），已有匹配的译文时直接返回、不调模型。翻译进行中原文被刷新换掉了：后来点的人不搭前一个请求，另发一个译新原文的；前一个请求回来得晚，发现库里的简介已经不是它译的那段，就不存（不会把新原文的译文盖掉）。
- **失败**不存任何东西，可以再点。给人看的是该怎么办，不是原始报错：连不上、超时是「连不上翻译服务，请稍后再试」；HTTP 错误、不是 JSON、空回答是「翻译服务返回了错误，请稍后再试」（toast 前面加「翻译失败：」）。状态码、返回内容的前 300 个字符、连的是哪个 `base` 进服务器日志（`[hebi8m] translate: …`），key 不进日志。
- **模型配置**：配置目录（§1.5）里手写的 `llm.json`，任何 OpenAI 兼容的 chat completions 接口：

  ```json
  { "base": "https://api.openai.com/v1", "key": "sk-...", "model": "gpt-4o-mini" }
  ```

  三项都要有；没有这个文件（或缺一项）就没有「翻译」按钮，已有的译文照常显示。请求是 `POST <base>/chat/completions`，`temperature: 0`，system 里是翻译要求，user 里只有简介原文，60 秒超时。这是服务端唯一调用模型的地方；发出去的只有数据源的公开简介，没有任何用户内容。模型调用不记进 `upstream`（那张表按数据源记）。

---

## 3. 序列层（纯函数，服务端与客户端共用）

### 3.1 `Bar`

`{ t, o, h, l, c, v: number | null, adj }`。按 `prices` 模式取价：`split` 直接用；`total` 时 o/h/l/c 乘 `adj`。

### 3.2 合成周期

D 原样；W 周一起算；M 月初；**Q 季初**（`Date.UTC(y, floor(m/3)*3, 1)`）。KLineChart 的 period：`Q = { type: "month", span: 3 }`。

### 3.3 对齐与合成标的

- `align(target: Bar[], other: Bar[])`：按 target 的交易日取 other 当天或之前最近一根的值（前向填充），开头没有数据的位置为 `null`。v1 的 `alignCloses` 泛化成返回整根 bar。
- 合成标的 `=表达式`：操作数是别名或完整 key（`=binance:BTCUSDT/tv:TVC:GOLD`、`=2*(yahoo:SPY-yahoo:QQQ)`），支持 `+ - * / ^`、数字、括号。词法（`lexSynth`）：字母（含中文）、数字和 `_ . ! =` 连成一个操作数，`:` 后面可以跟 `^`（`yahoo:^GSPC`）；数字后面紧跟字母或点的是代码（`0700.HK`），否则是常数；`^` 出现在该有操作数的位置（开头、运算符或左括号后）是代码的一部分（`^GSPC`），跟在操作数后是乘方；`-` 永远是减号。所以代码里有 `-`、`/` 或空格的 key 要加引号：`="yahoo:BRK-B"/yahoo:SPY`、`="data:gpu/4090-xianyu"/USDCNH`。写回时（`synthOperand`）能原样读回的 key 不加引号，否则加；key 恰好也是某个别名的名字时保留引号（不带引号的词先查别名）。写回按原输入的 token 先解析再拼（`writeSynth`），所以 `1 2` 是错误，不会拼成 `12`。**逐字段计算**（o=oA/oB，h=hA/hB，l=lA/lB，c=cA/cB，v=null），这正是 TradingView spread 的做法。交易日取第一个操作数的交易日，其余前向填充；任一操作数尚无数据的前导区间丢掉。合成标的不入 `bars` 表，按需计算；其 `stats` 同普通标的。算不出数据时，`/api/bars` 的报错列出每个没有数据的操作数和它的同步错误（`synthNoData`，如「yahoo:SPX：No data found…」），不是笼统的「暂无数据」。
- 显示名（`synthName`，没有 yaml `name` 时用）照 TV：操作数只写代码，`=yahoo:AAPL/yahoo:MSFT` 显示 `AAPL/MSFT`，`tv:TVC:GOLD` 显示 `GOLD`，`data:` 显示序列 id。
- 搜索框里的输入规则见 §5.4。

### 3.4 `stats`

```ts
{
  last, lastTime, currency,
  changes: { "1W": number | null, "1M": ..., "3M", "YTD", "1Y", "3Y", "5Y" },  // 全部算好，显示哪些由 periods 决定
  ddAth,                                  // 距历史最高收盘的回撤，<= 0
  pos52,                                  // 52 周高低区间位置 0..1
  spark: number[],                        // 近 104 周的周收盘
}
```

- `changes`/`ddAth`/`pos52` 的定义与 v1 `src/lib/stats.ts` 相同，按 yaml 的 `prices` 模式计算。
- stats 里不再有条件结果：警报的状态在 `alert_state`（§1.4），总览徽标从那里读。

---

## 4. 公式引擎 v2

在 v1 `src/indicators/formula.ts` 的 tokenizer / parser / 序列求值上扩展，不重写。

**语法增量**

- 比较与布尔：`> < >= <= == !=`、`and or not`；结果是 0/1 序列。优先级：`not` > 比较 > `and` > `or`，都低于算术。
- 字符串字面量 `"..."`，只用于标的引用。
- 标的引用：`close`、`open`、`high`、`low`、`volume` 既是变量也是一元函数：`close` 是本标的；`close(QQQ)` / `close("yahoo:QQQ")` 是别的标的，按本标的交易日对齐并前向填充；`bench` 是本标的在 yaml 里的 `bench`（没配就报错「未设置基准」）。`close(bench)` 与裸 `bench` 等价。
- 新增函数：`iff(cond, a, b)`、`cross(a, b)`（a 上穿 b 的那根为 1）、`barssince(cond)`、`atr(n)`、`tr`、`corr(a, b, n)`、`pctrank(x, n)`。
- `compile(source)` 额外返回 `refs: string[]`（引用到的标的，别名已解析为 key）。
- `evaluate(program, { bars, refs: { [key]: AlignedBar[] } })`。

**用在三处**：图表指标（客户端，KLineChart 模板）、警报的 `when`（服务端，§2.5）、对比（客户端）。引擎是纯 TS，没有环境依赖。

---

## 5. 页面

### 5.1 总览 `/`（RSC 直读 yaml + stats 表，价格来自报价的行现算）

- 顶部：`自选 · 上次同步`；右侧「上次复盘 N 天前」链到 `/review`、「周期 · 1周 1月 1年」（点开选择显示的涨跌周期）、涨跌色分段开关「绿涨 | 红涨」、「刷新」、「+ 添加」（打开全局搜索的添加模式，Enter = 加入自选，见 §5.4）。
- **待确认的警报**：viewer 有草稿警报（agent 经 MCP 建的对全部自选的警报，§2.5）时，标题行上方多一块卡片，每条一行：名字、范围和定义、「确认」「丢弃」。没有草稿时不出现。
- **一张表格**，`table-layout: fixed` + `<colgroup>`，分组做 subheader 行，所以「价格」列在每个分组里的 x 坐标一致。名称列吃剩余宽度并 truncate（title 显全名）；其余列固定：价格 112、每个涨跌周期 72、距高点 96、警报 220、两年 200、菜单 28。
- **距高点**一列合并了原来的「距高点」和「52 周」两列：上面是距历史最高收盘的跌幅（`ddAth`，按它排序），下面是 52 周区间位置的短条（`pos52`，最左 52 周低点、最右高点）。
- **表头悬浮说明**：名称、价格、各涨跌周期（相对哪天的收盘）、距高点（两部分各是什么）、两年都有 `title`，有说明的表头文字带虚下划线；可排序的在说明后面接排序提示。
- **分组（分区）**：标题行是「拖动手柄 · 折叠箭头 + 组名 + 数量 · ⋯」。折叠状态是界面偏好，存 localStorage（`hebi8:watchlist:collapsed`，组名列表，和图表页的自选面板共用）。「⋯」：重命名 / 删除分组（照 TV 删除分区：组里的标的并入上面那组，第一组并入下面那组；唯一的组里还有标的时不能删）。列表末尾「+ 新建分组」内联输入。yaml 里没写 `name` 的组显示为「组 N」（按位置），移动、重命名、删除分组之前先把这些显示名写进 yaml（和别的组重名时加「 (2)」），免得位置一变名字跟着变，页面指错组。
- **拖动排序**：标的行和分组标题都能拖（鼠标按住行任意处拖动，移动超过 4px 才算拖，松开后的 click 被吞掉；手指从行首的手柄拖），标的可以拖进别的组，拖到折叠或空的组上就放到那组末尾；落点画一条 accent 色的线，被拖的行变淡，靠近滚动区上下边缘时自动滚动，Esc 取消。键盘：聚焦手柄（Tab 可达，hover / focus 时显示，触屏一直显示）后 ↑ / ↓ 移动一格，跨组边界就进相邻组，焦点跟着走，结果用 `aria-live` 读出。界面先乐观更新（`useOptimistic`），Server Action `moveSymbol(key, group, index)` / `moveGroup(name, index)` 写回 yaml 顺序，失败 toast 并恢复。按列排序时不能拖（手柄隐藏，给一行提示）。访客没有手柄和组菜单，只能折叠。
- 表头整格可点排序：第一次降序、第二次升序、第三次恢复 yaml 顺序；箭头指示方向（`aria-sort`）；**同一列的排序同时作用于所有分组**。
- 整行是链接（`onClick` 路由 + 名称单元格是真正的 `<a>`，中键在新标签打开）。行尾「⋯」菜单始终可聚焦，视觉上 hover / focus / 打开时才显示；右键整行也打开：打开 / 移到分组 ▸（现有分组或新建）/ 改名 / 设基准 / 添加警报… / 移除（行立即消失，toast「已移除 X · 撤销」，失败时恢复并 toast；不用原生 confirm）。
- **「警报」列**：这个标的上用户自己建的警报，徽标上是警报的名字（`label`，没写就是自动生成的「BTC 上穿 130,000」）。对全部自选的警报只在**成立中或本周触发过**的标的上出现，像一个自己起名的筛选标记。没有系统预置的；访客看不到（警报和笔记一样是各人的）。
- 徽标四态，同一个 `Badge` 组件（复盘页也用），从 `alert_state` 算（`alertBadges`）：**本周新触发**（`fired_at` 落在 `sync.tz` 的本周）淡高亮底（浅色 `bg-accent/10 border-accent/40 text-accent`，深色 `bg-accent/15 border-accent/50`）加圆点；**已触发 / 成立中**正文色实线（事件类触发过就算已触发，公式和状态类看上次判断是否为真）；**未触发**灰字；**已停止**虚线边、`opacity .55`，不用删除线。
- **悬停徽标**显示白话定义（原生 title，多行）：名字、定义（价格条件写「收盘价上穿 130,000」，公式写「周线公式 close > …」）、范围与触发方式与是否推送、状态和上次触发时间。表头「警报」旁的「?」悬停 / 聚焦弹出状态图例。
- **点徽标**打开和图表上同一个警报对话框（§5.2）编辑，对话框里也能删除；行菜单「添加警报…」新建，商品默认是这一行，可切到「全部自选」。保存后同一个响应里重新渲染总览。
- **报价**：价格来自报价的行（`withQuote` 采用了报价，§2.6，和图表、警报同一个价），价格是报价价，涨跌幅等按它现算；价格下面一行（窄屏是价格左边）是小号灰字「盘中 · 3 分钟前」，时段用状态条的叫法（盘中 / 盘前 / 盘后 / 休市，加密是 24h），只在报价还是当前的时候标，过了只写「3 小时前」；时间总是报价取到多久前。休市（`closed`）只写「休市」不带时间（收盘价不会变旧，时间留在悬停里）。悬停 title 补充取价频率（开盘和加密每 5 分钟、其余时段每小时）。合成标的按操作数的报价现算，只写多久前（最旧的那个操作数报价），不标时段。价格来自日线的行不标（`data:` 标的，或者日线同步刚跑完、下一轮报价还没到）。
- 显示名：yaml `name` > 内置字典中文名 > 数据源名（超过 24 字符 truncate，hover 显全名）。
- ≤768px 隐藏 sparkline，徽标 `whitespace-nowrap`；≤640px 改为列表：第一行 名称 + 报价标签 + 价格，第二行 所选涨跌周期，第三行 徽标（徽标是按钮，放在卡片链接外面）；外层 `overflow-x-auto` 兜底，不允许横向溢出。
- 页面上不提示 yaml 的路径：共用实例的其他人和访客改不了服务器上的文件，怎么手改 yaml 写在 README。
- 同步错误显示在该行；库为空时显示「首次拉取中…」并轮询。

### 5.2 图表 `/chart/[key]`（key 需 URL 编码，`yahoo:SPY → yahoo%3ASPY`，合成 `=BTC/GOLD → %3DBTC%2FGOLD`）

**原则：照搬 TradingView 的操作模型。** 有 TV 肌肉记忆的人不用学；界面文字尽量用 TV 中文版的说法（指标、比较商品、自选列表、十字光标……）。页面占满页头以下的视口（`height: calc(100dvh - var(--site-header-h))`），最小高度随副图数量增长（见下文布局）。

**布局（TV 桌面版）**

- **顶部工具栏**（一行，38px，按钮 30px 热区，组间 1px 竖分隔线）：`‹ 总览` · **商品按钮**（放大镜 + 代码 + 名称，点开全局搜索换标的）· `+` **比较商品** · 周期快捷按钮 `日 周 月 季` · **图表类型**（图标 + 下拉：实心 K 线 / 空心阳线 / 美国线 / 面积）· `fx 指标` · ……右端 **刷新**（tooltip 显示同步时间，加载时图标转动）· **拍快照**（相机，见下文）· **全屏**（`document.documentElement.requestFullscreen()`，全屏时隐藏站点页头，弹窗和搜索浮层照常可用）。
- **左侧画线工具栏**（42px 竖条，图标按钮，tooltip「名称 · 快捷键」）：十字光标（= 退出画线）· 六个**工具组**，和 TV 一样每组一个按钮：趋势线工具 · 江恩和斐波那契工具 · 形态 · 预测和测量工具 · 几何形状 · 标注工具（组和工具见 `chart-types.ts` 的 `DRAW_GROUPS`）。按钮画这一组当前的工具，悬停时右缘出现小箭头，点开在旁边弹出这一组的菜单（分小节：图标 · 名称 · 快捷键）；选过的工具留在按钮上，记在 localStorage（`hebi8:chart:tools`）｜ **测量**（尺子，tooltip「测量 · Shift + 点击」，见下文「测量」）｜ 磁铁模式（overlay `mode: weak_magnet`）· 锁定所有绘图 · 隐藏所有绘图 / 显示所有绘图 · 删除所有绘图（确认）。当前工具高亮；画完一条自动回到十字光标（TV 默认）；开始画线时若「隐藏所有绘图」开着会先显示出来。磁铁 / 锁定 / 隐藏是纯界面偏好，存 localStorage（`hebi8:chart:drawing`），作用于所有画线和之后新画的；有单条隐藏的绘图时眼睛按钮显示为「显示所有绘图」，点一下全部显示（含单条隐藏的）。
- **图内图例（左上角，TV 样式，React 覆盖层 `ChartLegend`）**：第一行 `名称 周期 · 源 · 币种 · 基准` + `开 高 低 收` + 涨跌（相对上一根收盘，十字线处或最后一根）；然后每个百分比对比一行、每个主图指标一行（名称 + 参数 + 各条线的值，颜色同线）；副图指标 / 新窗格对比的行放在各自窗格左上角（`chart.getSize(paneId).top`）。行上悬停（鼠标指针事件，不用 CSS `:hover`，触屏上点一下）出现 **眼睛**（隐藏 / 显示，会话内）· **设置**（内置指标 = 参数弹窗，按当前周期保存；公式指标 = 公式编辑器）· **×**（移除）；双击行 = 设置；指标行还有 **⋯**（TV 的「更多」），里面「移动到」：副图指标 →「主图窗格」，主图指标 →「下方新窗格」，写回 yaml `chart.panes`（回到默认窗格时删掉那一项）。移到主图的副图指标用自己的刻度：成交量和 TV 一样不显示刻度、柱子占主图底部四分之一（值域放大到 4 倍），其它的在左侧单独一条刻度（KLineChart 10 的 `createYAxis` + 指标 `yAxisId`；价格轴的 `overrideYAxis` 因此按 id 只改价格轴），图例随左刻度右移。主图图例最后一行下面是 TV 的折叠箭头：收起后只剩商品行，箭头旁显示收起的行数，状态存 localStorage（`hebi8:chart:legend-collapsed`）。数值跟十字线走：KLineChart 10 的 `onCrosshairChange` 只给指针坐标（`{ x, y, paneId }`，不带 `dataIndex`），所以按 x 用 `convertFromPixel` 求 K 线下标；鼠标离开图表时它不回调，由容器的 `mouseleave` 回到最后一根。KLineChart 自己的蜡烛与指标 tooltip 关闭（`showRule: "none"`），数值由 `indicator.result` 和图形样式按 KLineChart 同样的规则取（线色按 `lines[i]`，柱按 `figure.styles` 动态色）。
- **右侧边栏**：最右 42px 图标条（自选列表 · 商品详情 · 笔记 · 警报），面板 280px，同一时间只开一个，上次打开的记在 localStorage（`hebi8:chart:panel`；没记过时有笔记就默认开笔记）。**自选列表**按 yaml 分组，每行名称 · 最新价 · 总览第一个周期的涨跌（`stats`），当前标的高亮，点击客户端切换（偏好不变）；分组和总览一样能折叠、重命名、删除、新建，标的和分组都能拖动排序（§5.1）；标题栏「+」打开搜索的添加模式。行尾「×」（照 TV，hover / focus 时显示，触屏一直显示；访客没有）把这一行从自选移除，和总览行菜单的「移除」是同一个操作（`useWatchlist` 的 `removeSymbol`）：行立即消失，toast「已移除 X · 撤销」，撤销按 yaml 原来的 `name` / `bench` 加回原分组末尾。× 在数字后面自己的一列里（表头同样留出），不盖最新价和涨跌，触屏上这一列加宽到 36px；在 × 上按下不会起拖。移除的是当前打开的标的时留在这张图上，顶栏出现「加入自选」。**商品详情**见下文。**笔记**即原来的笔记面板。
- **加入自选**：当前标的不在自选里时，顶栏商品按钮后面出现「加入自选」下拉（现有分组 + 新分组名输入），选了就 `addSymbol`，toast 可撤销；在自选里就不显示。不在自选里的标的打开时先按需拉日线（§2.3），图上显示「正在拉取 X 的日线…」。
- **底部栏**（32px）：左边日期范围 `1年 3年 5年 10年 全部`——按当前周期算出这段有多少根，`setBarSpace(可用宽度 / 根数)` 后 `scrollToRealTime()`；若每根不足 1px（例如日线 10 年），像 TV 一样自动升到下一个周期（日 → 周 → 月）再适配。右边 `ADJ`（含分红，总回报）· `%`（百分比坐标，localStorage）· `log` · `自动`（TV 的开关：亮 = 价格轴自动缩放；点一下熄灭，价格范围固定，在图上上下拖就是纵向平移；拖动价格轴、在价格轴上滚轮缩放也会让它熄灭，双击价格轴或再点一下恢复；换周期 / 换标的时恢复）。对数坐标下 KLineChart 自己按价格做纵向平移和缩放（结果像缩放，甚至出现负刻度），所以对数轴的 `setRange` 被包了一层：库算出的新范围按比例换算到对数空间再生效（拖动以按下时的范围为基准，滚轮以当前范围为基准）。价格里有 0 或负数（`data:` 序列、合成标的可能有）时 `log` 按钮禁用，tooltip 说明原因，yaml 里的 `log` 偏好不动、只是在这个标的上不生效。`%` 与 `log` 互斥；有百分比对比时 `%` 显示为按下且锁定，tooltip「比较模式下使用百分比坐标」，`log` 禁用。
- **窄屏（≤768px，TV 移动版）**：顶部工具栏一行横向滚动；左侧画线栏隐藏，改为顶栏里的「画线」下拉（十字光标、测量，然后按组列出全部工具 + 磁铁 / 锁定 / 隐藏 / 删除，200px 宽、可滚动）；右侧图标条隐藏，自选 / 商品详情 / 笔记 / 警报按钮进顶栏，面板变成底部抽屉（60vh，默认关闭）；底部栏仍是一行。390px 宽无横向溢出。下拉菜单用 `position: fixed` 按按钮位置弹出，不被滚动的工具栏裁掉；菜单右缘超出视口时整体左移。

**快捷键（TV 默认；焦点在输入框里时不响应，`Esc` 除外）**

| 键 | 作用 |
|---|---|
| 字母 / 数字 | 打开搜索并带入该字符（换标的） |
| `/`、`Ctrl/Cmd+K` | 打开搜索 |
| `Alt+T` / `Alt+H` / `Alt+J` / `Alt+V` / `Alt+C` / `Alt+F` | 趋势线 / 水平线 / 水平射线 / 垂直线 / 十字线 / 斐波那契回撤 |
| `Shift+点击`（主图） | 测量：从这一点到指针的涨跌幅、K 线数、成交量；再点一下固定，之后点击任意处或 `Esc` 消失（见下文「测量」） |
| `Esc` | 退出画线和测量、关闭弹窗和菜单（路径 / 折线画到一半时按已点的点结束） |
| `Enter` | 结束正在画的路径 / 折线（双击也行） |
| `Delete` / `Backspace` | 删除选中的画线（KLineChart `onSelected` / `onDeselected` 跟踪选中）；右键画线弹出菜单：设置… / 锁定 / 隐藏 / 删除（TV 样式，不再右键直接删） |
| `Ctrl+Z` / `Ctrl+Y`、`Ctrl+Shift+Z`（Mac 上 `⌘`） | 撤销 / 重做画线的改动：新建、拖动、删除（含删除所有绘图）、改样式、锁定 / 隐藏 / 显示所有绘图、设置弹窗里的修改（含延长、日期、价格坐标）。快照就是写回的 `overlays`（带 `scale`、`tvId`），重建和恢复走同一条路（`drawing_<n>` id）；KLineChart 留着传给它的点对象、把新样式合并进原有的样式对象，所以序列化和重建两头都拷贝点、样式和 `extendData`（`drawing-spec.ts`），快照不会被之后的拖动或改样式改掉。只在当前图表页的内存里，换标的就清空；画到一半、弹窗开着、在输入框或原地编辑文字时不响应 |
| `Alt+R` | 重置图表：回到最新、默认缩放、价格轴自动 |
| `Ctrl/Cmd+Alt+S` / `Alt+S` | 拍快照：下载图片 / 复制图表链接（见下文「拍快照」） |
| `←` / `→` | 向更早 / 更新滚动可见宽度的 10% |
| `↑` / `↓` | 放大 / 缩小 |
| `Space` / `Shift+Space` | 自选列表下一只 / 上一只（跨分组循环，客户端路由；下一只的 `/api/bars` 低优先级预取） |

KLineChart 自带的 `Shift+←/→` 滚动和 `Shift+= / -` 缩放保留。

**弹窗**

- **指标**（TV「指标、度量和策略」）：顶部搜索框（同时搜内置与公式），左栏分类「内置 / 我的公式」，列表点一下添加，已添加的打勾、再点移除；需要基准而标的没有 `bench` 的灰掉。「我的公式」里每行有编辑按钮，末尾「新建公式」，都在弹窗内打开公式编辑器。开关照旧写回 yaml `chart.indicators`。
- **设置**（图例齿轮）：参数输入框（逗号分隔，聚焦全选），说明「只对周线生效」，恢复默认 / 取消 / 确定；参数按周期写回 `chart.params`（去抖）。成交量（VOL）和 TV 一样默认不画均线，参数为空；在设置里填周期（如 20）才画，清空 = 恢复默认。
- **比较商品**：见下文对比。

**布局细节**：副图（指标、新窗格对比）每个固定 100px，指标窗格排在对比窗格上面（`setPaneOptions({ order })`）；图表最小高度 `max(520, (101 × 副图数 + 25) / 0.54)`，保证主图至少占 45%。主图上方留给图例的空白 = 图例实测高度 + 12px：KLineChart 的 `gap.top` 是把值域按比例放大（像素值先除以窗格高度），实际留白会偏小，所以按 `top = px × (1 + bottom) / (H − px)` 反解成比例传入，窗格高度变化时重算（仅在自动缩放时）。画布字体：刻度与十字线 mono，标注 sans。

**对比（和 TradingView 一致的显示）**

- 顶栏 `+` 打开「比较商品」弹窗：可输别名、完整 key，或搜索（§5.4 的搜索接口）；高亮行上两个按钮「同百分比坐标」（Enter，默认）/「新窗格」，和 TV 一样；下方列出已添加的对比，可移除。添加后写入 `charts/<fileKey>.json`。
- `percent` 模式（默认）：主图叠加。主图 y 轴切到 KLineChart 的 `percentage`（`overrideYAxis({ paneId: "candle_pane", name: "percentage" })`；百分比轴与对数轴互斥，开对比时对数自动关闭，关掉所有对比后恢复）。每个对比标的是叠在 `candle_pane` 上的一个 indicator（`createIndicator({...}, true)`，`series: "price"`，一条线），值 = `mainClose[base] × cmpClose[i] / cmpClose[base]`，`base` 是**可见区间左边缘**那根（`getVisibleRange().realFrom`，若该处对比标的无数据则向右找第一根有数据的）。订阅 `subscribeAction("onVisibleRangeChange")`，去抖 ~80ms 后用 `overrideIndicator` 更新 base 重算——这样滚动、缩放时所有线都从左边缘重新归零，和 TV 的「同百分比坐标」行为一致。
- `pane` 模式：对比标的放独立副图（`series: "normal"`，画原始收盘价，自己的坐标轴），用于美债收益率这类单位不同的叠加。
- 图例：每个对比标的一行（名称用线的颜色）· 十字线处的收盘价 · 相对 base 的 %；悬停出现眼睛（隐藏 / 显示）和 ×（移除）。百分比对比在主图图例里，新窗格对比在自己窗格的左上角。
- 调色板（明暗模式都可读，且不与 KLineChart 默认指标色 `#FF9600 #935EBD #2196F3 #E11D74 #01C5C4` 撞色）：`#0e9aa7 #c2410c #2f6fde #a21caf #65a30d #4b5563`，按添加顺序取；线宽 2px。青和锈色排在前面，常见的一两条对比不会和均线同色。
- 比较商品弹窗用全局搜索组件的 `pick` 模式（§5.4，`pickActions` 给出两个按钮）：别名不区分大小写，自选 / 常用 / 搜索三段，Enter = 同百分比坐标，加入后输入框清空。`pane` 模式的图例同样显示相对可见区间起点的 %。

**画线**：KLineChart 内置的 overlay（`segment rayLine straightLine horizontalStraightLine horizontalRayLine verticalStraightLine priceChannelLine fibonacciLine brush`）加上 `chart-overlays.ts` 用 `registerOverlay` 实现的其余 TV 工具（信息线、趋势角、十字线、平行通道、回归趋势、安德鲁音叉、斐波那契扩展 / 通道 / 时间周期 / 速度阻力扇 / 圆环 / 螺旋 / 速度阻力弧、江恩方箱 / 扇、XABCD / ABCD / 三角形态 / 头肩、艾略特四种、多头 / 空头持仓、价格 / 日期 / 日期和价格范围、矩形 / 圆 / 椭圆 / 三角形 / 弧形 / 曲线 / 路径 / 折线、文本 / 注释 / 价格标签 / 旗帜 / 箭头 / 向上向下箭头）。TV 的「趋势线」是有限线段，对应 `segment`；无限延伸的 `straightLine` 叫「延长线」。`simpleAnnotation`（注释）用同名模板覆盖了内置的那个，因为内置版只有锚点能点中。所有自定义图形的颜色、线宽、线型都取自这条画线的 `styles.line`（多头 / 空头持仓、向上 / 向下箭头固定用涨跌色；斐波那契回撤 / 扩展默认每档一种颜色，见下），所以一套样式模型适用于线、填充和标签。回归趋势按两个点之间各根 K 线的收盘价做线性回归（±2σ；对数画线对 log(收盘价) 回归，±2σ 也在对数空间），点吸附在回归线上；多头 / 空头持仓点一下放下，目标 / 止损按可见区间的价格幅度给默认值（盈亏比 2），两个手柄拖动改价、共用右边缘。路径 / 折线一直点下去，双击、`Enter` 或 `Esc` 结束（KLineChart 的 overlay 需要固定步数，所以模板给 200 步，结束时用已点的点重建；双击留下的重复点会去掉）。
- **斐波那契回撤 / 基于趋势的斐波那契扩展**（TV 的样子，`fib.ts` + `chart-overlays.ts` 的 `fibLevels`）：两个工具同一套档位和配色，TV 的默认值：0、0.236、0.382、0.5、0.618、0.786、1、1.618、2.618、3.618、4.236，颜色依次是灰、红、橙、绿、青、浅蓝、灰、蓝、红、紫、粉（`FIB_LEVELS`）。回撤的 0 在第二个点、1 在第一个点，1 以上的档位越过第一个点继续走（从高点画到低点，扩展档就在上方）；扩展是第一、二个点的那段走势从第三个点算起。设置里的「反向」（TV 的 Reverse）把方向反过来、点不动：回撤变成 0 在第一个点、1 在第二个点、1 以上越过第二个点（从低点画到高点的回撤勾上后扩展档在上方）；扩展变成那段走势从第三个点朝相反方向算。档位价格都在画线自己的价格空间里算（`fibPrice`，对数画线按比例，所以反向的对数扩展不会落到 0 以下）。档位线只画在两个点的 x 之间（回撤是它的两个点，扩展是第二、三个点），宽度靠拖点调；设置里「向左延长」「向右延长」把线拉到窗格边缘。相邻两档之间填背景：用靠外那一档的颜色加透明度（默认 80%），背景不接收指针事件，所以在背景上照样能拖动图表，选中画线点它的线或标签。每档的线和标签（`0.618 (123.45)`）用这一档的颜色；标签在线的左端外侧、和线垂直居中，不压在背景上，向左延长时改放在窗格左边缘的线上方。线宽和线型取 `styles.line`，作用在档位线上；两点之间（扩展是三点之间）的连线是虚线，用 `styles.line` 的颜色。**颜色**：默认多色；设置里的「使用单一颜色」（TV 的同名选项）勾上后所有档位、标签和背景都用 `styles.line` 的颜色。在浮动工具栏里选颜色等于选了单一颜色（同时勾上）；设置弹窗里选颜色也会勾上，取消勾选就回到多色，这时选的颜色只用于连线。不提供逐档改数值、颜色或开关的界面。
- **手柄**（TV 的做法）：KLineChart 只把存下来的点画成手柄，其余手柄是模板自己画的图形（样式取 overlay 的 `point` 样式，和 KLineChart 的一样只在悬停或选中时出现）。拖这种图形时 KLineChart 先把整条画线平移（它只认点和整体两种拖法），模板的 `onPressedMoving` 再按按下时的点和手柄改回去，所以数据仍是原来那几个点。矩形、椭圆、江恩方箱、价格 / 日期 / 日期和价格范围有八个手柄：两个存下的对角、另两个角、四条边的中点；拖边只改那一边（一个点的时间或价格），拖角改相交的两边；那一边按指针从按下处移动的价格在画线自己的坐标里走（对数画线按比例），时间取 KLineChart 整体平移后的位置；不用整体平移后的价格，因为整体平移会把手柄不动的那一边也推到 ≤ 0 而被拒绝。手柄算出的结果有价格 ≤ 0 而画线或当前轴是对数时不生效，画线停在这次拖动上一个能画的位置（通道为保持宽度把另一条线推到 0 以下也一样）。平行通道有六个：两条线的四个端点（拖一端，另一条线的对应端跟着走，宽度不变）和两条线的中点（平移这条线，即调宽度）；画第三个点时它落在第二条线的起点。通道的几何（`dragChannel`）在 x 像素和画线自己的价格空间（对数画线是 log 价格）里算，画线和当前轴坐标不同时宽度也在画线自己的空间里保持。
- **K 线数**：信息线 / 日期范围的「N 根K线」、回归趋势取的 K 线、多头 / 空头持仓的默认宽度都按 KLineChart 自己的定位算（`timestampToDataIndex` / `dataIndexToTimestamp`，取图表内部的 store）：数据范围内取不大于这个时间的那根，范围外按周期的日历推算（日线一天一根、周线一周一根、月线一个月一根），和图上点的位置一致。

- **价格坐标**（`overlays[].scale`，§1.3）：画线在它画的那种坐标里是直线，所以对数坐标上画的射线换到普通坐标是一条往上弯的曲线，反过来也一样，延长部分不会偏到别处。KLineChart 的内置模板都是把点换成像素再连直线，所以线段、射线、延长线、价格通道、斐波那契回撤用同名模板覆盖了内置的（和注释一样）。`SCALED_DRAWINGS` 的模板注册时包一层（`chart-overlays.ts` 的 `scaled`）：画线的坐标和当前轴一样（或是没有记录的旧画线）时原样画；不一样时，图形在画线自己的空间里算（一个 y 和 log 价格或价格成线性的像素空间，在画线的平均价附近和当前轴对齐），算出来的线、多边形裁到可见区域后逐段换回当前轴，按半像素的误差二分细分成曲线（`drawing-scale.ts` 的 `makeWarp` / `bendLine` / `bendPolygon`，纯函数有测试）；矩形（斐波那契的背景带、江恩方箱的底色）先裁到可见的价格范围再把上下两边换过去（`bendRect`），所以普通坐标画的回撤在对数轴上有档位落到 0 以下时，跨过 0 的那条背景带仍画到窗格底；文字跟着锚点走，箭头、信息线的信息框、趋势角的角度这类按屏幕像素画的部分按端点在屏幕上的位置画。曲线的像素用 KLineChart `convertFromPixel` 反推的线性映射算，不用 `convertToPixel`（它取整，曲线会出折角）。斐波那契回撤 / 扩展的档位、回归趋势的拟合都在画线自己的空间里算（`levelPrice`、`fitLine`）：对数画线的 0.5 是两个价格的几何平均，在对数轴上正好在中点。按像素画的工具不跟坐标：圆、斐波那契圆环 / 螺旋 / 速度阻力弧、椭圆（框里的内切椭圆）；水平 / 垂直线、十字线、矩形、价格 / 日期范围、多头 / 空头持仓、单点的文字和标记在两种坐标上本来就一样，也不记。设置弹窗里「价格坐标  常规 | 对数」改单条画线的坐标（旧画线两个都不亮，tooltip 说明；有价格 ≤ 0 时对数不可选；对数画线改成 ≤ 0 的价格不生效）。
- **拖动**：KLineChart 拖整条画线时给每个点加同一个价格差，对数轴上会改变斜率，往下拖还会出现 ≤ 0 的价格（对数轴把负数镜像，画线乱跳）。`chart-overlays.ts` 的 `patchMoves` 换掉了 overlay 原型上的 `eventPressedOtherMove`：在画线自己的空间里平移，对数画线（或旧画线在对数轴上）按比例，普通画线按差值；某个点会落到 ≤ 0 而画线或当前轴是对数时，这一步不动（停在上一个位置）。平移后再调一次模板的 `performEventPressedMove`，回归趋势的点回到新区间的拟合上。单独拖一个点时，对数画线在普通轴上拖到 0 以下保持原价。恢复保存的画线时 overlay id 由 `KChart` 先定好（`drawing_<n>`），坐标在 KLineChart 创建它之前就记上，因为回归趋势在创建时就按坐标吸附点。

- **选中后的浮动工具栏**（TV 的绘图工具栏，图表顶部居中）：工具图标 · 颜色（TV 调色板：一行色相一行灰）· 线宽 1–4px · 线型 实线 / 虚线 / 点线；文字类（文本、注释）换成颜色 · 字号 · 编辑文字 ｜ 设置 · 添加警报（水平线、水平射线、十字线）｜ 锁定 · 隐藏 · 删除。改动立刻写回。**设置**弹窗：颜色、线宽、线型（文字类为字号和文字）、趋势线 / 射线 / 延长线的「向左延长」「向右延长」（改了就换成对应的工具，见 §1.3：删掉后按恢复保存画线的同一条路重画，`scale`、`tvId`、锁定 / 隐藏都带着，用的是上文覆盖的同名模板）、斐波那契回撤 / 扩展的「使用单一颜色」「背景」开关和「透明度」滑块（0–100%，步长 5）、「向左延长」「向右延长」、「反向」（写进这条画线的 `extendData`，§1.3；和其他样式一样确定后立刻写回、能撤销）、价格坐标（随坐标变的工具，见上）、每个点的日期和价格（只写回改过的，没改的保持原值）。日期按当前周期落到它所在的那根 K 线上，最后一根之后的空白处也能填（按周期推算）。和页面其他弹窗一样，`Esc` 关闭、开着时快捷键不响应。双击画线 = 设置，双击文字 = 原地编辑。只有画完的绘图会被选中（路径画到一半没有工具栏）；每次点击画线都会选中它（KLineChart 只在换了一条时报告选中）。
- **测量**（TV 的 Measure，`chart-overlays.ts` 的 `measure` 模板 + `measure.ts`）：临时的尺子，不是画线：不写进 `charts/<fileKey>.json`、不进撤销栈、不能选中，也没有浮动工具栏；「锁定所有绘图」「隐藏所有绘图」不影响它，未登录的访客也能用。两个入口：在主图上按住 `Shift` 点一下（正在画别的画线时不触发；点完就可以松开 `Shift`），或者左侧工具栏的尺子按钮（窄屏在「画线」下拉里，触屏只有这个入口）后在主图上点一下。之后尺子跟着指针走，再点一下固定；固定后在图上再按下任意处（再按 `Shift` 点就是量下一段）或按 `Esc` 消失，选别的画线工具也会收起它。显示：两点之间的半透明矩形，价格向上用涨色、向下用跌色（跟着红涨 / 绿涨的设置，明暗模式都可读），中间横竖各一条带箭头的线，信息框在价格走向的那一头外侧（涨在上、跌在下，贴到窗格边缘时留在窗格内）：第一行价格差和百分比（`+12.34 (+5.67%)`，按点上的真实价格算，对数和百分比坐标下一样）、第二行 `N 根K线，Xd`（K 线数和日期范围同一套定位，见下条；天数是两点的日历天数）、第三行区间内的成交量合计（两端的 K 线都算，`成交量 1.23M`；区间里没有一根有成交量的就不显示这一行，整段都在第一根 K 线之前或最后一根之后的空白处也一样）。实现上是放在自己一组（`groupId: "measure"`）的 KLineChart overlay，`KChart` 用它的两步绘制来跟指针和固定，序列化、撤销、清空、锁定 / 隐藏都按组跳过它；开始和收起听的是图表容器捕获阶段的 `pointerdown`（触屏点一下只来一次，不会被浏览器补发的鼠标事件把刚固定的尺子收掉）。跟着磁铁模式吸附。点在副图上的那一下不算，重新等主图上的点击（鼠标和触屏都是，和画线同一处处理）。
- **文字**：TV 的做法，先在图上点位置，再在原处输入（`TextEditor`，`Enter` 确定、`Shift+Enter` 换行、`Esc` 取消、点别处确定；空文字即删除；输入法选字时的 `Enter` / `Esc` 归输入法）；文字能点中、拖动、双击编辑。
- **锁定 / 隐藏**：单条的 `lock` / `hidden` 写进这条画线；「锁定所有绘图」「隐藏所有绘图」是界面模式，叠加在上面，不写进每条画线。锁住的画线仍能选中（改样式、解锁），只是不能拖。
- 画完 / 拖动结束 / 删除 / 改样式即序列化 `getOverlays()` 写回 `charts/<fileKey>.json`（跳过 `currentStep` 还没到完成态的那条）；每次写回前的状态进撤销栈（`drawing-edit.ts`，最多 100 步，和上一次一样就不记），撤销 / 重做把图上的画线换成那个状态再写回；页面回到前台按服务端重建时清空撤销栈；图表挂载后第一批 K 线到了时 `createOverlay` 恢复一次（换标的会挂载新图表）；页面回到前台时按服务端的文件对一遍，不一样才重建（§5.5）。之后换周期、切 ADJ 重新取数据时绘图原样保留（KLineChart 按时间戳重新定位），选中、画到一半的、正在输入的文字都不受影响。**删除必须写回**：KLineChart 在把 overlay 从列表移除之前就调用 `onRemoved`，所以序列化时按 id 排除正在删除的那条。只保存主图（`candle_pane`）上的画线；在副图上点击会被丢弃并重新开始同一个工具（10.0.3 的 `paneId` 并不能把绘制钉在某个 pane）；触屏的点按也一样：KLineChart 在 `touchend` 里处理点按并拦掉浏览器随后的 `click`，所以这一步同时听 `click` 和 `touchend`。KLineChart 在 `createOverlay` 里就调用 `onDrawStart`，所以正在画的那条 overlay 在创建后用 `getOverlays({ id })` 取。KLineChart 会把 500ms 内落在别处的第二次点击吞掉（只认双击），画线时点得太快第二个点不算。

**警报**（TV 的「警报」，§2.6）：

- **入口**：顶栏闹钟按钮「警报」和 `Alt+A`，价格默认填最新价；在主图上右键出现「在 12,345.00 添加警报」（十字线所在价格）；选中水平线 / 水平射线后，浮动工具条多一个闹钟按钮，价格取这条线的价格（只是复制价格，之后挪线不会改警报）。
- **对话框**（「新建警报」/「编辑警报」，图表和总览共用）：第一行「商品」分段「当前标的 | 全部自选」，选全部自选时价格和通道类条件不可选；「条件」下拉是 §2.6 表里的九种叫法加「自定义公式」；值的输入随条件变化（一个价格 / 通道的上下沿 / 百分比和 K 线数 / 公式编辑器），公式多一行「周期」日 / 周 / 月 / 季线；「判断时机」分段「盘中价格 | 日线收盘」（默认随商品：当前标的是盘中价格，全部自选是日线收盘；没动过它时切换商品跟着变）；「触发」分段「仅一次 | 每根 K 线一次」（全部自选时固定为每根 K 线最多一次）；「名称」占位是自动生成的名字；「通知」勾选框「推到我的通知通道」，不勾就只在总览显示。底部「取消」「创建」，从总览编辑时左边多一个「删除」。数值输入框聚焦全选，回车提交。
- **图上的警报线**：当前标的每条启用的价格类警报画一条虚线（通道画两条），右端价格轴上有闹钟标签；点标签打开编辑。已停止的不画。
- **警报列表**：右侧边栏在「自选」「笔记」旁边多一个「警报」页签，列出当前 vault 的全部警报：标的名（对全部自选的写「全部自选」，没有当前价）、条件、触发方式、是否推送、状态（活动 / 已触发 / 已停止，草稿是「待确认」）、当前价和取价时间，agent 建的或改的在名字旁标「Agent」（§2.5）；每行有「编辑」「暂停 / 恢复」「删除」（草稿是「编辑」「确认」「丢弃」），点行打开那个标的的图表。
- **写回**：Server Actions `saveAlert(def)`、`deleteAlert(id)`、`setAlertEnabled(id, enabled)`，和别的写操作一样先过 viewer 写权限，写当前 viewer 的 yaml，注释保留。只读访客看到入口，点开是登录提示。

**拍快照**（TV 顶栏的相机按钮，在刷新和全屏之间）：菜单是「下载图片 · 复制图片 · 复制链接 · 在 X 上分享」，系统支持带文件分享时（手机）多一项「分享…」（`navigator.share` 带 PNG）。快捷键照 TV 文档里有的两个：`Ctrl/Cmd+Alt+S` 保存图片，`Alt+S` 复制链接（TV 的 Alt+S 是拍快照并把快照链接放进剪贴板；这里没有托管快照，复制的是图表页的公开地址）。复制图片只在菜单里，没有快捷键。

- **图片**（`chart-snapshot.ts`）：KLineChart 的 `getConvertPictureUrl(true, "png", 卡片底色)` 给出全部窗格、坐标轴和画线（overlay 画布里的十字线、警报线也在）；React 图例不在画布上，按图例的快照（`LegendSnapshot`：各窗格顶部、指标值、对比值）在原位置重画指标和对比行，和页面一样按宽度换行（每行最宽为图宽减 5rem，所以不会压到价格轴），主图图例折叠时不画主图那几行。上面一条信息栏代替图例的商品行：名称 · 代码 · 周期 · 源 · 币种 · 基准，右侧最后一根 K 线的日期（周线写「YYYY-MM-DD 当周」、月线 YYYY-MM、季线 YYYY Qn），下一行开高低收和相对上一根收盘的涨跌（金额和百分比连在一起）。什么都不截断：一行放不下就折行（涨跌先折到下一行），信息栏按行数长高（一行名称一行价格时 56px），图表往下挪；下面一条 34px：icon.svg 的蜡烛 logo +「hebi8/market」等宽字 + 标语，右侧这张图的公开地址（key 解码后显示；放不下先去标语，再只留域名）。颜色从页面的 CSS 变量取，所以跟着明暗主题和 `data-updown`。按设备像素比输出 PNG，文件名照 TV：`<代码>_<YYYY-MM-DD_HH-mm-ss>.png`。水印只在导出的图片里，页面上的图表不加。
- **复制图片**用 `navigator.clipboard.write` + `ClipboardItem`（把生成中的 Promise 直接放进 ClipboardItem，Safari 只允许在点击里写）。异步剪贴板只在安全上下文里有：经隧道的 https 和 localhost 能用，Tailscale 直连是 http，菜单项置灰并说明。复制链接走隐藏 textarea + `execCommand("copy")`（`src/lib/copy-text.ts`，http 下也能用）。
- **链接**一律是公开地址（`HEBI8_PUBLIC_URL`，默认 `https://market-hebi8.dreaife.tokyo`，`app-info.ts` 的 `publicUrl()`）+ `/chart/<编码的 key>`，在 Tailscale 上打开的页面也一样。未登录的人打开看到的是根 vault 的这张图（§1.6），不是分享者自己 vault 里的画线。
- **系统分享**：生成图片可能耗掉点击带来的用户激活，`navigator.share` 因此抛 `NotAllowedError` 时，留着这次生成的文件，提示「图片已生成，再点一次分享」，下一次点直接分享它。
- **在 X 上分享**打开 `https://x.com/intent/post?text=<标题 · hebi8/market>&url=<链接>`；intent 带不了图片，和 TV 一样只分享链接，链接展开时的卡片见 §5.9。
- 标签页标题跟着周期变（`chartTitle`：「英伟达 NVDA · 周线 · hebi8/market」），服务端的 `generateMetadata` 只知道 yaml 里存的周期。

**商品详情**（TV 的同名面板，`ProfilePanel`；数据见 §2.8，页面渲染时读缓存，不联网）：这个标的是什么。从上到下，没有内容的小节整节不出现，没有值的行不出现：

- 名称，下面一行 `代码 · 交易所 · 币种`。
- **简介**：数据源的原文，超过六行时折叠，「显示更多 / 收起」（只在文字真的被截掉时出现；切换原文 / 译文、译文刚到时先折回去，按新的文字重新量）；下面是「翻译」（能点的人才有）或「显示原文 / 显示译文」（§2.8）。
- **关键数据**：市值、市盈率 (TTM)、每股收益 (TTM)、股息收益率、下一次财报（交易所当地的日期，当天过完就不显示）。市值、市盈率、股息收益率用实际成交的最新价现算（§2.8，不受 `ADJ` 影响），随每轮报价变。大数照 TV 写成 `5.54T`、`809.22B`。
- **公司**：板块、行业、国家/地区、员工。
- **基金**：发行商、类别、费率、资产管理规模；**前十大持仓**（名称 · 按占比的短条 · 百分比，数据源给了代码的可以点开那只的图表）；**行业分布**。
- **相关链接**（§2.8）：每行一个链接，左边中文的名字、右边域名，新标签页打开（`rel="noopener noreferrer"`），悬停显示完整地址。官网在这里，不在「公司」里重复。yahoo / tv / binance 的标的至少有数据源行情页这一条，所以这一节总在；`data:` 序列只在清单给了链接时有；合成标的没有。
- **交易信息**：类型、交易所、币种、时区、交易时段（`symbols.hours` 写成 `09:30–16:00`，`24x7` 写「全天」）、数据源。所有真实标的都有，所以指数、外汇、商品、加密、债券这些没有资料的类型不是空面板。
- 底部「资料更新于 YYYY-MM-DD，每周刷新」（`data:` 序列写「随数据集每次同步更新」）；数据源该有资料但还没取到时写「资料还没有取到，下次同步后补上」。刚加自选或刚打开的标的，资料比日线晚一点到（§2.3）：面板开着且资料还没到时，3 秒后 `router.refresh()` 一次，25 秒后（最慢的源已经超时）再一次，之后不再试，不轮询。
- 合成标的：一句「由下面的标的按需计算，没有自己的资料」和各操作数（名称 + key），点了打开那只的图表。

访客看得到全部内容（资料是共用缓存，不是谁的私有内容），只是没有「翻译」按钮。

**笔记**：右侧边栏的「笔记」面板，显示 `notes/<fileKey>.md` 的渲染结果，「编辑」切换 textarea，自动保存走 Server Action。没有笔记时显示「写下为什么看它」。

**实时 K 线和倒计时**（照 TradingView）：

- **最后一根自己动**：图表页在前台时，每轮报价后（上一次报价时间 + 5 分钟 + 20 秒）读一次 `GET /api/status?key=&tf=&prices=&with=`，拿到状态条要的同步 / 报价时间，和当前周期最后一根 K 线（`tail`：K 线本身、对比 / 公式引用 / 基准在这一根上的值、最后一个交易日）。K 线走 KLineChart 的 `subscribeBar` 回调：时间戳相同就替换最后一根，更大就追加一根（新的一天 / 周 / 月），指标、对比线、基准线随之重算，图例和价格线跟着变；`refs` 的对应位置原地改。不重新请求 `/api/bars`，所以缩放和滚动位置不动。同一时间只有一个状态请求在路上（发新的之前取消上一个），后发先至不会把旧价放回去。`tail.prev` 是倒数第二根的时间：它比图表手里的最后一根还新，说明页面睡过了不止一根（电脑合盖两天），这时才整份重新请求 `/api/bars`，免得中间缺一根。下一轮状态请求照常排着，这次重拉失败的话下一轮再试。
- **倒计时**在右侧最新价标签下面（KLineChart 的 `priceMark.last.extendTexts`，和价格标签同底色，每秒重画），显示距离当前这根 K 线收盘的时间：一天以上 `2d 5h`，一小时以上 `05:12:09`，否则 `12:09`。时间由纯函数 `barCloseAt()`（`src/lib/session.ts`）在浏览器里算：
  - 全天交易（报价时段 `always`，或 `hours` 是 `24x7`）：日线到下一个 UTC 0 点，周线到下周一 0 点，月 / 季线到下个月 / 季度 1 日 0 点。
  - 交易所：只在报价是当前的、时段是盘中（`open`）时显示；日线到报价之后的第一个收盘时刻（那个交易日最后一段的结束时间，按交易所时区；跨夜品种因此落在所属交易日的收盘；半日市当天就是提前的那个时刻；当天已收盘、后面是假日的跨夜品种跳到下一个交易日），周 / 月 / 季线到这一周（周一到周日）/ 当月 / 当季**最后一个交易日**的收盘：从周期最后一天往回找，跳过周末和假日，那天是半日市就用它提前的收盘。假日和半日市来自交易日历（§2.6）；没有日历的标的每个工作日都当完整交易日。`hours` 按星期给了不同时段时（TradingView 的 `1700-1600:2345|1700-1500:6`，`:` 后是星期，1 = 周日）取目标交易日那一天的：点名这一天的优先，其次是没写星期的（默认周一到周五）。
  - 报价「当前」的窗口（`quoteIsCurrent()`，和服务端同一个函数）在浏览器里每秒也判一次：状态请求一直失败时，倒计时过了窗口自己消失，不靠上一次响应里的时段。收盘时刻一过倒计时就消失，不会接着数到第二天。
  - 盘前、盘后、休市，报价过期，合成标的，还没同步出 `hours` 的标的：不显示。
- **状态条**（窄屏底部，iPhone home bar 那一条）：交易所 · 时段 · 最新日期 · 新鲜度，数据同上。

**数据流**：客户端组件请求 `GET /api/bars?key=&tf=&prices=&with=k1,k2`，`with` = 对比列表 ∪ 已开启公式指标的 `refs` ∪ bench；响应里带对齐好的 `refs`，公式模板通过闭包拿到。K 线、图例、指标参数和参数弹窗都跟随已经到手的那组 K 线的周期（`dataTf`），点了新周期、数据还没回来时不会把周线参数套在日线上。`tf`/`log`/`style`/指标开关/参数变化写回 yaml `chart:`（参数编辑去抖），`ADJ` 写回 `prices`；`%` 坐标、画线模式、侧栏面板只存 localStorage。图例的眼睛（隐藏指标 / 对比）只在当前页面有效。

### 5.3 复盘 `/review`

- 本周 journal：textarea 自动聚焦，**自动保存**（§5.6）；为空时填模板。
- 上周 journal：渲染展示。
- 本周触发的警报：所有「本周新触发」的 (标的, 警报)，按组排列，不在自选里的标的放最后，用同一个 `Badge`，点击进图表。
- 有笔记的标的：名称 + 笔记首行**纯文本**（`plainFirstLine`：跳过标题和分隔线，去掉强调、代码、链接、图片、列表与引用标记）。

### 5.4 全局搜索（找标的 / 切标的 / 加标的 / 对比，同一个组件 `SymbolSearch`）

**入口**：页头中间的搜索框（占位「搜索标的 · 按 /」）；任何页面焦点不在输入框时按 `/` 或 `Ctrl/Cmd+K`；图表页直接敲字母 / 数字（带入该字符）；图表页顶栏的商品按钮；总览「+ 添加」；比较商品弹窗（`pick` 模式）。`Esc` 关闭。

**结果三段**（`role="combobox"` / `listbox` / `aria-activedescendant`，默认高亮第一行，↑↓ 移动，Enter 主动作，Tab 在高亮行的分组芯片间切换，鼠标点击 = Enter）：

1. 「使用 `<key>`」：输入本身是合法 key（`yahoo:XXX`、`binance:XXX`、`tv:EX:SYM`、`=A/B`）或别名（不区分大小写）时永远是第一行。
2. 「自选」：本地即时匹配，不区分大小写，匹配 name、ticker、key、yaml 别名、分组名、内置字典的中文名和拼音（全拼 / 首字母）；每行「名称 · 代码 · 分组」；Enter = 打开（图表页 = 客户端切换）。
3. 「常用」：yaml `aliases` 与内置字典里尚未在自选的条目。
4. 「搜索」：外部结果，300ms 防抖（ASCII ≥2 字符，CJK ≥1）；状态「搜索中…」/「无结果，可直接输入 source:ticker 或 AAPL/MSFT 这样的表达式」；已在自选的行尾标「已在自选 · 分组」。

**每一行（照 TV 的搜索框）**：左边是标的的圆形 logo，右边是类型、交易所名和交易所小 logo，中间名称 · 代码。logo 是 TradingView 搜索结果里的 `logoid` / `source_logoid`，浏览器直接从 `s3-symbol-logo.tradingview.com` 加载（隐私说明里写明）；没有或加载失败时左边是代码首字母的圆点，右边只剩名字。手机上有交易所 logo 时只留 logo，没有或加载失败时照样显示名字。同一标的合并成一行时（TV 的 `NYSE:SCCO` 并进 `yahoo:SCCO`），胜出的那条缺的 logo 从同组其他条补（交易所 logo 连同它的交易所名一起）；本地行（自选、常用）先借外部结果里同 key 那行的交易所、类型和 logo，哪个源都没说的由 `keyInfo` 从 key 和字典推：交易所是 `tv:` 的前缀、`binance:` 是 Binance、`.HK/.SS/.SZ` 是 HKEX/SSE/SZSE（logo 试 `source/<交易所>`），普通美股推不出就不显示；Binance 交易对的 logo 用 TV 的 `crypto/XTVC<币>`；字典条目带 TradingView 搜索给的类型和 logo（`wellknown.ts` 的 `TV_META`）。代码和类型任何时候都不让位：名称先截断（最少留 4rem），再不够时行尾按钮换到第二行，靠右。类型（`typeLabel`）是防选错的关键（COPPER 会搜出一排名字都叫 Copper 的 CFD 和期货）：TV 的 typespecs 优先（`cfd` → CFD，指数 CFD 写「指数 CFD」，`crypto` → 加密，`etf` → ETF），其次 kind（股票 / ETF / 基金 / 指数 / 期货 / 加密 / 外汇 / 债券 / 商品 / 数据），都没有时看 key（`=` 比价、`data:` 数据、`binance:` 加密、Yahoo 的 `^` 指数 / `=F` 期货 / `=X` 外汇），推不出就不显示。

**运算符按钮与引导**：输入框右侧一组按钮 `÷ × + − ^ ( )`（照 TV 的 spread 按钮，三种模式都有；窄屏换到输入框下一行，提示文字先换行，不挤输入框），点了在光标处插入 ASCII 运算符（有选区就替换），焦点和光标留在输入框；`−` 插入成 ` - `，保证按减号识别。输入为空时列表区显示一行「比价试试：BTC/GOLD · SPY/QQQ · 2*(SPY - QQQ)」，点了填入、光标到末尾。

**合成表达式（照 TV 的 spread 输入）**：输入以 `=` 开头，或含运算符（`AAPL/MSFT`、`2*(SPY-QQQ)`、`^GSPC/^DJI`、`SPY^2`）时按表达式处理（`isExpression`）。例外：只有不带空格的 `-`、没有别的运算符和数字时仍是一个代码（`BRK-B`、`BTC-USD`），想做减法就加空格（`SPY - QQQ`）或写 `=`；`data:` 开头不带空格的是数据集 key。词法同 §3.3，只是不认识的词不报错。
- 本地和外部搜索都只查光标所在的操作数（光标在运算符后面时不查），结果里选一行 = 把这个操作数换成那个 key（`synthOperand`，必要时加引号），搜索框不关，光标停在换上的 key 后面；行尾显示「替换」。操作数本身是别名或完整 key 时，它自己那一行也留着；高亮在搜索的操作数变化时回到第一行。
- 每个操作数按固定规则解析成完整 key（`resolveOperand`），**不看自选列表**：别名（不区分大小写）或完整 key → 内置字典的代码和中英文名（`GOLD`、`BTC`、`黄金`；不认拼音缩写，`BP` 是真代码）→ TradingView 写法 `NASDAQ:AAPL`（按 `canonicalKey` 转成首选源，`yahoo:AAPL`）→ `…USDT` 是 `binance:` → 这个操作数的外部搜索结果里代码完全相同的第一条（`PLTR` → `yahoo:PLTR`）。字典条目可带 `codes`，是 TradingView 的指数代码（`SPX` → `^GSPC`、`NI225` → `^N225`、`UKX` → `^FTSE`），和条目自己的代码一样解析。不再盲目落到 `yahoo:<代码>`：搜索没回来时提示「搜索中…」，没有完全匹配就要从结果里选。搜索框会对每个还要靠搜索的操作数发外部搜索，结果在弹窗打开期间按文本缓存。中文名之类要搜的词解析不了，要从结果里选；`data:gpu` 这种已知源前缀的半截 key 不当成交易所，提示整个 key 加引号。
- 全部操作数能解析且 `parseSynth` 通过时，第一行是「使用 <短名>」（代码列显示完整 key），key 规范化成去掉空格、操作数都是完整 key 的形式：`AAPL/MSFT` → `=yahoo:AAPL/yahoo:MSFT`，`= 2 * (spy - qqq)` → `=2*(yahoo:SPY-yahoo:QQQ)`，`btc/"yahoo:BRK-B"` → `=binance:BTCUSDT/"yahoo:BRK-B"`。这一行和普通标的一样：Enter 打开、Shift+Enter 加入自选（分组推断为「比价」）、`pick` 模式加入对比；不会把表达式记成别名。解析不了时底部显示「表达式：<原因>」（`parseSynth` 的中文报错，或「「腾讯」要从搜索结果里选一个标的」）。

**打开和加入是两个动作（照 TV）**。`navigate` 模式（页头搜索框、`/`、图表页敲字母、商品按钮）：Enter / 点击 = 打开图表，**不改自选**（不在自选的标的由图表页按需拉数据，§2.3）；加入自选是行尾的「+」按钮或 Shift+Enter。`add` 模式（总览「+ 添加」、图表页自选面板的「+」，对应 TV 自选列表的「添加商品」）：Enter / 点击 = 加入自选，已在自选的行只标「已在自选」。两种模式加入后搜索框都不关，可以接着加，行尾随即变成「已在自选 · 分组」（按当前 yaml 判断，不看搜索时的结果）。访客选不在列表里的行无效，底部提示登录。

**加入**（行不在自选时）：行尾显示推断的分组芯片——`binance` / 加密类 → 加密；`.HK/.SS/.SZ` 或 `tv:SSE/SZSE/HKEX` → 港 A；`tv:TVC/FX_IDC/OANDA` 或 kind ∈ index/bond/commodity/forex/cfd/currency/economic → 宏观；`=` → 比价；其余 → 美股。按组名（含同义词）匹配 yaml 里现有的组，没有就落到第一个组；高亮行展开全部芯片 + 「新建分组…」（内联输入）+「+」，其他行只有淡色「+」；Tab 换组。加入 = `addSymbol` 到该组；名称写 yaml 时取字典中文名；若输入的是中文搜索词且添加成功，把「搜索词 → key」写进 `aliases`；成功 toast「已把 X 加入「港 A」· 撤销」（撤销 = `removeSymbol`）。

**`pick` 模式**（比较商品弹窗）：主动作由 `pickActions` 给出（「同百分比坐标」/「新窗格」，高亮行上显示为按钮，Enter = 第一个），自选段也是；排除当前标的与已对比的 key。

**后端**（纯函数在 `src/lib/search.ts`，可测试；路由只做编排）：规范化 query → 合法 key 直接返回 → 本地层（在浏览器里跑：自选 + aliases + 字典 `src/lib/wellknown.ts`，约 65 条 `{ key, zh, en, aliases }`，拼音直接写在 aliases 里，不引入拼音库）→ 外部层并行：

- Binance：`/api/v3/ticker/price` 内存缓存 24h，取 `*USDT`，按币名前缀匹配，`<base>USDT` 完全匹配排最前。
- Yahoo：仅 ASCII 查询（含 CJK 直接抛 `Invalid Search Query`）；过滤 FUTURE / OPTION / MUTUALFUND；外地挂牌（`.TO/.DU/.F/.DE/.L/.MX…`，`.HK/.SS/.SZ` 除外）只在查询本身含 `.` 时保留；同一公司只留主上市。
- TradingView：查询含 CJK、或含 `:`、或 Yahoo 过滤后的命中 < 3 时调用（COPPER 在 Yahoo 只搜到期货，全被丢掉）；含 `:` 时直接按交易所查，否则并行 `index`、`cfd`、`stock`（像收益率的查询再加 `bond`）各取前几条合并；丢 bond（除非查询像 `US10Y` / 收益率 / 国债）、structured、swap、dr、warrant、futures（除非查询含 `!` / 期货）、FINRA 等数据商序列；`<em>` 高亮去掉；大交易所的股票 / ETF 改写成 Yahoo key（`HKEX:700 → yahoo:0700.HK`、`SSE:600519 → yahoo:600519.SS`、`NASDAQ:AAPL → yahoo:AAPL`），`BINANCE:XXXUSDT → binance:XXXUSDT`。

排序：精确代码匹配 > 自选 > 字典 > 来源偏好（股票 yahoo > tv；币 binance > yahoo；宏观 / 指数 / 汇率 tv:TVC/HSI/FX_IDC/OANDA > yahoo）> 名称前缀 > 交易所白名单（TVC、HSI、SSE、SZSE、HKEX、NASDAQ、NYSE、BINANCE、FX_IDC、OANDA）> 其余按到达顺序。同一标的多源去重（`yahoo:BTC-USD` 与 `binance:BTCUSDT` 算同一个，币优先 binance）。返回 `{ key, name, exchange?, kind?, source, inWatchlist?, suggestedGroup }`，最多 12 条。

### 5.5 设置

周期选择、涨跌色、图表偏好由各处 UI 写回 yaml；分组、名称、基准由总览行菜单写回；警报由图表和总览的警报对话框写回；其余（同步时间、别名、数据集）直接改 yaml，写法在 README，页面上不提示路径（owner 在 `/usage` 能看到）。通知通道写在 `~/.config/hebi8/market/notify.json`（§2.5）。反馈用的 GitHub App 只有一个 client id，写在源码里（§5.8）。

**设置页 `/settings`**（页头「设置」）放两类东西：agent 的接入令牌，和一次性的搬家操作（从 TradingView 导入自选列表和画线、把自选导出成 TradingView 能导入的列表）。访客能看、能导出（示例列表），生成令牌和导入的按钮是灰的，提示登录。

**Agent 接入（MCP）**（`AgentTokens`，Server Actions 在 `src/app/token-actions.ts`）：第一节。写着 MCP 地址（当前页面的 origin + `/mcp`，所以在 Tailscale 地址上生成的命令走 Tailscale）和要带的请求头。

- **生成**：起名（必填，最多 40 字）、选「只读」或「可写」、点「生成令牌」。共用模式下要登录（`viewer.canWrite`），令牌记在登录的那个账号名下；单用户模式下能改页面的人就能生成，`login` 为空。
- **只显示一次**：生成后出现一个框，里面是令牌明文和可以直接复制的 Claude Code 接入命令（`claude mcp add --transport http hebi8-market <地址> --header "Authorization: Bearer <令牌>"`），各带「复制」；刷新或离开页面后不再出现，服务器上只有哈希（§1.6）。
- **列表**：名字、权限、创建日期、最后使用日期（一天最多更新一次，没用过写「还没用过」；日期按 `sync.tz`）、「吊销」（点两次确认）。只列自己的令牌，吊销也只能吊销自己的。页面上一个令牌用哈希的前 16 位表示。纯函数在 `src/lib/tv-import.ts`（列表、代码映射）和 `src/lib/tv-drawings.ts`（画线），Server Actions 在 `src/app/tv-actions.ts`，都先过 viewer 写权限、只写 `viewer.dir`。

**代码映射**（`tvSymbolOf(key, exchange)` / `keyIdentity(key)` / `tvIdentity(symbol)`）：

| key | TradingView |
|---|---|
| `tv:EXCH:SYM` | `EXCH:SYM` |
| `binance:X` | `BINANCE:X` |
| `yahoo:NVDA`（无后缀） | `NASDAQ / NYSE / AMEX / BATS:NVDA`，交易所按缓存里数据源报的 `exchange`（NasdaqGS → NASDAQ、NYSEArca → AMEX…）；`BRK-B ↔ BRK.B` |
| `yahoo:0700.HK` | `HKEX:700`（去前导零） |
| `yahoo:X.SS` / `.SZ` / `.T` | `SSE:X` / `SZSE:X` / `TSE:X` |
| `yahoo:^GSPC` 等常见指数 | 小表：`SP:SPX`、`NASDAQ:NDX`、`NASDAQ:IXIC`、`DJ:DJI`、`TVC:RUT`、`CBOE:VIX`、`HSI:HSI`、`TVC:NI225`、`TVC:UKX`、`XETR:DAX` |

判断「是不是同一个标的」用 identity：美股的几个交易所（NASDAQ、NYSE、AMEX、NYSEARCA、ARCA、BATS、CBOE、OTC）算一个，港股代码去前导零，其余就是 `EXCH:SYM`。自选里的 key 先按别名解析（读出来的 `Config` 已经解析过）。合成标的、`data:`、表里没有的（其他市场的后缀、`=X` / `=F`、`-USD`）没有 TradingView 代码。

**导入自选列表**：TradingView 自选列表菜单「导出列表…」得到 `.txt`：逗号分隔的 `EXCH:SYM`，`###节名` 分节，可能有换行、BOM、第一节之前的标的。上传文件或粘贴文本，浏览器里 `parseTvList` + `planTvImport` 即时预览（每组：TradingView 代码、写入的 key、状态）：

- 新标的写成 `tv:EXCH:SYM`（tv 源什么都有；字典里有中文名的照 `addSymbol` 写成 `{ key, name }`）。
- 自选里已经有等价标的（任何 key）的标「已在「组名」」，不再加；文件里重复的（同一 identity）只保留第一次，其余标「重复」。
- 第一个 `###` 之前的标的进一个默认组，组名默认是文件名（去扩展名），可改。同名的节在文件里出现两次合成一组：先按文件顺序定下每个标的第一次出现在哪一节，再把同名的节合起来，所以 `###A,NASDAQ:NVDA,###B,NASDAQ:AAPL,###A,BATS:AAPL` 里 AAPL 属于 B。
- **合并**（默认）：新标的加到同名分组末尾，没有就在 `groups` 最后新建；已在自选的不动。全都已在自选时报错，什么也不写。
- **替换**（按钮要点两次确认）：`groups` 整个换成文件里的节；已在自选的标的沿用原来那条 yaml 条目（别名写法、名字、基准、行尾注释都在），只是挪到新位置，文件里没有的从自选里去掉。其他顶层字段和注释不动。
- `importTvList` 在服务端按当前 yaml 重新算一遍计划再写（`parseDocument` 改写，原子写入），不信任浏览器算的状态。写完不等拉数据：后台跑一次 `syncAll()`（新标的从没同步过，会被拉；一小时内拉过的跳过），之后照常算 stats 和警报，拉不到的在总览那一行显示同步错误。

**导出自选列表**：页面渲染时算好（`exportTvList`），按钮在浏览器里下载 `hebi8-watchlist.txt`，格式和 TradingView 导出的一样是一行：`###组名,EXCH:SYM,…`。空分组不写；组名里的逗号换成空格。合成标的、`data:` 标的、映射不出来的跳过，页面上逐个列出（key、组、原因；美股 Yahoo 标的还没同步过、不知道交易所的写明「同步一次后再导出」）。

**导入画线**：TradingView 没有画线导出，两种来源：

1. **从布局取**：先填两个 cookie `sessionid`、`sessionid_sign`，点「获取布局」列出账号下的布局，下拉里选一个（默认最近修改的），再「取画线并预览」；下拉最后一项「手填链接或 ID…」填布局链接或 ID（`https://www.tradingview.com/chart/<ID>/`），用来取别人分享的布局，没获取列表时也是填这个。服务端（`src/lib/tv-layout.ts`）照 TradingView 自己页面的做法取，库的 `getDrawings` 已经不能用：
   - **布局列表**（`listTvLayouts({ sessionid, sign })` → `fetchLayouts`）：`GET https://www.tradingview.com/my-charts/`，网页「打开布局」对话框用的接口（带 cookie 和浏览器 UA，`redirect: "manual"`，15 秒超时）。401 / 403、或者回的不是 JSON（未登录时的页面）报「cookie 不对或已过期」，其他非 200 报 HTTP 状态码。回的是数组，每项**只依赖布局短 id**：`image_url`（就是 `/chart/<ID>/` 那段），没有就从 `url` 里的链接抽；其余字段有就显示、没有就空：名字 `name`、标的 `short_symbol` / `symbol`、周期 `interval` / `resolution`、时间 `modified` / `created`（秒、毫秒或 ISO 字符串都认）。按时间倒序，没时间的排最后；下拉显示「名字 · 标的 · 周期 · N 天前修改」。字段名是照网页的请求写的，没有逐个核对过：不是数组时错误里列出顶层字段，一项都认不出 id 时列出第一项的字段，方便对照实际返回改。
   - **账号 id**：只请求一次 `https://www.tradingview.com/markets/`（带 cookie 和浏览器 UA，`redirect: "manual"`，15 秒超时；不是 200 就报「连不上」）。不用首页：登录后它 302 到账号语言的站点（`cn.tradingview.com`），跨域跳转时 fetch 丢掉 cookie，跳过去就是未登录；也不用库的 `getUser`，它读首页，页面没有登录用户时无止境地递归请求自己。页面里有 `var is_authenticated = true` 才算登录，id 取 `var user = {"id":<数字>`（页面里别处还有经纪商的 `"user":{"username":…}`，不能拿宽的正则去找）。
   - **token**：库的 `getChartToken(layout, { id, session, signature })`（`/chart-token` 301 到 `/chart-token/`，同域，axios 跟随时 cookie 不丢）。
   - **有哪些画线**：charts-storage 的每个请求都要带 cookie（没有就 403 `Header validation failed`）和 `layout_id=<ID>`、`jwt=<token>`。先取两份尺寸清单：布局的 `GET charts-storage/layout/<ID>/sizes` 和全局同步的 `GET charts-storage/user/sizes`，`payload.charts` 按 chart id（`_shared` 是开了「同步画线」的那部分，多图布局里每个图表另有自己的 id；全局同步的是 `UserSync`）列出有画线的标的和条数，不用猜 chart id。
   - **取画线**：`sources` 不带 `symbol` 时 `payload` 是空的，所以按清单逐个标的取（同时最多 4 个请求）：布局的 `GET charts-storage/get/layout/<ID>/sources?chart_id=&layout_id=&jwt=&symbol=`，全局同步的 `GET charts-storage/get/user/sources?layout_id=&jwt=&symbol=`（不带 chart_id）。清单里的表达式标的（`1/FX:USDJPY*TVC:DXY`）照样取，预览里跳过（计入报告）。同一条画线在几处出现只算一次。
   - 页面按来源列出取到几条：「布局（同步画线 _shared）215 条，布局图表 2 …，全局同步 54 条」，和清单里的 `countSourcesChart` 对不上时注明 TradingView 记的条数。
   - **cookie 只在这一次请求里用**：不存、不写日志、不进错误信息（错误只说「cookie 不对或已过期」「布局不存在或打不开」「连不上 / HTTP 状态码」「列表格式不认识（字段名）」），获取布局列表后输入框还留着，取画线的请求发出后清空；页面上写明 cookie 只从服务器发给 tradingview.com。
2. **粘贴 JSON**：开发者工具 Network 面板里 `sources` 请求的响应（`{ payload: { sources: {…} } }`），或者其中的 `sources` 对象、画线数组、单条画线。在浏览器里解析成精简的画线（`normalizeDrawing`：只留 id、symbol、type、points 和用得到的样式字段），原文不上传。Server Action 请求体上限在 `next.config.ts` 调到 10mb（`experimental.serverActions.bodySizeLimit`，默认 1MB：一条 3 万个点的画笔就超了），确认导入时画线要整批发回服务端；请求被拒绝（超限、服务不在）时面板上显示错误，不抛给 React。

存储格式（接口原样，粘贴的也是它）：`payload.sources[id] = { id, symbol, ownerSource, serverUpdateTime, state: { type, id, points, zorder, linkKey, state: {样式…, interval} } }`，类型和点在外层 `state`，样式在 `state.state`；「外层 `state` 摊平」的样子（旧库 `getDrawings` 返回的）也认。`symbol` 是 `EXCH:SYM`、表达式，或者 `={"symbol":"NASDAQ:NVDA","adjustment":"splits"}`。点是 `{ time_t（秒）, offset, price, interval }`，点上没写 `interval` 的取画线的 `state.state.interval`。真实数据（一个布局 215 条 + 全局同步 54 条）的周期：1W、240、1D、1M、60、15、12M。

**预览**（`previewTvDrawings`）按 `drawing.symbol` 分组，用上面的 identity 对到自选里的标的；每个标的列出可导入几条、以前导入过几条、跳过几条及原因（按原因计数，没有对应工具的按 TradingView 类型名计数）。对不上的标的可以选「加入「某组」」（写成 `tv:EXCH:SYM`，组可以是现有的或新建「TradingView」）或跳过；同一批里等价的几个代码（`NASDAQ:NVDA` 和 `BATS:NVDA`）只有第一个能选，后面的标「同 NASDAQ:NVDA」，跟着它走，加入时也只加一次、画线都进第一个的 key。**确认**（`importTvDrawings`）：要加入的标的先 `syncOne(key, true)`（顺便校验，失败的列出来、不写），写进 yaml，再逐个标的转换，**追加**到 `charts/<fileKey>.json` 的 `overlays` 末尾，`compare` 和已有画线不动，每条带上 `tvId`（§1.3）。

**图表页回到前台**（`visibilitychange` 变成可见或窗口 `focus`）时 `router.refresh()` 重读页面，刷新完成后 `KChart` 比较服务端的画线和图上的：不一样就按服务端的重建（正在画的那条、正在输入的文字不动），对比列表本来就跟着页面数据走。典型场景是在另一个标签页的设置页导入完切回来。没有用保存时带版本号、过期就拒绝的办法：图表的保存是每次改动就发，拒绝后用户刚做的改动也要丢，而 `tvId` 跟着画线走以后，被冲掉的导入画线再导入一次就能回来。

**类型映射**（`TV_TOOLS` + 几个特殊处理，对应 `DRAW_GROUPS`）：

| TradingView | 应用 |
|---|---|
| `LineToolTrendLine` | 不延伸 `segment`；只向右 `rayLine`；只向左 `rayLine`（两点对调）；两边 `straightLine`（按 `state.extendLeft/extendRight`） |
| `LineToolRay` / `LineToolExtended` / `LineToolInfoLine` / `LineToolTrendAngle` | `rayLine` / `straightLine` / `infoLine` / `trendAngle` |
| `LineToolHorzLine` / `LineToolHorzRay` / `LineToolVertLine` / `LineToolCrossLine` | `horizontalStraightLine` / `horizontalRayLine`（补一个 100 天后的第二点定方向）/ `verticalStraightLine` / `crossLine` |
| `LineToolParallelChannel` / `LineToolRegressionTrend` / `LineToolPitchfork` | `parallelChannel` / `regressionTrend` / `pitchfork` |
| `LineToolFibRetracement` / `TrendBasedFibExtension` / `FibChannel` / `FibTimeZone` / `FibSpeedResistanceFan` / `FibCircles` / `FibSpiral` / `FibSpeedResistanceArcs` | `fibonacciLine` / `fibExtension` / `fibChannel` / `fibTimeZone` / `fibFan` / `fibCircles` / `fibSpiral` / `fibArcs` |
| `LineToolGannComplex`、`LineToolGannSquare` / `LineToolGannFan` | `gannBox` / `gannFan` |
| `LineTool5PointsPattern` / `ABCD` / `TrianglePattern` / `HeadAndShoulders` | `xabcd` / `abcd` / `trianglePattern` / `headShoulders` |
| `LineToolElliottImpulse` / `Correction` / `Triangle` / `DoubleCombo` | `elliottImpulse` / `elliottCorrection` / `elliottTriangle` / `elliottDoubleCombo` |
| `LineToolRiskRewardLong` / `Short` | `longPosition` / `shortPosition`：入场点 + 右边缘（第二个点，没有就 20 天）。TradingView 只存跳数：止盈 `state.profitLevel`、止损 `state.stopLevel`（没有价格字段；`amountTarget / amountStop` 是金额），价格 = 入场价 ± 跳数 × 最小变动价位。最小变动价位用这个标的缓存里最近 50 根收盘价算（能写下全部收盘价的最少小数位，容差千分之一步，Yahoo 的 float32 价格也行），没有 K 线就跳过 |
| `LineToolPriceRange` / `DateRange` / `DateAndPriceRange` | `priceRange` / `dateRange` / `datePriceRange` |
| `LineToolBrush`、`LineToolHighlighter` / `Path` / `Polyline` | `brush` / `path` / `polyline`（全部点，去掉相邻重复，至少两个） |
| `LineToolRectangle` / `Circle` / `Triangle` / `Arc` | `rect` / `circle` / `triangle` / `arc` |
| `LineToolEllipse` | `ellipse`：两个点当对角；三个点（一条轴的两端 + 另一条轴上的点）换算成正放的外接框 |
| `LineToolBezierQuadro` | `curve`：第三点（控制点）换成曲线中点 =（控制点 + 两端中点）/ 2 |
| `LineToolText` | `text`（文字、`color`、`fontsize`） |
| `LineToolNote` / `Comment` / `Callout` / `Balloon` / `Signpost` | `simpleAnnotation`（第一个点、文字、底色取 `backgroundColor / markerColor / …`、字号） |
| `LineToolPriceLabel` / `PriceNote` | `priceLabel`（第一个点） |
| `LineToolFlagMark` / `Arrow`、`ArrowMarker` / `ArrowMarkUp` / `ArrowMarkDown` | `flag` / `arrow` / `arrowMarkUp` / `arrowMarkDown` |

其余（成交量分布、锚定 VWAP、正弦线、图标、表格、`TextAbsolute` 这类钉在屏幕上的、`ElliottTripleCombo`、`Cypher`、`ThreeDrivers`、Schiff / Inside 音叉、`GannFixed`……）跳过，按类型计数报告。应用里只有「价格通道」`priceChannelLine` 在 TradingView 没有对应。画在表达式标的（`1/FX:USDJPY*TVC:DXY`，`isTvSymbol` 为假）上的画线没有对应的图表，预览里标「表达式，跳过」，也不能选加入自选。点数不够的、文字为空的文字类跳过，各有原因。

**点**：`time_t` 是这个点所在 K 线的时间（画线时的周期），日线是开盘时刻：美股纽约 09:30，亚洲按当地开盘，外汇 / 期货 / TVC 是前一晚 17:00 / 18:00 纽约，加密是 UTC 0 点；日内周期上画的点是那根日内 K 线的时间。换成本应用的点（`pointDay`）：取交易所时区的当地日期，时区不是 UTC 且当地时间 ≥ 17:00 时算下一个交易日（晚上开盘的那一节）。不能直接用 `tradingDay`：它的 +12h 只适合开盘时刻，会把美股下午的点推到第二天。时区取缓存里这个标的的 `timezone`（数据源报的），没有就当 UTC。然后对齐到库里的交易日（`bars.t`）：落在节假日、周末的点归到前一根，和 KLineChart 的定位一致（`timestampToDataIndex` 在数据范围内二分取不大于它的那根，范围外按周期推算），范围外的日期原样保留。最后存成毫秒时间戳，所以导入的线和手画的一样跨周期。

**`offset`**（点在当时最后一根 K 线右边多少根）：`interval` 是日线或没写（当日线）时，从 `time_t` 那根起按库里的交易日数 `offset` 根，超出最后一根的部分每根算一个日历日（图表在右边空白处就是这样排的）；`time_t` 本身就在缓存最后一根之后时（缓存比 TradingView 旧），从它起直接按日历日加；周线、月线按周、月加（`12M` 是 12 个月），月份加完日子超过目标月末的落在月末（2026-01-31 + 1 个月 = 02-28，和 KLineChart 推算月线的规则一样）。日内周期（`interval` 是分钟数：`15`、`60`、`240`）**近似**换算成交易日：`ceil(offset × 分钟 / 每天交易分钟)`，再按日线的规则数；每天交易分钟按 TradingView 交易所前缀给（`sessionMinutes`）：美股和美股指数 390，沪深 240，港股 330，东京 300，伦敦 / 法兰克福等欧洲 510，其余（加密、外汇、期货、CFD、TVC）按 24 小时 1440。不计午休、盘前盘后和节假日，所以离最后一根越远误差越大，点可能差一两天。秒、tick 周期换算不了，整条跳过并计入报告。真实数据里 269 条有 49 条是日内周期带 offset 的。

**样式**：颜色取 `linecolor`（文字取 `color`，注释和标签取 `backgroundColor` 等，斐波那契取 `trendline.color`：斐波那契回撤 / 扩展导入后仍是每档一种颜色，这个颜色只用在连线上），`#RRGGBB`、`#RGB`、`#RRGGBBAA`、`rgba()` 都转成 `#rrggbb`（透明度丢掉，应用只有一个颜色）；`linewidth` 取整到 1–4；`linestyle` 0 实线、1 / 4 点线、2 / 3 虚线；文字类加 `styles.text.size = fontsize`。用 `drawingStyles()` 生成，和浮动工具条改出来的完全一样。没有颜色就不写 `styles`（默认样式）。`state.visible === false` → `hidden`，`state.frozen` → `lock`。斐波那契回撤 / 扩展的线宽和线型取 `levelsStyle`（档位线的样式）而不是 `trendline`（连线在应用里固定是虚线），没有就是 1px 实线；`fillBackground`、`transparency`、`extendLines`（向右）、`extendLinesLeft`、`reverse` 有记录时写进 `extendData`（§1.3 的背景、透明度、向右 / 向左延长、反向；点保持 TradingView 的顺序）。TradingView 只存改过的属性，它的默认值（有背景、80%、不延长、不反向）和应用的一样，所以没有这些字段就不写 `extendData`。这五个字段名来自 Charting Library 的属性名，手头的真实样本里都是默认值、没有出现过；逐档的 `levelN` 没有对应的设置，不读。

**价格坐标**：不填 `scale`，导入的画线跟着当前坐标（§1.3）。画线数据（`sources`）里只有点、类型和样式，`ownerSource` 指向主序列，没有价格坐标；对数开关是布局里图表价格轴的状态，只说明现在开着没有，不说明画的时候，全局同步的画线也不属于哪个布局，所以没法按条推断。

### 5.6 自动保存（笔记与复盘日志）

`useAutosave`：输入停止 1s 后保存（Server Action）；`Ctrl/Cmd+S` 立即保存（只认不带 Shift、Alt 的：带 Alt 是图表的下载图片，带 Shift 不归这里）；保存中又有输入则保存完再发最新的；dirty 时 `beforeunload` 拦截；状态文字用 muted 色：「已保存 12:03」/「保存中…」/「未保存」/「保存失败：…」。localStorage 草稿兜底：key 含文件名（`hebi8:draft:notes/<fileKey>.md`、`hebi8:draft:journal/<week>.md`），每次输入写入，保存成功即清；打开时若有草稿、内容与文件不同且比文件的 mtime 新，横幅提示「有 12:03 的未保存草稿 · 恢复 / 丢弃」。笔记面板保留「编辑 / 完成」切换，没有保存按钮。

### 5.7 视觉规范（客观项）

- 次要文字最小 11px；浅色 `--green: #138a4b`（白底 ≥ 4.5:1），深色不变。
- 所有可聚焦元素统一 `:focus-visible` 2px accent 外框。
- 状态文字（已保存等）用 muted，不用 accent。
- 滚动条：页面内部的滚动区（图表页右侧面板、弹窗、抽屉、菜单、搜索结果、横向滚动的表格）的滚动条占 8px 宽、无轨道，滑块可见宽度 4px（两边各 2px 透明边框）、圆角，颜色取 `--fg` 的 22%，悬停 40%（更明显），深浅色跟主题走。只写 `::-webkit-scrollbar` 一套，在 Chrome / Edge / 桌面 Safari / Android Chrome 上生效；iOS Safari 对这组伪元素只认 `display: none`，宽度和颜色不生效，保持系统样式。不同时设 `scrollbar-width` / `scrollbar-color`：Chrome 里这两个属性的计算值只要不是 `auto`，webkit 伪元素在那个元素上就不生效。页面自己的滚动条保持浏览器原生，弹层锁滚动时留的宽度（`use-scroll-lock.ts`）不受影响。图表页的工具栏行（`.scroll-row`）和两侧 42px 的竖向工具栏（`[role="toolbar"][aria-orientation="vertical"]`）不显示滚动条。
- 全站按钮：`.btn` 纯文本（hover 底色）、`.btn-primary`（实心 fg 底 + bg 字）、`.btn-secondary`（1px line 描边）；分段 `.seg`；输入 `.input`；徽标 `.badge`；菜单 `.menu`。
- 图表页工具栏：`.tb-btn`（30px 热区、fg 色图标或图标 + 短文字、hover 浅底，按下 / 展开时 fg 11% 实底）、`.tb-sep` / `.tb-sep-h` 1px 分隔；图标是 `chart-icons.tsx` 里的 18px 线性 SVG，不引入图标库。

### 5.8 帮助抽屉与应用内反馈

**目标**：几秒钟内在应用里把问题报给 GitHub，issue 的作者是报告的人自己，且带机器可读的上下文，以后让自动化识别并修复简单问题。任何人自己部署的 hebi8 都能把问题报到 `Hebi8/hebi8-market`：device flow 只要公开的 client id，不配任何密钥就能用。

**入口**：页头最右的圆形「?」，或焦点不在输入框时按 `?`（Shift+/）；图表页全屏时页头隐藏，顶栏全屏按钮旁出现同样的「?」。右侧抽屉 380px（≤768px 为底部抽屉 85dvh），两个页签「使用 / 反馈」，上次的页签记在 localStorage（`hebi8:help:tab`，「使用」的值是 `project`，存着已经去掉的 `notify` 时回到「使用」）。Esc、点外面、再按 `?` 关闭；抽屉内的按键不冒泡到页面（图表的 Space / 方向键 / 字母搜索不会在背后触发）。`?help=feedback|project` 打开抽屉并从地址栏去掉这个参数。全程不用原生 alert / confirm / prompt（会退出全屏）。

**原则**：抽屉里只放用的时候要的东西：怎么用、快捷键、反馈、隐私说明和登录状态。项目介绍、架构、数据源细节、yaml 字段、版本 / commit、vault 路径、缓存统计、部署信息都写在 README 和本文档，界面上只留一个「项目文档」链接到仓库。owner 需要的实例状态在 `/usage`（§1.7）；通知设置在自己的抽屉里（§2.5），不是这里的页签。

**使用页签**（纯前端，不请求接口）：「怎么用」一句话 +「打开三步引导」（§1.6 的引导面板）；快捷键表；「项目文档」（仓库首页，即 README）和「隐私说明」两个链接。

**版本**：`package.json` version + 构建时的 `git rev-parse --short HEAD` + 构建时间（`next.config.ts` 的 `env` 注入 `HEBI8_VERSION / HEBI8_COMMIT / HEBI8_BUILT_AT`，取不到 commit 时为 `unknown`）。只出现在反馈的 `hebi8-context` 里和 owner 的 `/usage` 上。

**`GET /api/help`**（只读本地）：`{ shared, canSetBot, issuesUrl, github: { enabled, webLogin, feedbackRepo, user: { login, avatarUrl, token } } }`，反馈页签和通知设置抽屉共用。`user.token` 是这条会话有没有 GitHub token（从其他设备带过来的登录没有）。`webLogin` 是这个请求的入口能不能网页登录，由服务端按请求的 origin 算；根 layout 也算一次传给 `UiProvider`，客户端不自己判断。

**配置**（`src/lib/app-info.ts`，服务端读，环境变量可覆盖，供 fork 用自己的 App / 仓库）：

| 常量 | 默认 | 环境变量 |
|---|---|---|
| `FEEDBACK_REPO` | `Hebi8/hebi8-market` | `HEBI8_FEEDBACK_REPO`（须形如 `owner/name`，否则用默认） |
| `GITHUB_APP_CLIENT_ID` | `"Iv23liCniWEUtlDruFJa"`（Hebi8 组织的 hebi8-market App） | `HEBI8_GITHUB_CLIENT_ID`（`off` 关闭应用内登录） |

client id 不是秘密（device flow 的设计就是给拿不住密钥的客户端用的），写在源码里即可。

网页登录另有一个文件，配置目录（§1.5）下的 `github-oauth.json`，手写，权限 600，每次用到时读，改了不用重启：

```json
{ "client_id": "Iv23li…", "client_secret": "…", "scope": "", "origins": ["https://market-hebi8.dreaife.tokyo"] }
```

| 字段 | 说明 |
|---|---|
| `client_id`、`client_secret` | 必填，两个都有才启用网页登录。通常就是反馈用的那个 GitHub App（`GITHUB_APP_CLIENT_ID`）加上它的 client secret：两种登录拿到的是同一种 token，都能在应用里提交。也可以是另一个 OAuth App：authorize / token 接口一样，代码不区分，差别只在 OAuth App 的 token 没有过期时间和 refresh token，而且不带 scope 时只确认身份（见下面「提交」） |
| `scope` | 可省，默认空，原样传给 GitHub。GitHub App 不看它（权限是 App 自己的）；对 OAuth App，空就是只确认身份 |
| `origins` | 可省，默认 `[publicUrl()]`。请求的 origin（`Host` + `X-Forwarded-Proto`）在这个列表里才提供网页登录：GitHub 只跳回登记过的回调地址（GitHub App 可以登记多个，OAuth App 只能一个），从别的入口发起会落到另一个 Host 上，cookie 到不了发起的入口 |

没有这个文件、当前入口不在列表里、或 `HEBI8_GITHUB_CLIENT_ID=off`：没有网页登录，「登录」走 device flow。

**反馈页签**的四种状态，表单（类型分段 问题 bug / 体验 ux / 数据 data / 想法 idea、标题、描述、「附带页面信息」、「可以自动修复」、可展开的「预览将附带的信息」= 实际发送的 JSON）在每种状态下都在，未发送的内容在本标签页内关掉抽屉也保留：

- **未启用**（client id 为空）：「反馈未启用」，说明不能在应用里直接提交（不提配置项，那是部署的人看的，见上表）；表单下方主按钮是「在 GitHub 网页上提交」。
- **未登录**：「用 GitHub 登录」+ 说明会以你的名义提交到哪个仓库；表单下方是次要按钮「在 GitHub 网页上提交」。入口提供网页登录时，按钮是整页跳转（`next` 是当前页面加 `?help=feedback`，回来后抽屉重新打开在反馈页签）；跳走前把未发送的表单存进 sessionStorage（`hebi8m:feedback-draft`），页面再加载时取回并删掉；device flow 不离开页面，不暂存。
- **登录中**（只有 device flow）：大号、可复制的 user code（复制不用 async clipboard——内网是 http，没有安全上下文——而是隐藏 textarea + `execCommand("copy")`，焦点留在抽屉里）、「打开 github.com/login/device」（新标签页，地址来自 GitHub 的 `verification_uri`，只接受 `https://github.com/…`）、状态行（等待授权 / GitHub 要求放慢）+ 倒计时、「取消」。进行中的登录记在模块变量里，关掉再打开抽屉会接着轮询。
- **已登录**：头像 + 用户名 +「退出」；「提交」按钮下注明「以你的 GitHub 账号提交到 <repo>」。`Ctrl/Cmd+Enter` 提交，成功 toast「已提交 #123」（链到 issue）并清空；GitHub 返回 403 / 404 / 410 时显示中文原因并给出「在 GitHub 网页上提交」。未登录 / 未启用时 `Ctrl/Cmd+Enter` 打开网页版。
- **已登录但会话没有 token**（从其他设备带过来的登录）：头像 + 用户名 +「退出」下面多一块说明「这台设备的登录是从其他设备带过来的，没有 GitHub 的授权」和「用 GitHub 登录」（网页登录或 device flow，登录后换成带 token 的新会话）；表单下方和未登录时一样是「在 GitHub 网页上提交」。服务端同样把关：这种会话调 `POST /api/github/issues` 得到 403 和同样的说明，会话保留。

下方列出最近 5 条 `from-app` issue。

**登录**有两种方式，结果都是同一种会话。所有 GitHub 调用都在 `src/lib/github.ts`，错误是带中文消息的 `GitHubError`；token、device code 和 client secret 只在服务端，不进浏览器、不写日志、不进错误信息。

**网页登录（OAuth authorization code）**，入口在 `origins` 里时用它：浏览器里已经登录 GitHub 的人点一下就回来，授权过的连确认页都没有。

1. `GET /api/github/login?next=<站内路径>` → 生成 32 字节随机 `state` 和 PKCE verifier，和 `next` 一起放进 cookie `hebi8m_login`（HttpOnly、SameSite=Lax、10 分钟、HTTPS 时 Secure）→ 302 到 `https://github.com/login/oauth/authorize`（`client_id`、`redirect_uri=<origin>/api/github/callback`、`state`、`scope`、`code_challenge`（verifier 的 SHA-256）、`code_challenge_method=S256`；不认 PKCE 的 client 会忽略后两个）。`next` 只接受站内路径（`safeNext()`：以单个 `/` 开头，没有反斜杠和控制字符，解析掉 `..` 之后仍然不是 `//` 开头，不超过 1000 字符），否则是 `/`。入口不提供网页登录时不去 GitHub，303 回 `next`。
2. `GET /api/github/callback?code&state` → `state` 和 cookie 里的做常数时间比较 → `POST https://github.com/login/oauth/access_token`（`client_id`、`client_secret`、`code`、`redirect_uri`、`code_verifier`）→ `GET /user` → 建会话（记下 `web_client` = 这个 client id），设会话 cookie，清掉 `hebi8m_login`，303 回 `next`。浏览器原来带着的会话一并删掉。
3. 每条出路都回到 `next`（cookie 没了就是 `/`），并带上 `?login=`：`ok`、`denied`（在 GitHub 上点了拒绝）、`state`（state 对不上或 cookie 已过期）、`failed`（换 token 或取用户失败，原因写进服务端日志）、`unavailable`（入口不提供网页登录）。`UiProvider` 按这个值弹一条 toast（文案在客户端，地址栏里只有代号），然后把参数从地址栏去掉。

**device flow**，其余入口用它（只要 `GITHUB_APP_CLIENT_ID`）：

1. `POST /api/github/device` → 服务端 `POST https://github.com/login/device/code`（只带 `client_id`）→ device code 留在服务端内存（`globalThis` 上的 Map，键是 32 字节随机 flowId，按 `expires_in` 过期，最多 20 个并发）→ 返回 `{ flowId, user_code, verification_uri, expires_in, interval }`。`device_flow_disabled` → 「GitHub App 没有开启 Device Flow」；不认识的 client id（GitHub 回 404 或 `incorrect_client_credentials`）→ 界面上只说「GitHub 不认识这个应用，请联系部署的人检查登录配置」，该查哪个常量、环境变量或文件写进服务端日志（`[hebi8m] github: …`，不含 secret）；网页登录的 `redirect_uri_mismatch` 同样处理。界面上不提配置项，那是部署的人看的。
2. 面板每 `interval` 秒 `POST /api/github/device/poll { flowId }`。服务端每次最多向 GitHub 发一次 `POST https://github.com/login/oauth/access_token`（`client_id`、`device_code`、`grant_type=urn:ietf:params:oauth:grant-type:device_code`，没有 client_secret），且自己也卡住间隔：没到时间直接回 `pending`。`authorization_pending` → 继续；`slow_down` → 间隔 +5 秒（GitHub 给了新 `interval` 就取较大者）；`expired_token` / 超时 → `expired`；`access_denied` → `denied`；其它错误结束本次登录。
3. 拿到 token → `GET /user` → 建会话（32 字节随机 id，cookie `hebi8m_session` HttpOnly、SameSite=Lax、30 天，用着就一直续，§1.6；内网没有 HTTPS，所以不设 Secure）。

**两种方式共用的**：

- GitHub App 的用户 token 8 小时过期；离过期不到 5 分钟时用 `grant_type=refresh_token` + `refresh_token` 续，**由发 token 的那个 client 续**：会话有 `web_client` 的用 `github-oauth.json` 的 `client_id` + `client_secret`（文件里的 client 已经换掉或删掉就续不了）；没有的是 device flow 的会话，用 `githubClientId()`，不带 secret（两种登录用的是同一个 App 时也是这样分）。OAuth App 的 token 不过期，没有 refresh token，不走这一步。同一条会话同时只续一次：refresh token 用一次就作废，所以进行中的续期按会话 id 记在 `globalThis` 上的 Map 里，同时到来的请求（两个标签页一起提交）等同一个结果，不会各续各的、后一个被拒而把刚续好的会话删掉。续不上（或 GitHub 对用户 token 返回 401）就删会话，面板显示原因和登录按钮。
- `POST /api/github/logout` 删会话。
- 写操作的接口都拒绝跨站 `Origin`；两个 GET（`login`、`callback`）靠 `state` 和 SameSite=Lax 的临时 cookie。

**在其他设备上登录**（`src/lib/claim.ts`）。两个入口，单用户模式都不显示：页头头像菜单里「通知设置」后面的一项，打开账号抽屉并立刻生成链接；抽屉里用户名下面的按钮，点了才生成。

1. `POST /api/github/claim`（要求已登录，拒绝跨站）→ 32 字节随机码，放服务端内存（`globalThis` 上的 Map，和 device flow 的做法一样），记下发起人的 login 和头像，2 分钟过期；一个人同时只有一个码，再生成就作废上一个；最多 20 个并发，过期的在下次生成时清掉 → 返回 `{ url: "<当前 origin>/claim?c=<码>", qr, expires_in }`。`qr` 是服务端用 `uqr`（MIT，零依赖，只在服务端用，不进浏览器的包）画的 SVG，抽屉里以 data URL 显示，不请求任何外部服务。抽屉显示二维码、可复制的链接、倒计时、「重新生成」和「关闭」（`DELETE /api/github/claim`，链接随之失效）。「关闭」的请求回来之前不能再生成（否则迟到的 DELETE 会把新链接一起作废）；关闭之前发出、之后才回来的生成结果不显示。
2. 另一台设备打开 `/claim?c=<码>`。**GET 不登录**：聊天软件的链接预览、扫码应用的预取都会请求这个地址，一次性码不能被它们用掉；别人发来的链接也不能让人不知不觉登上他的账号。页面只读不取（`peekClaim`），显示「以 <头像> <login> 的身份登录这台设备？」、一句后果说明（这台设备上看到和改动的都是这个人的内容）、已经登录着别人时的提示，以及「登录」「取消」。码无效或过期时说明原因，给「回首页」。页面 `noindex, nofollow`、`referrer: same-origin`，不在 sitemap 里；流量统计只记路径，不记查询串。在这个页面上提交反馈时，附带的页面地址不含 `c`：issue 是公开的，码在 2 分钟内谁看到都能兑换。`reportablePage()` 在浏览器里组装 context 时去掉它（预览、网页版链接、应用内提交都用这份 context），服务端收到提交时再去一次。
3. 「登录」是一个普通表单，`POST /api/github/claim/redeem`（拒绝跨站）→ `takeClaim` 把码用掉 → 建一条**新会话**（自己的 id，login 和头像来自发起人，`access_token` 等四个 token 字段都是 null），设 cookie，303 到 `/?login=ok`；码已经没了就 303 回 `/claim`。**不复制 token**：GitHub App 的 refresh token 每用一次就换新的，两条会话共用一份会互相作废。
4. 没有 token 的会话身份完全正常（vault、通知、警报都照常），只有应用内提交要用 GitHub 登录一次（见上面反馈页签的状态）。

**提交**：`POST /api/github/issues` → 用**用户** token `POST /repos/<repo>/issues`，只有 title + body，不带标签（非协作者带的标签会被 GitHub 静默丢掉）。用户 token 只能访问用户和 App 都能访问的资源，所以 App 必须安装在反馈仓库上；没装（404）、账号被仓库限制（403）、仓库关了 issue（410）都映射成中文说明并提供网页版。网页登录的 token 看它是哪个 client 发的：会话的 `web_client` 就是 `githubClientId()`（网页登录用的是反馈的那个 GitHub App）时，和 device flow 的 token 一样能提交，被拒的原因和说明也同上。是另一个 client（不带 scope 的 OAuth App）时，token 只确认身份，开不了 issue（GitHub 回 403 或 404），这两个状态的说明换成「这次登录的授权不能在 <repo> 上开 issue（网页登录只确认身份，没有开 issue 的权限）」，同样提供网页版。只按会话里记的 client 判断，不为此多发探测请求。`GET /api/github/issues`：`from-app` 标签、`state=all`、去掉 PR、前 5 条；登录时用用户 token（被拒就匿名重试），否则匿名（公开仓库）；服务端按仓库缓存 60 秒，提交成功后清缓存。

**网页版**（`webIssueUrl()`，纯函数，浏览器里算）：`https://github.com/<repo>/issues/new?title=…&body=…`，body 与应用内提交的完全一样（含 context 块）。URL 上限 7000 字符（GitHub 约 8 KB 起报 414）：超了先把 JSON 压成一行，再去掉 `errors`、`userAgent`，再只留 `{ v, type, autoFix }`，最后才从尾部截断描述并注明「网页版已截断」。

**会话存储**：不在仓库、vault、data 里。目录 `HEBI8_SECRETS`（默认 `~/.config/hebi8/market`，权限 700），只有 `sessions.json`（原子写入，权限 600）：会话 id → login、avatar_url、access_token（从其他设备带过来的登录是 null）、access_expires_at、refresh_token、refresh_expires_at、created_at、seen_at（最后使用时间，一天最多更新一次；没有这个字段的旧会话按 created_at 算）、web_client（网页登录的 client id；device flow 的会话没有这个字段）。超过 30 天没用的会话在每次写入时清掉；token 过没过期不影响会话。

**issue 格式**：标题是用户填的；正文

````markdown
<描述>

---

<details><summary>页面信息</summary>        （没勾「附带页面信息」时是「反馈信息」）

```json hebi8-context
{ ... }
```
</details>

<sub>来自 hebi8 market 应用内反馈</sub>
````

`hebi8-context`（`src/lib/feedback.ts` 的 `FeedbackContext`，`parseIssueContext()` 可读回）。`v`、`type`、`autoFix` 总是在（打标签要用），其余只在勾了「附带页面信息」时出现；`type` 和 `autoFix` 由服务端按表单字段重写：

```ts
{
  v: 1,                                   // 字段含义变了就加一；未知字段忽略
  type: "bug" | "ux" | "data" | "idea",
  autoFix: boolean,                       // 「可以自动修复」：只是报告人的意愿，授权看下面的标签
  app?: { version, commit, builtAt },
  page?: "/chart/yahoo%3ASPY",            // 路径 + 查询，不含 origin；去掉 help 和 /claim 的一次性码（reportablePage）
  chart?: { symbol, tf, style, log, prices, indicators: string[], compares: { key, mode }[] },  // 只在图表页
  viewport?: { width, height, dpr },
  colorScheme?: "light" | "dark",
  fullscreen?: boolean,
  userAgent?: string,
  errors?: { t, kind: "error" | "rejection", message, source? }[],  // 本标签页最近 ≤10 个未捕获错误（ErrorCapture 尽早安装）
  at?: string                             // ISO 时间
}
```

**标签：GitHub Actions**（`.github/workflows/app-feedback.yml`，逻辑在 `.github/scripts/feedback-labels.js`，有单元测试）。`issues: [opened, edited]`，权限 `contents: read` + `issues: write`，`actions/checkout@v5`（只稀疏检出 `.github/scripts`，不留凭据）+ `actions/github-script@v8`。正文只当数据：用正则取出 ```` ```json hebi8-context ```` 块，`JSON.parse` 包在 try/catch 里，只认白名单里的 `type`（`bug` / `ux` / `data` / `idea`）和 `autoFix === true`，事件里的内容不拼进脚本或 shell。有块就确保标签存在（缺的按颜色和说明创建）并加上 `from-app` + 类型标签；`autoFix` 为真时，作者的 `author_association` 是 `OWNER` / `MEMBER` / `COLLABORATOR` 才加 `auto-fix-ok`，否则加 `auto-fix-requested`。只加不删。所有人的 issue 都适用，实例里不需要任何密钥。

**分类：GitHub Actions**（`.github/workflows/issue-triage.yml`，逻辑在 `.github/scripts/issue-triage.js`，有单元测试）。所有新开或重开的 issue（也可手动 `workflow_dispatch` 指定编号重跑），把标题、正文（截到 8000 字）、其他打开的 issue 标题和 `.github/triage-context.md`（项目简介、类型、模块、难度标准）发给一个 OpenAI 兼容的 chat completions 接口（变量 `TRIAGE_API_BASE`、`TRIAGE_MODEL`，密钥 `TRIAGE_API_KEY`；没配就跳过）。回答只能从白名单里选：类型（`bug` / `ux` / `data` / `idea` / `question` / `documentation`，应用内反馈已经带类型的不再加）、一到两个 `area:*`、`duplicate`（只认打开的 issue 编号）、难度。`triage:simple` 还要作者是 `OWNER` / `MEMBER` / `COLLABORATOR`，由脚本判断，不由模型；其余、重复的、调用或解析失败的都是 `triage:judgment`。已经有难度标签的不再问。理由只写进运行摘要，不在 issue 上评论。每天一次的巡检会话把 `triage:simple` 当候选自动修复、验证、用 `scripts/deploy.sh` 部署，`triage:judgment` 交给维护者。

**给以后的自动化**：只有带 `auto-fix-ok` 且作者是仓库 owner / 成员 / 协作者的 issue 才算自动修复候选（标签任何有写权限的人都能加，作者关联才是授权依据，自动化应再核对一次）；上下文从 ```` ```json hebi8-context ```` 块里解析，`v` 不认识就跳过。

**仓库 owner 的一次性设置**：

1. 用预填好的链接在 Hebi8 组织下注册 App（名字、描述、主页、公开、关闭 webhook、Issues 读写；Metadata 只读是自动带的）：
   `https://github.com/organizations/Hebi8/settings/apps/new?name=hebi8-market&description=hebi8%20market%20%E7%9A%84%E5%BA%94%E7%94%A8%E5%86%85%E5%8F%8D%E9%A6%88%EF%BC%9A%E7%94%A8%E4%BD%A0%E8%87%AA%E5%B7%B1%E7%9A%84%20GitHub%20%E8%B4%A6%E5%8F%B7%E5%9C%A8%20Hebi8%2Fhebi8-market%20%E4%B8%8A%E6%8F%90%E4%BA%A4%20issue&url=https%3A%2F%2Fgithub.com%2FHebi8%2Fhebi8-market&public=true&webhook_active=false&issues=write`
   核对：**Any account** 可安装（公开——私有 App 只有组织成员能授权）；Webhook 不勾 Active；Repository permissions 只有 Issues: Read and write 和 Metadata: Read-only；Callback URL 留空（device flow 不需要，网页登录才要，见下面）；**Expire user authorization tokens** 保持勾选（8 小时 + refresh）。私钥用不到；client secret 只有网页登录要，device flow 不用。
2. 建好后在 App 的 General 设置里勾选 **Enable Device Flow** 并保存（URL 参数不能设这一项）。
3. Install App → Hebi8 → **Only select repositories → hebi8-market** → Install。
4. 把 App 页面上的 **Client ID**（`Iv23…`）填进 `src/lib/app-info.ts` 的 `GITHUB_APP_CLIENT_ID`，提交。
5. 确认仓库开着 Issues，Actions 允许运行（Settings → Actions → General：允许 `actions/*`；Workflow permissions 用默认即可，工作流自己声明了 `issues: write`）。

fork：建自己的公开 App（同样的权限、开 Device Flow、装在自己的仓库），设 `HEBI8_GITHUB_CLIENT_ID` 和 `HEBI8_FEEDBACK_REPO`；把 `.github/workflows/app-feedback.yml` 留在自己的仓库里就有同样的标签。

**实例的一次性设置（网页登录，可选）**：不做这一步，登录就是 device flow。

1. 打开反馈用的那个 GitHub App 的设置页（上面注册的 hebi8-market，client id 就是 `GITHUB_APP_CLIENT_ID`）：在 **Callback URL** 里加上 `<公开地址>/api/github/callback`，点 **Generate a new client secret**。Enable Device Flow 保持勾选，其他入口还在用。
2. 在配置目录里写 `github-oauth.json`（上面的格式），`chmod 600`：`client_id` 是 App 的 Client ID（`Iv23…`），`client_secret` 是刚生成的。`origins` 不写就是 `HEBI8_PUBLIC_URL`；要写就只写回调地址登记在这个 App 上的入口。GitHub App 可以登记多个回调地址，别的入口也要网页登录的话，把它的 `<origin>/api/github/callback` 也登记上，再写进 `origins`。
3. 从公开地址打开页面点「登录」，应该跳到 GitHub 再回来。回调地址不对时 GitHub 自己的页面会报 redirect_uri 不匹配。

这样网页登录和 device flow 拿到的是同一个 App 的用户 token：能在应用里提交，8 小时过期，用 refresh token 续（网页登录的会话续期带 secret）。

另一种可行的配置是单独建一个 OAuth App（Settings → Developer settings → OAuth Apps，只能登记一个回调地址），把它的 id 和 secret 填进去。这种登录不带 scope 时只确认身份，token 开不了 issue，应用内提交会说明原因并给出网页版；要能提交得写 `"scope": "public_repo"`，那是这个人所有公开仓库的写权限，所以更推荐上面用 GitHub App 的做法。


### 5.9 元数据、分享卡片与搜索引擎

- **公开地址**：`HEBI8_PUBLIC_URL`（`app-info.ts` 的 `publicUrl()`，须是 http(s) 地址，否则用默认 `https://market-hebi8.dreaife.tokyo`）。根 layout 的 `generateMetadata` 用它做 `metadataBase`，请求时读取，所以换地址只要改环境变量重启。
- **根 layout**：`title` 模板 `%s · hebi8/market`（默认 `hebi8/market`）、`description`、`applicationName`、`openGraph`（website、站点名、zh_CN）、`twitter: summary_large_image`。文字常量在 `src/lib/brand.ts`（`BRAND`、`SLOGAN`、`TAGLINE`、`DESCRIPTION`、社交图用的深色 `DARK`），页头也用它们。
- **页面标题**：图表页 `generateMetadata` 给「名称 代码 · 周线」（viewer 的名字和存的周期）、描述、canonical、openGraph / twitter 标题；复盘、设置、使用情况是「复盘」「设置」「使用情况」并且 `robots: noindex, nofollow`；`/claim`（§5.8）是「登录这台设备」，同样 noindex；隐私说明是「隐私说明」。
- **图标**：`icon.svg`（带 `width`/`height`，canvas 和 Firefox 才能画它）、`apple-icon.tsx`（180px PNG，icon.svg 铺满深色方块，iOS 自己切圆角）、`pwa-icon/[file]`（192 / 512 和 maskable，§2.7）、`manifest.ts`（standalone，深色底）。
- **分享卡片**（`opengraph-image.tsx`，next/og，1200×630，深色主题，`force-dynamic`）：站点卡片是大 logo +「hebi8/market」+ 标语 + 一句话介绍 + 公开域名；图表卡片（`/chart/[key]/opengraph-image`）是名称和代码、源 · 币种 · 近半年涨跌、最新收盘和日涨跌 + 日期、近 130 根日线收盘的折线和渐变填充（涨跌色看半年涨跌），底部是和导出图片同样的 logo +「hebi8/market」+ 地址。涨跌色取根 yaml 的 `updown`。
- **卡片不泄露个人内容**：抓取方没有会话，卡片也不读 cookie：名字、配色、合成表达式的别名只从根 vault 的 yaml 读（未登录访客本来就看这个），K 线只从公共缓存读，不碰任何 `users/<login>/`、画线、笔记、警报。没缓存的 key 显示「暂无缓存的日线」，读取不会触发同步。
- **字体不走网络**：next/og 遇到已加载字体里没有的字会去 Google Fonts 下载、遇到 emoji 会去拉 twemoji，违反「读取不碰网络」。所以 `src/lib/og.tsx` 只用本机字体：`HEBI8_OG_FONT` 或常见路径下的 Noto Sans CJK SC `.otf`（satori 读不了 `.ttc`）、DejaVu Sans Mono 一类的等宽字体，找不到中文字体时用 next/og 自带的 Geist；图上画的每一段文字（名称、代码、说明、价格、空态文案、地址）都过 `ogText`：按字素切开，含 emoji 成分的整段去掉（国旗、ZWJ 组合、keycap、变体选择符），再去掉任何已加载字体的 cmap 里都没有的字（`src/lib/font-coverage.ts`），所以没有中文字体时中文也一起去掉。字体数组整个进程只建一次，satori 按引用缓存解析结果（第一次约 0.4s，之后十几毫秒）。
- **`robots.txt`**：只禁止 `/api/` 和 `/mcp`，指向 `sitemap.xml`。设置、复盘、使用情况不在 Disallow 里：它们靠页面上的 noindex 不被收录，而爬虫只有能抓取才读得到 noindex（被 Disallow 的地址反而可能只以链接的形式进索引）。首页有 canonical 指向公开地址的根路径。**`sitemap.xml`**：首页 + 根 vault 自选里每个标的的图表页（`lastModified` 是同步时间）。两个都 `force-dynamic`，地址和自选在请求时读。
- 这些元数据文件（图标、manifest、分享卡片、robots、sitemap）和 `sw.js` 不计入流量（proxy 的 matcher 排除，`pwa-icon/*.png` 和 `sw.js` 靠扩展名，§1.7）。

---

## 6. 接口

**Route Handlers（只读 JSON）**

- `GET /api/bars?key=&tf=D|W|M|Q&prices=split|total&with=k1,k2`
  → `{ symbol: {key, name, source, ticker, currency, exchange, bench, calendar: {hours, timezone, holidays, corrections}, syncedAt, syncError, quotedAt, session, lastDay}, pricePrecision, bars: [{timestamp, open, high, low, close, volume}], refs: { [key]: { c: (number|null)[], o?, h?, l?, v? } } }`，`refs` 与 `bars` 等长对齐。响应按 viewer 的 yaml 解析名字、基准和合成别名，`Cache-Control: no-store`，不做条件请求。
- `GET /api/status?key=&tf=&prices=&with=`（参数同 `/api/bars`）→ `{ syncedAt, syncError, quotedAt, session, tail: { bar, prev, refs: { [key]: {o,h,l,c,v} }, lastDay } | null, price }`：打开着的图表每轮报价后读它来更新最后一根 K 线和状态条（§5.2），只读缓存。`price` 是实际成交的最新价（`tradedPrice()`，不随 `prices` 变，合成标的为 null），「商品详情」拿它现算市值和市盈率（§2.8）。
- `GET /api/search?q=` → 外部结果 `SearchResult[]`（§5.4；本地层在浏览器里算）。
- `GET /api/help` → 反馈页签和通知设置抽屉要的登录状态与反馈设置（§5.8，只读本地）。
- `/api/github/login`（GET，跳到 GitHub 的授权页）、`/api/github/callback`（GET，GitHub 跳回来，建会话）、`/api/github/device`（POST 开始 device flow / DELETE 取消）、`/api/github/device/poll`（POST）、`/api/github/logout`（POST）、`/api/github/issues`（GET 最近反馈 / POST 提交）：§5.8，唯一会碰 GitHub 网络的接口（`login` 自己不联网，只是重定向），都是打开反馈页签或用户动作触发。
- `/api/github/claim`（POST 生成「在其他设备上登录」的一次性链接和二维码 / DELETE 作废）、`/api/github/claim/redeem`（POST，确认页的表单，建会话）：§5.8，不联网。

**Server Actions（写）**：`refresh()`、`addSymbol({ key, group, name?, bench?, alias? })`、`loadSymbol(key)`（只拉缓存，§2.3）、`removeSymbol(key)`、`moveSymbol(key, group, index?)`（index 不算被移动的那个，省略 = 末尾）、`moveGroup(name, index)`、`addGroup(name)`、`renameGroup(name, next)`、`deleteGroup(name)`（标的并入相邻组）、`renameSymbol(key, name)`、`setBench(key, bench | null)`、`saveNote(key, body)`、`saveJournal(week, body)`、`saveIndicator(def)` / `deleteIndicator(id)`、`saveAlert({ id?, key | null, cond, value? | when + tf?, trigger, label?, notify? })` / `deleteAlert(id)` / `setAlertEnabled(id, enabled)`、`saveChartState(key, state)`、`setChartPrefs(partial)`、`setPeriods(list)`、`setUpdown(mode)`、`setUsageLimits({ visitors, limited })`（owner，§1.7）、`translateProfile(key)`（把简介翻成中文并存进缓存，返回原文和译文 `{ source, text }`，§2.8）；`src/app/tv-actions.ts` 里的 `importTvList({ text, fallback, mode })`、`listTvLayouts({ sessionid, sign })`、`previewTvDrawings(来源)`、`importTvDrawings({ drawings, add })`（§5.5，`listTvLayouts` 和 `previewTvDrawings` 是仅有的带用户 TradingView cookie 访问外网的地方：`/my-charts/`；`/markets/`、`/chart-token`、charts-storage）。Server Action 在客户端是**串行派发**的，自动保存靠去抖合并，不并行发。

`saveAlert` 的入参还有 `check?`、`enabled?`，以及撤销删除时把草稿和来源放回去用的 `draft?`、`by?`；`confirmAlert(id)` 确认一条草稿（§2.5）。设置页的令牌在 `src/app/token-actions.ts`：`createAgentToken({ name, write })`（返回值里带一次明文）、`revokeAgentToken(id)`（§5.5）。

所有写入校验输入；文件路径只能落在 vault 内（fileKey 已保证无 `/`、`..`）；写入原子。

**操作层**（`src/lib/ops.ts`）：页面和 agent 都能做的写操作只有一份实现，入参是 viewer：`addSymbol`、`removeSymbol`、`saveAlert`、`deleteAlert`、`setAlertEnabled`、`confirmAlert`、`saveIndicator`、`deleteIndicator`，以及只给 agent 的 `appendNote`、`appendJournal`。对应的 Server Action 是薄壳（取 viewer、`requireWriter`、`revalidatePath`、包成 `ActionResult`），MCP 工具是另一层薄壳；校验和报错（中文，抛出）都在操作层，两边看到的一样。`saveAlert` 和 `setAlertEnabled` 多一个参数说明是谁在改（`page` / `agent`），§2.5 的草稿规则就在这里。只有页面用的操作（分组、排序、图表偏好、画线、整篇保存笔记和日志、TV 导入）留在 action 里。

**MCP 入口 `/mcp`**（`src/app/mcp/route.ts` → `src/lib/mcp/server.ts`，工具在 `src/lib/mcp/tools.ts`）：给 agent 用的唯一入口，也是唯一的非浏览器写入口。

- **协议**：MCP 的 Streamable HTTP，无状态。每个 POST 一条 JSON-RPC 消息，回 `application/json`（通知回 202）；不发 `Mcp-Session-Id`，没有 SSE，GET / DELETE 回 405。协议部分（`initialize`、`tools/list`、`tools/call`、`ping`、通知、版本协商）用官方 `@modelcontextprotocol/sdk` 的 `Server` 和 `WebStandardStreamableHTTPServerTransport`（直接吃 Web 标准的 `Request`、吐 `Response`，`sessionIdGenerator: undefined`、`enableJsonResponse: true`），每个请求新建一对、用完关掉。工具入参用 zod 定义，`tools/list` 里的 JSON Schema 由它生成，调用时先按它校验。
- **身份**：任何模式下都必须带 `Authorization: Bearer <令牌>`，单用户模式也一样（实例经隧道公开，页面可以让人随便看，写入口不行）。没带、无效或已吊销回 401（`WWW-Authenticate: Bearer`），在进协议之前。令牌解析成 viewer（§1.6），所有工具只读写 `viewer.dir`、只碰 `viewer.vault` 的 `stats` 和 `alert_state`。
- **只读令牌**调写工具：工具结果 `isError`，「这个令牌是只读的…」，在操作之前拒绝。`tools/list` 仍然列出全部工具，写工具的 `annotations.readOnlyHint` 为假。
- **出错**：参数不合 schema、只读令牌、操作层抛的错都作为工具结果返回（`isError: true`，正文就是那句话，操作层的中文原样），不抛成协议错误，agent 读得到。
- **读不联网**：和页面一样只读 vault、SQLite 和 `quotes` 表；`scan`、`test_formula`、`get_bars` 只算已缓存的标的，没同步过的报「没有缓存的日线」，不触发拉取。联网的只有 `search_symbols`（和 `/api/search` 共用 `src/lib/search-external.ts`）和 `add_symbol`（首次拉取兼校验，同页面）。
- 写工具成功后 `revalidatePath("/", "layout")`，和 Server Action 一样。
- `/mcp` 在流量统计里算 api（§1.7），`robots.txt` 禁止抓取。

工具（名字是英文 snake_case，描述是写给 agent 的英文，写明只有日线及以上周期、没有日内 K 线）：

| 工具 | 读 / 写 | 作用 |
|---|---|---|
| `overview` | 读 | 分组和每个标的：key、别名、名字、基准、最新价（有报价用报价，带时段）、1W…5Y 涨跌、距高点、52 周位置、在它上面成立或本周触发的警报、同步错误；上次和下次同步时间；待确认的草稿数 |
| `get_bars` | 读 | 一个标的某周期（D / W / M / Q）的 OHLCV，最新的 `limit` 根（默认 200，最多 1000），带今天未收盘的那根（`last_daily_bar.closed` 说明这根的交易日结束没有，和「日线收盘」警报同一个判断：`bars.ts` 的 `dayClosed`，合成标的看各操作数用到的那根） |
| `get_profile` | 读 | 一个标的是什么（§2.8）：缓存里的元数据（类型、交易所、币种、时区、时段）、存下的事实（简介、板块、行业、国家、员工、网站、股本、EPS、每股分红、下次财报日；基金的发行商、类别、费率、规模、前十大持仓、行业分布）、用实际成交的最新价现算的市值 / 市盈率 / 股息率（带 `price`；`prices: total` 下它和 `get_bars` 的收盘可以不一样）、已有的中文译文（`description_zh`）、相关链接（`links`：`{ name, url }`，现算的，不保证此刻还打得开）和资料的取得时间；合成标的返回它的操作数。只读缓存，没取过资料的返回缓存里有的 |
| `scan` | 读 | 一条公式（布尔或数值）× 一批标的（默认全部自选，可给 `group` 或 `keys`）：每个标的最后一根和上一根的值、是否成立（`holds`）、出错原因；`only_true` 只留成立的和出错的。成立与否和警报用同一个函数（`conditions.ts` 的 `holds`）：没有值（NaN）不算，其余非 0 为真，无穷大（除以 0）也是值、为真，返回里写成字符串 `"Infinity"` / `"-Infinity"`（JSON 放不了），没有值是 `null`。`check` 选带今日 K 线（`price`，默认）还是只看已收盘日线（`close`），和警报的判断时机对应 |
| `test_formula` | 读 | 一条公式在一个标的最近 N 根（默认 250，最多 3000）里：成立的根数、成立的区间、由假变真的次数和日期（规则同 §2.5 的判定：上一个已知值为假、这根为真；没有值的根不改状态，第一次见到只记录）。建警报前核对用 |
| `formula_reference` | 读 | 公式语法、变量和函数（从 `SERIES_VARS`、`FUNCTIONS` 生成，不手抄）、警报的字段和 `cond` 种类（从 `ALERT_CONDS` 生成）、agent 能做什么 |
| `search_symbols` | 读（联网） | 页面搜索的本地层 + 外部层合并后的结果：key、名字、交易所、是否已在自选、建议分组 |
| `list_alerts` | 读 | 全部警报：定义、`status`（`draft` / `active` / `triggered` / `stopped`）、`by`、上次判断时在哪些标的上成立（`holds_on`，事件类没有）、上次触发时间 |
| `read_note` | 读 | 一个标的的笔记；不给 key 列出有笔记的标的 |
| `read_journal` | 读 | 某一周的复盘日志；不给周列出本周的 id 和有日志的周 |
| `save_alert` | 写 | 新建或（给 `id`）整条替换一条警报；有 `key` 直接生效，没 `key` 存成草稿并在返回里写明要用户在页面确认（§2.5）；不是草稿的全部自选警报不能带 id 替换。`by: agent` |
| `delete_alert` | 写 | 删除（草稿也行） |
| `set_alert_enabled` | 写 | 停止任何警报；恢复只限盯一个标的的 |
| `add_symbol` | 写（联网） | 加自选，`group` 省略时按 `suggestGroup` 选现有分组 |
| `remove_symbol` | 写 | 移出自选（不在自选里报错） |
| `append_note` | 写 | 在笔记**末尾追加**一段（空行隔开） |
| `append_journal` | 写 | 在某周（默认本周）日志末尾追加；那一周还没有文件时从页面的模板起头 |
| `save_indicator` / `delete_indicator` | 写 | 公式指标，同页面（新建的自动在图表上打开） |

笔记和日志只给追加、不给整篇覆盖：页面有自动保存（§5.6），agent 发来一整篇会把正在输入的内容冲掉。反过来，页面开着且有未保存的输入时，它下一次保存仍会盖掉 agent 刚追加的那段；这个窗口只有去抖的一秒，不为它加版本号。

不经 MCP 暴露：分组的增删改排序、基准和改名、图表偏好、画线和对比、TV 导入、通知通道、使用情况设置、强制同步、确认草稿、令牌本身的管理、触发简介翻译（§2.8）。没有 OAuth（claude.ai 的连接器要用，之后做，发出的令牌同样交给 `tokenViewer()`）、没有另一套 REST 接口、没有 CLI。

---

## 7. Next.js 用法（这版 Next 与训练数据不同，写代码前读 `node_modules/next/dist/docs/01-app/`）

必读：`01-getting-started/06-fetching-data.md`、`08-caching.md`、`09-revalidating.md`、`15-route-handlers.md`、`02-guides/server-actions.md`、`02-guides/instrumentation.md`、`03-api-reference/03-file-conventions/02-route-segment-config/`。

- 页面是 RSC，直接读 vault 与 SQLite，**必须是动态渲染**（按文档用 route segment config 或 `connection()`），否则 build 时会被静态预渲染成空页面。
- `params` / `searchParams` 是 Promise（v1 已经 `await searchParams`）。
- 交互部分（表格排序、图表、编辑器）是 client component；数据通过 props 从 RSC 下发，除了图表用 `/api/bars`。
- `next.config.ts` 的 `serverExternalPackages` 保留 `better-sqlite3`、`yahoo-finance2`、`@mathieuc/tradingview`。
- 涨跌色在 SSR 时从 yaml 读出写到 `<html data-updown>`，不再需要 head 里的 localStorage 脚本；localStorage 整体不再使用。

**KLineChart v10 已确认的 API**：`init(el, { locale, timezone: "UTC" })`、`setDataLoader`、`setSymbol`、`setPeriod`、`setStyles`、`overrideYAxis({ paneId, name: "normal" | "percentage" | "logarithm" })`、`createIndicator(create, isStack)`（pane 通过 `create.paneId`）、`overrideIndicator`、`removeIndicator`、`registerIndicator`、`createOverlay` / `getOverlays` / `removeOverlay` / `overrideOverlay`、`subscribeAction(type, cb)`（`onVisibleRangeChange`、`onCrosshairChange`、`onIndicatorTooltipFeatureClick` 等）、`getVisibleRange()`、`getConvertPictureUrl(includeOverlay, "png", backgroundColor)`（拍快照，按设备像素比的 data URL）。

---

## 8. 实施顺序与验收

每个阶段结束：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build` 全过，提交一次（conventional commit）。

**阶段 1 · 地基**（做完功能与 v1 持平，v1 的 8 个设计问题消失）
schema v2 + 迁移；`adj` 因子与 `prices` 模式；适配器 meta；应用内调度器；同步后计算 stats；vault（yaml/notes/journal/charts 的读写层 + `vault.example`）；RSC 总览分组表格（排序、徽标位先留空）；图表页迁移到 yaml 偏好；`/api/bars` v2；添加/移除标的；README 重写。
验收：`rm -rf data vault && npm run dev` 后首页能从 `vault.example` 起步、自动拉取、显示表格；图表页周/月/季线、对数、四种样式、内置与代码指标正常；`vault/hebi8.yaml` 注释在 UI 改动后仍保留。

**阶段 2 · 公式与对比**
公式引擎 v2（布尔、引用、新函数、`refs`）；合成标的；条件计算与徽标、本周变化；对比（percent / pane、图例、调色板）；公式指标编辑写回 yaml。
验收：`=BTC/GOLD` 能开图并有 stats；NVDA 对比 QQQ、SPY 在 percent 模式下滚动时从左边缘重新归零；US10Y 以 pane 模式叠在 SPY 上；条件徽标与「本周新触发」在总览上出现。

**阶段 3 · 复盘**
笔记侧栏；journal 与 `/review`；「上次复盘」；画线工具与持久化。
验收：周线上画的水平线切到日线还在，刷新后还在；`/review` 能写本周、看上周、列出本周变化。

**阶段 4 · 顺手**（可选）
搜索添加；`vault:check` 校验命令；宏观面板（FRED / ETF 流入）留空位不做。

**测试**：保留 v1 的 time/series/stats/formula 测试并按新接口调整；新增：公式 v2（布尔、引用、字符串）、合成表达式逐字段计算、季线合成、前向填充对齐、stats 的 `prev/now`、vault 解析与写回（注释保留、fileKey）、调度器下一时刻计算（含跨日与夏令时）。

---

## 9. 不做的事

页面的访问控制、限流和封禁（实例经隧道公开，GitHub 登录只用来区分共用实例的人和提交反馈，不防恶意访问者；流量只监控，§1.6、§1.7；`/mcp` 例外，没有令牌进不来）；vault 之间的共享和协作编辑；日内 K 线（盘中只取最新价判断警报，§2.6，不存也不画日内 K 线）；比 5 分钟更快的价格警报（WebSocket、逐笔）；入站 webhook（入站的写接口只有带个人令牌的 `/mcp`，§6；没有别的 REST 写接口，也不接收别人推来的事件）；agent 替人确认对全部自选的警报（§2.5）；数据集爬虫（hebi8 只读仓库）；Pine Script 兼容；多个自选列表（TV 的「列表」切换）：现在只有一个列表 + 分组，一个标的只在一个组里，bench、名字都挂在条目上；要做多列表得先把每个标的的字段和「在哪些列表」分开，等确实需要再说；标的资料只在图表页的面板里（§2.8）：没有独立的详情页路由，不做财务报表、新闻、分析师评级，总览上没有「本周财报」徽标（财报日只存下来显示在面板里），简介不自动翻译、只翻成简体中文。
