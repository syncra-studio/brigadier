// What Overnight's mockup is drawn with: the fake session and its night, a window to draw it in, the pill and the composer.
import { type ReactNode, useRef, useState } from "react";

import { ComposerPill, ContextRing, PlusButton, SharedComposer } from "../src/components/composer/composer";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { CommandRow, ComposerMenu, ComposerMenuOption, MenuHeading } from "../src/components/composer/menus";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import type { PendingQuestion } from "../src/components/composer/question";
import { SendButton } from "../src/components/composer/send-button";
import { cx } from "../src/components/cx";
import { ROW, StepIcon, Words } from "../src/components/thread/activity-row";
import { AssistantMessage, UserBubble } from "../src/components/thread/message";
import { BranchAlt, Folder, Branch, ChevronDown } from "../src/icons";
import { RAIL_PILL, UtilityBar } from "../src/home/pills";
import { BrigadierMark } from "../src/onboarding/mark";
import type { Runner } from "../src/session/composer";
import { BrigadeToggle } from "../src/sessions/brigade";
import { OVERNIGHT } from "../src/sessions/overnight";
import { Markdown } from "../src/thread/markdown";

/** Rust's stand-in: it answers nothing. */
export const run: Runner = async () => ({ ok: false, error: "Not in this mockup" });
export const noop = () => {};

export const TITLE = "Export a chat as Markdown";
export const TASK = "Build export for chats: a chat saved as a Markdown file I can open in Obsidian. Keep code blocks, images and who said what.";
export const PLAN = "I have the plan: an **Export** row in the chat’s menu, Rust writes the file, images go beside it. Three things are still open before I build it.";

/** The last questions, each with the agent's own pick. */
export const QUESTIONS: PendingQuestion = {
  id: "q-night",
  title: "Before you go",
  items: [
    {
      text: "What should tool steps look like in the file?",
      options: [
        { label: "Folded, one line each", description: "Opens in Obsidian as a callout" },
        { label: "Left out", description: "Only your messages and the replies" },
        { label: "In full", description: "Every command with its output" },
      ],
      recommended: 0,
      multiSelect: false,
    },
    {
      text: "Is PDF part of this?",
      options: [{ label: "No, Markdown only" }, { label: "Yes, if it needs no paid library" }],
      recommended: 1,
      multiSelect: false,
    },
    {
      text: "May I push the branch and open a draft PR when it’s done?",
      options: [{ label: "Keep it on this Mac", description: "You review and land it in the morning" }, { label: "Push and open a draft PR" }],
      recommended: 0,
      multiSelect: false,
    },
  ],
};

/** The night's outcome. */
export const DONE = [
  { id: "menu", title: "Export in a chat’s menu", proof: "Opened in the app and used on 3 chats", more: "Ran it on a 412-message chat, one with 9 images and an empty one. Each file opened in Obsidian with its images. Screenshots of all three are kept." },
  { id: "rust", title: "Rust writes the file and its images", proof: "18 checks pass, cargo build clean", more: "`cargo test export` · 18 passed, 0 failed. 1.2 s for the 412-message chat. A full disk and a folder without access both say so and leave no half file." },
  { id: "words", title: "Code blocks, names and times kept", proof: "Compared with 4 chats by a second agent", more: "A reviewer on another model read each file against its chat: 2 lost code fences found, fixed, read again, none left." },
  { id: "review", title: "Reviewed against itself, twice", proof: "7 findings, 7 fixed", more: "Round 1 found 5, round 2 found 2: all fixed. Round 3 found nothing." },
];
export const NOT_DONE = { title: "PDF export", why: "Every library that keeps code blocks is paid or adds 90 MB to the app. Stopped there, as you said.", next: "Try printing from the browser tab" };
export const DECIDED = [
  { id: "name", title: "Files are named by title and date", why: "Obsidian links by name; 4 of 5 other apps do the same", other: "Name by id" },
  { id: "images", title: "Images sit in a folder beside the file", why: "Embedded images made one file 31 MB", other: "Embed them" },
  { id: "edits", title: "An edited message keeps only its last text", why: "Complaints about duplicates in two rival exports", other: "Keep every version" },
];
export const WAITING: PendingQuestion = {
  id: "q-morning",
  items: [
    {
      text: "Should archived chats have Export too?",
      options: [{ label: "Yes, the same row" }, { label: "No, restore first" }],
      recommended: 0,
      multiSelect: false,
    },
  ],
};
export const RESEARCH = "34 sources read, 5 rival exports tried";

