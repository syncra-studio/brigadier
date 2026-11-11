import { Button } from "../../components/button";
import { ErrorLine } from "../../components/error-line";
import { Spinner, Warning } from "../../icons";
import type { SourceData } from "./data";

/** The session's folder was removed outside the app: the card's line, with Restore when it can [D180, D1187]. */
export function Gone({ data, onRestore }: { data: SourceData; onRestore?: () => void }) {
  const restoring = data.restoring ?? false;
  return (
    <div className="flex flex-col items-center gap-2 pt-5 text-center">
      <span className="flex text-warning svg:size-8">
        <Warning />
      </span>
      <span className="text-base font-medium">This session's folder is gone</span>
      {data.truth?.restorable ? (
        <Button size="sm" disabled={restoring || data.offline} onClick={onRestore}>
          {restoring && <Spinner className="animate-spin motion-reduce:animate-none" />}
          {restoring ? "Restoring…" : data.restoreError ? "Try again" : "Restore"}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">It can't be restored from here.</span>
      )}
      <ErrorLine error={data.restoreError ?? null} />
    </div>
  );
}

