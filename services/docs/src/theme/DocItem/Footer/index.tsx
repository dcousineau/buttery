import Footer from "@theme-original/DocItem/Footer";
import type FooterType from "@theme/DocItem/Footer";
import type { WrapperProps } from "@docusaurus/types";
import { useDoc } from "@docusaurus/plugin-content-docs/client";
import styles from "./styles.module.css";

type Props = WrapperProps<typeof FooterType>;

const AIL_URL = "https://danielmiessler.com/blog/ai-influence-level-ail";

/**
 * Daniel Miessler's AI Influence Level scale, quoted. See docs/AIL.md at the
 * repo root for the full table and guidance on choosing one.
 */
const AIL_COPY: Record<number, string> = {
  0: "Human created, no AI involved.",
  1: "Human created, with minor AI assistance.",
  2: "Human created, with major AI augmentation.",
  3: "AI created, from a full human-supplied structure.",
  4: "AI created, from a human's basic idea, reviewed by a human before publishing.",
  5: "AI created, with little human involvement.",
};

/**
 * Wraps the stock doc footer (tags, edit link, last-updated) with Buttery's AI
 * Influence Level disclosure, read from the article's `ail` frontmatter.
 *
 * The declaration is mandatory, so a missing or invalid value fails the build
 * rather than rendering a page with no disclosure — an unlabelled article is
 * the exact thing this footer exists to prevent, and a warning would ship.
 */
export default function FooterWrapper(props: Props): React.ReactElement {
  const { frontMatter, metadata } = useDoc();
  const ail = (frontMatter as { ail?: unknown }).ail;

  if (typeof ail !== "number" || !(ail in AIL_COPY)) {
    throw new Error(
      `Missing or invalid \`ail\` frontmatter in ${metadata.source}. Every article must ` +
        `declare an AI Influence Level as an integer 0-5 (e.g. \`ail: 4\`). ` +
        `See docs/AIL.md for the levels and how to pick one.`,
    );
  }

  return (
    <>
      <Footer {...props} />
      <footer className={styles.ail}>
        <p className={styles.ailText}>
          <strong className={styles.ailLabel}>AI Influence Level: AIL-{ail}</strong> — {AIL_COPY[ail]}{" "}
          <a href={AIL_URL} target="_blank" rel="noreferrer">
            What&rsquo;s an AI Influence Level?
          </a>
        </p>
      </footer>
    </>
  );
}