/** One moment of the night, titled, in a window like the app's main panel. */
export function Scene({ title, note, tall = false, look, children }: { title: string; note: string; tall?: boolean; look?: string; children: ReactNode }) {
  return (
    <section className="mx-auto flex w-full max-w-5xl shrink-0 flex-col gap-2">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        {title}
        <span className="text-label font-normal text-muted-foreground">{note}</span>
      </h2>
      <div className={cx("flex flex-col overflow-hidden rounded-surface border border-border transition-colors", look ?? "bg-background", tall ? "min-h-160" : "min-h-104")}>{children}</div>
    </section>
  );
}

/** A thread over its composer. `empty` centres the new chat's hero instead. */
export function Panel({ thread, composer }: { thread: ReactNode; composer: ReactNode }) {
  return (
    <>
      <div className="flex flex-1 flex-col justify-end px-scrollbar">
        <div className="mx-auto box-content flex w-full max-w-reading flex-col gap-5 px-4 pt-8 pb-6">{thread}</div>
      </div>
      {composer}
    </>
  );
}

export const Hero = () => (
  <div className="flex flex-1 shrink-0 flex-col items-center justify-end gap-5 px-4 pt-14 pb-11 select-none">
    <BrigadierMark className="hero-mark size-16 text-foreground opacity-60" />
    <h3 className="text-center font-display text-hero font-normal tracking-hero">What should we build in brigadier?</h3>
  </div>
);

export const ProjectRail = () => (
  <UtilityBar>
    <ComposerPill className={RAIL_PILL}>
      <Folder />
      brigadier
    </ComposerPill>
    <ComposerPill className={RAIL_PILL}>
      <BranchAlt />
      New worktree
    </ComposerPill>
    <ComposerPill className={RAIL_PILL}>
      <Branch />
      main
    </ComposerPill>
  </UtilityBar>
);

export const You = ({ id, children }: { id: string; children: string }) => <UserBubble keep={id} text={children} />;
export const Says = ({ id, children }: { id: string; children: string }) => (
  <AssistantMessage text={children} final={false}>
    <Markdown text={children} keep={id} />
  </AssistantMessage>
);
export const Step = ({ kind, verb, object, live }: { kind: Parameters<typeof StepIcon>[0]["kind"]; verb: string; object?: string; live?: boolean }) => (
  <p className={ROW}>
    <StepIcon kind={kind} />
    <Words verb={verb} object={object} live={live} />
  </p>
);

/** Full access while the night lasts; the level from before comes back after. */
export function Level({ overnight }: { overnight: boolean }) {
  const [level, setLevel] = useState<PermissionLevel>("auto");
  return <PermissionPicker value={overnight ? "full" : level} onChange={setLevel} />;
}

export function Brigade() {
  const [on, setOn] = useState(false);
  return <BrigadeToggle on={on} onChange={setOn} />;
}

/** The / menu, drawn open over the card. */
export const OvernightMenu = ({ onPick }: { onPick: () => void }) => (
  <ComposerMenu label="Commands">
    <MenuHeading>Commands</MenuHeading>
    <ComposerMenuOption selected onClick={onPick}>
      <CommandRow command={OVERNIGHT} query="over" />
    </ComposerMenuOption>
  </ComposerMenu>
);

/** The composer, as a session mounts it. */
export function FakeComposer({ look, rail, pills, menu, placeholder, initial, running = false, status, send }: { look?: string; rail?: ReactNode; pills?: ReactNode; menu?: ReactNode; placeholder: string; initial?: string; running?: boolean; status?: ReactNode; send?: ReactNode }) {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(!initial);
  return (
    <div className={look}>
      <SharedComposer
        rail={rail}
        plus={<PlusButton />}
        level={pills}
        status={status}
        ring={<ContextRing usedTokens={61_000} windowTokens={200_000} />}
        model={
          <ComposerPill>
            Opus 5.5 High
            <ChevronDown />
          </ComposerPill>
        }
        send={send ?? <SendButton empty={empty} running={running} canStop={running} onSend={() => field.current?.set([])} onStop={noop} />}
      >
        {menu}
        <ComposerField ref={field} placeholder={placeholder} initial={initial ? { parts: [initial], attachmentIds: [] } : undefined} onChange={(parts) => setEmpty(parts.every((part) => typeof part === "string" && !part.trim()))} onSubmit={noop} />
      </SharedComposer>
    </div>
  );
}

/** Room under the thread for the open menu, so it covers no words here. */
export const MenuRoom = () => <div className="h-18" />;
