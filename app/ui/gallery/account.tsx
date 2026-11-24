// A project's GitHub account in its page's Settings tab [D631, D780], on Fake records: shown on press.
import { useState } from "react";

import { Button } from "../src/components/button";
import type { Project } from "../src/daemon";
import { ProjectSettings, type SettingsSource } from "../src/projects/settings";
import { Row, Section } from "./parts";

const PROJECT: Project = { id: "p1", name: "billing", folder: "/Users/sam/Development/work/billing", trusted: true, setup: "pnpm install", include: [".env.local"], added: 0, branch_prefix: "brigadier/" };
const LOGINS = [
  { login: "sam-example", sees: false },
  { login: "sam-at-work", sees: true },
  { login: "sam-studio", sees: false },
];
const SEEN: Project["github"] = { github: true, of: ["github.com/work/billing"], logins: LOGINS };
const CASES: [string, Partial<Project>][] = [
  ["account: saved", { github: SEEN, github_account: "sam-at-work" }],
  ["account: none can see it", { github: { ...SEEN, logins: LOGINS.map((each) => ({ ...each, sees: false })) } }],
  ["account: signed out of gh", { github: SEEN, github_account: "sam-old" }],
  ["account: several repositories", { github: { ...SEEN, of: ["a", "b", "c"] }, github_account: "sam-at-work" }],
  ["account: several, on two servers", { github: { ...SEEN, of: ["a", "b"], host: "github.com" }, github_account: "sam-at-work" }],
  ["not on GitHub: no row", { github: { github: false, logins: [] } }],
];
const FAKE: SettingsSource = {
  pick: async () => null,
  check: async () => ({ kind: "invalid", reason: "" }),
  save: async () => {},
  repos: async () => [],
  accounts: async () => {},
};

export function AccountGallery() {
  const [open, setOpen] = useState<Partial<Project> | null>(null);
  return (
    <Section title="Project settings · GitHub account">
      <Row>
        {CASES.map(([label, each]) => (
          <Button key={label} size="sm" variant="outline" onClick={() => setOpen(each)}>
            {label}
          </Button>
        ))}
      </Row>
      {open && (
        <div className="rounded-surface bg-background">
          <ProjectSettings key={CASES.findIndex(([, each]) => each === open)} project={{ ...PROJECT, ...open }} source={FAKE} />
        </div>
      )}
    </Section>
  );
}
