import { useEffect, useState } from "react";
import { ago, api, type DocDetail, type Link, type Role, type User } from "./api";
import { Avatar, Icon } from "./App";

export function Share({ detail, me, onClose, onChanged }: { detail: DocDetail; me: User; onClose: () => void; onChanged: () => void }) {
  const [links, setLinks] = useState<Link[]>([]);
  const [fresh, setFresh] = useState<{ url: string; role: Role } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.links(detail.id).then(setLinks, (e) => setError(e.message));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const make = async (role: Role) => {
    const { token } = await api.createLink(detail.id, role);
    setFresh({ url: `${location.origin}/#/join/${token}`, role });
    setCopied(false);
    load();
  };
  const copy = async () => {
    if (!fresh) return;
    await navigator.clipboard.writeText(fresh.url).catch(() => {});
    setCopied(true);
  };
  const act = (p: Promise<unknown>) => p.then(() => { onChanged(); load(); }, (e) => setError(e.message));

  return (
    <Panel title="Share this page" onClose={onClose}>
      <section>
        <h3>Invite with a link</h3>
        <p className="muted">Anyone who signs in with the link joins the page. You'll only see a link once, so copy it now.</p>
        <div className="row">
          <button className="btn sm" onClick={() => make("editor")}><Icon d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" size={15} /> Link to edit</button>
          <button className="btn ghost sm" onClick={() => make("viewer")}><Icon d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" size={15} /> Link to view</button>
        </div>
        {fresh && (
          <div className="fresh-link">
            <code>{fresh.url}</code>
            <button className="btn sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
        )}
        {links.length > 0 && (
          <ul className="links">
            {links.map((l) => (
              <li key={l.id}>
                <span>{l.role === "editor" ? "Edit link" : "View link"} <span className="muted">· made {ago(l.createdAt)}</span></span>
                <button className="link" onClick={() => act(api.revokeLink(detail.id, l.id))}>Turn off</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>People</h3>
        <ul className="people">
          {detail.people.map((p) => (
            <li key={p.id}>
              <Avatar name={p.name} color={p.color} />
              <span className="grow">{p.name}{p.id === me.id && <span className="muted"> (you)</span>}</span>
              {p.role === "owner" ? (
                <span className="chip">Owner</span>
              ) : (
                <>
                  <select value={p.role} onChange={(e) => act(api.setRole(detail.id, p.id, e.target.value as Role))} aria-label={`${p.name}'s access`}>
                    <option value="editor">Can edit</option>
                    <option value="viewer">Can view</option>
                  </select>
                  <button className="icon-btn" title={`Remove ${p.name}`} onClick={() => act(api.removePerson(detail.id, p.id))}><Icon d="M18 6L6 18M6 6l12 12" size={15} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">Changing someone's access takes effect straight away, even while they have the page open.</p>
      </section>
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}

export function Panel({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`panel ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon d="M18 6L6 18M6 6l12 12" /></button>
        </header>
        {children}
      </aside>
    </div>
  );
}
