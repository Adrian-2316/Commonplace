import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { editor, ORIGIN, person, startServer, textOf, until, write, type Server } from "./harness.js";

let server: Server;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => { await server.stop(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

describe("accounts", () => {
  it("signs up, signs in, and refuses a wrong password the same way as an unknown email", async () => {
    const ana = await person(server, "Ana");
    expect((await post("/api/login", { email: ana.email, password: "a long enough password" })).status).toBe(200);
    const wrong = await post("/api/login", { email: ana.email, password: "not the password" });
    const nobody = await post("/api/login", { email: "nobody@example.com", password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(nobody.status).toBe(401);
    expect(await wrong.json()).toEqual(await nobody.json());
  });

  it("refuses a second account with the same email, in any case", async () => {
    const ana = await person(server, "Ana");
    const again = await post("/api/signup", { email: ana.email.toUpperCase(), name: "Ana", password: "a long enough password" });
    expect(again.status).toBe(409);
  });

  it("sets a session cookie scripts can't read", async () => {
    const res = await post("/api/signup", { email: `c-${Date.now()}@example.com`, name: "C", password: "a long enough password" });
    const set = res.headers.getSetCookie()[0]!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
  });

  it("refuses changes sent from another site", async () => {
    const ana = await person(server, "Ana");
    const r = await ana.call("POST", "/api/documents", undefined, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("slows down password guessing", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post("/api/login", { email: "x@example.com", password: "guess" }, { "x-forwarded-for": "203.0.113.9" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("documents and sharing", () => {
  it("hides documents from people they aren't shared with, without confirming they exist", async () => {
    const ana = await person(server, "Ana");
    const eve = await person(server, "Eve");
    const { body } = await ana.call("POST", "/api/documents");
    expect((await eve.call("GET", `/api/documents/${body.id}`)).status).toBe(404);
    expect((await eve.call("GET", `/api/documents/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await eve.call("GET", "/api/documents")).body).toEqual([]);
  });

  it("joins through a link, and a viewer link never demotes an editor", async () => {
    const ana = await person(server, "Ana");
    const ben = await person(server, "Ben");
    const { body } = await ana.call("POST", "/api/documents");
    const edit = await ana.call("POST", `/api/documents/${body.id}/links`, { role: "editor" });
    const view = await ana.call("POST", `/api/documents/${body.id}/links`, { role: "viewer" });

    await ben.call("POST", `/api/join/${edit.body.token}`);
    await ben.call("POST", `/api/join/${view.body.token}`);
    expect((await ben.call("GET", `/api/documents/${body.id}`)).body.role).toBe("editor");
  });

  it("stops working once the owner turns the link off", async () => {
    const ana = await person(server, "Ana");
    const ben = await person(server, "Ben");
    const { body } = await ana.call("POST", "/api/documents");
    const link = await ana.call("POST", `/api/documents/${body.id}/links`, { role: "editor" });
    const [listed] = (await ana.call("GET", `/api/documents/${body.id}/links`)).body;
    expect(JSON.stringify(listed)).not.toContain(link.body.token);

    await ana.call("DELETE", `/api/documents/${body.id}/links/${listed.id}`);
    expect((await ben.call("POST", `/api/join/${link.body.token}`)).status).toBe(404);
  });

  it("only lets the owner share, change roles or delete", async () => {
    const ana = await person(server, "Ana");
    const ben = await person(server, "Ben");
    const { body } = await ana.call("POST", "/api/documents");
    const link = await ana.call("POST", `/api/documents/${body.id}/links`, { role: "editor" });
    await ben.call("POST", `/api/join/${link.body.token}`);

    expect((await ben.call("POST", `/api/documents/${body.id}/links`, { role: "editor" })).status).toBe(403);
    expect((await ben.call("DELETE", `/api/documents/${body.id}`)).status).toBe(403);
    expect((await ben.call("PATCH", `/api/documents/${body.id}/people/${ana.id}`, { role: "viewer" })).status).toBe(403);
  });
});

describe("version history", () => {
  it("saves a named version and restores it for everyone, keeping the newer text as a version too", async () => {
    const ana = await person(server, "Ana");
    const { body } = await ana.call("POST", "/api/documents");
    const id = body.id as string;

    const a = editor(server, id, ana);
    await a.synced();
    write(a.doc, "The calm first draft");
    await until(async () => (await ana.call("POST", `/api/documents/${id}/versions`, { label: "Draft one" })).status === 201
      && (await ana.call("GET", `/api/documents/${id}/versions`)).body.length > 0, "version not saved");
    const draft = (await ana.call("GET", `/api/documents/${id}/versions`)).body.find((v: { label: string }) => v.label === "Draft one");

    write(a.doc, "A rambling second paragraph");
    await until(() => textOf(a.doc).includes("rambling"), "local write");

    expect((await ana.call("POST", `/api/documents/${id}/versions/${draft.id}/restore`)).status).toBe(204);
    await until(() => !textOf(a.doc).includes("rambling"), "restore never reached the open editor");
    expect(textOf(a.doc)).toContain("The calm first draft");

    const versions = (await ana.call("GET", `/api/documents/${id}/versions`)).body as { id: number; label: string }[];
    const before = versions.find((v) => v.label?.startsWith("Before restoring"))!;
    const saved = (await ana.call("GET", `/api/documents/${id}/versions/${before.id}`)).body.state;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(saved, "base64"));
    expect(textOf(doc)).toContain("rambling");
    a.close();
  });

  it("doesn't let a viewer restore", async () => {
    const ana = await person(server, "Ana");
    const vic = await person(server, "Vic");
    const { body } = await ana.call("POST", "/api/documents");
    await ana.call("POST", `/api/documents/${body.id}/versions`, { label: "v1" });
    const link = await ana.call("POST", `/api/documents/${body.id}/links`, { role: "viewer" });
    await vic.call("POST", `/api/join/${link.body.token}`);
    const [v] = (await vic.call("GET", `/api/documents/${body.id}/versions`)).body;
    expect((await vic.call("POST", `/api/documents/${body.id}/versions/${v.id}/restore`)).status).toBe(403);
  });
});
