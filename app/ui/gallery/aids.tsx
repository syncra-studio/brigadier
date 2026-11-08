// The composer's typing aids (slice 3): the `@` and `/` menus, chips, attachments and the + menu, frozen, plus one live copy.
import { type ReactNode, useRef, useState } from "react";

import { type Attachment, AttachmentsContext, AttachmentTiles, MentionIcon } from "../src/components/composer/attachments";
import { ComposerCard, ComposerFooter, ComposerTools } from "../src/components/composer/composer";
import { type Draft, isEmpty } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import {
  ComposerMenu,
  ComposerMenuOption,
  fuzzyMatch,
  MatchedText,
  type Mention,
  type MentionGroup,
  type Mentions,
  MenuHeading,
  MenuNote,
  PlusMenu,
  type SlashCommand,
} from "../src/components/composer/menus";
import { SendButton } from "../src/components/composer/send-button";
import { MenuRow } from "../src/components/menu";
import { Sparkle, Terminal } from "../src/icons";
import { Card, ModelPill } from "./composer";
import { Row, Section, State } from "./parts";
import picture from "./sample.svg?no-inline";

const noop = () => {};
const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });

const FILES: Mention[] = [
  { id: "f1", type: "file", label: "app/ui/src/components/composer/field.tsx", name: "field.tsx", detail: "app/ui/src/components/composer" },
  { id: "f2", type: "file", label: "app/ui/src/components/composer/menus.tsx", name: "menus.tsx", detail: "app/ui/src/components/composer" },
  { id: "f3", type: "folder", label: "app/ui/src/components/composer", name: "composer", detail: "app/ui/src/components" },
  { id: "f4", type: "file", label: "../brigadier-plan/PLAN.md", name: "PLAN.md", detail: "docs" },
  { id: "f5", type: "file", label: "app/ui/src/theme.css", name: "theme.css", detail: "app/ui/src" },
];
const CHATS: Mention[] = [
  { id: "c1", type: "chat", label: "Fix the queue's drag order", hint: "2h" },
  { id: "c2", type: "chat", label: "Composer slice 3", hint: "yesterday" },
];
const COMMANDS: SlashCommand[] = [
  { id: "compact", label: "/compact", description: "Save the context so far", icon: <Terminal /> },
  { id: "review", label: "/review", description: "Review the changes", icon: <Terminal />, text: "/review" },
  { id: "model", label: "/model", description: "Pick another model", icon: <Terminal />, disabled: true, hint: "While working" },
  { id: "skill-docs", label: "/docs", description: "Write the docs for a change", icon: <Sparkle />, group: "Skills", text: "/docs" },
  { id: "skill-kit", label: "/kit", description: "Port a component to the kit", icon: <Sparkle />, group: "Skills", text: "/kit" },
];

/** Rust's stand-in search: the files and chats matching the query, the files ranked. */
function search(query: string): MentionGroup[] {
  const files = FILES.filter((file) => fuzzyMatch(file.name ?? file.label, query));
  const chats = CHATS.filter((chat) => fuzzyMatch(chat.label, query));
  return [
    { title: null, items: files },
    { title: "Chats", items: chats, note: chats.length === 0 && query === "" ? "No other chats" : undefined },
  ];
}

const ATTACHMENTS = new Map<string, Attachment>(
  [
    { id: "i1", name: "screenshot.png", mime: "image/png", state: "ready", url: picture },
    { id: "i2", name: "photo.png", mime: "image/png", state: "uploading" },
    { id: "p1", name: "Pasted text.txt", mime: "text/plain", state: "ready" },
    { id: "t1", name: "design/spec.pdf", mime: "application/pdf", state: "ready" },
    { id: "t2", name: "notes.md", mime: "text/markdown", state: "uploading" },
    { id: "t3", name: "huge-video.mov", mime: "video/quicktime", state: "failed", error: "Over the 20 MB limit" },
    { id: "t4", name: "diagram.png", mime: "image/png", state: "ready", url: picture },
    { id: "t5", name: "archive.zip", mime: "application/zip", state: "ready" },
  ].map((each) => [each.id, each as Attachment]),
);

/** The `@` menu as it shows for `query`, its first row highlighted. */
function FrozenMentions({ query }: { query: string }) {
  const groups = search(query);
  const empty = groups.every((group) => group.items.length === 0 && !group.note);
  let at = 0;
  return (
    <ComposerMenu label="Mentions">
      {groups.map((group, index) =>
        group.items.length === 0 && !group.note ? null : (
          <div key={index} className="contents">
            {group.title && <MenuHeading>{group.title}</MenuHeading>}
            {group.items.map((item) => (
              <ComposerMenuOption key={item.id} selected={at++ === 0}>
                <MenuRow
                  icon={<MentionIcon type={item.type} label={item.label} />}
                  title={<MatchedText text={item.name ?? item.label} query={query} />}
                  detail={item.detail}
                  hint={item.hint}
                  mono
                />
              </ComposerMenuOption>
            ))}
            {group.note && <MenuNote>{group.note}</MenuNote>}
          </div>
        ),
      )}
      {empty && <MenuNote>No results</MenuNote>}
    </ComposerMenu>
  );
}

