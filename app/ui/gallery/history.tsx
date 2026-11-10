// The History tab (2.29) and a commit's Review tab, each state on fake data [D1041, D1114].
import { showToast } from "../src/components/toast";
import { HistoryList } from "../src/history/history-tab";
import type { HistoryState } from "../src/history/store";
import { COMMITS } from "../src/panel/fake";
import { ReviewTab } from "../src/review/review-tab";
import { read } from "./review-data";
import { Row, Section, State } from "./parts";

const ignore = () => {};
const NOW = Date.now();
const LIST: HistoryState = { history: { base: "main", commits: COMMITS }, error: null, loading: false };
const open = (sha: string) => showToast(`Open ${sha} in a Review tab`);

function List({ state, connected = true }: { state: HistoryState; connected?: boolean }) {
  return (
    <div className="flex h-80 w-140 flex-col overflow-hidden rounded-surface border border-border">
      <HistoryList state={state} connected={connected} nowMs={NOW} onCommit={open} onRefresh={ignore} />
    </div>
  );
}

const branch = read("branch", { staged: new Set(), reverted: new Set() });
const COMMIT = COMMITS[0]!;

export function HistoryGallery() {
  return (
    <Section title="History tab">
      <Row name="The session's commits since its base; a click opens one in a Review tab">
        <State label="Commits">
          <List state={LIST} />
        </State>
      </Row>
      <Row name="Its states">
        <State label="Loading">
          <List state={{ history: null, error: null, loading: true }} />
        </State>
        <State label="None since the base">
          <List state={{ history: { base: "main", commits: [] }, error: null, loading: false }} />
        </State>
        <State label="A read failed: the last list stays">
          <List state={{ ...LIST, error: "git log: fatal: bad revision 'main..HEAD'" }} />
        </State>
        <State label="Disconnected">
          <List state={LIST} connected={false} />
        </State>
      </Row>
      <Row name="A commit in a Review tab: its subject and id, no scope picker, no stage or revert">
        <State label="Commit">
          <div className="flex h-120 w-200 flex-col overflow-hidden rounded-surface border border-border">
            <ReviewTab
              scope="commit"
              onScope={ignore}
              review={{ ...branch.review, scope: "commit", base: null, commit: { sha: `${COMMIT.sha}${"0".repeat(33)}`, subject: COMMIT.subject, atMs: COMMIT.atMs } }}
              contents={branch.contents}
              error={null}
              loading={false}
              connected
              onRefresh={ignore}
              onLoad={ignore}
              states={new Map()}
              onRequest={ignore}
              onOpenIn={ignore}
              comments={[]}
              onComment={ignore}
              onRemoveComment={ignore}
            />
          </div>
        </State>
      </Row>
    </Section>
  );
}
