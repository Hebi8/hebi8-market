import { NextResponse, type NextRequest } from "next/server";
import type { StatusResponse } from "@/lib/api-types";
import { chartTail, loadChart } from "@/lib/bars";
import { SESSION_COOKIE } from "@/lib/github";
import { liveReader, symbolStatus, tradedPrice } from "@/lib/quotes";
import { readConfigSafe } from "@/lib/vault";
import { resolveViewer } from "@/lib/viewer";
import { chartQuery } from "@/lib/chart-query";

export const dynamic = "force-dynamic";

/**
 * What an open chart reads after each quote round, instead of loading its bars again (which
 * resets the view): the status strip's sync and quote, and the last bar of the timeframe with the
 * other symbols at it. Never touches the network.
 */
export function GET(request: NextRequest) {
  const { config, error } = readConfigSafe(resolveViewer(request.cookies.get(SESSION_COOKIE)?.value).dir);
  if (!config) return NextResponse.json({ error }, { status: 500 });
  const query = chartQuery(request.nextUrl.searchParams, config);
  if (!query) return NextResponse.json({ error: "need ?key=<source:ticker>&tf=D|W|M|Q&prices=split|total" }, { status: 400 });
  const { key, tf, prices, withKeys } = query;
  let tail: StatusResponse["tail"];
  try {
    tail = chartTail(loadChart(key, tf, prices, withKeys, config, liveReader()));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const body: StatusResponse = { ...symbolStatus(key, config.aliases), tail, price: tradedPrice(key) };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
