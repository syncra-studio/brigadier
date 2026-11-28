import { useRef, useState } from "react";
import { Text } from "react-native";
import type { Frame } from "../../../app/shared/client";
import { DialogButton } from "../Button";
import { Sheet } from "../sheets/Sheet";
import { Box, ErrorLine, s } from "../thread/rows/parts";
import { macNow } from "../link";
import { signed } from "./act";

/**
 * The one sheet before every fresh signature (lasting answers, starts, the powers), the desktop's confirm dialog
 * (components/confirm-dialog.tsx): what will happen, the exact command or path whole in a code box, Cancel and Face
 * ID. `onDone` gets the Mac's reply, or null when cancelled here.
 */
export function Confirm({ title, body, shown, args, mac, onDone }: {
  title: string;
  body?: string;
  /** Shown whole and as is: the `!` line, the resolved path, or the answer. */
  shown: string;
  args: string[];
  /** The Mac it was asked on: on any other, nothing is signed or sent. */
  mac?: string;
  onDone: (reply: Frame | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Taps before the spinner shows don't start a second signature.
  const going = useRef(false);
  async function go() {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    setError(null);
    const reply = mac !== undefined && macNow() !== mac ? { ok: false, error: "closed" } : await signed(args);
    going.current = false;
    setBusy(false);
    // Nothing was sent: the sheet stays, so the user can try again or cancel.
    if (reply.error === "cancelled") return setError("Face ID didn't confirm it. Nothing was sent.");
    if (reply.error === "notSigned") return setError("This iPhone couldn't sign it. Nothing was sent.");
    onDone(reply);
  }
  return (
    <Sheet
      title={title}
      description={body}
      onClose={() => !busy && onDone(null)}
      footer={
        <>
          <DialogButton title="Cancel" variant="ghost" disabled={busy} onPress={() => onDone(null)} />
          <DialogButton title="Confirm with Face ID" busy={busy} onPress={go} />
        </>
      }
    >
      <Box>
        <Text selectable style={s.code}>{shown}</Text>
      </Box>
      <ErrorLine error={error} xs />
    </Sheet>
  );
}
