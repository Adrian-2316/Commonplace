import { useState } from "react";
import { api, type User } from "./api";
import { Mark } from "./App";

export function Login({ onIn, invited }: { onIn: (u: User) => void; invited: boolean }) {
  const [mode, setMode] = useState<"in" | "up">(invited ? "up" : "in");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onIn(mode === "in" ? await api.login(email, password) : await api.signup(email, name, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <form className="card narrow login" onSubmit={submit}>
        <div className="brand-row"><Mark size={34} /> <span className="brand">Commonplace</span></div>
        <h1>{invited ? "You've been invited to a page" : mode === "in" ? "Welcome back" : "Start writing together"}</h1>
        <p className="muted">
          {invited ? "Sign in or make an account to open it." : "Shared pages that stay in sync as you type, and keep working when you're offline."}
        </p>
        {mode === "up" && (
          <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="name" /></label>
        )}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            minLength={mode === "up" ? 10 : undefined} autoComplete={mode === "up" ? "new-password" : "current-password"} />
          {mode === "up" && <small className="muted">At least 10 characters.</small>}
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn wide" disabled={busy}>{mode === "in" ? "Sign in" : "Create account"}</button>
        <p className="switch">
          {mode === "in" ? "New here? " : "Already have an account? "}
          <button type="button" className="link" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}>
            {mode === "in" ? "Make an account" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
}
