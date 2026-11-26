import { execFileSync } from "node:child_process";
import { type Socket, connect, createServer } from "node:net";
import { isOurs, processGroup, type StackState } from "./paths";

const DENIED = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

// The socket's far end must belong to this stack's next dev, not to whatever took the port after it died.
// The client sees the connection before the server has accepted it, so the row is polled for briefly.
async function servedByStack(upstream: Socket, state: StackState): Promise<boolean> {
  const filter = `( src 127.0.0.1:${state.port} and dst 127.0.0.1:${upstream.localPort} )`;
  for (let tries = 0; tries < 40 && isOurs(state); tries++) {
    let rows: string[];
    try {
      rows = execFileSync("ss", ["-tnpH", "state", "established", filter], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return false;
    }
    const pids = [...(rows[0] ?? "").matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    if (rows.length === 1 && pids.length > 0) return pids.every((pid) => processGroup(pid) === state.pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
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
    const parts = lines[0].split(" ");
    if (parts.length !== 3 || !parts[1] || !/^HTTP\/1\.[01]$/.test(parts[2])) {
      client.end(DENIED);
      return;
    }
    const [method, target, version] = parts;
    let host: string;
    let port: number;
    let first: Buffer | null = null;
    if (method === "CONNECT") {
      const at = target.lastIndexOf(":");
      host = target.slice(0, at);
      port = at > 0 && /^\d{1,5}$/.test(target.slice(at + 1)) ? Number(target.slice(at + 1)) : -1;
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
    upstream.on("connect", async () => {
      if (!(await servedByStack(upstream, state))) {
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
