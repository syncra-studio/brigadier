import { useRef, useState } from "react";

import { BranchAlt, Spinner } from "../../icons";
import { type ModelChoice, type ModelGroup, ModelPicker } from "../composer/model-picker";
import { SwitchAgentDialog } from "../composer/switch-agent";
import { ErrorLine } from "../error-line";
import { TooltipIconButton } from "../icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MenuRow,
} from "../menu";
import { forkFiles, FORK_WORDS } from "../../../../shared/words";

/**
 * What Rust's one check offers on an answer [D1068]; the UI writes the words. `worktree`: the new worktree
 * row's files, as they were (`snapshot`), today's (`none`), as they were from today's base (`gone`), or today's from
 * the fork's own copy where its source is gone (`sourceGone`, D1079); null in a chat with no project, which forks
 * its conversation only. `fingerprint` goes back with the fork, which refuses
 * if the answer changed meanwhile (proposed). A folder chat's fork copies each repo it claimed, said per repo in
 * `repos`, and reads `repos` where they aren't all as they were [D3105].
 */
export type ForkOffer = {
  worktree: "snapshot" | "none" | "gone" | "sourceGone" | "repos" | null;
  repos?: { name: string; files: "snapshot" | "none" | "gone" | "later" }[];
  /** The one destination rule's place, where a fork with another agent goes (proposed). */
  default: "worktree" | "chat";
  /** The agent the answer's conversation is on, which forks natively; null from an inherited copy [D1081]. */
  agent: string | null;
  fingerprint: string;
};

/** Where a pick sends the fork; `to`, another agent, model, effort or speed, goes by the one destination rule (proposed). */
export type ForkPick = { where: "worktree" | "chat" } | { to: ModelChoice };

/** The places a fork can go, from Rust's offer: under an answer and in a session's ⋯ menu alike. */
export function ForkPlaces({ offer, onPick }: { offer: ForkOffer; onPick: (pick: ForkPick) => void }) {
  return (
    <>
      {offer.worktree && (
        <Place title={offer.repos ? FORK_WORDS.repos : FORK_WORDS.worktree} detail={forkFiles(offer)} onClick={() => onPick({ where: "worktree" })} />
      )}
      {!offer.worktree && (
        <DropdownMenuItem onClick={() => onPick({ where: "chat" })}>
          <MenuRow icon={<BranchAlt />} title={FORK_WORDS.chat} />
        </DropdownMenuItem>
      )}
    </>
  );
}

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
 * The fork icon after Copy under an answer, and its menu [D48, D1069, D1071]: the old ForkMenu's rows on our
 * kit's menu. The offer is read as the pointer reaches the button and as it opens (`onOpen`); until then a spinner row, or why it couldn't be read. "Fork with
 * another agent" opens the composer's own model picker by the button, on this session's model: what is picked there is
 * held, and the fork goes on it as the picker closes, another vendor's agent asked first; Escape forks nothing.
 */
export function ForkMenu({
  chat,
  offer,
  error,
  agents,
  agentsError,
  current,
  value,
  busy = false,
  onSetUp,
  onOpen,
  onPick,
}: {
  /** A chat's words: "Fork chat from here". */
  chat: boolean;
  offer?: ForkOffer;
  error?: string;
  /** The agents and models the picker lists, undefined while they're read; `current` is this session's agent. */
  agents: ModelGroup[] | undefined;
  /** Why the list couldn't be read; opening the menu again reads it again. */
  agentsError?: string;
  current: string;
  /** This session's model, effort and speed, where known: the picker opens on it. */
  value?: ModelChoice | null;
  busy?: boolean;
  /** The picker's "Set up" for an agent not installed or signed in. */
  onSetUp?: (provider: string) => void;
  /** Reads the offer and the agents: as the pointer reaches the button, so the menu opens whole, and as it opens. */
  onOpen?: () => void;
  onPick: (pick: ForkPick) => void;
}) {
  const [vendor, setVendor] = useState<{ choice: ModelChoice; label: string } | null>(null);
  const [asked, setAsked] = useState(0);
  const [held, setHeld] = useState<ModelChoice | null>(null);
  // What was picked, read as the picker closes in the same click, before a draw.
  const picked = useRef<ModelChoice | null>(null);
  const hold = (choice: ModelChoice | null) => {
    picked.current = choice;
    setHeld(choice);
  };
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = chat ? "Fork chat from here" : "Fork session from here";
  // Read and no agent set up: no row that opens empty.
  const another = !agents || agents.some((group) => !group.unavailable && group.models.length > 0);
  const close = (cancelled: boolean) => {
    const held = picked.current;
    hold(null);
    if (cancelled || !held) return;
    // The same agent forks natively; another vendor's agent asks first [D1081, D90].
    if (held.provider === current) onPick({ to: held });
    else setVendor({ choice: held, label: agents?.find((group) => group.provider === held.provider)?.label ?? held.provider });
  };
  return (
    <span ref={anchor} className="inline-flex">
      <DropdownMenu modal={false} onOpenChange={(open) => open && onOpen?.()}>
        <DropdownMenuTrigger
          onPointerEnter={() => onOpen?.()}
          render={<TooltipIconButton tooltip={tooltip} size="icon-answer" disabled={busy} aria-busy={busy || undefined} />}
        >
          {busy ? <Spinner className="animate-spin" /> : <BranchAlt />}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-select">
          <DropdownMenuLabel variant="heading">{tooltip}</DropdownMenuLabel>
          {offer ? (
            <>
              <ForkPlaces offer={offer} onPick={onPick} />
              {another && (
                <>
                  <DropdownMenuSeparator />
                  {agentsError ? (
                    <div className="px-2 py-1.5">
                      <ErrorLine size="sm" error={agentsError} />
                    </div>
                  ) : (
                    <DropdownMenuItem disabled={!agents} onClick={() => setAsked((n) => n + 1)}>
                      <MenuRow icon={agents ? <BranchAlt /> : <Spinner className="animate-spin" />} title="Fork with another agent" />
                    </DropdownMenuItem>
                  )}
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
      <ModelPicker
        groups={agents ?? []}
        value={held ?? value ?? { provider: current, model: "", effort: null }}
        onChange={hold}
        {...(onSetUp && { onSetUp })}
        asksSwitch={false}
        asked={asked}
        anchor={anchor}
        onClose={close}
      />
      <SwitchAgentDialog
        fork
        to={vendor?.label ?? null}
        onCancel={() => setVendor(null)}
        onConfirm={() => {
          if (vendor) onPick({ to: vendor.choice });
          setVendor(null);
        }}
      />
    </span>
  );
}
