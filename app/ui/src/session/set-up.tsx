import { useEffect } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/dialog";
import { useDaemon } from "../daemon";
import { AgentCard, stateOf, useAgentSetup } from "../onboarding/agents";
import { checkAll, checkOne, useAgents } from "../onboarding/api";

/**
 * "Set up {Agent}" from the model picker [D219]: onboarding's card for that one agent, in a kit dialog, running its
 * CLI's own install or sign-in. It closes once the agent has a model to pick, and the picker then lists them.
 */
export function SetUpAgentDialog({ name, onClose }: { name: string | null; onClose: () => void }) {
  const { daemon } = useDaemon();
  const online = Boolean(daemon);
  const { list, checking } = useAgents();
  const { starting, failed, begin, close } = useAgentSetup(list, online);
  const agent = list?.find((each) => each.name === name);
  // Asked afresh as it opens: it may have been set up some other way meanwhile.
  useEffect(() => {
    if (name && online) void (list ? checkOne(name) : checkAll());
  }, [name, online]);
  const ready = name !== null && stateOf(agent) === "ready";
  useEffect(() => {
    if (ready) onClose();
  }, [ready]);
  return (
    <Dialog open={name !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up {agent?.label ?? name}</DialogTitle>
        </DialogHeader>
        <ul className="flex min-w-0 flex-col">
          <AgentCard
            agent={agent}
            online={online}
            starting={starting === name}
            retrying={Boolean(name && checking.has(name))}
            failed={name ? failed[name] : undefined}
            onAction={(action) => agent && void begin(agent, action)}
            onCancel={() => name && void close(name)}
            onRetry={() => name && void checkOne(name)}
          />
        </ul>
      </DialogContent>
    </Dialog>
  );
}
