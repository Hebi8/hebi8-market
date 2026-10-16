import { NextResponse, type NextRequest } from "next/server";
import { instanceBotApis, readNotifyConfig, setInstanceBot, type BotSummary } from "@/lib/notify";
import { botCaller } from "@/lib/notify-caller";
import { botName, resetBindings } from "@/lib/telegram";

export const dynamic = "force-dynamic";

const failed = (err: unknown, status: number) => NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });

async function summary(): Promise<BotSummary> {
  const t = readNotifyConfig().config.telegram;
  if (!t) return { configured: false, username: null };
  try {
    return { configured: true, username: await botName(t) };
  } catch (err) {
    return { configured: true, username: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(request: NextRequest) {
  const caller = botCaller(request);
  if (caller instanceof NextResponse) return caller;
  return NextResponse.json(await summary(), { headers: { "Cache-Control": "no-store" } });
}

/** `{ token }`: checked with getMe first, written to notify.json only when Telegram accepts it. */
export async function PUT(request: NextRequest) {
  const caller = botCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!/^\d+:[\w-]+$/.test(token)) return failed(new Error("token 的格式是 数字:字母数字，从 @BotFather 复制"), 400);
  let apis: string[];
  try {
    apis = instanceBotApis();
  } catch (err) {
    return failed(err, 409);
  }
  let username: string;
  try {
    username = await botName({ token, apis });
  } catch (err) {
    return failed(new Error(`Telegram 不接受这个 token：${err instanceof Error ? err.message : String(err)}`), 400);
  }
  try {
    setInstanceBot(token);
  } catch (err) {
    return failed(err, 409);
  }
  // codes handed out for the old bot would never be answered
  resetBindings();
  return NextResponse.json({ configured: true, username } satisfies BotSummary);
}

/** 移除: drops the telegram section (bot and the root vault's chat); the rest of the file stays. */
export async function DELETE(request: NextRequest) {
  const caller = botCaller(request);
  if (caller instanceof NextResponse) return caller;
  try {
    setInstanceBot(null);
  } catch (err) {
    return failed(err, 409);
  }
  resetBindings();
  return NextResponse.json({ configured: false, username: null } satisfies BotSummary);
}
