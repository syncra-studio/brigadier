import { HOME } from "../../shell/tab-store";
import { BRANCHES, DRAFT, GIT_RUNS, HOST, setFakeSource, useFake, WATCH } from "../fake";
import { SourcePanel } from "./panel";

/** The Source view of a session or project chat: fake until 2.14 wires it to Rust; a project chat shows its folder [D1039]. */
export function SourceView({ owner }: { owner: string }) {
  const fake = useFake(owner, owner === HOME);
  return <SourcePanel data={{ source: fake.source, step: fake.step, host: HOST, branches: BRANCHES, gitRuns: GIT_RUNS, prs: fake.prs ?? [], watch: WATCH, draft: DRAFT }} draftKey={owner} nowMs={Date.now()} onSource={(source) => setFakeSource(owner, source)} />;
}
