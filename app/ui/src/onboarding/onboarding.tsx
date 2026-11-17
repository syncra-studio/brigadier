import { useEffect, useRef, useState } from "react";

import { useDaemon } from "../daemon";
import { daemonSource } from "../projects/store";
import { AgentsStep } from "./agents";
import { errorText, type Profile, run, setProfile } from "./api";
import "./onboarding.css";
import { GitStep } from "./git";
import { type Step, STEPS, TopBar } from "./parts";
import { ProjectsStep } from "./projects";
import { Welcome } from "./welcome";

/**
 * The first launch [D45, D48, D616]: welcome, name, agents, GitHub or GitLab, projects, each kept in the profile as it is
 * given, so a launch that stops part way picks up where it left off. Finishing the projects marks
 * it done.
 */
export function Onboarding({ profile }: { profile: Profile }) {
  const { daemon } = useDaemon();
  const [step, setStep] = useState<Step>(() => (!profile.intro_seen ? "intro" : profile.name ? "agents" : "name"));
  const [reached, setReached] = useState(() => Math.max(STEPS.indexOf(step), 0));
  const stopSound = useRef<(() => void) | null>(null);
  // A name that couldn't be saved brings its step back, with the name as typed and why.
  const [nameFailed, setNameFailed] = useState<{ name: string; error: string } | null>(null);
  // Leaving the welcome before its sound has ended fades it out.
  useEffect(() => () => stopSound.current?.(), []);
  // The Projects step's lists are read now, so they're there when it opens [D627]; it reads them itself if this fails.
  const online = Boolean(daemon);
  useEffect(() => {
    if (online) run(["projects", "warm"]).catch(() => {});
  }, [online]);

  const go = (next: Step) => {
    setStep(next);
    setReached((current) => Math.max(current, STEPS.indexOf(next)));
  };

  return (
    <main className="fixed inset-0 flex flex-col">
      {step !== "intro" && <TopBar step={step} reached={reached} onStep={go} />}
      {step === "intro" || step === "name" ? (
        <Welcome
          step={step}
          name={nameFailed?.name ?? profile.name}
          nameError={nameFailed?.error ?? null}
          onSound={(stop) => (stopSound.current = stop)}
          onContinue={() => {
            go("name");
            setProfile(["--intro"], { intro_seen: true }).catch((error: unknown) => console.error(error));
          }}
          onName={(name) => {
            // The agents come in at once; the name is saved meanwhile.
            setNameFailed(null);
            go("agents");
            setProfile(["--name", name], { name }).catch((cause: unknown) => {
              setNameFailed({ name, error: errorText(cause) });
              go("name");
            });
          }}
        />
      ) : step === "agents" ? (
        <AgentsStep onBack={() => go("name")} onContinue={() => go("git")} />
      ) : step === "git" ? (
        <GitStep onBack={() => go("agents")} onContinue={() => go("projects")} />
      ) : (
        <ProjectsStep source={daemonSource} offline={!daemon} onBack={() => go("git")} />
      )}
    </main>
  );
}
