---
name: auto-approve
description: Add, list or remove rules of the auto-approve permission gate, or learn new rules from the decision log. Use when the user says "auto-approve", wants fewer permission prompts, or asks why a tool call was asked or allowed.
---

# Auto-Approve

The `auto-approve` mod decides each tool call before it runs: allow it, or ask the user. This skill
edits the rules the mod reads and reviews its decision log.

## Files

| What | Path |
|------|------|
| Global rules | `${XDG_CONFIG_HOME:-$HOME/.config}/auto-approve/rules.txt` |
| Repo rules | `$(git rev-parse --path-format=absolute --git-common-dir)/auto-approve-rules.txt` |
| Decision log | `${XDG_STATE_HOME:-$HOME/.local/state}/auto-approve/log/<session-id>.jsonl` |
| Learn summary | `${XDG_STATE_HOME:-$HOME/.local/state}/auto-approve/learn-summary.md` |

- The global rules file is created from the shipped defaults the first time the gate needs it.
- The repo rules file sits in the git common dir, so every worktree of the repository reads the
  same file. It is never committed and a cloned repository cannot ship one.
- Rules are plain language, one per line, starting with `ALLOW:`, `ASK:` or `DENY:`. Lines that
  start with `#` are dropped before the model reads the file.

Resolve the paths with Bash before reading or writing. Never guess them.

## Commands

### add

```
/auto-approve add "allow kubectl port-forward to staging"
/auto-approve add --global "ask before any terraform apply"
```

Default layer: **repo**. Use `--global` for all projects.

1. Resolve the target file. Outside a git repository there is no repo layer: say so and offer global.
2. Read the file. If a line already covers the rule, or conflicts with it, show that line and ask.
3. Rewrite the user's words as one line with a label: `ALLOW: ...`, `ASK: ...` or `DENY: ...`.
4. Append the line. Confirm with the layer and the exact line written.

### list

```
/auto-approve list
```

Print both layers with line numbers, global first. Say which files do not exist yet.

### remove

```
/auto-approve remove "kubectl port-forward"
```

Find the lines that match in both layers. Show them, ask which to delete, then delete only those.

### learn

```
/auto-approve learn [days]
```

Reviews what the gate decided and what the user approved, then suggests rules. Default window: 7 days.

Each log line is one JSON object:

```json
{"ts":"...","tool":"Bash","input":"<command>","action":"allow|ask","decision":"ALLOW|ASK|DENY|USER_APPROVED","reason":"...","layer":"hard-allow|hard-ask|llm|danger-llm|oversize|user","ms":812}
```

`decision` is the verdict and `action` is what the gate did with it: a `DENY` verdict still ends as
`ask`. `USER_APPROVED` means the gate asked and the user said yes. An `ASK` with no later `USER_APPROVED`
for the same `tool` and `input` means the user said no, or the call never ran.

1. Read every `*.jsonl` in the log dir. Keep entries inside the window.
2. Group by tool and a normalized command pattern (drop paths, ids, hashes, branch names). Count per
   group: `ALLOW`, `ASK`, `DENY`, `USER_APPROVED`.
3. Read both rules files, so no suggestion repeats or fights an existing line.
4. Synthesize. Do not report raw counts as rules. Generalize a group to its intent:
   - Bad: `ALLOW: kubectl port-forward svc/pprof 6060:6060`
   - Good: `ALLOW: kubectl port-forward for profiling and debugging on staging`
5. Suggest:
   - asked often and approved every time: an `ALLOW:` rule
   - asked often and never approved: an `ASK:` or `DENY:` rule
   - a `layer: "llm"` group that is always `ALLOW` and is slow (`ms`): mention it, the rule already works
6. Show each suggestion with its evidence (counts and two example commands). Ask which to keep and
   in which layer. A pattern seen in one repository only belongs in the repo layer.
7. Append the confirmed lines.
8. Delete log files whose newest entry is older than the window.
9. Last, always: write the learn summary file. The mod reads its mtime to decide when to suggest
   the next review.

```markdown
# Auto-approve learn summary
Run: <ISO datetime with timezone>

## Patterns analyzed
- <tool>: <pattern> - <asked>x asked, <approved>x approved

## Rules added
- <layer>: "<line>"

## Log maintenance
- Deleted <N> log files older than <days> days
```

Write "No rules added" when the user declined everything.

## Principles

- Counts are evidence, not verdicts. Generalize.
- Never suggest a rule that weakens a `DENY:` line, reads secrets, or allows a force push.
- One intent-based rule beats three specific ones.
- The regex layers in the mod are not editable from here. A push to a protected branch always asks,
  whatever the rules say.
