/** "+3 −1" as the old Counts drew it: mono, tabular, green and red, a zero dim. */
export function Counts({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className={insertions === 0 ? "text-muted-foreground" : "text-success"}>+{insertions}</span>{" "}
      <span className={deletions === 0 ? "text-muted-foreground" : "text-destructive"}>−{deletions}</span>
    </span>
  );
}
