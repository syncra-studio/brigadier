// Mockup only: what Rust would measure for Settings › Storage, faked in GB, and a count that arrives kind by kind.
import { useEffect, useState } from "react";

import { showToast } from "../src/components/toast";
import { type Chat, type Counted, GROUPS, type Group, type Holder, KINDS, type Kind, PER_CHAT, gb, storageOf } from "../src/settings/storage-data";

type Own = (typeof PER_CHAT)[number];
type Gigabytes = Record<Own, number>;
type FakeHolder = Pick<Holder, "id" | "title" | "archived" | "worker"> & { gigabytes: Gigabytes; working?: boolean; unmerged?: boolean };
type Fake = FakeHolder & { project: string | null; workers: FakeHolder[] };

const gigabytes = (worktrees: number, build: number, temp: number, history: number): Gigabytes => ({ worktrees, build, temp, history });
const worker = (id: string, title: string, archived: boolean, own: Gigabytes, state: Pick<FakeHolder, "working" | "unmerged"> = {}): FakeHolder => ({ id, title, gigabytes: own, archived, worker: true, ...state });

const CHATS: Fake[] = [
  {
    id: "export", title: "Ship the export dialog", project: "atlas", archived: false, worker: false, gigabytes: gigabytes(0.6, 3.1, 0.2, 0.4),
    workers: [
      worker("w1", "Draw the PDF pages", false, gigabytes(0.5, 4.2, 0.3, 0.1)),
      worker("w2", "Check the CSV columns", false, gigabytes(0.5, 3.8, 0.1, 0.1)),
      worker("w3", "Review the export", false, gigabytes(0.5, 2.9, 0.1, 0.1), { working: true }),
    ],
  },
  {
    id: "search", title: "Move search to SQLite", project: "atlas", archived: true, worker: false, gigabytes: gigabytes(0.6, 0, 0.1, 0.3),
    workers: [
      worker("w4", "Rebuild the index", true, gigabytes(0.5, 3.6, 0.2, 0.1)),
      worker("w5", "Compare the results", true, gigabytes(0.5, 3.3, 0.4, 0.1), { unmerged: true }),
    ],
  },
  {
    id: "signin", title: "Sign-in redesign", project: "lantern", archived: false, worker: false, gigabytes: gigabytes(0.4, 0, 0, 0.2),
    workers: [
      worker("w6", "Add passkeys", false, gigabytes(0.4, 2.6, 0.1, 0.1), { unmerged: true }),
      worker("w7", "Sign-in card mockup", false, gigabytes(0.4, 1.1, 0.6, 0.1)),
    ],
  },
  { id: "flaky", title: "Flaky checkout tests", project: "lantern", archived: true, worker: false, gigabytes: gigabytes(0.4, 0, 1.4, 0.2), workers: [] },
  { id: "invoices", title: "Invoice emails in German", project: "atlas", archived: false, worker: false, gigabytes: gigabytes(0.3, 0.9, 0, 0.1), workers: [] },
];
const REST: (Fake & { many: number })[] = [
  { id: "rest-live", title: "", project: null, archived: false, worker: true, many: 26, gigabytes: gigabytes(3.1, 2.2, 0.9, 1.6), workers: [] },
  { id: "rest-archived", title: "", project: null, archived: true, worker: true, many: 61, gigabytes: gigabytes(1.2, 0.8, 1.9, 2.2), workers: [] },
];
const GB = 1e9;
/** Each chat past the listed ones, all alike. */
const SMALLER: Fake[] = REST.flatMap(({ many, ...rest }) =>
  Array.from({ length: many }, (_, n) => ({ ...rest, id: `${rest.id}-${n}`, gigabytes: Object.fromEntries(PER_CHAT.map((kind) => [kind, rest.gigabytes[kind] / many])) as Gigabytes })),
);
const ALL = [...CHATS, ...SMALLER];
export const BROWSER = 1.3 * GB;
/** What Brigadier uses and what is free, together. */
const DISK = 324.7 * GB;

function goes({ archived, worker: isWorker, working, unmerged }: FakeHolder): Holder["goes"] {
  if (working) return {};
  if (archived) return { build: "left", temp: "left", ...(!unmerged && { worktrees: "left" }) };
  return isWorker ? { build: "build" } : {};
}
const holder = ({ gigabytes: _, ...own }: FakeHolder): Holder => ({ working: false, unmerged: false, ...own, goes: goes(own as FakeHolder) });
export const CHATS_SHOWN: Chat[] = ALL.map(({ project, workers, ...own }) => ({ ...holder(own), project, workers: workers.map(holder) }));

const holders = ALL.flatMap((chat): FakeHolder[] => [chat, ...chat.workers]);
export const measure = (kind: Own): Record<string, number> => Object.fromEntries(holders.map((each) => [each.id, each.gigabytes[kind] * GB]));
export const free = (sizes: Counted["sizes"]) => DISK - BROWSER - Object.values(sizes).flatMap((each) => Object.values(each)).reduce((total, size) => total + size, 0);
const EVERY = Object.fromEntries(PER_CHAT.map((kind) => [kind, measure(kind)])) as Record<Own, Record<string, number>>;

/** `sizes` without what `groups` take. */
function without(sizes: Counted["sizes"], groups: readonly Group[]): Counted["sizes"] {
  const shown = CHATS_SHOWN.flatMap((chat): Holder[] => [chat, ...chat.workers]);
  return Object.fromEntries(PER_CHAT.map((kind) => [kind, Object.fromEntries(shown.map((each) => [each.id, each.goes[kind] && groups.includes(each.goes[kind]) ? 0 : (sizes[kind]?.[each.id] ?? 0)]))]));
}

/** `?state=counting` holds the count part way; `?state=freed` starts with everything freed. */
export function useStorage() {
  const asked = new URLSearchParams(location.search).get("state");
  const [arrived, setArrived] = useState(0);
  const [sizes, setSizes] = useState<Counted["sizes"]>(() => (asked === "freed" ? without(EVERY, GROUPS.map(({ group }) => group)) : EVERY));
  const [freeing, setFreeing] = useState<Counted["freeing"]>(null);
  const last = asked === "counting" ? 2 : KINDS.length;
  useEffect(() => {
    if (arrived >= last) return;
    const timer = setTimeout(() => setArrived(arrived + 1), 550);
    return () => clearTimeout(timer);
  }, [arrived, last]);

  const here = (kind: Kind) => KINDS.findIndex((each) => each.kind === kind) < arrived;
  const counted: Counted = {
    chats: CHATS_SHOWN,
    free: free(sizes),
    sizes: Object.fromEntries(PER_CHAT.filter(here).map((kind) => [kind, sizes[kind]])),
    browser: here("browser") ? BROWSER : undefined,
    freeing,
  };
  const take = (groups: readonly Group[]) => {
    const size = groups.reduce((total, group) => total + storage.freeable(group), 0);
    let done = 0;
    setFreeing({ done, total: size });
    const tick = setInterval(() => {
      done += 1;
      if (done < 8) return setFreeing({ done: (size * done) / 8, total: size });
      clearInterval(tick);
      setSizes((now) => without(now, groups));
      setFreeing(null);
      showToast(`Freed ${gb(size)}`);
    }, 220);
  };
  const storage = storageOf(counted, { free: take, recount: () => setArrived(0) }, CHATS.length);
  return storage;
}
