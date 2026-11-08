// Add project on Fake data [D165, D168, D202]: each view and state frozen, plus a live copy.
import { Button } from "../src/components/button";
import { Dialog, DialogContent } from "../src/components/dialog";
import { ADD_PROJECT_FRAME, AddProject, AddProjectDialog, type GitHubIn, type View } from "../src/projects/add-project";
import { DEFAULT_PARENT, type GitHub, openAddProject, openFolders, type Repo, type Source } from "../src/projects/store";
import { Held, Row, Section, State } from "./parts";

const REPOS: Repo[] = [
  { path: "/Users/you/code/invoice-service", name: "invoice-service", project_id: null },
  { path: "/Users/you/Development/brigadier", name: "brigadier", project_id: null },
  { path: "/Users/you/code/hello", name: "hello", project_id: "p-hello" },
  { path: "/Users/you/code/design-tokens", name: "design-tokens", project_id: null },
  { path: "/Users/you/Projects/landing-page", name: "landing-page", project_id: null },
];
const GITHUB: GitHub = {
  repos: [
    { name: "you/invoice-service", description: "Billing and invoices for the shop", private: true },
    { name: "you/dotfiles", description: "My shell and editor setup", private: false },
    { name: "you/landing-page", description: null, private: false },
    { name: "acme/design-tokens", description: "Colours, type and spacing as tokens", private: true },
  ],
};

const never = <T,>() => new Promise<T>(() => {});
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** A Fake source: answers like Rust would, a moment later; `with` swaps any part for a state. */
function fake(with_: Partial<Source> = {}): Source {
  return {
    find: () => after(400, REPOS),
    check: (path) => after(100, { kind: "repo", repo: path, name: path.split("/").at(-1)!, project_id: null }),
    add: () => after(600, `p-${Date.now().toString(36)}`),
    clone: () => after(1500, `p-${Date.now().toString(36)}`),
    github: () => after(300, GITHUB),
    pick: () => after(0, "/Users/you/code/new-app"),
    ...with_,
  };
}

const FOUND = fake({ find: async () => REPOS, github: async () => GITHUB });
const LOADING = fake({ find: never, github: never });

function Frozen({ label, source, start, githubIn, offline = false }: { label: string; source: Source; start?: View; githubIn?: GitHubIn; offline?: boolean }) {
  return (
    <State label={label}>
      <Held className="h-152 w-196 overflow-hidden rounded-surface">
        {(box) => (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} frame={ADD_PROJECT_FRAME}>
              <AddProject source={source} offline={offline} start={start} githubIn={githubIn} />
            </DialogContent>
          </Dialog>
        )}
      </Held>
    </State>
  );
}

const LIVE = fake();

export function ProjectsGallery() {
  return (
    <Section title="Add project">
      <Row name="live: + / empty page / View menu · ⌘O (picks /Users/you/code/new-app)">
        <State label="live">
          <Button size="sm" variant="outline" onClick={() => openAddProject()}>
            Add project…
          </Button>
          <Button size="sm" variant="outline" onClick={() => void openFolders(LIVE, ["/Users/you/code/new-app"])}>
            ⌘O
          </Button>
          <AddProjectDialog source={LIVE} offline={false} />
        </State>
      </Row>
      <Row name="pick: found · loading · nothing found · error · disconnected">
        <Frozen label="found" source={FOUND} />
        <Frozen label="loading" source={LOADING} />
        <Frozen label="nothing found (no CLI history)" source={fake({ find: async () => [] })} />
        <Frozen label="error" source={fake({ find: async () => Promise.reject(new Error("Couldn't read ~/code: permission denied")) })} />
        <Frozen label="disconnected" source={LOADING} offline />
      </Row>
      <Row name="clone from URL (recommended: your GitHub repositories under the field) · O17">
        <Frozen label="GitHub list" source={FOUND} start={{ kind: "clone" }} />
        <Frozen label="owner/name typed" source={FOUND} start={{ kind: "clone", url: "you/inv" }} />
        <Frozen label="Cloning…" source={FOUND} start={{ kind: "clone", url: "you/invoice-service", cloning: true }} />
        <Frozen label="Cloning… while disconnected" source={FOUND} start={{ kind: "clone", url: "you/invoice-service", cloning: true }} offline />
        <Frozen label="git's error" source={FOUND} start={{ kind: "clone", url: "https://github.com/you/gone.git", error: "Repository not found." }} />
        <Frozen label="gh not installed" source={fake({ github: async () => ({ gh: "missing" }) })} start={{ kind: "clone" }} />
        <Frozen label="gh signed out" source={fake({ github: async () => ({ gh: "signed-out" }) })} start={{ kind: "clone" }} />
        <Frozen label="no GitHub list (Pick has it)" source={FOUND} start={{ kind: "clone", url: "you/invoice-service" }} githubIn="pick" />
      </Row>
      <Row name="alternative: On GitHub in Pick · O17">
        <Frozen label="On GitHub" source={FOUND} githubIn="pick" />
        <Frozen label="gh signed out" source={fake({ find: async () => REPOS, github: async () => ({ gh: "signed-out" }) })} githubIn="pick" />
      </Row>
      <Row name="new repository: empty · git's reason under the field">
        <Frozen label="empty" source={FOUND} start={{ kind: "new", parent: DEFAULT_PARENT, name: "" }} />
        <Frozen
          label="git can't commit"
          source={FOUND}
          start={{ kind: "new", parent: DEFAULT_PARENT, name: "my-project", error: "Author identity unknown: please tell git who you are (git config --global user.email)." }}
        />
      </Row>
    </Section>
  );
}
