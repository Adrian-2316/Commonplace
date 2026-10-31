import { Hocuspocus } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import crossws from "crossws/adapters/node";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as Y from "yjs";
import { atLeast, roleOf } from "./access.js";
import { sessionFromCookieHeader, userForSession, type User } from "./auth.js";
import type { Db } from "./db.js";

export type Context = { user: User; role: "owner" | "editor" | "viewer" };

/** Automatic snapshots: at most one every ten minutes while someone is writing. */
const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
/** A document's whole state is bounded; a single message much more so. */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** The plain text of the first block, which the editor always keeps as the title heading. */
export function titleOf(doc: Y.Doc): string {
  const first = doc.getXmlFragment("default").get(0);
  return first ? textOf(first).trim().slice(0, 200) : "";
}

function textOf(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) return node.toDelta().map((d: { insert: unknown }) => (typeof d.insert === "string" ? d.insert : "")).join("");
  if (node instanceof Y.XmlElement) return node.toArray().map((n) => textOf(n as Y.XmlElement | Y.XmlText)).join("");
  return "";
}

export function createCollab(db: Db, opts: { allowedOrigins: string[]; quiet?: boolean }) {
  const lastSnapshot = new Map<string, number>();

  const hocuspocus = new Hocuspocus<Context>({
    quiet: opts.quiet ?? true,
    debounce: 1500,
    maxDebounce: 8000,

    /**
     * Every connection is checked against the session cookie sent with the WebSocket handshake, and against
     * the person's role on this particular document. Viewers get a read-only connection: the server drops
     * any change they send, whatever their browser does.
     */
    async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
      const user = await userForSession(db, sessionFromCookieHeader(requestHeaders.get("cookie")));
      if (!user) throw new Error("Not signed in");
      const role = await roleOf(db, documentName, user.id);
      if (!role) throw new Error("No access to this document");
      connectionConfig.readOnly = !atLeast(role, "editor");
      return { user, role } satisfies Context;
    },

    extensions: [
      new Database({
        fetch: async ({ documentName }) => {
          const { rows } = await db.query<{ state: Buffer | null }>("select state from documents where id = $1", [documentName]);
          return rows[0]?.state ? new Uint8Array(rows[0].state) : null;
        },
        store: async ({ documentName, state, document }) => {
          await db.query("update documents set state = $2, title = $3, updated_at = now() where id = $1",
            [documentName, state, titleOf(document)]);
          const now = Date.now();
          if (now - (lastSnapshot.get(documentName) ?? 0) > AUTO_SNAPSHOT_MS) {
            lastSnapshot.set(documentName, now);
            await snapshotIfChanged(db, documentName, state);
          }
        },
      }),
    ],
  });

  const ws = crossws({
    serverOptions: { maxPayload: MAX_MESSAGE_BYTES },
    hooks: {
      open(peer) {
        const conn = hocuspocus.handleConnection(peer.websocket as never, peer.request as Request);
        (peer as unknown as { _hp: typeof conn })._hp = conn;
      },
      message(peer, message) {
        (peer as unknown as { _hp?: { handleMessage(m: Uint8Array): void } })._hp?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        (peer as unknown as { _hp?: { handleClose(e: { code?: number; reason?: string }): void } })._hp?.handleClose({ code: event.code, reason: event.reason });
      },
    },
  });

  /**
   * Only same-site pages may open a collaboration socket. Browsers send cookies with WebSocket handshakes
   * from any origin, so without this check another site could open a socket as a signed-in visitor.
   */
  function attach(server: HttpServer) {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? "";
      if (!url.startsWith("/collab")) return socket.destroy();
      if (!opts.allowedOrigins.includes(req.headers.origin ?? "")) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      ws.handleUpgrade(req, socket, head);
    });
  }

  /** Closes a person's open connections to a document, after their access was removed or changed. */
  function kick(documentId: string, userId?: string) {
    const doc = hocuspocus.documents.get(documentId);
    if (!doc) return;
    doc.getConnections().forEach((c) => {
      if (!userId || (c.context as Context | undefined)?.user.id === userId) c.close({ code: 4403, reason: "Access changed" });
    });
  }

  return { hocuspocus, attach, kick };
}

/** Saves a version unless it would be identical to the latest one. */
export async function snapshotIfChanged(db: Db, documentId: string, state: Uint8Array, label: string | null = null, userId: string | null = null) {
  const { rows } = await db.query<{ state: Buffer }>(
    "select state from versions where document_id = $1 order by created_at desc, id desc limit 1", [documentId]);
  if (!label && rows[0] && Buffer.compare(rows[0].state, Buffer.from(state)) === 0) return;
  await db.query("insert into versions (document_id, label, state, created_by) values ($1, $2, $3, $4)",
    [documentId, label, Buffer.from(state), userId]);
}
