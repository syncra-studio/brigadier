import { useEffect, useRef, useState } from "react";

import { AgentsStep } from "./agents";
import { type Profile, setProfile } from "./api";
import "./onboarding.css";
import { type Step, STEPS, TopBar } from "./parts";
import { ProjectsStep } from "./projects";
import { Welcome } from "./welcome";

/**
 * The first launch [D45, D48]: welcome, name, agents, projects, each kept in the profile as it is
 * given, so a launch that stops part way picks up where it left off. Finishing the projects marks
 * it done.
 */
export function Onboarding({ profile }: { profile: Profile }) {
  const [step, setStep] = useState<Step>(() => (!profile.intro_seen ? "intro" : profile.name ? "agents" : "name"));
  const [reached, setReached] = useState(() => Math.max(STEPS.indexOf(step), 0));
  const stopSound = useRef<(() => void) | null>(null);
  // Leaving the welcome before its sound has ended fades it out.
  useEffect(() => () => stopSound.current?.(), []);

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
          name={profile.name}
          onSound={(stop) => (stopSound.current = stop)}
          onContinue={() => {
            go("name");
            setProfile(["--intro"], { intro_seen: true }).catch((error: unknown) => console.error(error));
          }}
          onName={async (name) => {
            await setProfile(["--name", name], { name });
            go("agents");
          }}
        />
      ) : step === "agents" ? (
        <AgentsStep onBack={() => go("name")} onContinue={() => go("projects")} />
      ) : (
        <ProjectsStep onBack={() => go("agents")} />
      )}
    </main>
  );
}
