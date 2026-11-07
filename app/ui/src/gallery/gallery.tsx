// Dev-only: every kit component in every state (D2). Opened by `pnpm gallery`.
import { useState } from "react";

import { Button } from "../components/button";
import { Gaps } from "./gaps";
import { Kit } from "./kit";

const SCREENS = { kit: "Components", gaps: "Theme gaps" };

export default function Gallery() {
  const [screen, setScreen] = useState<keyof typeof SCREENS>("kit");
  return (
    <div key={screen} className="fixed inset-0 overflow-y-auto">
      <header className="app-drag sticky top-0 z-10 flex h-titlebar items-center gap-2 border-b border-divider bg-background ps-traffic-lights">
        <span className="w-2" />
        {(Object.keys(SCREENS) as (keyof typeof SCREENS)[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={screen === key ? "secondary" : "ghost"}
            aria-pressed={screen === key}
            className="app-no-drag"
            onClick={() => setScreen(key)}
          >
            {SCREENS[key]}
          </Button>
        ))}
      </header>
      <main className="isolate flex flex-col gap-10 px-8 py-8">{screen === "kit" ? <Kit /> : <Gaps />}</main>
    </div>
  );
}
