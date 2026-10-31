import { useEffect, useState } from "react";
import { api, forgetLocalCopies, Unauthorized, type User } from "./api";
import { Login } from "./Login";
import { Home } from "./Home";
import { DocPage } from "./DocPage";

type Route = { page: "home" } | { page: "doc"; id: string } | { page: "join"; token: string };

function parse(): Route {
  const [p, arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (p === "d" && arg) return { page: "doc", id: arg };
  if (p === "join" && arg) return { page: "join", token: arg };
  return { page: "home" };
}

export const go = (hash: string) => { location.hash = hash; };

export function App() {
  const [me, setMe] = useState<User | null | false>(null);
  const [route, setRoute] = useState(parse);

  useEffect(() => {
    api.me().then(setMe, () => setMe(false));
    const on = () => setRoute(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  if (me === null) return <div className="splash" />;
  if (me === false) return <Login onIn={setMe} invited={route.page === "join"} />;

  const signOut = async () => {
    await api.logout().catch(() => {});
    await forgetLocalCopies(me.id);
    setMe(false);
    go("/");
  };
  const lost = (e: unknown) => { if (e instanceof Unauthorized) setMe(false); };

  if (route.page === "join") return <Join token={route.token} />;
  if (route.page === "doc") return <DocPage key={route.id} id={route.id} me={me} onLost={lost} />;
  return <Home me={me} onSignOut={signOut} onLost={lost} />;
}

function Join({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.join(token).then(({ id }) => go(`/d/${id}`), (e) => setError(e.message));
  }, [token]);
  return (
    <div className="center-card">
      <div className="card narrow">
        {error ? <><h2>That link didn't work</h2><p className="muted">{error}</p><a className="btn" href="#/">Go to your pages</a></> : <p className="muted">Opening the page…</p>}
      </div>
    </div>
  );
}

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M10 9h9a3 3 0 0 1 3 3v11H13a3 3 0 0 1-3-3z" fill="var(--paper)" />
      <path d="M13 13h6M13 16.5h6M13 20h3.5" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function Avatar({ name, color, size = 30, title }: { name: string; color: string; size?: number; title?: string }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.4 }} title={title ?? name}>
      {name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
