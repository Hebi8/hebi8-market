import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");

/** BlockList also checks IPv4-mapped IPv6 against its IPv4 rules. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

const hostname = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

async function publicAddresses(host: string, where: string) {
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new Error(`${where} 无法解析`);
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error(`${where}必须是公网地址`);
  return addresses;
}

/** Save-time check; delivery resolves again inside the connection's lookup. */
export async function requirePublicUrl(value: string, where: string): Promise<void> {
  await publicAddresses(hostname(new URL(value)), where);
}

const publicLookup: LookupFunction = (host, options, callback) => {
  publicAddresses(host, "通知地址").then(
    (addresses) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    (error) => callback(error, "", 0),
  );
};

/** A fresh connection using only checked addresses; redirects and response bodies are not consumed. */
export async function publicPost(value: string, headers: http.OutgoingHttpHeaders, body: string | Uint8Array, signal: AbortSignal): Promise<number> {
  const url = new URL(value);
  const host = hostname(url);
  // Node skips lookup for IP literals.
  if (isIP(host)) await publicAddresses(host, "通知地址");
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers, signal, lookup: publicLookup, agent: false }, (res) => {
      resolve(res.statusCode!);
      res.destroy();
    });
    req.on("error", reject);
    req.end(body);
  });
}
