import type { Db } from "./db.js";

export type Role = "owner" | "editor" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person's role on the document, or null if they have none (or the id isn't even a uuid). */
export async function roleOf(db: Db, documentId: string, userId: string): Promise<Role | null> {
  if (!UUID.test(documentId)) return null;
  const { rows } = await db.query<{ role: Role }>("select role from members where document_id = $1 and user_id = $2", [documentId, userId]);
  return rows[0]?.role ?? null;
}

export const atLeast = (role: Role | null, needed: Role) => role !== null && RANK[role] >= RANK[needed];
