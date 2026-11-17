// Settings › General › Notifications in each state macOS can put it in [D611]; the rows look and act the same in all.
import type { Settings } from "../src/settings/api";
import { type Notices, NotificationsSection } from "../src/settings/general";
import { Row, Section, State } from "./parts";

const SETTINGS = { notify_finished: "background", notify_needs_you: true, sound: true } as Settings;
const STATES: [string, Notices][] = [
  ["Off in System Settings", "blocked"],
  ["Allowed, shown nowhere", "hidden"],
  ["Not asked yet", "unasked"],
  ["On", "sent"],
];

export function NotificationsGallery() {
  return (
    <Section title="General › Notifications">
      <Row>
        {STATES.map(([label, notices]) => (
          <State key={notices} label={label}>
            <div className="w-160">
              <NotificationsSection settings={SETTINGS} notices={notices} reload={() => undefined} />
            </div>
          </State>
        ))}
      </Row>
    </Section>
  );
}
