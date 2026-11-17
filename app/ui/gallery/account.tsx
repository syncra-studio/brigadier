// A project's GitHub account in Project settings [D631], on Fake replies: opened on press.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Dialog, DialogContent } from "../src/components/dialog";
import type { Project } from "../src/daemon";
import { type GithubAccounts, ProjectSettings, SETTINGS_FRAME, type SettingsSource } from "../src/projects/settings";
import { Row, Section } from "./parts";

const PROJECT: Project = { id: "p1", name: "billing", folder: "/Users/sam/Development/work/billing", trusted: true, setup: "pnpm install", include: [".env.local"], added: 0, branch_prefix: "brigadier/" };
const LOGINS = [
  { login: "sam-example", sees: false },
  { login: "sam-at-work", sees: true },
  { login: "sam-studio", sees: false },
];
const SEEN: GithubAccounts = { github: true, repo: "work/billing", auto: "sam-at-work", logins: LOGINS };
const CASES: [string, GithubAccounts][] = [
  ["account: automatic", SEEN],
  ["account: none can see it", { ...SEEN, auto: null, logins: LOGINS.map((each) => ({ ...each, sees: false })) }],
  ["not on GitHub: no row", { github: false, auto: null, logins: [] }],
];
const fake = (reply: GithubAccounts): SettingsSource => ({
  pick: async () => null,
  check: async () => ({ kind: "invalid", reason: "" }),
  save: async () => {},
  // The local read at once, the probed one a moment later, as Rust answers.
  accounts: (_, local) => (local ? Promise.resolve({ ...reply, auto: null, logins: reply.logins.map((each) => ({ ...each, sees: null })) }) : new Promise((done) => setTimeout(() => done(reply), 800))),
});

export function AccountGallery() {
  const [open, setOpen] = useState<GithubAccounts | null>(null);
  return (
    <Section title="Project settings · GitHub account">
      <Row>
        {CASES.map(([label, each]) => (
          <Button key={label} size="sm" variant="outline" onClick={() => setOpen(each)}>
            {label}
          </Button>
        ))}
      </Row>
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent frame={SETTINGS_FRAME}>{open && <ProjectSettings project={PROJECT} source={fake(open)} onClose={() => setOpen(null)} />}</DialogContent>
      </Dialog>
    </Section>
  );
}
