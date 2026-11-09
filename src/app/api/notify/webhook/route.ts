import { NextResponse, type NextRequest } from "next/server";
import { channelSummary, httpUrl, setUserChannel } from "@/lib/notify";
import { requirePublicUrl } from "@/lib/public-address";
import { notifyCaller } from "@/lib/notify-caller";

export const dynamic = "force-dynamic";

/** Save the viewer's webhook: `{ url, format: "text" | "json" }`. */
export async function PUT(request: NextRequest) {
  const caller = notifyCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { url?: unknown; format?: unknown } | null;
  const format = body?.format ?? "text";
  let url: string;
  try {
    if (typeof body?.url !== "string" || !body.url.trim()) throw new Error("请填写 webhook 地址");
    if (format !== "text" && format !== "json") throw new Error("格式应为 text 或 json");
    url = httpUrl(body.url.trim(), "webhook 地址");
    if (caller.vault) await requirePublicUrl(url, "webhook 地址");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  setUserChannel(caller.login, "webhook", { url, format });
  return NextResponse.json(channelSummary(caller.vault, caller.owner));
}

export async function DELETE(request: NextRequest) {
  const caller = notifyCaller(request);
  if (caller instanceof NextResponse) return caller;
  setUserChannel(caller.login, "webhook", null);
  return NextResponse.json(channelSummary(caller.vault, caller.owner));
}
