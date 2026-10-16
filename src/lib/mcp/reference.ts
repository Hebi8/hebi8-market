/**
 * What `formula_reference` returns: the formula language and the alert fields, for an agent that
 * is about to write one. The variables and functions are listed from the engine's own tables, so
 * this cannot drift from what `compile` accepts; their descriptions are the ones the formula
 * editor shows (Chinese).
 */
import { FUNCTIONS, SERIES_VARS } from "@/indicators/formula";
import { FORMULA_EXAMPLES } from "@/indicators/formula-indicators";
import { ALERT_CONDS, type AlertCond } from "../alert-conds";
import { TIMEFRAMES, TF_LABELS } from "../symbols";

const VALUE_SHAPES: Record<(typeof ALERT_CONDS)[AlertCond]["value"], string> = {
  price: "a number (price level)",
  channel: "[low, high]",
  move: "{ pct, bars }: moved at least pct % within the last `bars` daily bars",
};

export function formulaReference(): string {
  const vars = Object.entries(SERIES_VARS).map(([name, desc]) => `- \`${name}\`: ${desc}`);
  const fns = Object.values(FUNCTIONS).map(({ hint }) => {
    // 「sma(x, n) 简单均线」: the signature, then what it does
    const end = hint.indexOf(")") + 1;
    const what = hint.slice(end).trim();
    return `- \`${hint.slice(0, end)}\`${what ? `: ${what}` : ""}`;
  });
  const conds = (Object.keys(ALERT_CONDS) as AlertCond[]).map((c) => `- \`${c}\` (${ALERT_CONDS[c].label}, ${ALERT_CONDS[c].kind}): value is ${VALUE_SHAPES[ALERT_CONDS[c].value]}`);
  const examples = FORMULA_EXAMPLES.map((e) => `- ${e.label}: \`${e.formula.replace(/\n/g, "; ")}\``);
  return `# Formulas

A formula is evaluated over a whole series of bars of one symbol on one timeframe: ${TIMEFRAMES.map((tf) => `${tf} (${TF_LABELS[tf]}线)`).join(", ")}. Daily bars are the smallest unit; there are no intraday bars. 3D, W, M and Q are aggregated from daily bars, and their last bar is the period so far. Weeks start on Monday. 3D counts weekdays in threes from Monday 1970-01-05 (calendar days for a symbol that trades on weekends, such as crypto), so its bars never shift as days come in and symbols counted alike share them; a holiday leaves its bar a day short, and \`close(X)\` on 3D counts days the way the formula's own symbol does.

## Syntax

- Arithmetic \`+ - * / ^\`, parentheses, numbers.
- Comparisons \`> < >= <= == !=\` and \`and\`, \`or\`, \`not\` give 0/1 series. Precedence: \`not\` > comparison > \`and\` > \`or\`, all below arithmetic.
- Statements are separated by \`;\` or newlines; \`name = expr\` names a line so later statements can use it; \`#\` starts a comment. A chart indicator plots every statement; a scan, a test and an alert use the last one.
- Another symbol: \`close(QQQ)\`, \`high("yahoo:BRK-B")\`. The argument is an alias from the user's yaml or a quoted full key; \`open\`, \`high\`, \`low\`, \`close\` and \`volume\` all take one. The other symbol is aligned to this symbol's trading days and forward filled.
- \`bench\` (same as \`close(bench)\`) is the benchmark configured for the symbol being evaluated; a symbol without one makes the formula an error on that symbol.
- Where there are not enough bars yet (the first 199 bars of \`sma(close, 200)\`) the formula has no value.

## Series variables

${vars.join("\n")}

## Functions

Window arguments (\`n\`) are positive integer constants.

${fns.join("\n")}

## Examples

${examples.join("\n")}
- 跌破 200 日线: \`close < sma(close, 200)\`
- 放量上穿 50 日线: \`cross(close, sma(close, 50)) and volume > 2 * sma(volume, 20)\`
- 相对基准 20 日走强: \`roc(close, 20) > roc(bench, 20)\`

# Alerts

An alert is one entry of \`alerts\` in the user's yaml: either a formula (\`when\`) or a TradingView-style condition (\`cond\` + \`value\`), never both.

| field | meaning |
|---|---|
| \`key\` | The symbol (alias or full key, synthetic ones too). Without it the alert covers every watched symbol, each judged on its own with its own \`bench\`. |
| \`when\` | A boolean formula. It fires when it turns true (false on the previous check, true now), at most once per bar of its timeframe. |
| \`tf\` | Timeframe of \`when\`: D (default), 3D, W, M or Q. |
| \`cond\` + \`value\` | A condition on the daily close / latest price, see below. Needs \`key\`, except the two \`moving_*_pct\` conditions. |
| \`trigger\` | \`once\` (default: the alert switches itself off after firing) or \`bar\` (at most once per daily bar). Always \`bar\` on the whole watchlist. |
| \`check\` | When it is judged. \`price\`: after every quote round (about every 5 minutes while the market is open), on daily bars whose last one is today's unfinished bar. \`close\`: only after a daily sync, on closed daily bars. Default \`price\` with a \`key\`, \`close\` without. |
| \`label\` | The name shown on the overview and in the message; generated when omitted. |
| \`notify\` | false: shown on the overview only, never pushed. Default true. |
| \`enabled\` | false: stopped. |
| \`draft\` | true: waiting for the user to confirm it on the page; not judged until then. |
| \`by\` | \`agent\` on alerts created or changed through this endpoint. |

## Conditions (\`cond\`)

${conds.join("\n")}

An event compares two consecutive checks (crossing up: above the level now, on or below it before; sitting exactly on the level fires nothing) and the first check only records. A state fires whenever it holds, the first check included.

## What an agent may do

- An alert on one symbol (\`key\` given) takes effect as soon as it is saved.
- An alert on the whole watchlist (no \`key\`) is always saved as a draft: the user confirms it on the page before it is judged. You can edit your draft (it stays a draft), but not one the user has in effect or stopped: saving with its \`id\` is refused, so save a new draft without \`id\` and leave the old one running. A stopped one can only be resumed by the user. Deleting and stopping are allowed.
`;
}
