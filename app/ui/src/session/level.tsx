import { useRef, useState } from "react";

import { type PermissionLevel, PermissionPicker } from "../components/composer/pickers";
import { ErrorLine } from "../components/error-line";
import type { Row } from "../daemon";
import { errorText, run } from "../onboarding/api";
import { newId } from "./store";

/**
 * The permission pill a session and Home's draft both mount [D169, D170, D176]: the agent's own levels [D129, D175],
 * Ask locked while the project holds it [D166], Full access behind the kit's confirm only [D189]. An agent with no
 * levels runs as its CLI always has, so there is no pill.
 */
export function LevelPicker({
  levels,
  level,
  held,
  onChange,
}: {
  levels: readonly PermissionLevel[];
  /** The level shown: Rust's, or the user's pick until Rust has it. */
  level: PermissionLevel | null;
  held: boolean;
  onChange: (level: PermissionLevel) => void;
}) {
  if (levels.length === 0) return null;
  return <PermissionPicker value={level ?? levels[0]!} levels={levels} untrusted={held} onChange={onChange} />;
}

/** A session's row with what its next turn runs at, by the rule send uses [D129, D166, D225]. */
type LevelRow = Row & {
  levels?: PermissionLevel[];
  /** Null when the agent has no levels, or can't run at the one picked (`level_refused` says why). */
  level?: PermissionLevel | null;
  level_refused?: string | null;
  held?: boolean;
  /** The last level pick Rust took, by the app's op id [D30]. */
  level_op?: string | null;
};

/**
 * The session's permission pill: a pick shows at once and goes to Rust with its op id, settled when the row's
 * `level_op` reaches it; only the newest pick's refusal undoes it, with Rust's words [D30, D40]. It applies from the
 * next turn.
 */
export function SessionLevel({ id, row }: { id: string; row: LevelRow | undefined }) {
  const [pending, setPending] = useState<{ op: string; level: PermissionLevel } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef("");

  if (pending && row?.level_op === pending.op) setPending(null);

  const pick = (level: PermissionLevel) => {
    const op = newId();
    latest.current = op;
    setPending({ op, level });
    setError(null);
    run(["level", id, level, "--op", op]).catch((cause) => {
      if (latest.current !== op) return;
      setPending(null);
      setError(errorText(cause));
    });
  };

  return (
    <>
      <LevelPicker levels={row?.levels ?? []} level={pending?.level ?? row?.level ?? null} held={row?.held === true} onChange={pick} />
      <ErrorLine error={error ?? row?.level_refused ?? null} className="min-w-0 truncate" />
    </>
  );
}
