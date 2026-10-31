import { HocuspocusProvider } from "@hocuspocus/provider";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { api, localStoreName, type DocDetail, type User } from "./api";
import { Avatar, Icon, Mark } from "./App";
import { extensions } from "./editorSetup";
import { History } from "./History";
import { Share } from "./Share";

type Status = "connecting" | "saved" | "saving" | "offline" | "denied";
type Peer = { clientId: number; name: string; color: string };

export function DocPage({ id, me, onLost }: { id: string; me: User; onLost: (e: unknown) => void }) {
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [panel, setPanel] = useState<"share" | "history" | null>(null);

  const refresh = () => api.document(id).then(setDetail, (e) => { onLost(e); setMissing(e.message); });
  useEffect(() => void refresh(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) {
    return (
      <div className="center-card">
        <div className="card narrow">
          <h2>Can't open this page</h2>
          <p className="muted">{missing}</p>
          <a className="btn" href="#/">Back to your pages</a>
        </div>
      </div>
    );
  }
  if (!detail) return <div className="splash" />;
  return (
    <>
      <Writing key={id} id={id} me={me} detail={detail} onPanel={setPanel} />
      {panel === "share" && <Share detail={detail} me={me} onClose={() => setPanel(null)} onChanged={refresh} />}
      {panel === "history" && <History detail={detail} onClose={() => setPanel(null)} />}
    </>
  );
}

function Writing({ id, me, detail, onPanel }: { id: string; me: User; detail: DocDetail; onPanel: (p: "share" | "history") => void }) {
  const [session, setSession] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [canEdit, setCanEdit] = useState(detail.role !== "viewer");
  const [ready, setReady] = useState(false);

  // One Y.Doc per open page: kept in IndexedDB on this device, and in sync with everyone through the server.
  useEffect(() => {
    let alive = true; // React may set this up twice in development; only the latest set may change state
    setReady(false);
    const doc = new Y.Doc();
    const local = new IndexeddbPersistence(localStoreName(me.id, id), doc);
    const provider = new HocuspocusProvider({
      url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`,
      name: id,
      document: doc,
      token: "session", // the real credential is the session cookie the browser sends with the handshake
    });
    const update = () => {
      if (!navigator.onLine || provider.configuration.websocketProvider.status !== "connected") setStatus((s) => (s === "denied" ? s : "offline"));
      else setStatus(provider.hasUnsyncedChanges ? "saving" : "saved");
    };
    const onPeers = () => {
      const list: Peer[] = [];
      provider.awareness?.getStates().forEach((s, clientId) => {
        if (clientId !== doc.clientID && s.user) list.push({ clientId, name: s.user.name, color: s.user.color });
      });
      setPeers(list);
    };
    provider.on("status", update);
    addEventListener("online", update);
    addEventListener("offline", update);
    provider.on("synced", update);
    provider.on("unsyncedChanges", update);
    provider.on("authenticated", ({ scope }: { scope: string }) => setCanEdit(scope === "read-write"));
    provider.on("authenticationFailed", () => setStatus("denied"));
    provider.awareness?.on("change", onPeers);
    // Show the editor only once the page's content has arrived, from the server or from this device.
    // An editor bound to an empty document fills in a blank title, which would then merge into the real one.
    // (The provider's "synced" event can fire before the content arrives, so we watch the content itself.)
    const fragment = doc.getXmlFragment("default");
    const check = () => alive && (fragment.length > 0 || (detail.empty && provider.isSynced)) && setReady(true);
    fragment.observe(check);
    provider.on("synced", check);
    local.on("synced", check);
    setSession({ doc, provider });
    return () => {
      alive = false;
      fragment.unobserve(check);
      removeEventListener("online", update);
      removeEventListener("offline", update);
      provider.destroy();
      local.destroy();
      doc.destroy();
    };
  }, [id, me.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="writing">
      <header className="bar">
        <a className="back" href="#/" title="All pages"><Mark size={26} /><Icon d="M15 18l-6-6 6-6" size={16} /></a>
        <DocTitle doc={session?.doc} />
        <StatusPill status={status} />
        <div className="bar-right">
          <div className="presence" aria-label="People here now">
            {peers.slice(0, 5).map((p) => <Avatar key={p.clientId} name={p.name} color={p.color} title={`${p.name} is here`} />)}
            <Avatar name={me.name} color={me.color} title="You" />
          </div>
          <button className="btn ghost sm" onClick={() => onPanel("history")}><Icon d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" size={16} /> <span className="hide-sm">History</span></button>
          {detail.role === "owner" ? (
            <button className="btn sm" onClick={() => onPanel("share")}><Icon d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" size={16} /> <span className="hide-sm">Share</span></button>
          ) : (
            <span className="chip hide-sm">{canEdit ? "Can edit" : "Can view"}</span>
          )}
        </div>
      </header>

      {status === "denied" ? (
        <div className="notice">You don't have access to this page any more. <a href="#/">Back to your pages</a></div>
      ) : !canEdit ? (
        <div className="notice soft">You can read this page and watch others write, but not change it.</div>
      ) : null}

      {session && ready && <Page key={session.doc.guid} doc={session.doc} provider={session.provider} me={me} canEdit={canEdit && status !== "denied"} />}
    </div>
  );
}

/** The title lives in the document itself (its first heading), so it updates live for everyone. */
function DocTitle({ doc }: { doc?: Y.Doc }) {
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (!doc) return;
    const f = doc.getXmlFragment("default");
    const read = () => {
      const first = f.get(0);
      const text = first instanceof Y.XmlElement ? first.toArray().map((n) => (n instanceof Y.XmlText ? n.toString().replace(/<[^>]+>/g, "") : "")).join("") : "";
      setTitle(text.trim());
    };
    read();
    f.observeDeep(read);
    return () => f.unobserveDeep(read);
  }, [doc]);
  useEffect(() => { document.title = `${title || "Untitled"} · Commonplace`; }, [title]);
  return <span className="doc-name">{title || "Untitled"}</span>;
}

function Page({ doc, provider, me, canEdit }: { doc: Y.Doc; provider: HocuspocusProvider; me: User; canEdit: boolean }) {
  // Built once per page. New extension objects on every render would make TipTap rebuild the editor,
  // which throws away the caret: typing would then land at the top of the page.
  const editor = useEditor({
    extensions: useMemo(() => extensions(doc, provider, { name: me.name, color: me.color }), [doc, provider, me.name, me.color]),
    editable: canEdit,
    editorProps: { attributes: { class: "prose", spellcheck: "true", "aria-label": "Page content" } },
  }, [doc, provider]);
  useEffect(() => { editor?.setEditable(canEdit); }, [editor, canEdit]);
  return (
    <>
      {editor && canEdit && <Toolbar editor={editor} />}
      <main className="sheet">
        <EditorContent editor={editor} />
      </main>
    </>
  );
}

function StatusPill({ status }: { status: Status }) {
  const text = { connecting: "Connecting…", saved: "Saved", saving: "Saving…", offline: "Offline · kept on this device", denied: "No access" }[status];
  return <span className={`status s-${status}`}><i />{text}</span>;
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }), bold: e.isActive("bold"), italic: e.isActive("italic"),
      mark: e.isActive("highlight"), bullets: e.isActive("bulletList"), tasks: e.isActive("taskList"), quote: e.isActive("blockquote"),
    }),
  });
  const chain = () => editor.chain().focus();
  const B = ({ on, label, run, children }: { on: boolean; label: string; run: () => void; children: React.ReactNode }) => (
    <button className={on ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={run} title={label} aria-label={label} aria-pressed={on}>{children}</button>
  );
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <B on={s.h2} label="Heading" run={() => chain().toggleHeading({ level: 2 }).run()}><b>H</b></B>
      <B on={s.bold} label="Bold" run={() => chain().toggleBold().run()}><b>B</b></B>
      <B on={s.italic} label="Italic" run={() => chain().toggleItalic().run()}><i className="serif">I</i></B>
      <B on={s.mark} label="Highlight" run={() => chain().toggleHighlight().run()}><Icon d="M9 11l-4 4v4h4l4-4M14 6l4 4M12 8l4 4-5 5-4-4z" size={16} /></B>
      <span className="sep" />
      <B on={s.bullets} label="List" run={() => chain().toggleBulletList().run()}><Icon d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" size={16} /></B>
      <B on={s.tasks} label="Checklist" run={() => chain().toggleTaskList().run()}><Icon d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9" size={16} /></B>
      <B on={s.quote} label="Quote" run={() => chain().toggleBlockquote().run()}><Icon d="M7 7h4v4H8v3M14 7h4v4h-3v3" size={16} /></B>
    </div>
  );
}
