import { createServer } from "node:http";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { dataDir } from "./paths.js";
import type { SessionManager } from "./sessionManager.js";

export function resolveBindHost(envHost = process.env.HOST): string {
  const host = envHost || "127.0.0.1";
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (loopbackHosts.has(host)) return host;
  if (process.env.LLM_FUSION_ALLOW_UNSAFE_HOST === "1") return host;
  throw new Error(
    `Refusing to bind LLM Fusion to non-loopback host ${host}. Set LLM_FUSION_ALLOW_UNSAFE_HOST=1 to override.`,
  );
}

// A browser page from another site can open a WebSocket to our loopback
// server. Terminals accept raw input, so we require the Origin (when the
// browser sends one) to be same-origin loopback. Non-browser clients omit
// Origin and are allowed through.
export function isAllowedWsOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return false;
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopback.has(originHost)) return false;
  // Also require the Origin host to match the Host header the request targeted.
  return !host || new URL(origin).host === host;
}

export function attachSessionWebSocket(server: Server, sessionManager: SessionManager): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/sessions" });

  wss.on("connection", (socket, req) => {
    if (!isAllowedWsOrigin(req.headers.origin, req.headers.host)) {
      socket.close(1008, "Cross-origin WebSocket connections are not allowed");
      return;
    }

    const url = new URL(req.url || "/ws/sessions", `http://${req.headers.host || "127.0.0.1:4174"}`);
    const sessionId = url.searchParams.get("id");

    if (!sessionId || !sessionManager.getSession(sessionId)) {
      socket.close(1008, "Missing or invalid session id");
      return;
    }

    socket.send(JSON.stringify({ type: "replay", buffer: sessionManager.readBuffer(sessionId) }));

    const outputSubscription = sessionManager.onOutput((id, chunk) => {
      if (id === sessionId && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "data", chunk }));
      }
    });

    socket.on("message", (data) => {
      try {
        sessionManager.writeRaw(sessionId, data.toString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "error", error: message }));
        }
      }
    });

    socket.on("close", () => {
      outputSubscription.dispose();
    });
  });

  return wss;
}

export function startServer(): Server {
  const host = resolveBindHost();
  const port = Number(process.env.PORT || 4174);
  const staticDir = join(process.cwd(), "dist", "public");
  const { app, sessionManager } = createApp({ dataDir: dataDir(), staticDir });
  const server = createServer(app);
  attachSessionWebSocket(server, sessionManager);

  server.listen(port, host, () => {
    console.log(`LLM Fusion listening at http://${host}:${port}`);
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
