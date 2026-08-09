# AI Influence Level (AIL)

Buttery labels written content with an **AI Influence Level** — a one-number disclosure of how much of the words came from a model and how much came from a human. The scale is [Daniel Miessler's](https://danielmiessler.com/blog/ai-influence-level-ail), published 2023-05-15. Buttery did not invent it and does not extend it; this file exists so that an agent working in any service can look the levels up without leaving the repo or guessing.

The reasoning behind the practice — and Buttery's broader position on LLM usage — is on the public [AI Usage page](../services/web/src/routes/ai-usage.tsx), which is itself deliberately AIL-1.

## The levels

| Level     | Name                                 | Definition                                                                                                          |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **AIL-0** | Human Created, No AI Involved        | A handwritten letter, a painting created from an independent idea, a typed essay done without any AI-based tooling. |
| **AIL-1** | Human Created, Minor AI Assistance   | An essay written by hand, but grammar and/or sentence structure was fixed by an AI.                                 |
| **AIL-2** | Human Created, Major AI Augmentation | An article was written by a human, but it was significantly modified or expanded upon using AI tools.               |
| **AIL-3** | AI Created, Human Full Structure     | A human fully described a story, including giving extensive structure to an AI, and the AI filled it in.            |
| **AIL-4** | AI Created, Human Basic Idea         | A human had a basic idea for a story and gave it to an AI for implementation.                                       |
| **AIL-5** | AI Created, Little Human Involvement | An AI writing tool has an API, and when invoked it produces full stories.                                           |

Definitions are quoted from the source. Pronounced "ale", or "ail" as in ailment.

## Picking a level

The number describes **who produced the words**, not who is accountable for them — a human reviews and ships everything here regardless of the level, so "I read it before merging" does not move a page down the scale.

In practice almost everything an agent writes for Buttery lands at **AIL-4**: the human gave direction and an outline's worth of intent, the model wrote the prose. Reach for AIL-3 only when the human actually supplied the full structure — section by section, with the argument already made — and the model filled in sentences. Do not self-assign AIL-0, AIL-1, or AIL-2 to something you drafted; those describe human-authored text, and an agent claiming one is making a false disclosure. If a human hands you their own writing to format or link up, that stays at their level.

When genuinely unsure, use the higher (more AI) number and say so — over-disclosing is harmless, under-disclosing is the whole failure mode this scale exists to prevent.

## Where it has to appear

- **Docs site** (`services/docs`) — every article declares `ail:` in its frontmatter and the theme renders the footer automatically. The build fails on a missing or out-of-range value, so there is no way to ship an undeclared page. See [`services/docs/AGENTS.md`](../services/docs/AGENTS.md).
- **Web app** (`services/web`) — content-heavy static pages render through `LegalPage`, which takes an `ail` prop and renders the same footer. See [`services/web/src/components/LegalPage.tsx`](../services/web/src/components/LegalPage.tsx).
- **Repo markdown** — no automated enforcement. Documents that read as prose rather than as reference material state their level in a line at the end; [`CONTRIBUTING.md`](../CONTRIBUTING.md) is the example to copy.
