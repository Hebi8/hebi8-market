# 维护者说明

给改这个仓库的人看：文档放哪、反馈用的 GitHub App、issue 的标签、源码结构和验证命令。数据模型和各模块的设计见 [design.md](design.md)，给 agent 的约定见 [`AGENTS.md`](../AGENTS.md)。

## 文档放哪

| 文件 | 写什么 |
|---|---|
| [`README.md`](../README.md) | 给第一次来的人：一句话介绍、核心功能各一两句、快速开始、数据源概览、文档索引。不写操作细节 |
| [`docs/usage.md`](usage.md) | 每项功能的完整操作、快捷键、公式、警报和通知、代码指标、MCP 接入 |
| [`docs/self-hosting.md`](self-hosting.md) | 生产运行、`deploy.sh`、环境变量、vault、实例状态、多人共用、网页登录 |
| `docs/maintainers.md`（本文） | 文档约定、GitHub App、反馈标签、源码结构、验证 |
| [`docs/design.md`](design.md) | 设计：数据模型、同步、接口、页面行为的规格 |

新功能或改了行为时，操作说明写进 `usage.md`（运维相关写进 `self-hosting.md`），规格写进 `design.md`；README 只在功能列表需要多一行、或快速开始变了时才改。

## 反馈用的 GitHub App

应用内反馈和登录（见 [usage.md](usage.md#帮助与反馈)）用的是公开 GitHub App「hebi8-market」，代码里只有 client id。**仓库 owner 要做的一次性设置**（详见 [`design.md`](design.md) §5.8）：在 Hebi8 组织下注册公开的 GitHub App（[预填好的注册链接](https://github.com/organizations/Hebi8/settings/apps/new?name=hebi8-market&description=hebi8%20market%20%E7%9A%84%E5%BA%94%E7%94%A8%E5%86%85%E5%8F%8D%E9%A6%88%EF%BC%9A%E7%94%A8%E4%BD%A0%E8%87%AA%E5%B7%B1%E7%9A%84%20GitHub%20%E8%B4%A6%E5%8F%B7%E5%9C%A8%20Hebi8%2Fhebi8-market%20%E4%B8%8A%E6%8F%90%E4%BA%A4%20issue&url=https%3A%2F%2Fgithub.com%2FHebi8%2Fhebi8-market&public=true&webhook_active=false&issues=write)），在 App 设置里勾选 **Enable Device Flow**，只安装到 hebi8-market，把 client id 填进 `app-info.ts` 的 `GITHUB_APP_CLIENT_ID`。

fork 想把反馈收到自己的仓库：建自己的 App，设环境变量 `HEBI8_GITHUB_CLIENT_ID` 和 `HEBI8_FEEDBACK_REPO`（见 [self-hosting.md](self-hosting.md#环境变量)）。网页登录要的 client secret 见 [self-hosting.md](self-hosting.md#网页登录可选)。

## 反馈 issue 的标签

标签不由应用加（非协作者开 issue 时 GitHub 会丢掉标签），而是仓库里的 Actions 工作流 `.github/workflows/app-feedback.yml` 读 issue 正文里的 `hebi8-context` 块：加 `from-app` 和类型标签；勾了「可以自动修复」的，作者是仓库 owner / 组织成员 / 协作者才加 `auto-fix-ok`，其他人加 `auto-fix-requested`。

所有新 issue 还会由 `.github/workflows/issue-triage.yml` 分诊（模型走 OpenAI 兼容接口，项目背景在 `.github/triage-context.md`）：打一个类型、`area:*`，以及 `triage:simple` 或 `triage:judgment`。

## 源码结构

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
