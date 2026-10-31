import { useEffect, useState } from "react";
import { ago, api, type DocSummary, type User } from "./api";
import { Avatar, go, Icon, Mark } from "./App";

const ROLE: Record<string, string> = { owner: "Yours", editor: "Can edit", viewer: "Can view" };

export function Home({ me, onSignOut, onLost }: { me: User; onSignOut: () => void; onLost: (e: unknown) => void }) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  useEffect(() => void api.documents().then(setDocs, onLost), []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const { id } = await api.create();
    go(`/d/${id}`);
  };

  return (
    <div className="home">
      <header className="bar">
        <a className="brand-row" href="#/"><Mark /> <span className="brand">Commonplace</span></a>
        <div className="bar-right">
          <Avatar name={me.name} color={me.color} title={`Signed in as ${me.name}`} />
          <button className="btn ghost sm" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <main className="shelf">
        <div className="shelf-head">
          <div>
            <h1>Your pages</h1>
            <p className="muted">Everything you've written or been invited to, newest first.</p>
          </div>
          <button className="btn" onClick={create}><Icon d="M12 5v14M5 12h14" /> New page</button>
        </div>

        {docs === null ? null : docs.length === 0 ? (
          <div className="empty card">
            <h2>A blank page is waiting</h2>
            <p className="muted">Write something, then share a link. Everyone sees each other's typing as it happens.</p>
            <button className="btn" onClick={create}>Start a page</button>
          </div>
        ) : (
          <ul className="pages">
            {docs.map((d) => (
              <li key={d.id}>
                <a className="page-card" href={`#/d/${d.id}`}>
                  <span className="page-title">{d.title || "Untitled"}</span>
                  <span className="page-meta">
                    <span className="stack">
                      {d.people.slice(0, 4).map((p, i) => <Avatar key={i} name={p.name} color={p.color} size={24} />)}
                      {d.people.length > 4 && <span className="more">+{d.people.length - 4}</span>}
                    </span>
                    <span className="muted">Edited {ago(d.updatedAt)}</span>
                    <span className={`chip r-${d.role}`}>{ROLE[d.role]}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
