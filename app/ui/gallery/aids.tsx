// The composer's typing aids (slice 3): the `@` and `/` menus, chips, attachments and the + menu, in one live copy.
import { useRef, useState } from "react";

import { type Attachment, AttachmentsContext, AttachmentTiles } from "../src/components/composer/attachments";
import { ComposerCard, ComposerFooter, ComposerTools } from "../src/components/composer/composer";
import { type Draft, isEmpty } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { fuzzyMatch, type Mention, type MentionGroup, type Mentions, PlusMenu, type SlashCommand } from "../src/components/composer/menus";
import { SendButton } from "../src/components/composer/send-button";
import { Toaster } from "../src/components/toast";
import { ModelPill, openChip } from "./composer";
import { Section } from "./parts";
import picture from "./sample.svg?no-inline";

const noop = () => {};
const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });

const FILES: Mention[] = [
  { id: "f1", type: "file", label: "app/ui/src/components/composer/field.tsx", name: "field.tsx", detail: "app/ui/src/components/composer" },
  { id: "f2", type: "file", label: "app/ui/src/components/composer/menus.tsx", name: "menus.tsx", detail: "app/ui/src/components/composer" },
  { id: "f3", type: "folder", label: "app/ui/src/components/composer", name: "composer", detail: "app/ui/src/components" },
  { id: "f4", type: "file", label: "../brigadier-plan/PLAN.md", name: "PLAN.md", detail: "docs" },
  { id: "f5", type: "file", label: "app/ui/src/theme.css", name: "theme.css", detail: "app/ui/src" },
  { id: "f6", type: "file", label: "docs/spec.pdf", name: "spec.pdf", detail: "docs" },
  { id: "f7", type: "file", label: "data/usage.csv", name: "usage.csv", detail: "data" },
  { id: "f8", type: "file", label: "design/roadmap.pptx", name: "roadmap.pptx", detail: "design" },
  { id: "f9", type: "file", label: "app/ui/gallery/sample.svg", name: "sample.svg", detail: "app/ui/gallery" },
  { id: "f10", type: "file", label: "crates/core/src/state.rs", name: "state.rs", detail: "crates/core/src" },
  { id: "f11", type: "file", label: "package.json", name: "package.json", detail: "" },
];
const CHATS: Mention[] = [
  { id: "c1", type: "chat", label: "Fix the queue's drag order", hint: "2h" },
  { id: "c2", type: "chat", label: "Composer slice 3", hint: "yesterday" },
];
export const COMMANDS: SlashCommand[] = [
  { id: "compact", kind: "command", label: "/compact", description: "Save the context so far", instant: true },
  { id: "review", kind: "command", label: "/review", description: "Review the changes", instant: false },
  { id: "model", kind: "command", label: "/model", description: "Pick another model", disabled: true, hint: "While working", instant: true },
  { id: "skill-docs", kind: "skill", label: "/docs", description: "Write the docs for a change", instant: false },
  { id: "skill-kit", kind: "skill", label: "/kit", description: "Port a component to the kit", instant: false },
  { id: "mcp-triage", kind: "mcp", source: "issues", label: "/issues:triage", description: "Sort the new issues by area and urgency", instant: false },
];

/** Rust's stand-in search: files, folders and chats matching the query, each under its heading; with nothing typed, a hint for files. */
export function search(query: string): MentionGroup[] {
  const matching = (items: Mention[]) => items.filter((item) => fuzzyMatch(item.name ?? item.label, query));
  const files = matching(FILES.filter((item) => item.type === "file"));
  return [
    query === "" ? { title: "Files", items: [], note: "Type to search files" } : { title: "Files", items: files },
    { title: "Folders", items: matching(FILES.filter((item) => item.type === "folder")) },
    { title: "Chats", items: matching(CHATS) },
  ];
}

