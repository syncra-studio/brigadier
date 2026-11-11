// The Review tab (steps 2.8–2.10): every scope, a long diff, split and wrap, its states and comments, on fake data,
// beside the live copy.
import type { ReactNode } from "react";

import { showToast } from "../src/components/toast";
import { CommentBox } from "../src/review/comments";
import { FileSection, type FileProps } from "../src/review/file-section";
import { ReviewTab, type ReviewTabProps } from "../src/review/review-tab";
import type { DiffComment, ReviewScope } from "../src/review/types";
import { type Done, FIRST_STAGED, NOTHING_DONE, read } from "./review-data";
import { LastTurnGallery } from "./review-brief";
import { ChipComposer, Frame, LiveReview } from "./review-live";
import { Row, Section, State } from "./parts";

const ignore = () => {};

/** A ReviewTab frozen on a scope's fake data, everything arrived. */
export function Tab({ scope, done = FIRST_STAGED, ...change }: { scope: ReviewScope; done?: Done } & Partial<ReviewTabProps>) {
  const { review, contents } = read(scope, done);
  return (
    <Frame>
      <ReviewTab
        scope={scope}
        onScope={ignore}
        review={review}
        contents={contents}
        error={null}
        loading={false}
        connected
        onRefresh={ignore}
        onLoad={ignore}
        onOpenIn={ignore}
        comments={[]}
        onComment={ignore}
        onRemoveComment={ignore}
        {...change}
      />
    </Frame>
  );
}

const RETRY = "src/upload/retry.ts";
const uncommitted = read("uncommitted", FIRST_STAGED);
const fileOf = (path: string) => uncommitted.review.files.find((file) => file.path === path)!;

/** One file's section frozen, in a tab's frame. */
function File({ path = RETRY, ...change }: { path?: string } & Partial<FileProps>) {
  return (
    <div className="flex w-full max-w-240 flex-col overflow-hidden rounded-surface border border-border bg-background">
      <FileSection
        file={fileOf(path)}
        contents={uncommitted.contents.get(path)}
        look={{ numbered: true, split: false, wrap: false, words: true }}
        collapsed={false}
        onToggle={ignore}
        connected
        onRetry={ignore}
        onOpenIn={ignore}
        comments={[]}
        onComment={ignore}
        onRemoveComment={ignore}
        {...change}
      />
    </div>
  );
}

const COMMENTS: DiffComment[] = [
  { id: "c1", path: RETRY, side: "additions", start: 19, end: 19, excerpt: "return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);", text: "Cap at 5 s: the tray looks stuck at 8." },
  { id: "c2", path: RETRY, side: "additions", start: 30, end: 32, excerpt: "if (!retryable(error)) throw error;", text: "Log the status before deciding, or we lose why it stopped." },
];

export function Wide({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function ReviewGallery() {
  return (
    <>
      <Section title="Review diff">
        <Row name="Live: pick a scope, fold, split, wrap, comment">
          <LiveReview />
        </Row>
        <Row name="Scopes (D1035)">
          <Wide label="Uncommitted, the default: staged and not, the first hunk already staged">
            <Tab scope="uncommitted" />
          </Wide>
          <Wide label="Staged Changes">
            <Tab scope="staged" />
          </Wide>
          <Wide label="Changes (not staged)">
            <Tab scope="unstaged" />
          </Wide>
          <Wide label="Branch since main">
            <Tab scope="branch" done={NOTHING_DONE} />
          </Wide>
        </Row>
        <Row name="Long diff (D1036)">
          <Wide label="A file over the threshold arrives folded with its counts (schema.ts, last but one)">
            <Tab scope="uncommitted" />
          </Wide>
          <Wide label="Opened: its contents on the way">
            <File path="src/generated/schema.ts" contents={undefined} />
          </Wide>
        </Row>
        <Row name="Split and wrap">
          <Wide label="Split">
            <File look={{ numbered: true, split: true, wrap: false, words: true }} />
          </Wide>
          <Wide label="Wrap">
            <File path="src/upload/client.ts" look={{ numbered: true, split: false, wrap: true, words: true }} />
          </Wide>
        </Row>
        <Row name="States (D30)">
          <Wide label="The list on its way">
            <Tab scope="uncommitted" review={null} />
          </Wide>
          <Wide label="Reading again: Refresh spins, the diff stays">
            <Tab scope="uncommitted" loading />
          </Wide>
          <Wide label="No changes">
            <Tab scope="uncommitted" review={{ scope: "uncommitted", base: "main", files: [], insertions: 0, deletions: 0 }} />
          </Wide>
          <Wide label="The list couldn't be read: the last one stays under the reason">
            <Tab scope="uncommitted" error="git exited with 128: not a git repository" />
          </Wide>
          <Wide label="Daemon away: the diff stays">
            <Tab scope="uncommitted" connected={false} />
          </Wide>
          <Wide label="A file's contents couldn't be read">
            <File contents={{ error: "the file is no longer in the checkout" }} />
          </Wide>
          <Wide label="Binary">
            <File path="assets/upload-icon.png" />
          </Wide>
        </Row>
      </Section>
      <LastTurnGallery />
      <Section title="Comments to the agent (D1040)">
        <Row name="The box under picked lines">
          <State label="Comment on lines 30–32">
            <div className="bg-background">
              <CommentBox start={30} end={32} onCancel={ignore} onSubmit={ignore} />
            </div>
          </State>
        </Row>
        <Row name="Two ranges commented: marked on the diff, chips on the composer">
          <Wide label="On the diff until sent">
            <File comments={COMMENTS} onRemoveComment={(id) => showToast(`Delete ${id}`)} />
          </Wide>
          <Wide label="Above what you type; Send takes them">
            <div className="w-full max-w-reading">
              <ChipComposer comments={COMMENTS} onRemove={ignore} onSend={ignore} />
            </div>
          </Wide>
        </Row>
      </Section>
    </>
  );
}
