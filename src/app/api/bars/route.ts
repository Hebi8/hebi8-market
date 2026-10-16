import { NextResponse, type NextRequest } from "next/server";
import type { BarsResponse } from "@/lib/api-types";
import { loadChart, synthNoData, type ChartData } from "@/lib/bars";
import { findItem } from "@/lib/config";
import { pricePrecision } from "@/lib/stats";
import { liveReader, symbolStatus } from "@/lib/quotes";
import { calendarOfRow, getSymbol } from "@/lib/store";
import { isSynthetic, parseKey } from "@/lib/symbols";
import { synthName } from "@/lib/synth";
import { SESSION_COOKIE } from "@/lib/github";
import { readConfigSafe } from "@/lib/vault";
import { resolveViewer } from "@/lib/viewer";
import { chartQuery } from "@/lib/chart-query";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // names, benchmarks and synthetic aliases come from the viewer's own yaml
  const { config, error } = readConfigSafe(resolveViewer(request.cookies.get(SESSION_COOKIE)?.value).dir);
  if (!config) return NextResponse.json({ error }, { status: 500 });
  const query = chartQuery(request.nextUrl.searchParams, config);
  if (!query) return NextResponse.json({ error: "need ?key=<source:ticker>&tf=D|3D|W|M|Q&prices=split|total" }, { status: 400 });
  const { key, tf, prices, withKeys } = query;

  const item = findItem(config, key);
  const row = isSynthetic(key) ? null : getSymbol(key);

  // today's bar from the latest quote, as the status strip and the alerts see it
  let chart: ChartData;
  try {
    chart = loadChart(key, tf, prices, withKeys, config, liveReader());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const { daily, bars, refs } = chart;
  if (daily.length === 0) {
    const why = isSynthetic(key) ? synthNoData(key, config, (k) => getSymbol(k)?.syncError ?? null) : (row?.syncError ?? "暂无数据，等待同步");
    return NextResponse.json({ error: why }, { status: 404 });
  }

  const body: BarsResponse = {
    symbol: {
      key,
      name: item?.name ?? row?.name ?? (isSynthetic(key) ? synthName(key) : parseKey(key).ticker),
      source: isSynthetic(key) ? "expr" : parseKey(key).source,
      ticker: isSynthetic(key) ? synthName(key) : parseKey(key).ticker,
      currency: row?.currency ?? null,
      exchange: row?.exchange ?? null,
      bench: item?.bench ?? null,
      calendar: calendarOfRow(row),
      ...symbolStatus(key, config.aliases),
      lastDay: daily[daily.length - 1].t * 1000,
    },
    pricePrecision: pricePrecision(daily[daily.length - 1].c),
    bars,
    refs,
  };
  // per person (names, benchmarks and synthetic aliases come from their yaml), so never reused
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
