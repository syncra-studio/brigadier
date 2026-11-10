// Study only (D464): four looks for a reply that throws while it's drawn, in the reply's place, the rest of the
// thread untouched. Each has a live copy: a real boundary around a reply that fails once, Try again draws it anew.
import { Component, type ComponentType, type ReactNode, useState } from "react";

import { Button } from "../src/components/button";
import { CopyButton } from "../src/components/copy-button";
import { cx } from "../src/components/cx";
import { ErrorLine } from "../src/components/error-line";
import { AssistantMessage, UserBubble } from "../src/components/thread/message";
import { ChevronRight, ExclamationMarkCircle, Info } from "../src/icons";
import { Row } from "./parts";

const TEXT = "The flaky test waits on a timer that the CI clock skips.\n\n| step | before | after |\n|---|---|\n| wait | 2s | until ready |";
const ERROR = "TypeError: Cannot read properties of undefined (reading 'cells')\n    at Table (markdown.tsx:212:31)";
type Look = { retry: () => void };

/** Ours: the old app's quiet line, drawn by the kit's one error line, with Details opening the error's own words. */
function Ours({ retry }: Look) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {/* Wraps rather than cutting the words, as the old app's line did. */}
      <div className="flex flex-wrap items-center gap-x-2.5 text-sm leading-5.25">
        <ErrorLine size="sm" error="This reply couldn’t be shown" />
        <button type="button" onClick={retry} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
          Try again
        </button>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1 rounded-control text-muted-foreground hover:text-foreground focus-visible:focus-ring">
          Details
          <ChevronRight className={cx("size-icon-xs chevron-motion", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <div className="flex items-start gap-1">
          <pre className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-live-text-quiet">{ERROR}</pre>
          <CopyButton text={ERROR} tooltip="Copy error" />
        </div>
      )}
    </div>
  );
}

/** Theirs: a small bordered card, its title, a secondary Try again; the error itself isn't shown. */
function Theirs({ retry }: Look) {
  return (
    <div role="alert" className="rounded-control border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
      <p className="mb-2 font-medium text-foreground">This turn couldn't render</p>
      <Button variant="secondary" size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

/** Mixed: the small card holds the place, with our words, our link-blue actions and Copy error. */
function Mixed({ retry }: Look) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-control border border-border bg-card px-4 py-3 text-sm">
      <ExclamationMarkCircle className="mt-0.5 size-icon-sm shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium text-foreground">This reply couldn’t be shown</p>
        <p className="text-muted-foreground">Nothing is lost: the reply is saved, only drawing it failed.</p>
        <div className="flex items-center gap-3 pt-1.5">
          <button type="button" onClick={retry} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
            Try again
          </button>
          <CopyButton text={ERROR} tooltip="Copy error" />
        </div>
      </div>
    </div>
  );
}

/** Improvised: the reply's own words as plain text, so it's still read, with one quiet line above saying why. */
function Improvised({ retry }: Look) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Info className="size-icon-xs shrink-0" />
        Shown as plain text ·
        <button type="button" onClick={retry} className="cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
          Try again
        </button>
      </p>
      <p className="leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground">{TEXT}</p>
    </div>
  );
}

const LOOKS: [string, string, ComponentType<Look>][] = [
  ["Ours (the old app's line)", "One red line in the reply's place, Try again and Details › opening the error with Copy.", Ours],
  ["Theirs", "A small card: title and a Try again button. The error isn't shown.", Theirs],
  ["Mixed", "The small card holding the place; our words, our link actions, Copy error.", Mixed],
  ["Improvised", "The reply's saved words as plain text, a quiet line above: nothing to read is lost.", Improvised],
];

/** Catches a throw from its reply and shows the look instead; Try again mends the reply and draws it again. */
class Boundary extends Component<{ look: ComponentType<Look>; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {}
  override render() {
    const retry = () => {
      this.props.onRetry();
      this.setState({ failed: false });
    };
    const Look = this.props.look;
    return this.state.failed ? <Look retry={retry} /> : this.props.children;
  }
}

/** A reply that throws while it's `broken`. */
function Flaky({ broken }: { broken: boolean }) {
  if (broken) throw new Error("drawing failed (gallery)");
  return (
    <AssistantMessage text={TEXT} final>
      <p className="whitespace-pre-wrap">{TEXT}</p>
    </AssistantMessage>
  );
}

function Live({ look }: { look: ComponentType<Look> }) {
  const [broken, setBroken] = useState(true);
  return (
    <div className="flex flex-col gap-2">
      <Boundary look={look} onRetry={() => setBroken(false)}>
        <Flaky broken={broken} />
      </Boundary>
      <Button variant="soft" size="xs" className="self-start" disabled={broken} onClick={() => setBroken(true)}>
        Break it again
      </Button>
    </div>
  );
}

export function ErrorCardLooks() {
  return (
    <>
      <Row name="Error card when a reply can't be shown: four looks (D464)">
        <p className="w-full -mt-1 text-xs text-muted-foreground">
          Today a reply that throws while drawn takes the whole window down with it: we have no boundary. The old app wrapped each turn.
        </p>
        {LOOKS.map(([name, why, Shown]) => (
          <div key={name} className="flex w-72 flex-col gap-2">
            <span className="text-2xs text-muted-foreground">{name}</span>
            <span className="text-2xs text-faint-foreground">{why}</span>
            <UserBubble keep={`ec-${name}`} text="Why is the login test flaky?" />
            <div className="pt-4">
              <Shown retry={() => {}} />
            </div>
          </div>
        ))}
      </Row>
      <Row name="Error card, live: each reply throws until Try again">
        {LOOKS.map(([name, , look]) => (
          <div key={name} className="flex w-72 flex-col gap-2">
            <span className="text-2xs text-muted-foreground">{name}</span>
            <Live look={look} />
          </div>
        ))}
      </Row>
    </>
  );
}
