export type User = { id: string; email: string; name: string; color: string };
export type Role = "owner" | "editor" | "viewer";
export type DocSummary = { id: string; title: string; updatedAt: string; role: Role; people: { name: string; color: string }[] };
export type Person = { id: string; name: string; color: string; role: Role };
export type DocDetail = { id: string; title: string; updatedAt: string; role: Role; people: Person[]; empty: boolean };
export type Link = { id: string; role: Role; createdAt: string };
export type Version = { id: number; label: string | null; createdAt: string; by: string | null; color: string | null };

export class Unauthorized extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== "/api/login") throw new Unauthorized();
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error ?? `Something went wrong (${res.status}).`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  me: () => call<User>("GET", "/api/me"),
  login: (email: string, password: string) => call<User>("POST", "/api/login", { email, password }),
  signup: (email: string, name: string, password: string) => call<User>("POST", "/api/signup", { email, name, password }),
  logout: () => call<void>("POST", "/api/logout"),
  documents: () => call<DocSummary[]>("GET", "/api/documents"),
  create: () => call<{ id: string }>("POST", "/api/documents"),
  document: (id: string) => call<DocDetail>("GET", `/api/documents/${id}`),
  remove: (id: string) => call<void>("DELETE", `/api/documents/${id}`),
  setRole: (id: string, userId: string, role: Role) => call<void>("PATCH", `/api/documents/${id}/people/${userId}`, { role }),
  removePerson: (id: string, userId: string) => call<void>("DELETE", `/api/documents/${id}/people/${userId}`),
  links: (id: string) => call<Link[]>("GET", `/api/documents/${id}/links`),
  createLink: (id: string, role: Role) => call<{ token: string; role: Role }>("POST", `/api/documents/${id}/links`, { role }),
  revokeLink: (id: string, linkId: string) => call<void>("DELETE", `/api/documents/${id}/links/${linkId}`),
  join: (token: string) => call<{ id: string }>("POST", `/api/join/${token}`),
  versions: (id: string) => call<Version[]>("GET", `/api/documents/${id}/versions`),
  version: (id: string, versionId: number) => call<{ state: string }>("GET", `/api/documents/${id}/versions/${versionId}`),
  saveVersion: (id: string, label: string) => call<void>("POST", `/api/documents/${id}/versions`, { label }),
  restore: (id: string, versionId: number) => call<void>("POST", `/api/documents/${id}/versions/${versionId}/restore`),
};

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** Local copies of documents are kept per account, and removed when that account signs out on this device. */
export const localStoreName = (userId: string, docId: string) => `commonplace:${userId}:${docId}`;

export async function forgetLocalCopies(userId: string) {
  if (!("databases" in indexedDB)) return;
  for (const db of await indexedDB.databases()) {
    if (db.name?.startsWith(`commonplace:${userId}:`)) indexedDB.deleteDatabase(db.name);
  }
}
