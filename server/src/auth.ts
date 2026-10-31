import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db.js";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = "cp_session";
const SESSION_DAYS = 30;

/** Warm, readable cursor colours. Each person gets one when they sign up. */
const COLORS = ["#c2410c", "#0f766e", "#7c3aed", "#b45309", "#be185d", "#1d4ed8", "#4d7c0f", "#9f1239"];

export type User = { id: string; email: string; name: string; color: string };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

/** A hash computed once, so signing in as someone who doesn't exist takes as long as a wrong password. */
let decoyHash: Promise<string> | undefined;

export async function userForSession(db: Db, token: string | undefined): Promise<User | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await db.query<User>(
    `select u.id, u.email, u.name, u.color from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

/** Reads the session cookie out of a raw Cookie header (the WebSocket handshake has no Fastify request). */
export function sessionFromCookieHeader(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

/** An error that is safe to show: its status and message go to the client as they are. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest, _reply?: FastifyReply): User {
  if (!req.user) throw new HttpError(401, "Please sign in.");
  return req.user;
}

export async function authRoutes(app: FastifyInstance, db: Db, opts: { secureCookies: boolean }) {
  decoyHash ??= hashPassword(randomBytes(16).toString("hex"));

  const cookie = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: opts.secureCookies };

  async function startSession(reply: FastifyReply, userId: string) {
    const token = newToken();
    await db.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))",
      [sha256(token), userId, SESSION_DAYS]);
    reply.setCookie(SESSION_COOKIE, token, { ...cookie, maxAge: SESSION_DAYS * 86400 });
  }

  // Ten attempts a minute per address is plenty for a person and slow for a script.
  const limited = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post<{ Body: { email: string; name: string; password: string } }>("/api/signup", {
    ...limited,
    schema: {
      body: {
        type: "object",
        required: ["email", "name", "password"],
        additionalProperties: false,
        properties: {
          email: { type: "string", format: "email", maxLength: 254 },
          name: { type: "string", minLength: 1, maxLength: 60 },
          password: { type: "string", minLength: 10, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { email, name, password } = req.body;
    const color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
    const { rows } = await db.query<{ id: string }>(
      "insert into users (email, name, color, password_hash) values ($1, $2, $3, $4) on conflict (email) do nothing returning id",
      [email.trim(), name.trim(), color, await hashPassword(password)],
    );
    if (!rows[0]) return reply.code(409).send({ error: "There's already an account with that email. Try signing in." });
    await startSession(reply, rows[0].id);
    return reply.code(201).send({ id: rows[0].id, email, name: name.trim(), color });
  });

  app.post<{ Body: { email: string; password: string } }>("/api/login", {
    ...limited,
    schema: {
      body: {
        type: "object",
        required: ["email", "password"],
        additionalProperties: false,
        properties: { email: { type: "string", maxLength: 254 }, password: { type: "string", maxLength: 200 } },
      },
    },
  }, async (req, reply) => {
    const { rows } = await db.query<User & { password_hash: string }>(
      "select id, email, name, color, password_hash from users where email = $1", [req.body.email.trim()]);
    const user = rows[0];
    const ok = await verifyPassword(req.body.password, user?.password_hash ?? (await decoyHash!));
    if (!user || !ok) return reply.code(401).send({ error: "That email and password don't match." });
    await startSession(reply, user.id);
    return { id: user.id, email: user.email, name: user.name, color: user.color };
  });

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.query("delete from sessions where token_hash = $1", [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, cookie);
    return reply.code(204).send();
  });

  app.get("/api/me", async (req, reply) => requireUser(req, reply));
}
