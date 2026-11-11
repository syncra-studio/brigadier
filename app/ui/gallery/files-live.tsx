// The gallery's live Files on the fake checkout: the app's own (src/files/views.tsx) read Rust [D1002].
import { useCallback, useMemo, useState } from "react";

import { FILES, findFiles, IGNORED, MARKS } from "../src/files/fake";
import { FileTree, type OnOpen } from "../src/files/tree";
import type { FolderEntry } from "../src/files/types";

export function FilesView({ owner, shown = null, onOpen = () => {} }: { owner: string; shown?: string | null; onOpen?: OnOpen }) {
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState<Record<string, FolderEntry[]>>({});
  const readIgnored = useCallback(
    (paths: string[]) => setLoaded((last) => ({ ...last, ...Object.fromEntries(paths.map((path) => [path, IGNORED[path] ?? []])) })),
    [],
  );
  const results = useMemo(() => (query ? findFiles(FILES, query) : null), [query]);
  return (
    <FileTree
      scope={owner}
      listing={{ state: "listed", list: FILES }}
      marks={MARKS}
      loaded={loaded}
      onReadIgnored={readIgnored}
      shown={shown}
      results={results}
      onQuery={setQuery}
      onOpen={onOpen}
    />
  );
}