const mention = (id: string, type: "file" | "folder" | "chat", label: string) => ({ kind: "mention", id, type, label }) as const;
const command = (id: string, type: "command" | "skill" | "mcp", label: string) => ({ kind: "command", id, type, label }) as const;
/** Every kind a chip can name, so they read side by side from the start. */
const EVERY_KIND = draft(
  command("review", "command", "/review"),
  " ",
  command("skill-docs", "skill", "/docs"),
  " ",
  command("mcp-triage", "mcp", "/issues:triage"),
  " ",
  mention("f1", "file", "app/ui/src/components/composer/field.tsx"),
  " ",
  mention("f4", "file", "../brigadier-plan/PLAN.md"),
  " ",
  mention("f6", "file", "docs/spec.pdf"),
  " ",
  mention("f7", "file", "data/usage.csv"),
  " ",
  mention("f3", "folder", "app/ui/src/components/composer"),
  " ",
  mention("c1", "chat", "Fix the queue's drag order"),
  " ",
);

/** The live copy: `@` and `/` open their menus, a pasted image or long text becomes a chip, + adds files. */
function Live() {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(false);
  const [results, setResults] = useState<Mentions["results"]>(null);
  const [attachments, setAttachments] = useState<ReadonlyMap<string, Attachment>>(new Map());
  const [tiles, setTiles] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const put = (attachment: Attachment) => setAttachments((all) => new Map(all).set(attachment.id, attachment));
  // Rust's stand-in: stored a moment later; images then show the sample picture.
  const attach = (id: string, file: File, inText: boolean) => {
    const base = { id, name: file.name, mime: file.type };
    put({ ...base, state: "uploading" });
    if (!inText) setTiles((list) => [...list, id]);
    setTimeout(() => put({ ...base, state: "ready", url: file.type.startsWith("image/") ? picture : undefined }), 900);
  };
  const commands = { commands: COMMANDS, onRun: (command: SlashCommand) => setLog((list) => [...list, `ran ${command.label}`]) };
  const send = () => {
    const parts = field.current!.parts();
    if (isEmpty({ parts, attachmentIds: tiles })) return;
    setLog((list) => [...list, parts.map((part) => (typeof part === "string" ? part : part.kind === "mention" ? `@${part.label}` : part.kind === "command" ? part.label : `[${part.kind}]`)).join("")]);
    field.current!.set([]);
    setTiles([]);
  };
  return (
    <div className="flex w-full max-w-reading flex-col gap-3 pt-80">
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {log.map((each, at) => (
          <li key={at} className="truncate">
            {each}
          </li>
        ))}
      </ol>
      <ComposerCard>
        <AttachmentsContext value={attachments}>
          <AttachmentTiles ids={tiles} onRemove={(id) => setTiles((list) => list.filter((each) => each !== id))} />
        </AttachmentsContext>
        <ComposerField
          ref={field}
          initial={EVERY_KIND}
          placeholder="Type @ or /, or paste an image"
          attachments={attachments}
          // Rust's stand-in answers a moment later, echoing the query.
          mentions={{ results, onQuery: (query) => query !== null && setTimeout(() => setResults({ query, groups: search(query) }), 120) }}
          commands={commands}
          onAttach={attach}
          onOpen={openChip}
          onChange={(parts) => setEmpty(isEmpty(draft(...parts)))}
          onSubmit={send}
        />
        <ComposerFooter>
          <ComposerTools>
            <PlusMenu field={field} commands={commands} chats={CHATS} onFiles={(files) => files.forEach((file) => attach(crypto.randomUUID(), file, false))} />
          </ComposerTools>
          <ModelPill />
          <SendButton empty={empty && tiles.length === 0} running={false} canStop={false} onSend={send} onStop={noop} />
        </ComposerFooter>
      </ComposerCard>
    </div>
  );
}

export function AidsGallery() {
  return (
    <Section title="Typing aids: @ and / menus, chips, attachments">
      <Live />
      <Toaster />
    </Section>
  );
}
