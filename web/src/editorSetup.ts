import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Document from "@tiptap/extension-document";
import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";

/** Every page starts with its title, so the first block is always a heading. */
const TitledDocument = Document.extend({ content: "heading block*" });

export function extensions(doc: Y.Doc, provider?: HocuspocusProvider, user?: { name: string; color: string }) {
  return [
    TitledDocument,
    StarterKit.configure({
      document: false,
      undoRedo: false, // Yjs keeps its own history, per person
      trailingNode: { node: "paragraph" }, // not a heading, which is what a "heading block*" document would default to
      link: { openOnClick: false, autolink: true, protocols: ["http", "https", "mailto"] },
    }),
    Highlight,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({
      placeholder: ({ node, pos }) => (pos === 0 && node.type.name === "heading" ? "Untitled" : "Write something…"),
      showOnlyCurrent: false,
    }),
    Collaboration.configure({ document: doc, field: "default" }),
    ...(provider && user ? [CollaborationCaret.configure({ provider, user })] : []),
  ];
}
