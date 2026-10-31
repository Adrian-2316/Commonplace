import type { FastifyInstance, FastifyReply } from "fastify";
import * as Y from "yjs";
import { atLeast, roleOf, UUID, type Role } from "./access.js";
import { HttpError, newToken, requireUser, sha256 } from "./auth.js";
import type { createCollab } from "./collab.js";
import { snapshotIfChanged } from "./collab.js";
import type { Db } from "./db.js";

type Collab = ReturnType<typeof createCollab>;
type IdParams = { id: string };

const idParam = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: UUID.source } } } as const;

/**
 * A new page starts with its (empty) title heading already in place, so every editor that opens it finds
 * the same first block instead of each creating its own.
 */
function blankPage(): Buffer {
  const doc = new Y.Doc();
  const title = new Y.XmlElement("heading");
  title.setAttribute("level", 1 as never);
  title.insert(0, [new Y.XmlText()]);
  doc.getXmlFragment("default").insert(0, [title]);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

export async function documentRoutes(app: FastifyInstance, db: Db, collab: Collab) {
  /** Loads the caller's role, answering 404 (not 403) when they have none, so ids can't be probed. */
  async function need(_reply: FastifyReply, documentId: string, userId: string, needed: Role): Promise<Role> {
    const role = await roleOf(db, documentId, userId);
    if (!role) throw new HttpError(404, "That document doesn't exist, or it isn't shared with you.");
    if (!atLeast(role, needed)) throw new HttpError(403, `You need to be ${needed === "owner" ? "the owner" : "an editor"} to do that.`);
    return role;
  }

  /** The live state if the document is open on this server, otherwise what's stored. */
  async function currentState(id: string): Promise<Uint8Array> {
    const live = collab.hocuspocus.documents.get(id);
    if (live) return Y.encodeStateAsUpdate(live);
    const { rows } = await db.query<{ state: Buffer | null }>("select state from documents where id = $1", [id]);
    return rows[0]?.state ? new Uint8Array(rows[0].state) : Y.encodeStateAsUpdate(new Y.Doc());
  }

  app.get("/api/documents", async (req, reply) => {
    const user = requireUser(req, reply);
    const { rows } = await db.query(
      `select d.id, d.title, d.updated_at as "updatedAt", m.role,
              json_agg(json_build_object('name', u.name, 'color', u.color) order by o.added_at) as people
         from members m
         join documents d on d.id = m.document_id
         join members o on o.document_id = d.id
         join users u on u.id = o.user_id
        where m.user_id = $1
        group by d.id, m.role
        order by d.updated_at desc`,
      [user.id],
    );
    return rows;
  });

  app.post("/api/documents", async (req, reply) => {
    const user = requireUser(req, reply);
    const client = await db.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ id: string }>("insert into documents (owner_id, state) values ($1, $2) returning id", [user.id, blankPage()]);
      await client.query("insert into members (document_id, user_id, role) values ($1, $2, 'owner')", [rows[0]!.id, user.id]);
      await client.query("commit");
      return reply.code(201).send({ id: rows[0]!.id });
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: IdParams }>("/api/documents/:id", { schema: { params: idParam } }, async (req, reply) => {
    const user = requireUser(req, reply);
    const role = await need(reply, req.params.id, user.id, "viewer");
    const doc = await db.query(`select id, title, updated_at as "updatedAt", state is null as "empty" from documents where id = $1`, [req.params.id]);
    const people = await db.query(
      `select u.id, u.name, u.color, m.role from members m join users u on u.id = m.user_id
        where m.document_id = $1 order by m.added_at`, [req.params.id]);
    return { ...doc.rows[0], role, people: people.rows };
  });

  app.delete<{ Params: IdParams }>("/api/documents/:id", { schema: { params: idParam } }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "owner");
    collab.kick(req.params.id);
    await db.query("delete from documents where id = $1", [req.params.id]);
    return reply.code(204).send();
  });

  // ---- people

  app.patch<{ Params: IdParams & { userId: string }; Body: { role: "editor" | "viewer" } }>("/api/documents/:id/people/:userId", {
    schema: {
      params: { type: "object", properties: { id: { type: "string", pattern: UUID.source }, userId: { type: "string", pattern: UUID.source } } },
      body: { type: "object", required: ["role"], additionalProperties: false, properties: { role: { enum: ["editor", "viewer"] } } },
    },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "owner");
    const r = await db.query("update members set role = $3 where document_id = $1 and user_id = $2 and role <> 'owner'",
      [req.params.id, req.params.userId, req.body.role]);
    if (!r.rowCount) return reply.code(404).send({ error: "No such person on this document." });
    collab.kick(req.params.id, req.params.userId); // they reconnect with the new role
    return reply.code(204).send();
  });

  app.delete<{ Params: IdParams & { userId: string } }>("/api/documents/:id/people/:userId", {
    schema: { params: { type: "object", properties: { id: { type: "string", pattern: UUID.source }, userId: { type: "string", pattern: UUID.source } } } },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    // Owners can remove anyone else; anyone can leave.
    if (req.params.userId !== user.id) await need(reply, req.params.id, user.id, "owner");
    const r = await db.query("delete from members where document_id = $1 and user_id = $2 and role <> 'owner'", [req.params.id, req.params.userId]);
    if (!r.rowCount) return reply.code(404).send({ error: "No such person on this document." });
    collab.kick(req.params.id, req.params.userId);
    return reply.code(204).send();
  });

  // ---- share links

  app.get<{ Params: IdParams }>("/api/documents/:id/links", { schema: { params: idParam } }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "owner");
    const { rows } = await db.query(
      `select substr(token_hash, 1, 12) as id, role, created_at as "createdAt" from share_links
        where document_id = $1 and revoked_at is null order by created_at desc`, [req.params.id]);
    return rows;
  });

  app.post<{ Params: IdParams; Body: { role: "editor" | "viewer" } }>("/api/documents/:id/links", {
    schema: {
      params: idParam,
      body: { type: "object", required: ["role"], additionalProperties: false, properties: { role: { enum: ["editor", "viewer"] } } },
    },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "owner");
    const token = newToken();
    await db.query("insert into share_links (token_hash, document_id, role, created_by) values ($1, $2, $3, $4)",
      [sha256(token), req.params.id, req.body.role, user.id]);
    // The token is shown once, here. Only its hash is stored.
    return reply.code(201).send({ token, role: req.body.role });
  });

  app.delete<{ Params: IdParams & { linkId: string } }>("/api/documents/:id/links/:linkId", {
    schema: { params: { type: "object", properties: { id: { type: "string", pattern: UUID.source }, linkId: { type: "string", pattern: "^[0-9a-f]{12}$" } } } },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "owner");
    await db.query("update share_links set revoked_at = now() where document_id = $1 and substr(token_hash, 1, 12) = $2 and revoked_at is null",
      [req.params.id, req.params.linkId]);
    return reply.code(204).send();
  });

  /** Opening a share link adds you to the document. It never lowers a role you already have. */
  app.post<{ Params: { token: string } }>("/api/join/:token", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    schema: { params: { type: "object", properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{20,64}$" } } } },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    const { rows } = await db.query<{ document_id: string; role: Role }>(
      "select document_id, role from share_links where token_hash = $1 and revoked_at is null", [sha256(req.params.token)]);
    const link = rows[0];
    if (!link) return reply.code(404).send({ error: "This link has expired or was turned off. Ask for a new one." });
    await db.query(
      `insert into members (document_id, user_id, role) values ($1, $2, $3)
       on conflict (document_id, user_id) do update set role = excluded.role
       where members.role = 'viewer' and excluded.role = 'editor'`,
      [link.document_id, user.id, link.role]);
    return { id: link.document_id };
  });

  // ---- versions

  app.get<{ Params: IdParams }>("/api/documents/:id/versions", { schema: { params: idParam } }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "viewer");
    const { rows } = await db.query(
      `select v.id, v.label, v.created_at as "createdAt", u.name as "by", u.color
         from versions v left join users u on u.id = v.created_by
        where v.document_id = $1 order by v.created_at desc, v.id desc limit 100`, [req.params.id]);
    return rows;
  });

  app.get<{ Params: IdParams & { versionId: string } }>("/api/documents/:id/versions/:versionId", {
    schema: { params: { type: "object", properties: { id: { type: "string", pattern: UUID.source }, versionId: { type: "string", pattern: "^[0-9]{1,18}$" } } } },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "viewer");
    const { rows } = await db.query<{ state: Buffer }>("select state from versions where id = $1 and document_id = $2", [req.params.versionId, req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "No such version." });
    return { state: rows[0].state.toString("base64") };
  });

  app.post<{ Params: IdParams; Body: { label: string } }>("/api/documents/:id/versions", {
    schema: {
      params: idParam,
      body: { type: "object", required: ["label"], additionalProperties: false, properties: { label: { type: "string", minLength: 1, maxLength: 80 } } },
    },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "editor");
    await snapshotIfChanged(db, req.params.id, await currentState(req.params.id), req.body.label.trim(), user.id);
    return reply.code(201).send();
  });

  /**
   * Restoring is itself an edit: the current content is saved as a version first, then replaced with the old
   * content in one transaction that every open editor receives. Nothing is lost, and it can be undone the same way.
   */
  app.post<{ Params: IdParams & { versionId: string } }>("/api/documents/:id/versions/:versionId/restore", {
    schema: { params: { type: "object", properties: { id: { type: "string", pattern: UUID.source }, versionId: { type: "string", pattern: "^[0-9]{1,18}$" } } } },
  }, async (req, reply) => {
    const user = requireUser(req, reply);
    await need(reply, req.params.id, user.id, "editor");
    const { rows } = await db.query<{ state: Buffer; created_at: Date }>(
      "select state, created_at from versions where id = $1 and document_id = $2", [req.params.versionId, req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "No such version." });

    const old = new Y.Doc();
    Y.applyUpdate(old, new Uint8Array(rows[0].state));
    const when = rows[0].created_at.toISOString().slice(0, 16).replace("T", " ");

    const conn = await collab.hocuspocus.openDirectConnection(req.params.id, { user, role: "editor" });
    try {
      await snapshotIfChanged(db, req.params.id, Y.encodeStateAsUpdate(conn.document!), `Before restoring ${when}`, user.id);
      await conn.transact((doc) => {
        const target = doc.getXmlFragment("default");
        const source = old.getXmlFragment("default");
        target.delete(0, target.length);
        target.insert(0, source.toArray().map((n) => (n as Y.XmlElement | Y.XmlText).clone()));
      });
    } finally {
      await conn.disconnect();
    }
    return reply.code(204).send();
  });
}
