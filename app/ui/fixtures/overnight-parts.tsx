// What the Overnight variants share: the fake session and its night, a window to draw it in, the pill and the composer.
import { type ReactNode, useRef, useState } from "react";

import { ComposerPill, ContextRing, PillDivider, PlusButton, SharedComposer } from "../src/components/composer/composer";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { CommandRow, ComposerMenu, ComposerMenuOption, MenuHeading, type SlashCommand } from "../src/components/composer/menus";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import type { PendingQuestion } from "../src/components/composer/question";
import { SendButton } from "../src/components/composer/send-button";
import { cx } from "../src/components/cx";
import { ROW, StepIcon, Words } from "../src/components/thread/activity-row";
import { AssistantMessage, UserBubble } from "../src/components/thread/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { BranchAlt, Folder, type IconProps, Branch, ChevronDown } from "../src/icons";
import { RAIL_PILL, UtilityBar } from "../src/home/pills";
import { BrigadierMark } from "../src/onboarding/mark";
import type { Runner } from "../src/session/composer";
import { BrigadeToggle } from "../src/sessions/brigade";
import { Markdown } from "../src/thread/markdown";

// From @openai/apps-sdk-ui 0.2.2 (MIT), as the app's own icons.
export const Moon = (props: IconProps) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M12.7836 2.47048C12.9676 2.76512 12.9855 3.13415 12.8309 3.44525C12.2994 4.51497 12 5.7211 12 7.00001C12 11.4183 15.5817 15 20 15L20.0575 14.9998C20.4049 14.9974 20.7287 15.1754 20.9127 15.47C21.0968 15.7647 21.1147 16.1337 20.9601 16.4448C19.325 19.7352 15.9279 22 12 22C6.47715 22 2 17.5229 2 12C2 6.50107 6.43841 2.03886 11.9284 2.00027C12.2758 1.99783 12.5995 2.17584 12.7836 2.47048ZM10.4099 4.15803C6.75344 4.8954 4 8.12619 4 12C4 16.4183 7.58172 20 12 20C14.587 20 16.8886 18.7721 18.3516 16.8648C13.6131 16.0789 10 11.9614 10 7.00001C10 6.01361 10.1431 5.05953 10.4099 4.15803Z" />
  </svg>
);
export const Sun = (props: IconProps) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 1C12.5523 1 13 1.44772 13 2V4C13 4.55228 12.5523 5 12 5C11.4477 5 11 4.55228 11 4V2C11 1.44772 11.4477 1 12 1ZM4.22183 4.22183C4.61235 3.8313 5.24551 3.8313 5.63604 4.22183L7.05025 5.63604C7.44078 6.02656 7.44078 6.65973 7.05025 7.05025C6.65973 7.44078 6.02656 7.44078 5.63604 7.05025L4.22183 5.63604C3.8313 5.24551 3.8313 4.61235 4.22183 4.22183ZM19.7782 4.22183C20.1687 4.61235 20.1687 5.24551 19.7782 5.63604L18.364 7.05025C17.9734 7.44078 17.3403 7.44078 16.9497 7.05025C16.5592 6.65973 16.5592 6.02656 16.9497 5.63604L18.364 4.22183C18.7545 3.8313 19.3876 3.8313 19.7782 4.22183ZM12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9ZM7 12C7 9.23858 9.23858 7 12 7C14.7614 7 17 9.23858 17 12C17 14.7614 14.7614 17 12 17C9.23858 17 7 14.7614 7 12ZM1 12C1 11.4477 1.44772 11 2 11H4C4.55228 11 5 11.4477 5 12C5 12.5523 4.55228 13 4 13H2C1.44772 13 1 12.5523 1 12ZM19 12C19 11.4477 19.4477 11 20 11H22C22.5523 11 23 11.4477 23 12C23 12.5523 22.5523 13 22 13H20C19.4477 13 19 12.5523 19 12ZM7.05025 16.9497C7.44078 17.3403 7.44078 17.9734 7.05025 18.364L5.63604 19.7782C5.24551 20.1687 4.61235 20.1687 4.22183 19.7782C3.8313 19.3876 3.8313 18.7545 4.22183 18.364L5.63604 16.9497C6.02656 16.5592 6.65973 16.5592 7.05025 16.9497ZM16.9497 16.9497C17.3403 16.5592 17.9734 16.5592 18.364 16.9497L19.7782 18.364C20.1687 18.7545 20.1687 19.3876 19.7782 19.7782C19.3877 20.1687 18.7545 20.1687 18.364 19.7782L16.9497 18.364C16.5592 17.9734 16.5592 17.3403 16.9497 16.9497ZM12 19C12.5523 19 13 19.4477 13 20V22C13 22.5523 12.5523 23 12 23C11.4477 23 11 22.5523 11 22V20C11 19.4477 11.4477 19 12 19Z"
    />
  </svg>
);

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

/** The pill after Brigade's, as its own: on, it wears the night's colour. `first`: no Brigade before it, so its own divider. */
export function OvernightPill({ on, onChange, className, divider = false }: { on: boolean; onChange: (on: boolean) => void; className?: string; divider?: boolean }) {
  return (
    <>
      {divider && <PillDivider />}
      <Tooltip>
        <TooltipTrigger render={<ComposerPill aria-pressed={on} className={className ?? "aria-pressed:bg-fill aria-pressed:text-foreground"} onClick={() => onChange(!on)} />}>
          <Moon />
          <span>Overnight</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{on ? "Turn Overnight off" : "Overnight: it asks what it needs, then finishes the job while you’re away"}</TooltipContent>
      </Tooltip>
    </>
  );
}

/** Full access while the night lasts; the level from before comes back after. */
export function Level({ overnight }: { overnight: boolean }) {
  const [level, setLevel] = useState<PermissionLevel>("auto");
  return <PermissionPicker value={overnight ? "full" : level} onChange={setLevel} />;
}

export function Brigade() {
  const [on, setOn] = useState(false);
  return <BrigadeToggle on={on} onChange={setOn} />;
}

export const OVERNIGHT: SlashCommand = { id: "overnight", kind: "command", label: "/overnight", description: "Finish the job while you’re away", instant: true };
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
