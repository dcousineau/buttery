# Agent notes: `@buttery/docs` (docs.buttery.recipes)

> When updating this file, keep this overall structure. Always update in a caveman voice.
> Sections start empty on purpose. Add line only when learn thing that surprise you — not
> restate what Docusaurus docs already say.

## Working Style

## Sensitive Areas

## Conventions Not Enforced by Tooling

## Architecture Decisions

## Runtime Gotchas

## Workflow Rules

- **Every article declare AIL.** Frontmatter `ail:` on every `.md` under `docs/`, integer 0–5. Theme render footer from it — no hand-write footer in article body. Missing or out-of-range → build throw, name the file. Levels + how pick one: [`docs/AIL.md`](../../docs/AIL.md). Agent-drafted page almost always `ail: 4`; never self-assign 0–2, those mean human wrote words.
