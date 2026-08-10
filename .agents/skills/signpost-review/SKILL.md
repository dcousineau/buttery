---
name: signpost-review
description: Leave a "signpost review" on a big PR — 8-12 inline comments marking the only files a human architect must open, out of hundreds changed. Use after landing a large feature branch, or when asked to review/summarize/annotate own PR for a human. Not a code review; no defect hunting.
user-invocable: true
---

# Signpost review

Big PR = 100+ files, 10k+ lines. Human supervisor care about **architecture**, not plumbing. Most files (fixtures, tests, generated, design-system sync, connector code) irrelevant to them — they trace those themselves if curious.

Job: **out of 10000s of lines, mark the 10 that matter.** Inline comments, anchored to real lines, so click go straight there.

Not a code review. No defects, no nits, no praise. Signposts only.

## Reader model

Assume human with ADHD reading on phone. Short, direct, no flowery prose.

- Lead **bold claim**. Then ≤3 short lines. Stop.
- Say **intent + why open it**, not function signature. "This is the brain, all state transitions live here" > "reduce(state, event): ImportState".
- **Skip tests.** Only comment test when one or two *cases* prove something critical.
- 8–12 comments total. More = same as none.

## What earn a signpost

Pick from these, skip ones that not exist:

| Kind | Comment say |
| --- | --- |
| Entry point | where user start feature (button, modal, route) |
| Feature root | route/screen that own the tree |
| The brain | core logic file — reducer, state machine, engine. Mark "read this one" |
| New endpoints | ONE comment, all fns listed one line each, + tables they write |
| Reused write path | new code borrow existing module → say so, so future change land in right place |
| Migrations | new tables + why shaped that way |
| New shared component | "import this, no hand-roll" + what it replace |
| App-wide primitive change | new form state, new token, new variant — opt-in or not |
| Extension point | where next implementation plug in (2nd importer, 2nd provider) |
| Tricky | hand-rolled infra, worker, perf hack. Say how it *fail* ("layout bug show up as scroll bug") |

Order comments **reading order**, not file order: door → root → brain → data → shared → tricky.

## Anchoring

Line must exist in diff or API reject comment.

- New file: any line fine.
- Modified file: only **added** lines. Check hunks first:

```
git diff -U0 origin/main...HEAD -- <file> | grep "^@@"
```

`@@ -44,0 +45,5 @@` → lines 45–49 anchorable.

## Post

Build payload in Python file (shell quoting eat markdown alive), then one API call.

```
gh pr view --json number,url,changedFiles,additions
```

Script build `{body, event: "COMMENT", comments: [{path, line, side: "RIGHT", body}]}`, dump JSON to file. Then:

```
gh api repos/<owner>/<repo>/pulls/<N>/reviews --method POST --input review.json --jq '.id, .state'
```

`event: "COMMENT"` always — never `APPROVE` own work.

Verify all landed (silent drops happen when line not in diff):

```
gh api --paginate repos/<owner>/<repo>/pulls/<N>/comments --jq '[.[] | select(.pull_request_review_id == <ID>)] | length'
```

Edit lead body later: `gh api repos/<owner>/<repo>/pulls/<N>/reviews/<ID> --method PUT --input body.json`

## Attribution — required

**Human's token/account posting** (normal `gh` auth): lead comment MUST end with footer naming model + harness:

```
*Written by Claude (Opus 5) in Claude Code.*
```

Human's name on machine-written words without disclosure is misattribution. Non-negotiable.

**Dedicated bot account** (own app/PAT, e.g. `buttery-bot`): identity already clear, no footer needed.

Unsure which? Run `gh api user --jq .login`, compare to repo owner. Match human → footer.

## Lead comment shape

```
**Signpost review** — 116 files, ~18k lines. Most of it is plumbing, fixtures, and
design-system sync you can skip.

The comments below mark the ~10 places worth actually opening, in reading order:
what it is, why it matters, and what future feature work needs to know.

*Written by Claude (Opus 5) in Claude Code.*
```
