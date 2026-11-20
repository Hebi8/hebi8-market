import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { vi } from "vitest";

/**
 * Exercise `publicPost`'s real HTTP transport locally: its lookup still checks the DNS answers, and
 * only checked ones are mapped to the test server on 127.0.0.1:`port`. https: is sent as plain http.
 */
export function localTransport(port: number, all = true) {
  const original = http.request;
  const checked: unknown[] = [];
  const optionsSeen: http.RequestOptions[] = [];
  const transport = (url: URL, options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
    optionsSeen.push(options);
    const lookup: LookupFunction = (host, _options, callback) => {
      options.lookup!(host, { all }, (error, address, family) => {
        if (error) return callback(error, "", 0);
        checked.push(address);
        if (all) callback(null, (address as { address: string; family: number }[]).map(() => ({ address: "127.0.0.1", family: 4 })));
        else callback(null, "127.0.0.1", family);
      });
    };
    return original({ ...options, hostname: url.hostname, port, path: url.pathname, lookup, family: all ? 0 : 4 }, cb);
  };
  vi.spyOn(http, "request").mockImplementation(transport as typeof http.request);
  vi.spyOn(https, "request").mockImplementation(transport as typeof https.request);
  return { checked, optionsSeen };
}
