// M3.3 S3b — test infrastructure: a local canonical-origin gateway, so
// production / maintenance servers spawned on isolated ports are exercised
// at their REAL canonical origin (https://<name>.tenotrainer.test — RFC 6761
// reserved, never resolvable publicly) with no application bypass.
//
//   * The browser is launched with this gateway as its HTTP proxy. A CONNECT
//     to a registered *.tenotrainer.test host is terminated here with a
//     throwaway self-signed certificate (contexts set ignoreHTTPSErrors) and
//     forwarded to the spawned Next server with the Host header unchanged
//     and NO X-Forwarded-* headers added. Playwright forces loopback traffic
//     through a configured proxy, so loopback (localhost / 127.0.0.1) HTTP
//     requests and tunnels are passed through unchanged; nothing else is.
//   * gatewayFetch() is a fetch-shaped helper for Node-side requests: a URL
//     on a registered host is sent straight to its upstream with that Host;
//     anything else falls through to the global fetch.
//   * rawRequest() sends an arbitrary request (any Host / X-Forwarded-* /
//     Origin) to an upstream port — for the adversarial host-header tests.
//
// It never changes what the application sees beyond what a real TLS
// terminator in front of it would: the request line, Host and headers.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

export const TEST_TLD = ".tenotrainer.test";

export async function startCanonicalGateway({ port, routes }) {
  const table = new Map(Object.entries(routes)); // hostname -> upstream port
  for (const h of table.keys()) if (!h.endsWith(TEST_TLD)) throw new Error(`gateway hosts must be under ${TEST_TLD}: ${h}`);
  const dir = mkdtempSync(join(tmpdir(), "m33-gateway-"));
  const san = [...table.keys()].map((h) => `DNS:${h}`).join(",");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=tenotrainer.test",
    "-addext", `subjectAltName=${san}`, "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const tlsServer = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    const upstream = table.get(host);
    if (!upstream) { res.writeHead(502); res.end("unknown gateway host"); return; }
    const p = http.request({ host: "127.0.0.1", port: upstream, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    p.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  rmSync(dir, { recursive: true, force: true });
  const loopback = (h) => ["127.0.0.1", "localhost", "[::1]"].includes(String(h).toLowerCase());
  const proxy = http.createServer((req, res) => {
    // Absolute-form proxy request: only loopback targets are passed through.
    let target;
    try { target = new URL(req.url ?? ""); } catch { target = null; }
    if (!target || target.protocol !== "http:" || !loopback(target.hostname)) { res.writeHead(403); res.end("the canonical gateway only tunnels registered hosts and loopback"); return; }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    const p = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    p.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  proxy.on("connect", (req, socket, head) => {
    const [host, p] = (req.url ?? "").split(":");
    if (loopback(host)) {
      const upstream = net.connect(Number(p), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      return;
    }
    if (!table.has(host?.toLowerCase()) || (p && p !== "443")) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    tlsServer.emit("connection", socket);
  });
  await new Promise((r) => proxy.listen(port, "127.0.0.1", r));
  return {
    proxyServer: `http://127.0.0.1:${port}`,
    routes: table,
    close: () => new Promise((r) => { tlsServer.close(); proxy.close(() => r()); proxy.closeAllConnections?.(); tlsServer.closeAllConnections?.(); }),
  };
}

// A Chromium whose contexts reach registered hosts through the gateway.
export async function launchCanonicalBrowser(gateway) {
  const browser = await chromium.launch({ proxy: { server: gateway.proxyServer } });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (opts = {}) => newContext({ ignoreHTTPSErrors: true, ...opts });
  return browser;
}

// Send one request to an upstream port with exactly the given headers
// (Host included). Returns { status, headers, text }.
export function rawRequest(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, setHost: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("rawRequest timeout")));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// fetch-shaped: registered-host URLs go to their upstream with that Host
// (never following redirects); everything else uses the global fetch.
export function gatewayFetch(gateway) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const upstream = gateway.routes.get(url.hostname.toLowerCase());
    if (!upstream) return globalThis.fetch(input, init);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    headers.host = url.host;
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    if (body !== undefined && headers["content-length"] === undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const r = await rawRequest(upstream, { method: init.method ?? "GET", path: `${url.pathname}${url.search}`, headers, body });
    const h = new Headers();
    for (const [k, v] of Object.entries(r.headers)) for (const one of [].concat(v)) h.append(k, one);
    const nullBody = (init.method ?? "GET").toUpperCase() === "HEAD" || [101, 204, 205, 304].includes(r.status);
    return new Response(nullBody ? null : r.text, { status: r.status, headers: h });
  };
}
