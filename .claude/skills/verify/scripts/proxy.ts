import { execFileSync } from "node:child_process";
import { type Socket, connect, createServer } from "node:net";
import { isOurs, processGroup, type StackState } from "./paths";

const DENIED = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

// The socket's far end must belong to this stack's next dev, not to whatever took the port after it died.
function servedByStack(upstream: Socket, state: StackState): boolean {
  if (!isOurs(state)) return false;
  let out: string;
  try {
    out = execFileSync("ss", ["-tnpH", "state", "established", `( sport = :${state.port} and dport = :${upstream.localPort} )`], { encoding: "utf8" });
  } catch {
    return false;
  }
  const pids = [...out.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
  return pids.length > 0 && pids.every((pid) => processGroup(pid) === state.pid);
}

// The browser's only way out: a request for this stack's panel is relayed once its socket is proven to be ours,
// anything else gets a 403. Every connection carries one request, so one check covers everything sent on it.
export async function panelOnlyProxy(state: StackState): Promise<{ port: number; close: () => void }> {
  const server = createServer((client) => {
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 65536) client.end(DENIED);
        return;
      }
      client.off("data", onData);
      client.pause();
      relay(client, head.subarray(0, end).toString("latin1").split("\r\n"), head.subarray(end + 4));
    };
    client.on("data", onData);
  });

  const relay = (client: Socket, lines: string[], rest: Buffer) => {
    const [method, target, version] = lines[0].split(" ");
    let host: string;
    let port: number;
    let first: Buffer | null = null;
    if (method === "CONNECT") {
      const at = target.lastIndexOf(":");
      host = target.slice(0, at);
      port = Number(target.slice(at + 1));
    } else {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        client.end(DENIED);
        return;
      }
      host = url.hostname;
      port = Number(url.port || 80);
      const headers = lines.slice(1).filter((line) => !/^(proxy-)?connection:/i.test(line));
      first = Buffer.concat([Buffer.from([`${method} ${url.pathname}${url.search} ${version}`, ...headers, "Connection: close", "", ""].join("\r\n"), "latin1"), rest]);
    }
    if (!["localhost", "127.0.0.1"].includes(host) || port !== state.port) {
      client.end(DENIED);
      return;
    }
    const upstream = connect({ host: "127.0.0.1", port });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("connect", () => {
      if (!servedByStack(upstream, state)) {
        upstream.destroy();
        client.end(DENIED);
        return;
      }
      if (first) upstream.write(first);
      else {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the proxy did not bind");
  return { port: address.port, close: () => server.close() };
}
