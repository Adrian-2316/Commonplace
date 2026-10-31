import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { ago, api, type DocDetail, type Version } from "./api";
import { Avatar } from "./App";
import { extensions } from "./editorSetup";
import { Panel } from "./Share";

export function History({ detail, onClose }: { detail: DocDetail; onClose: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [picked, setPicked] = useState<Version | null>(null);
  const [preview, setPreview] = useState<Y.Doc | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const canEdit = detail.role !== "viewer";

  const load = () => api.versions(detail.id).then(setVersions);
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!picked) return setPreview(null);
    let live = true;
    api.version(detail.id, picked.id).then(({ state }) => {
      if (!live) return;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Uint8Array.from(atob(state), (c) => c.charCodeAt(0)));
      setPreview(doc);
    });
    return () => { live = false; };
  }, [picked, detail.id]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.saveVersion(detail.id, label);
    setLabel("");
    setNote("Saved. You can come back to this version any time.");
    load();
  };
  const restore = async () => {
    if (!picked) return;
    await api.restore(detail.id, picked.id);
    setNote("Restored for everyone. What was there before is saved as a version too, so nothing is lost.");
    setPicked(null);
    load();
  };

  return (
    <Panel title="History" onClose={onClose} wide>
      <div className="history">
        <div className="history-list">
          {canEdit && (
            <form className="save-version" onSubmit={save}>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name this version…" maxLength={80} required />
              <button className="btn sm">Save</button>
            </form>
          )}
          {note && <p className="note">{note}</p>}
          <ul>
            {versions?.map((v) => (
              <li key={v.id}>
                <button className={`version ${picked?.id === v.id ? "on" : ""}`} onClick={() => setPicked(v)}>
                  {v.by ? <Avatar name={v.by} color={v.color ?? "#999"} size={24} /> : <span className="auto-dot" />}
                  <span className="grow">
                    <b>{v.label ?? "Autosaved"}</b>
                    <small className="muted">{v.by ?? "While you were writing"} · {ago(v.createdAt)}</small>
                  </span>
                </button>
              </li>
            ))}
            {versions?.length === 0 && <li className="muted small">Versions appear here as the page changes, about every ten minutes of writing.</li>}
          </ul>
        </div>
        <div className="history-preview">
          {preview && picked ? (
            <>
              <div className="preview-head">
                <span><b>{picked.label ?? "Autosaved"}</b> <span className="muted">· {new Date(picked.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span></span>
                {canEdit && <button className="btn sm" onClick={restore}>Restore this version</button>}
              </div>
              <Preview key={picked.id} doc={preview} />
            </>
          ) : (
            <p className="muted center">Pick a version to read it as it was.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Preview({ doc }: { doc: Y.Doc }) {
  const editor = useEditor({ extensions: useMemo(() => extensions(doc), [doc]), editable: false, editorProps: { attributes: { class: "prose small-prose" } } }, [doc]);
  return <EditorContent editor={editor} />;
}
