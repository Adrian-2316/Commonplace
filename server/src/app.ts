import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { authRoutes, HttpError, SESSION_COOKIE, userForSession } from "./auth.js";
import { createCollab } from "./collab.js";
import type { Db } from "./db.js";
import { documentRoutes } from "./documents.js";

export type Config = {
  /** Where people open the app, e.g. https://notes.example.com. Requests and sockets from elsewhere are refused. */
  origin: string;
  secureCookies: boolean;
  /** The built web app, served from / when set. */
  webDir?: string;
  logger?: boolean;
  /**
   * Addresses of the reverse proxies in front of the app (e.g. "10.0.0.0/8" or "loopback"), so rate limits
   * see the visitor's address rather than the proxy's. Leave unset when clients connect directly: otherwise
   * anyone could pick their own address with an X-Forwarded-For header and dodge the limits.
   */
  trustedProxies?: string;
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");

export async function buildApp(db: Db, config: Config): Promise<{ app: FastifyInstance; collab: ReturnType<typeof createCollab> }> {
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 64 * 1024, trustProxy: config.trustedProxies || false });
  const collab = createCollab(db, { allowedOrigins: [config.origin] });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req, reply) => {
    // Changes must come from our own pages. SameSite cookies already stop most cross-site requests;
    // this also covers older browsers and same-site subdomains.
    if (req.method !== "GET" && req.method !== "HEAD" && req.url.startsWith("/api/") && req.headers.origin !== config.origin) {
      return reply.code(403).send({ error: "Cross-site request refused." });
    }
    if (req.url.startsWith("/api/")) req.user = await userForSession(db, req.cookies[SESSION_COOKIE]);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy", CSP);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  // Errors never leak internals: validation errors say what's wrong with the input, anything else is generic.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.validation) return reply.code(400).send({ error: "Some of that input isn't valid." });
    if (err.statusCode === 429) return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
    req.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on our side." });
  });

  app.get("/health", async () => ({ ok: true }));
  await authRoutes(app, db, { secureCookies: config.secureCookies });
  await documentRoutes(app, db, collab);

  if (config.webDir) await serveWeb(app, config.webDir);

  return { app, collab };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon",
};

/**
 * Serves the built single-page app from memory. Only files that exist in the build at startup can be served,
 * looked up by exact path, so there is no way to reach anything else on disk. Unknown paths get index.html.
 */
async function serveWeb(app: FastifyInstance, dir: string) {
  const files = new Map<string, { body: Buffer; type: string }>();
  async function walk(d: string) {
    for (const name of await readdir(d)) {
      const full = path.join(d, name);
      if ((await stat(full)).isDirectory()) await walk(full);
      else files.set("/" + path.relative(dir, full).split(path.sep).join("/"), { body: await readFile(full), type: TYPES[path.extname(name)] ?? "application/octet-stream" });
    }
  }
  await walk(dir);
  const index = files.get("/index.html");
  if (!index) throw new Error(`No index.html in ${dir}`);

  app.get("/*", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    if (url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
    const file = files.get(url) ?? index;
    reply.header("Cache-Control", url.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.type(file.type).send(file.body);
  });
}
