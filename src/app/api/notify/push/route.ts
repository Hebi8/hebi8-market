import { NextResponse, type NextRequest } from "next/server";
import { addPushDevice, channelSummary, removePushDevices } from "@/lib/notify";
import { notifyCaller } from "@/lib/notify-caller";
import { requirePublicUrl } from "@/lib/public-address";
import { deviceLabel } from "@/lib/push";

export const dynamic = "force-dynamic";

/** The subscription's keys are base64url */
const isKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(v);

/** 在此设备上接收推送: the browser's `PushSubscription` as JSON, `{ endpoint, keys: { p256dh, auth } }`. */
export async function PUT(request: NextRequest) {
  const caller = notifyCaller(request);
  if (caller instanceof NextResponse) return caller;
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (typeof endpoint !== "string" || !URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:" || !isKey(p256dh) || !isKey(auth)) {
    return NextResponse.json({ error: "不是有效的推送订阅" }, { status: 400 });
  }
  if (caller.vault) {
    try {
      await requirePublicUrl(endpoint, "推送地址");
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
  }
  addPushDevice(caller.login, { endpoint, keys: { p256dh, auth }, label: deviceLabel(request.headers.get("user-agent") ?? ""), added: Date.now() });
  return NextResponse.json(channelSummary(caller.vault, caller.owner));
}

/** Remove a device from the list: `?id=` as the summary names it. */
export async function DELETE(request: NextRequest) {
  const caller = notifyCaller(request);
  if (caller instanceof NextResponse) return caller;
  removePushDevices(caller.login, [request.nextUrl.searchParams.get("id") ?? ""]);
  return NextResponse.json(channelSummary(caller.vault, caller.owner));
}
