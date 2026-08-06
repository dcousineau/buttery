# Contributing

Buttery is a personal project. I build it for myself, on my own schedule, and I don't watch the GitHub community closely. Contributions are welcome, but please read this first — these guidelines are subject to change without notice.

## AI policy

This is the part I care about most.

AI-assisted contributions are fine — I use AI on this project myself. But they come with two hard requirements:

1. **Co-author your commits with the agent you used.** Every commit produced with AI assistance must carry a `Co-Authored-By:` trailer naming the model/agent. For example:

   ```
   Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
   ```

2. **Leave a sign-post review on your own PR.** Before asking for my attention, review your own diff and post a comment calling out the core changes: what actually changed, why, and anything you're unsure about. Point me at the parts that matter. A PR that dumps a large AI-generated diff with no sign-posting will be closed without review.

Undisclosed AI contributions will be closed on sight.

Practicing what I preach: this document is itself AIL-4 — drafted by Claude Opus 5, from my direction, and reviewed and edited by me before it landed.

## Discuss before you open a PR

Open an issue or a discussion first. I would much rather talk about a change than receive a surprise PR.

- **Bug fixes** — happily evaluated. Still open an issue first if the fix is non-trivial; a one-line fix with a clear reproduction can go straight to a PR.
- **Major features** — unlikely to be accepted. This project follows my own priorities and taste, and I'd rather not have you spend hours on something I'm going to decline. Ask first.

If you don't hear back for a while, that's not a rejection — I'm just not monitoring closely.

## Practical notes

- See [README.md](./README.md) for local setup (`mise install`, `pnpm install`, `pnpm dev`).
- Match the existing code style; lint and typecheck before opening a PR.
- Conventional commit subjects (`fix(recipes): ...`, `feat(cook): ...`) match the existing history.
- Keep PRs small and scoped to one thing.

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](./LICENSE), the same license as the project.
