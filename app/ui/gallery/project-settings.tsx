// Trust this folder? on Fake data [D166, D167, D201]: each state frozen.
import type { ReactNode } from "react";

import { Dialog, DialogContent } from "../src/components/dialog";
import type { Project } from "../src/projects/projects";
import { TrustForm } from "../src/projects/trust";
import { Held, Row, Section, State } from "./parts";

const PROJECT: Project = { id: "p-1", name: "invoice-service", folder: "/Users/you/code/invoice-service", trusted: null, added: 0 };
const LONG: Project = { ...PROJECT, folder: "/Users/you/Development/clients/acme-corporation/platform/services/billing/invoice-service" };

/** A dialog held open in its own box, as the app shows it. */
export function Frozen({ label, frame, children }: { label: string; frame: string; children: ReactNode }) {
  return (
    <State label={label}>
      <Held className="h-80 w-152 overflow-hidden rounded-surface">
        {(box) => (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} frame={frame} showCloseButton={false}>
              {children}
            </DialogContent>
          </Dialog>
        )}
      </Held>
    </State>
  );
}

export function ProjectSettingsGallery() {
  return (
    <Section title="Project trust and settings">
      <Row name="Trust this folder? · short path · long path cut in the middle · refused">
        <Frozen label="short path" frame="max-w-trust gap-0 p-0">
          <TrustForm project={PROJECT} error={null} onAnswer={() => {}} />
        </Frozen>
        <Frozen label="long path" frame="max-w-trust gap-0 p-0">
          <TrustForm project={LONG} error={null} onAnswer={() => {}} />
        </Frozen>
        <Frozen label="refused" frame="max-w-trust gap-0 p-0">
          <TrustForm project={PROJECT} error="Brigadier isn't running" onAnswer={() => {}} />
        </Frozen>
      </Row>
    </Section>
  );
}
