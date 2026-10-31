import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { AddressInfo } from "node:net";
import { inject } from "vitest";
import * as Y from "yjs";
import { buildApp } from "../src/app.js";
import { connect, migrate, type Db } from "../src/db.js";

export const ORIGIN = "http://notes.test";

/** A real server on a random port, against the test Postgres. */
export async function startServer() {
  const db: Db = connect(inject("databaseUrl"));
  await migrate(db);
  const { app, collab } = await buildApp(db, { origin: ORIGIN, secureCookies: false, trustedProxies: "loopback" });
  collab.attach(app.server);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    db, app, collab, base,
    async stop() {
      await app.close();
      await db.end();
    },
  };
}

export type Server = Awaited<ReturnType<typeof startServer>>;

let counter = 0;

/** Someone with an account and a signed-in session, who can call the API. */
export async function person(server: Server, name = "Ana") {
  const email = `${name.toLowerCase()}-${Date.now()}-${counter++}@example.com`;
  const res = await fetch(`${server.base}/api/signup`, {
    method: "POST",
    // Each test person signs up from their own address, so the sign-up rate limit doesn't trip.
    headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": `198.51.100.${counter % 250}` },
    body: JSON.stringify({ email, name, password: "a long enough password" }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const me = (await res.json()) as { id: string };
  return {
    id: me.id, email, cookie,
    async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const r = await fetch(`${server.base}${path}`, {
        method,
        headers: { origin: ORIGIN, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    },
  };
}

export type Person = Awaited<ReturnType<typeof person>>;

/** A collaborator's editor: a Y.Doc kept in sync with the server over a real WebSocket. */
export function editor(server: Server, documentId: string, who: { cookie: string } | null, origin = ORIGIN) {
  const doc = new Y.Doc();
  const headers: Record<string, string> = { origin };
  if (who) headers.cookie = who.cookie;
  class AuthedSocket extends WebSocket {
    constructor(url: string) {
      super(url, { headers } as never);
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: server.base.replace("http", "ws") + "/collab", WebSocketPolyfill: AuthedSocket, maxAttempts: 1 });
  let failed: string | null = null;
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: documentId,
    document: doc,
    token: "session-cookie",
    onAuthenticationFailed: ({ reason }) => { failed = reason; },
  });
  provider.attach();
  return {
    doc, provider, socket,
    get failed() { return failed; },
    synced: () => until(() => provider.isSynced, "editor never synced"),
    close() {
      provider.destroy();
      socket.destroy();
    },
  };
}

/** Writes a paragraph of text at the end, the way the editor would. */
export function write(doc: Y.Doc, text: string) {
  const f = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  f.insert(f.length, [p]);
}

export function textOf(doc: Y.Doc) {
  return doc.getXmlFragment("default").toString().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function until(check: () => boolean | Promise<boolean>, message: string, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
