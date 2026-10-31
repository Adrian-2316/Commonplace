import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { editor, pause, person, startServer, textOf, until, write, type Server } from "./harness.js";

let server: Server;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => { await server.stop(); });

async function sharedDoc() {
  const ana = await person(server, "Ana");
  const ben = await person(server, "Ben");
  const { body } = await ana.call("POST", "/api/documents");
  const link = await ana.call("POST", `/api/documents/${body.id}/links`, { role: "editor" });
  await ben.call("POST", `/api/join/${link.body.token}`);
  return { id: body.id as string, ana, ben };
}

describe("live collaboration", () => {
  it("two people typing at the same moment end up with the same document", async () => {
    const { id, ana, ben } = await sharedDoc();
    const a = editor(server, id, ana);
    const b = editor(server, id, ben);
    await Promise.all([a.synced(), b.synced()]);

    write(a.doc, "Ana was here");
    write(b.doc, "Ben too");

    await until(() => textOf(a.doc).includes("Ben too") && textOf(b.doc).includes("Ana was here"), "edits never crossed");
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
    expect(textOf(a.doc)).toEqual(textOf(b.doc));
    a.close(); b.close();
  });

  it("edits made offline merge in when the connection comes back", async () => {
    const { id, ana, ben } = await sharedDoc();
    const a = editor(server, id, ana);
    await a.synced();
    write(a.doc, "Before the train");
    a.close();

    // Ana keeps writing with no connection; Ben edits the live document meanwhile.
    write(a.doc, "Written in the tunnel");
    const b = editor(server, id, ben);
    await b.synced();
    write(b.doc, "Ben at his desk");

    const again = editor(server, id, ana);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc)); // what IndexedDB gives back in the browser
    await again.synced();

    await until(() => textOf(b.doc).includes("Written in the tunnel") && textOf(again.doc).includes("Ben at his desk"), "offline edits never merged");
    expect(textOf(again.doc)).toEqual(textOf(b.doc));
    again.close(); b.close();
  });

  it("keeps the document when everyone leaves, and mirrors the first line as its title", async () => {
    const { id, ana } = await sharedDoc();
    const a = editor(server, id, ana);
    await a.synced();
    const f = a.doc.getXmlFragment("default");
    const h = new Y.XmlElement("heading");
    h.setAttribute("level", 1 as never);
    h.insert(0, [new Y.XmlText("Garden plans")]);
    f.insert(0, [h]);
    write(a.doc, "Tomatoes along the south wall");
    a.close();

    await until(async () => (await ana.call("GET", `/api/documents/${id}`)).body.title === "Garden plans", "title never stored");
    const later = editor(server, id, ana);
    await later.synced();
    expect(textOf(later.doc)).toContain("Tomatoes along the south wall");
    later.close();
  });
});

describe("who may connect", () => {
  it("refuses a connection without a session", async () => {
    const { id } = await sharedDoc();
    const stranger = editor(server, id, null);
    await until(() => stranger.failed !== null, "connection wasn't refused");
    expect(stranger.provider.isSynced).toBe(false);
    stranger.close();
  });

  it("refuses someone the document isn't shared with", async () => {
    const { id } = await sharedDoc();
    const eve = await person(server, "Eve");
    const e = editor(server, id, eve);
    await until(() => e.failed !== null, "connection wasn't refused");
    expect(e.doc.getXmlFragment("default").length).toBe(0);
    e.close();
  });

  it("refuses sockets opened from another site, even with a valid cookie", async () => {
    const { id, ana } = await sharedDoc();
    const forged = editor(server, id, ana, "https://evil.example");
    await pause(800);
    expect(forged.provider.isSynced).toBe(false);
    forged.close();
  });

  it("drops a viewer's changes on the server, whatever their browser sends", async () => {
    const { id, ana } = await sharedDoc();
    const vic = await person(server, "Vic");
    const link = await ana.call("POST", `/api/documents/${id}/links`, { role: "viewer" });
    await vic.call("POST", `/api/join/${link.body.token}`);

    const a = editor(server, id, ana);
    const v = editor(server, id, vic);
    await Promise.all([a.synced(), v.synced()]);
    write(a.doc, "From the owner");
    await until(() => textOf(v.doc).includes("From the owner"), "viewer can't even read");

    write(v.doc, "Sneaky viewer edit");
    await pause(800);
    expect(textOf(a.doc)).not.toContain("Sneaky");
    const fresh = editor(server, id, ana);
    await fresh.synced();
    expect(textOf(fresh.doc)).not.toContain("Sneaky");
    a.close(); v.close(); fresh.close();
  });

  it("disconnects someone the moment they're removed", async () => {
    const { id, ana, ben } = await sharedDoc();
    const b = editor(server, id, ben);
    await b.synced();
    expect((await ana.call("DELETE", `/api/documents/${id}/people/${ben.id}`)).status).toBe(204);
    await until(() => !b.provider.isSynced || b.provider.isAuthenticated === false || b.failed !== null || b.socket.status !== "connected", "removed person stayed connected");
    b.close();
  });
});
