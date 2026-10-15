# hebi8 market: context for issue triage

hebi8 market is a small self-hosted web app for a weekly market review, used by one person and a
few friends. Scan the watchlist for what changed this week, look closer at a few charts, then write
the week's notes. The chart page copies TradingView's layout and hotkeys. It runs as one Next.js
app with SQLite as a cache and a "vault" of YAML and markdown files as the user's content. Issues
are mostly written in Chinese by the maintainer.

## Types (pick one)
- bug: something is broken or wrong.
- ux: works, but is confusing or awkward to use.
- data: prices, sync, statistics or formula results look off.
- idea: a new feature or a change in behaviour.
- question: asks how something works; no change requested.
- documentation: README or docs only.

## Areas (pick one or two)
- chart: chart page (`/chart`), candles and timeframes, drawing tools and their toolbar, indicators, compare, price axis, legend.
- overview: overview page (`/`), watchlist table, groups, drag sorting, search, column hints, the guide panel.
- alerts: alerts (per symbol or the whole watchlist), the alert dialog, badges, Telegram / webhook notifications.
- review: per-symbol notes and the weekly review page (`/review`).
- data: data sources (Yahoo, TradingView, Binance, CSV datasets), sync schedule, statistics, the formula language.
- account: GitHub login, the shared instance and per-user vaults, in-app feedback, the owner's usage page.
- docs: README and docs/ (usage.md, self-hosting.md, maintainers.md, design.md).

## Difficulty
- simple: the expected behaviour is clear from the issue; the fix is small and local (about three
  files or fewer); it can be checked with a test or by looking at the page. Typical: a wrong label
  or text, a control that does nothing, a layout glitch, an off-by-one, a missing tooltip.
- judgment: anything else. Always judgment when the issue is vague or has several reasonable
  readings, asks for a new feature or a design change, or touches the data model, the YAML layout,
  migrations, login, notifications, dependencies, deployment or GitHub workflows.
- duplicateOf: the number of an open issue that asks for the same thing, otherwise null.
