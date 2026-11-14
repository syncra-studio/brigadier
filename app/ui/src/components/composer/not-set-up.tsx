import { Button } from "../button";
import { type ModelGroup, ProviderMark } from "./model-picker";

/** The picker's column for an agent not installed or not signed in: what it needs, and "Set up" where it can be. */
export function NotSetUp({ group, onSetUp }: { group: ModelGroup; onSetUp?: (() => void) | undefined }) {
  return (
    <div data-slot="model-picker-not-set-up" className="flex flex-col items-center gap-2.5 px-5 py-7 text-center">
      <span className="grid size-8.5 shrink-0 place-items-center rounded-nav border border-divider text-muted-foreground">
        <ProviderMark mark={group.mark} className="size-4.25" />
      </span>
      <p className="text-sm font-medium text-foreground">
        {group.label} {group.unavailable === "install" ? "isn't installed" : "isn't signed in"}
      </p>
      <p className="max-w-72 text-xs text-muted-foreground">
        {group.unavailable === "install" ? "Install it and its models show here." : "Sign in and its models show here."}
      </p>
      {onSetUp && (
        <Button variant="soft" size="sm" onClick={onSetUp}>
          Set up {group.label}
        </Button>
      )}
    </div>
  );
}
