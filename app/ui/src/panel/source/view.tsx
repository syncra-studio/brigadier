import { HOME } from "../../shell/tab-store";
import { BRANCHES, fakeFor, GIT_RUNS, HOST } from "../fake";
import { SourcePanel } from "./panel";

/** The Source view of a session or project chat: fake until 2.14 wires it to Rust; a project chat shows its folder [D1039]. */
export function SourceView({ owner }: { owner: string }) {
  const fake = fakeFor(owner, owner === HOME);
  return <SourcePanel data={{ source: fake.source, step: fake.step, host: HOST, branches: BRANCHES, gitRuns: GIT_RUNS }} nowMs={Date.now()} />;
}
