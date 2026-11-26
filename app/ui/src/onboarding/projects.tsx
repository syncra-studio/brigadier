import type { Source } from "../projects/store";
import { setProfile } from "./api";
import { StepFooter, StepHeader } from "./parts";
import { useProjectSources } from "./sources";

/** Onboarding's Projects step: the sources [D676], and a button that adds what's picked and finishes the setup; with none picked it finishes without. */
export function ProjectsStep({ source, offline, onBack }: { source: Source; offline: boolean; onBack: () => void }) {
  const { body, total, single, hint, adding, cloning, disabled, finish } = useProjectSources({
    source,
    offline,
    // Not shown early: done leaves onboarding, and undoing that would restart it at the agents step.
    onDone: () => {
      // It ends on Home, never on a screen kept from an earlier run or opened under it (⌘,); set first, so that never draws.
      window.location.hash = "";
      return setProfile(["--done"], {});
    },
  });
  const label = adding ? (cloning ? "Cloning…" : "Adding…") : total > 1 ? `Add ${total} projects` : single ? `Let's work on ${single.name}` : "Continue without a project";
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="What should we work on?" description="Pick folders on this Mac or repositories from any of your GitHub accounts, or start a new one." />
      <div className="mt-10 flex min-h-0 flex-1 flex-col px-6 pb-6">
        <div className="mx-auto flex min-h-0 w-full max-w-onboarding flex-1 flex-col">{body}</div>
      </div>
      <StepFooter onBack={onBack} count={hint} primary={{ label, onClick: () => void finish(), disabled, busy: adding }} />
    </div>
  );
}
