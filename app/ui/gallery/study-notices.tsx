// Study only (D464, D466): the studied thread notices next to ours, and four error-card looks. Dev gallery only;
// removed before anything lands.
import { StudyAroundKinds } from "./study-around";
import { ErrorCardLooks } from "./study-error-card";
import { StudyThreadKinds } from "./study-thread";
import { Section } from "./parts";

export function StudyNotices() {
  return (
    <Section title="Study notices">
      <ErrorCardLooks />
      <StudyThreadKinds />
      <StudyAroundKinds />
    </Section>
  );
}
