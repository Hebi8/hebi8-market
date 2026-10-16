# 使用说明

hebi8/market 各项功能的完整操作说明。项目概览和快速开始见 [README](../README.md)，部署、vault 和多人共用见 [self-hosting.md](self-hosting.md)。

- [搜索](#搜索)
- [总览](#总览)
- [图表](#图表)：对比、画线、测量、拍快照
- [合成标的](#合成标的)
- [笔记与复盘](#笔记与复盘)
- [从 TradingView 搬家](#从-tradingview-搬家)
- [商品详情](#商品详情)
- [数据源与自定义数据集](#数据源与自定义数据集)
- [警报与通知](#警报与通知)
- [公式](#公式)
- [代码指标](#代码指标)
- [让 agent 接入（MCP）](#让-agent-接入mcp)
- [帮助与反馈](#帮助与反馈)
- [分享卡片](#分享卡片)
- [快捷键](#快捷键)

## 搜索

页头搜索框，或在任何页面按 `/`、`Ctrl/Cmd+K`；图表页直接敲字母就开始搜。本地即时匹配自选、别名和一本约 65 条的内置字典（中文名、拼音、首字母：「腾讯」「tx」「maotai」都行），外部再查 Yahoo / TradingView / Binance。

和 TradingView 一样，Enter 只是打开图表，不改自选（不在自选的标的，图表页会先拉一次日线进缓存）；加入自选是结果行上的「+」或 Shift+Enter，按推断的分组加入，Tab 换组，toast 可撤销。总览「+ 添加」和图表右侧自选面板的「+」打开的是添加模式，Enter 就是加入。

## 总览

按 `hebi8.yaml` 里的分组列一张表，显示最新价、所选周期的涨跌、距高点（距历史高点的回撤，下面的短条是 52 周区间位置）、自己建的警报和近两年的周线迷你图；表头悬停有说明。

- 表头点击对所有分组排序（降序 → 升序 → 默认）；整行可点，行尾「⋯」或右键：移到分组、改名、设基准、添加警报、移除（可撤销）。
- 分组可以折叠（记在浏览器里）、重命名、删除（标的并入上一组）、新建；标的和分组都能拖动排序（触屏用行首手柄，键盘聚焦手柄后 ↑ ↓），顺序写回 `hebi8.yaml`。图表右侧的自选面板也一样。
- 「警报」列用你起的名字显示这个标的上的警报：本周新触发的淡高亮带圆点，已触发或成立中的实线，未触发的灰色，已停止的虚线变淡；悬停看定义，点击编辑或删除，表头的「?」是图例。

## 图表

基于 [KLineChart](https://github.com/klinecharts/KLineChart)，布局和快捷键照搬 TradingView：顶栏是商品搜索、`+` 比较商品、`日 3日 周 月 季`、图表类型、`fx 指标`、刷新、全屏；左边画线工具栏；图内左上角图例（OHLC、各指标和对比的数值，悬停出现隐藏 / 设置 / 移除）；右边自选列表和笔记；底栏是 `1年 3年 5年 10年 全部` 范围按钮和 `ADJ`（含分红）、`%`、`log`、`自动`。内置指标、代码指标和公式指标都在「指标」弹窗里开关，参数在图例的设置里改，按周期保存。设置的「样式」页给指标画的每条线单独选颜色、线宽和线型（指标有几条线就有几行），所有周期通用，存在 `hebi8.yaml` 的 `chart.styles`；公式指标在公式编辑器上方切到「样式」。

「3日」是 TradingView 的 3D：每 3 个交易日一根，从一个固定的日子起数（周末也交易的加密货币按日历日每 3 天一根），所以新的一天不会让以前的 K 线重新分组，比较的商品也按同样的日子分组；遇到节假日那一根少一天。警报和公式的周期也能选 3 日。

### 对比

把别的标的叠在主图上，用同百分比坐标——滚动、缩放时所有线从可见区间左边缘重新归零，和 TradingView 一致；单位不同的（比如美债收益率）放独立副图。

### 画线

左边画线栏照 TradingView 分六组（趋势线、江恩和斐波那契、形态、预测和测量、几何形状、标注），每组一个按钮，点开选具体工具，记住上次用的；共 50 多种，只画在主图上。

- 选中一条绘图出现浮动工具条：颜色、线宽、线型（文字类还有字号和内容）、设置、锁定、隐藏、删除，水平线还有添加警报；文字可以选中、拖动、双击改。
- 斐波那契回撤和基于趋势的扩展照 TradingView 画：每档一种颜色、档位之间有背景带，设置里可以关背景、调透明度、向左 / 向右延长、改成单一颜色、把档位反向（从低点画到高点的回撤，勾上后 1 以上的扩展档在上方）。
- 磁铁模式、锁定 / 隐藏 / 删除所有绘图。按时间戳保存，周线上画的线切到日线还在。`Delete` 删除选中，`Esc` 退出绘制。

### 测量

在主图上按住 `Shift` 点一下（或点左边的尺子按钮再点主图），移动鼠标看涨跌幅、跨过多少根 K 线和多少天、区间成交量；再点一下固定，之后点击或 `Esc` 消失。不保存。

### 拍快照

图表顶栏的相机按钮，照 TradingView：下载图片（`Ctrl/Cmd+Alt+S`）、复制图片（浏览器只在 HTTPS 页面允许，所以要从公网地址打开）、复制链接（`Alt+S`）、在 X 上分享（X 只能带链接和一行字），手机上还有系统分享。图片是当前看到的图表（画线、指标、对比都在），顶部一条信息栏写商品、周期、最后一根 K 线的开高低收和涨跌，底部是 hebi8/market 标识和这张图的公开地址；跟随明暗主题和涨跌配色。页面上的图表没有水印。

## 合成标的

在搜索框里直接输 `AAPL/MSFT`、`BTCUSDT/GOLD`、`2*(SPY-QQQ)` 这样的表达式，当作标的看图、对比、加自选、算统计、设警报，逐字段计算，和 TradingView 的 spread 一样。

合成标的的表达式比[公式](#公式)简单：支持 `+ - * / ^`、数字和括号，逐字段（开高低收）计算，交易日取第一个操作数的。

- 在搜索框里输入时，含运算符就当表达式（以 `=` 开头也行）：`AAPL/MSFT`、`^GSPC/^DJI`、`2*(SPY-QQQ)`、`NASDAQ:AAPL/TVC:GOLD`。只有不带空格的 `-` 时还是一个代码（`BRK-B`），做减法要加空格（`SPY - QQQ`）。
- 光标所在的操作数照常出搜索建议，选一个就把它换成那个标的；其余操作数按固定规则解析，不看自选：别名或完整 key → 内置字典的代码和名字（`GOLD`、`BTC`、`SPX`、`黄金`）→ `…USDT` 在 Binance → 外部搜索里代码完全一样的那条（`PLTR`）；都没有就要从建议里选。中文名这类要搜的词得从建议里选。
- 选中后表达式存成操作数都是完整 key 的形式，比如 `=yahoo:AAPL/yahoo:MSFT`，图上显示 `AAPL/MSFT`。代码里有 `-` 或 `/` 的 key 要加引号：`="yahoo:BRK-B"/yahoo:SPY`。yaml 里手写时也可以用别名：`=BTC/GOLD`。

## 笔记与复盘

每个标的一篇 markdown 笔记（thesis）；每周一篇复盘日志。都是自动保存：停止输入 1 秒后写盘，`Ctrl/Cmd+S` 立即保存，浏览器里留一份草稿兜底。复盘页列出本周触发的警报和有笔记的标的。

## 从 TradingView 搬家

页头「设置」。

- **自选列表**：把 TradingView「导出列表…」得到的 .txt 传上来或贴进来，预览后合并进现有分组或整个替换（已经在自选里的标的不会重复）；也能把自选导出成 TradingView「导入列表…」认的 .txt。
- **画线**：填 `sessionid` / `sessionid_sign` 两个 cookie，「获取布局」列出账号下的布局，选一个由服务器去取（别人分享的布局手填链接；cookie 只用于这两次请求，不保存），或者从浏览器开发者工具里复制 `sources` 接口的响应贴进来；按标的追加到各自图表，重复导入不会多出来。映射规则和支持的画线类型见 [`design.md`](design.md) §5.5。

## 商品详情

图表页右侧的「商品详情」面板说明这个标的是什么：股票有简介、板块、行业、国家、员工、网站、市值、市盈率、每股收益、股息收益率、下一次财报；ETF 和基金有简介、发行商、类别、费率、规模、前十大持仓、行业分布；指数、外汇、商品、加密货币、债券没有这些资料，显示类型、交易所、币种、时区、交易时段。数据源没有的字段不显示。

- **相关链接**：每个标的至少一条去处。公司有官网和披露页（美股是 SEC EDGAR，港股是港交所，A 股是上交所 / 深交所）；ETF 和基金有发行商的页面（Vanguard、Invesco、Schwab 等能直达产品页，其余是发行商官网）；美债、汇率、商品、指数、比特币这类没有公司的，配了官方或公开的资料页（美国财政部和 FRED、各国央行、世界黄金协会、EIA、指数公司等）；最后一条总是数据源自己的行情页（自定义数据集的序列除外：它的链接只有清单里写的，见[自定义数据集](#自定义数据集)）。链接由代码和类型现算，不联网；规则和那张表在 `src/lib/links.ts`，里面的地址都实际打开核对过，没覆盖到的标的只有行情页那一条。
- 资料来自标的自己的数据源（`yahoo` 和 `tv` 有，`binance` 没有，`data` 是清单里写的 `description` 和 `links`），存在缓存里，每周在定时同步之后刷新一次，标的第一次拉日线时也取一次；面板底部写着更新日期。打开页面不联网。
- 市值、市盈率、股息收益率不存，用实际成交的最新价现算（有当前报价用报价，否则最后一根日线收盘），不受 `ADJ`（含分红）影响。下一次财报按交易所当地的日期显示，当天过完就不再显示。
- **翻译**：简介是数据源的原文，多半是英文。想要「翻译」按钮，在 `HEBI8_SECRETS` 目录（默认 `~/.config/hebi8/market`，见 [self-hosting.md](self-hosting.md#环境变量)）里写 `llm.json`，`chmod 600`，填任何一个 OpenAI 兼容的 chat completions 接口：

  ```json
  { "base": "https://api.openai.com/v1", "key": "sk-...", "model": "gpt-4o-mini" }
  ```

  点了才翻译，译文存在缓存里，之后所有人打开都直接看到，可以切回原文；每周刷新后原文变了，按钮会重新出现。共用实例上只有登录的人能点，访客只能看已有的译文。没有这个文件就没有按钮。翻译失败时页面只说「稍后再试」，状态码和接口返回的内容在服务器日志里（`[hebi8m] translate:`）。

## 数据源与自定义数据集

四种数据源的概览见 [README](../README.md#数据源)。`yahoo` 必须经 yahoo-finance2 拉取：直接请求 Yahoo 接口会返回 429。`tv` 是逆向的非官方接口，TradingView 改动协议后可能失效。各数据源的日线时间戳不同：美股记在开盘时刻，亚洲市场记在 01:30 UTC，外汇和 TVC 品种记在前一晚开盘时刻。入库前统一按交易所时区换算成交易日。

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
  - { id: 4090-xianyu, name: RTX 4090 咸鱼, currency: CNY, file: series/4090-xianyu.csv }
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
- **详情和链接由数据集自己写**。图表页「商品详情」里一条序列的简介和「相关链接」只显示清单给的，没给就没有，hebi8 不替它配：

  ```yaml
  name: 显卡二手与零售价
  description: 每天从闲鱼和京东抓取的显卡价格      # 可省：没有自己 description 的序列用它
  links:                                        # 可省：对所有序列都适用的链接，排在序列自己的后面
    - { name: 数据出处, url: https://github.com/you/gpu-prices }
  series:
    - id: 4090-xianyu
      name: RTX 4090 咸鱼
      file: series/4090-xianyu.csv
      description: 闲鱼上 RTX 4090 的每日中位成交价
      links:
        - { name: 闲鱼搜索页, url: "https://www.goofish.com/search?q=4090" }
  ```

  `url` 只认 `http://` 和 `https://`，别的直接忽略；`name` 没写就显示域名。清单改了以后，下一次同步（或点「刷新」）就生效，不用等每周的资料刷新。

## 警报与通知

只有一个概念：**警报**，都推一条摘要（`notify: false` 的只在总览显示）。没有系统预置的，都是自己建、自己起名。

### 在界面上建警报

照搬 TradingView。顶栏「警报」或 `Alt+A`、主图右键「在 X 添加警报」、选中水平线后浮动工具条上的闹钟，总览的行菜单「添加警报…」，都打开同一个对话框：商品（这个标的或「全部自选」）、条件（穿过、上穿、下穿、大于、小于、进入 / 离开通道、在通道内 / 外、上涨 / 下跌 %，或自定义公式和它的周期）、触发（仅一次 / 每根 K 线一次）、名称、是否推送。图上画警报虚线，价格轴上的闹钟标签点了就是编辑；右侧栏「警报」列出全部警报，当前标的的排在最前，其他的在「其他商品」下面；可编辑、暂停、删除。

不指定标的的警报（公式或涨跌 %）是**对全部自选的警报**：每次同步后对每个自选标的判断，在成立的标的上显示，新成立时推一条摘要到 Telegram 或 webhook（ntfy、Discord 等）；关掉推送就只是总览上的筛选标记。

### 什么时候判断

- **一个标的的警报**：照搬 TradingView 的警报。自选里的标的（和警报用到的标的）都会定时取最新价（加密和正在交易的市场每 5 分钟，盘前盘后和休市每小时），把它当作今天还没收完的日线来判断；这根 K 线只在内存里，库里只有日线。日线同步收尾时也判断一遍。
- **判断时机**（对话框里的「盘中价格 / 日线收盘」，yaml 里的 `check: price | close`）：盘中价格就是上面这种，每次取到最新价都判断；日线收盘只在日线同步后判断，而且只看已经收盘的日线（当天还没走完的那根不算）。一个标的的警报默认盘中价格，对全部自选的默认日线收盘，都可以改成另一种。
- **对全部自选的警报**（不写 `key`）：每次定时同步或点「刷新」之后对每个自选标的检查，在界面上新建或改过时立刻按日线算一遍。公式**从不成立变成成立**的那一刻推送；规则第一次出现（新加的规则、新加的标的、删过缓存库）只记下当前状态；同一根 K 线只推一次，周线公式在本周内来回真假也只响一次。只能用公式或涨跌 %。

### 在 yaml 里写

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

### 通知通道

通道写在 `~/.config/hebi8/market/notify.json`（不在 vault 里，权限设成 600），两种可以同时开：

```json
{
  "telegram": { "token": "123456:ABC...", "chat": "123456789" },
  "webhook": "https://ntfy.sh/your-secret-topic",
  "link": "http://100.92.194.31:8808"
}
```

- `telegram`：找 @BotFather 建一个 hebi8/market 专用的 bot（用户名比如 `hebi8m_xxx_bot`）拿 token，给 bot 发一句话后从 `https://api.telegram.org/bot<token>/getUpdates` 里读 `chat.id`。用自建 Bot API 服务时加 `"api": "http://..."`；也可以给几个地址，比如 `"api": ["http://100.92.194.31:18081", "https://api.telegram.org"]`（不写就是 `https://api.telegram.org`）。几个地址时 hebi8 每 5 分钟对每个地址调一次 `getMe`（3 秒超时）测速，发消息先走能用且最快的那个（还没测过时按写的顺序）。一个地址明确没收到（域名解析失败，或者连接根本没建立：被拒、不可达、连接超时）就换下一个再发，到下次测速前它排到最后；请求可能已经发出去时（等回应超时、连上后断开或超时、回应没收完、回 5xx：网关超时回 504 时后面的服务器可能已经发了）不换地址重发，免得收到两条，这次 Telegram 算发送失败，这个地址同样排到最后；Telegram 自己回的错（chat 不存在、bot 被拉黑等 4xx）换地址也一样，原样报出来。
- **共用实例的 owner 也可以在页面上设置 bot**：页头菜单「通知设置」里的「实例的 Telegram bot」，粘贴 token 后先用 `getMe` 校验，通过才写进 `notify.json`（只改 `telegram` 段，其他字段原样保留），之后只显示 `@bot 用户名`，不再显示 token；「移除」删掉整个 `telegram` 段。单用户模式没有登录，也就没有这个页面，bot 和通道都直接写 `notify.json`。
- `webhook`：字符串，或 `{ "url": ..., "format": "json" }`。默认 `text` 把摘要当正文 POST，带 `Title: hebi8` 头，ntfy 直接能用；`json` 发 `{ title, text, events }`。
- `link`：可选，有的话每条后面带图表页链接。

配好后用这条命令往每个通道发一条测试消息：

```bash
npm run notify:test
```

**[共用实例](self-hosting.md#共用一台实例)**：`notify.json` 是实例的设置——bot 的 `token`、`api` 和 `link`；其中的 `chat` 和 `webhook` 是 owner（根 vault）的通道，可以不写。其他人登录后在页头菜单的「通知设置」里设置自己的通道，存在 `~/.config/hebi8/market/notify-users.json`（页面写入，权限 600，不用手改）：

- **绑定 Telegram**：点「绑定 Telegram」，打开链接在 Telegram 里点 Start，几秒后自动绑好，bot 会回一句「已绑定 hebi8：<login>」。链接里的一次性码 10 分钟有效。owner 也可以这样绑定，会替代 `notify.json` 里的 `chat`。
- **webhook**：填地址和格式（text / json）保存，同样替代 `notify.json` 里的 `webhook`。
- **推送**：勾上「在此设备上接收推送」，这台手机或浏览器就会收到系统通知，点开是对应的图表；每台设备各开一次，下面列着开过的设备，可以移除。只能在 HTTPS 地址上开（局域网、Tailscale 的 http 不行）；iPhone / iPad 要先在 Safari 里「分享 → 添加到主屏幕」，从主屏幕打开再开（iOS 16.4 及以上）。
- 「发测试消息」往自己的每个通道发一条，「解除绑定」「删除」去掉页面上设置的通道。
- 绑定时 hebi8 用 `getUpdates` 读 bot 收到的消息（只在有待绑定的码时，只往外连）；`api` 有几个地址时每个都读，因为 bot 同时用着云端和自建服务时 Telegram 不保证收到全部消息（都读也不能保证收齐，没读到时重新点一次绑定）。等待绑定时改了 `notify.json`，下一轮轮询就跟上：新加的地址开始读，去掉的地址不再读，换了 token 则已发出的绑定链接作废（文件一时读不出来不算，等它恢复）。所以这个 bot 要给 hebi8 专用：同一个 token 被别的程序 `getUpdates` 时两边会抢消息。

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

窗口 `n` 按当前周期计数：周线上 `sma(close, 40)` 就是 40 周均线。合成标的的表达式见[合成标的](#合成标的)。

## 代码指标

公式写不出来的逻辑，可以写成代码：

1. 在 `src/indicators/calc.ts` 写纯计算函数（方便测试）。
2. 在 `src/indicators/custom.ts` 写一个 KLineChart 的 `IndicatorTemplate`，并加进 `customIndicators`。
3. 在 `src/indicators/catalog.ts` 的 `INDICATORS` 里登记：名称、主图或副图、各周期的默认参数。指标栏会自动出现对应的开关和参数编辑。

KLineChart 内置的 MA、EMA、BOLL、VOL、MACD、RSI、KDJ、SAR、OBV 等指标也可以直接登记进 `INDICATORS`。需要基准的指标（比如相对强弱）读每根 K 线上的 `bench` 字段，由 `/api/bars` 按交易日对齐并前向填充。

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

## 帮助与反馈

页头最右的「?」（或按 `?`）打开帮助抽屉。「使用」页签有三步引导的入口、快捷键表、项目文档（本仓库）和隐私说明的链接；「反馈」页签把问题直接提交成 GitHub issue，自动附带当前页面、图表状态和最近的前端错误。界面上只放用的时候要看的东西，项目介绍、配置和运维写在 [README](../README.md) 和 `docs/` 下的文档里。

`?` → 反馈：填好标题和描述，点「用 GitHub 登录」，抽屉里会显示一串代码，到 github.com/login/device 输入并授权，回来就能提交——issue 以**你自己的** GitHub 账号开在 `Hebi8/hebi8-market` 上。登录用的是公开 GitHub App「hebi8-market」的 device flow，只需要写在 `src/lib/app-info.ts` 里的 client id，任何人自己部署的 hebi8 都能用，不用配置任何密钥；登录会话存在服务器的 `~/.config/hebi8/market/sessions.json`（`HEBI8_SECRETS` 可改，权限 600）。实例配了[网页登录](self-hosting.md#网页登录可选)的入口上，「用 GitHub 登录」是跳到 GitHub 再回来，不用输代码。不想登录、或者 App 还没配置（「反馈未启用」）时，「在 GitHub 网页上提交」会在 github.com 打开预填好同样内容的新 issue。

issue 的标签由仓库里的工作流加，见 [maintainers.md](maintainers.md#反馈-issue-的标签)。

页头的「更新」打开更新记录，列着每个版本带来了什么；有新的功能版本时它右上角亮一个小点，打开看过就消失（只为功能版本亮，修复不亮；记在浏览器里）。设置页底部写着当前版本。

## 分享卡片

链接贴到 X、Telegram 等处会展开成卡片：图表页是名称、最新收盘、近半年日线走势和 hebi8/market 标识，其他页面是站点卡片。卡片只读根 vault 和公共的 K 线缓存（抓取的一方没有登录），不会带出任何人的画线、笔记和自选。设置、复盘、使用情况页面标了 noindex，`robots.txt` 只挡接口，`sitemap.xml` 列出首页和根 vault 自选里的图表页。

## 快捷键

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
