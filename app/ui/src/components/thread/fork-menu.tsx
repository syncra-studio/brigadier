import { useState } from "react";

import { BranchAlt, Spinner } from "../../icons";
import { type ModelChoice, type ModelGroup, ProviderMark, SwitchAgentDialog } from "../composer/model-picker";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  MenuRow,
} from "../menu";

/**
 * What Rust's one check offers on an answer [D1068, D1070]; the UI writes the words. `worktree`: the new worktree
 * row's files, as they were (`snapshot`), today's (`none`), as they were from today's base (`gone`), or today's from
 * the fork's own copy where its source is gone (`sourceGone`, D1079); null where the folder isn't a git repository.
 * `here`: what Fork here shares, null in a chat with no project. `fingerprint` goes back with the fork, which refuses
 * if the answer changed meanwhile (proposed).
 */
export type ForkOffer = {
  worktree: "snapshot" | "none" | "gone" | "sourceGone" | null;
  here: "worktree" | "folder" | null;
  /** The one destination rule's place, where a fork with another agent goes (proposed). */
  default: "worktree" | "here" | "chat";
  /** The agent the answer's conversation is on, which forks natively; null from an inherited copy [D1081]. */
  agent: string | null;
  fingerprint: string;
};

/** Where a pick sends the fork; `to`, another agent or model, goes by the one destination rule (proposed). */
export type ForkPick = { where: "worktree" | "here" | "chat" } | { to: ModelChoice };

// Proposed words, shown to the owner on screen [D1068].
const FILES: Record<NonNullable<ForkOffer["worktree"]>, string> = {
  snapshot: "Files as they were at this message",
  none: "Today's files: this message has no snapshot",
  gone: "Files as they were · their commit is gone, so it starts from today's base",
  sourceGone: "Today's files: the session it came from is gone",
};
const HERE = {
  worktree: "Same worktree: both sessions work on these files",
  folder: "Same folder: keeps working on these files with you",
};

/** A place the fork can go, as the old ForkPlaces row: its icon, title and a grey line under it that wraps. */
function Place({ title, detail, onClick, disabled }: { title: string; detail: string; onClick: () => void; disabled?: boolean }) {
  return (
    <DropdownMenuItem className="items-start py-2" disabled={disabled} onClick={onClick}>
      <BranchAlt className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </span>
    </DropdownMenuItem>
  );
}

/**
 * The fork icon after Copy under an answer, and its menu [D48, D1069, D1070, D1071]: the old ForkMenu's rows on our
 * kit's menu. The offer is read as it opens (`onOpen`); until then a spinner row, or why it couldn't be read.
 */
export function ForkMenu({
  chat,
  offer,
  error,
  agents,
  agentsError,
  current,
  model,
  busy = false,
  onOpen,
  onPick,
}: {
  /** A chat's words: "Fork chat from here". */
  chat: boolean;
  offer?: ForkOffer;
  error?: string;
  /** The agents and models the switch picker lists, undefined while they're read; `current` is this session's agent. */
  agents: ModelGroup[] | undefined;
  /** Why the list couldn't be read; opening the menu again reads it again. */
  agentsError?: string;
  current: string;
  /** This session's model: forking to it isn't another agent, so it's left out with `current`. */
  model?: string | null;
  busy?: boolean;
  onOpen?: () => void;
  onPick: (pick: ForkPick) => void;
}) {
  const [vendor, setVendor] = useState<{ choice: ModelChoice; label: string } | null>(null);
  // Held so a click opens it too: a hover-opening submenu ignores mouse presses.
  const [sub, setSub] = useState(false);
  const tooltip = chat ? "Fork chat from here" : "Fork session from here";
  const others = (agents ?? [])
    .map((group) => ({ ...group, models: group.models.filter((each) => group.provider !== current || each.id !== model) }))
    .filter((group) => !group.unavailable && group.models.length > 0);
  // Read and nothing else to fork to: no row that opens empty.
  const another = !agents || Boolean(agentsError) || others.length > 0;
  const pickModel = (group: ModelGroup, model: string) => {
    const choice = { provider: group.provider, model, effort: null };
    // Another model of the same agent forks natively; another vendor's agent asks first [D1081, D90].
    if (group.provider === current) onPick({ to: choice });
    else setVendor({ choice, label: group.label });
  };
  return (
    <>
      <DropdownMenu modal={false} onOpenChange={(open) => (open ? onOpen?.() : setSub(false))}>
        <DropdownMenuTrigger
          render={<TooltipIconButton tooltip={tooltip} size="icon-answer" disabled={busy} aria-busy={busy || undefined} />}
        >
          {busy ? <Spinner className="animate-spin" /> : <BranchAlt />}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-select">
          <DropdownMenuLabel variant="heading">{tooltip}</DropdownMenuLabel>
          {offer ? (
            <>
              {offer.worktree && (
                <Place title="Fork to a new worktree" detail={FILES[offer.worktree]} onClick={() => onPick({ where: "worktree" })} />
              )}
              {offer.here && (
                <Place title="Fork here" detail={HERE[offer.here]} onClick={() => onPick({ where: "here" })} />
              )}
              {!offer.worktree && !offer.here && (
                <DropdownMenuItem onClick={() => onPick({ where: "chat" })}>
                  <MenuRow icon={<BranchAlt />} title="Fork chat" />
                </DropdownMenuItem>
              )}
              {another && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub open={sub} onOpenChange={setSub}>
                    <DropdownMenuSubTrigger onClick={() => setSub(true)}>
                      <MenuRow icon={<BranchAlt />} title="Fork with another agent" />
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {agentsError ? (
                        <div className="px-2 py-1.5">
                          <ErrorLine size="sm" error={agentsError} />
                        </div>
                      ) : !agents ? (
                        <DropdownMenuItem disabled>
                          <MenuRow icon={<Spinner className="animate-spin" />} title="Checking the agents" />
                        </DropdownMenuItem>
                      ) : null}
                      {others.map((group) => (
                        <div key={group.provider} role="group" aria-label={group.label}>
                          <DropdownMenuLabel variant="heading" className="flex items-center gap-2">
                            <ProviderMark mark={group.mark} className="size-icon-sm" />
                            {group.label}
                          </DropdownMenuLabel>
                          {group.models.map((model) => (
                            <DropdownMenuItem key={model.id} inset onClick={() => pickModel(group, model.id)}>
                              {model.name}
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
            </>
          ) : error ? (
            <div className="px-2 py-1.5">
              <ErrorLine size="sm" error={error} />
            </div>
          ) : (
            <DropdownMenuItem disabled>
              <MenuRow icon={<Spinner className="animate-spin" />} title="Checking this answer" />
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SwitchAgentDialog
        fork
        to={vendor?.label ?? null}
        onCancel={() => setVendor(null)}
        onConfirm={() => {
          if (vendor) onPick({ to: vendor.choice });
          setVendor(null);
        }}
      />
    </>
  );
}