/** The `/` menu as it shows for `query`. */
function FrozenCommands({ query }: { query: string }) {
  const shown = COMMANDS.filter((command) => fuzzyMatch(command.label, query));
  return (
    <ComposerMenu label="Slash commands">
      {shown.map((command, index) => (
        <div key={command.id} className="contents">
          {command.group && command.group !== shown[index - 1]?.group && <MenuHeading>{command.group}</MenuHeading>}
          <ComposerMenuOption selected={index === 0} disabled={command.disabled}>
            <MenuRow icon={command.icon} title={<MatchedText text={command.label} query={query} />} detail={command.description} hint={command.hint} />
          </ComposerMenuOption>
        </div>
      ))}
      {shown.length === 0 && <MenuNote>No commands</MenuNote>}
    </ComposerMenu>
  );
}

const Tall = ({ children }: { children: ReactNode }) => <div className="pt-80">{children}</div>;

/** The live copy: `@` and `/` open their menus, a pasted image or long text becomes a chip, + adds files. */
function Live() {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(true);
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
  const send = () => {
    const parts = field.current!.parts();
    if (isEmpty({ parts, attachmentIds: tiles })) return;
    setLog((list) => [...list, parts.map((part) => (typeof part === "string" ? part : part.kind === "mention" ? `@${part.label}` : `[${part.kind}]`)).join("")]);
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
          placeholder="Type @ or /, or paste an image"
          attachments={attachments}
          // Rust's stand-in answers a moment later, echoing the query.
          mentions={{ results, onQuery: (query) => query !== null && setTimeout(() => setResults({ query, groups: search(query) }), 120) }}
          commands={{ commands: COMMANDS, onRun: (command) => setLog((list) => [...list, `ran ${command.label}`]) }}
          onAttach={attach}
          onChange={(parts) => setEmpty(isEmpty(draft(...parts)))}
          onSubmit={send}
        />
        <ComposerFooter>
          <ComposerTools>
            <PlusMenu onFiles={(files) => files.forEach((file) => attach(crypto.randomUUID(), file, false))} />
          </ComposerTools>
          <ModelPill />
          <SendButton empty={empty && tiles.length === 0} running={false} canStop={false} onSend={send} onStop={noop} />
        </ComposerFooter>
      </ComposerCard>
    </div>
  );
}

export function AidsGallery() {
  const file = { kind: "mention", id: "f1", type: "file", label: "app/ui/src/components/composer/field.tsx" } as const;
  const folder = { kind: "mention", id: "f3", type: "folder", label: "app/ui/src/components/composer" } as const;
  const chat = { kind: "mention", id: "c1", type: "chat", label: "Fix the queue's drag order" } as const;
  return (
    <Section title="Composer typing aids">
      <Row name="@ menu">
        <State label="Typed @, results and chats">
          <Tall>
            <Card initial={draft("Look at @")} menu={<FrozenMentions query="" />} />
          </Tall>
        </State>
        <State label="@fi: matched letters bright">
          <Tall>
            <Card initial={draft("Look at @fi")} menu={<FrozenMentions query="fi" />} />
          </Tall>
        </State>
        <State label="Nothing matches">
          <Tall>
            <Card initial={draft("Look at @zzz")} menu={<FrozenMentions query="zzz" />} />
          </Tall>
        </State>
      </Row>
      <Row name="/ menu">
        <State label="Typed /, a disabled command, Skills">
          <Tall>
            <Card initial={draft("/")} menu={<FrozenCommands query="" />} />
          </Tall>
        </State>
        <State label="/re">
          <Tall>
            <Card initial={draft("/re")} menu={<FrozenCommands query="re" />} />
          </Tall>
        </State>
        <State label="Nothing matches">
          <Tall>
            <Card initial={draft("/zzz")} menu={<FrozenCommands query="zzz" />} />
          </Tall>
        </State>
      </Row>
      <Row name="Chips in the text">
        <State label="Mentions: file, folder, chat">
          <Card initial={draft("Compare ", file, " with ", folder, " as we said in ", chat)} />
        </State>
        <State label="Images: stored, storing; a pasted text">
          <Card
            attachments={ATTACHMENTS}
            initial={draft("Like this ", { kind: "image", attachmentId: "i1" }, " not this ", { kind: "image", attachmentId: "i2" }, " and read ", { kind: "paste", attachmentId: "p1", preview: "Error: connect ECONNREFUSED 127.0.0.1:5432 at TCPConnectWrap.afterConnect" })}
          />
        </State>
      </Row>
      <Row name="Commands in the text">
        <State label="Picked, typed mid-sentence, in backticks; a path stays plain">
          <Card
            commands={{ commands: COMMANDS, onRun: noop }}
            initial={draft("/review the queue, then use the /docs skill. Not `/docs` here, and /usr/bin stays plain.\n```\n/kit in a code block\n```")}
          />
        </State>
      </Row>
      <Row name="Attachments">
        <State label="Images, files: ready, attaching, failed">
          <Card attachments={ATTACHMENTS} tiles={<AttachmentTiles ids={["t4", "i2", "t1", "t2", "t3", "t5"]} onRemove={noop} />} initial={draft("Here are the files")} />
        </State>
      </Row>
      <Row name="Live">
        <Live />
      </Row>
    </Section>
  );
}
