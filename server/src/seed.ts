import * as Y from "yjs";
import { hashPassword } from "./auth.js";
import { titleOf } from "./collab.js";
import type { Db } from "./db.js";

/**
 * Demo data for local runs and screenshots: three people and a shared planning doc. Only runs with
 * SEED_DEMO=true and a DEMO_PASSWORD you choose, and only when the demo accounts don't exist yet.
 */
export async function seedDemo(db: Db) {
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) throw new Error("SEED_DEMO needs DEMO_PASSWORD (10+ characters)");
  const exists = await db.query("select 1 from users where email = 'ines@example.com'");
  if (exists.rowCount) return;

  const hash = await hashPassword(password);
  const people = [
    { email: "ines@example.com", name: "Inés", color: "#c2410c" },
    { email: "tom@example.com", name: "Tom", color: "#0f766e" },
    { email: "maya@example.com", name: "Maya", color: "#7c3aed" },
  ];
  const ids: string[] = [];
  for (const p of people) {
    const { rows } = await db.query<{ id: string }>("insert into users (email, name, color, password_hash) values ($1, $2, $3, $4) returning id",
      [p.email, p.name, p.color, hash]);
    ids.push(rows[0]!.id);
  }

  const doc = new Y.Doc();
  const f = doc.getXmlFragment("default");
  f.insert(0, [
    block("heading", { level: 1 }, "Spring catalogue launch"),
    block("paragraph", {}, [["Owner: Inés · Target: "], ["March 14", { bold: {} }], [" · Status: drafting"]]),
    block("heading", { level: 2 }, "What we're launching"),
    block("paragraph", {}, "Twelve new pieces for the table: olive wood boards, linen in two new colours, and a stoneware set made with a family workshop in Úbeda. The story is slow mornings."),
    list("bulletList", [
      "Photo shoot at the workshop, first week of February",
      "Product pages written in English and Spanish",
      "Newsletter to the 8,400 people on the list",
    ]),
    block("heading", { level: 2 }, "Before we ship"),
    tasks([
      ["Confirm stock counts with the workshop", true],
      ["Final prices for the stoneware set", false],
      ["Proofread the Spanish pages", false],
    ]),
    block("blockquote", {}, [block("paragraph", {}, "Keep the copy short. People skim on phones, so each page leads with the one thing that makes the piece special.")]),
    block("paragraph", {}, ""),
  ]);

  const { rows } = await db.query<{ id: string }>(
    "insert into documents (owner_id, state, title) values ($1, $2, $3) returning id",
    [ids[0], Buffer.from(Y.encodeStateAsUpdate(doc)), titleOf(doc)]);
  const docId = rows[0]!.id;
  await db.query(
    "insert into members (document_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'viewer')",
    [docId, ids[0], ids[1], ids[2]]);
  await db.query("insert into versions (document_id, label, state, created_by, created_at) values ($1, 'First draft', $2, $3, now() - interval '2 days')",
    [docId, Buffer.from(Y.encodeStateAsUpdate(doc)), ids[0]]);

  for (const [title, body] of [["Workshop visit notes", "Úbeda, Tuesday. The kiln runs twice a week."], ["Newsletter ideas", "Slow mornings, a recipe, one product."]] as const) {
    const d = new Y.Doc();
    d.getXmlFragment("default").insert(0, [block("heading", { level: 1 }, title), block("paragraph", {}, body)]);
    const r = await db.query<{ id: string }>("insert into documents (owner_id, state, title) values ($1, $2, $3) returning id",
      [ids[0], Buffer.from(Y.encodeStateAsUpdate(d)), title]);
    await db.query("insert into members (document_id, user_id, role) values ($1, $2, 'owner')", [r.rows[0]!.id, ids[0]]);
  }
}

type Run = [string, Record<string, object>?];

function block(name: string, attrs: Record<string, unknown>, content: string | Run[] | Y.XmlElement[]): Y.XmlElement {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string);
  if (Array.isArray(content) && content[0] instanceof Y.XmlElement) {
    el.insert(0, content as Y.XmlElement[]);
  } else {
    const text = new Y.XmlText();
    el.insert(0, [text]);
    const runs: Run[] = typeof content === "string" ? [[content]] : (content as Run[]);
    let at = 0;
    for (const [s, marks] of runs) {
      text.insert(at, s, marks ?? {});
      at += s.length;
    }
  }
  return el;
}

function list(name: string, items: string[]) {
  return block(name, {}, items.map((t) => block("listItem", {}, [block("paragraph", {}, t)])));
}

function tasks(items: [string, boolean][]) {
  return block("taskList", {}, items.map(([t, checked]) => block("taskItem", { checked }, [block("paragraph", {}, t)])));
}
