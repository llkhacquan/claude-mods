# auto-approve

```
/plugin install auto-approve --marketplace llkhacquan/claude-mods
```

A permission gate. It runs before every tool call and either lets the call run with no prompt, or
shows you the permission dialog with the reason. It never blocks on its own: the worst verdict is a
question to you.

Each call goes through these layers in order. The first one that matches decides.

```
tool call -> hard ask (regex) -> hard allow (regex) -> haiku reads your rules -> allow / ask
```

- **Hard ask**: always shows the dialog, with no model vote. Covers `gh pr create`,
  `gh release create`, and any `git push` to a protected branch (`main`, `master`, `develop`,
  `prod`, `staging`, `release*`), with a force, delete, mirror or tags flag, or to a target that
  cannot be resolved. No rule can turn this off.
- **Hard allow**: instant, no model call. Read-only and routine commands such as `git status`,
  `git add`, `git commit`, `go test`, `cargo build`, `ls`, `cat`, `grep`. A command falls out of
  this layer when any part of it redirects to a file, names a secret path, or smuggles an exec.
  `Read`, `Glob` and `Grep` are allowed the same way, unless they name a secret path.
- **Model**: everything else. Haiku reads your rules and returns `ALLOW`, `ASK` or `DENY` with a
  short reason. `DENY`, a timeout, an API error, and a reply that is not a verdict all become a
  question to you, never an allow. Destructive patterns (`rm -rf`, `dd of=/dev/...`) skip the hard
  allow and reach the model with a danger note.

The model call goes through your Claude Code session, so there is no API key to set up. It costs
about 1 second and about 1,300 input tokens per call that reaches the model (measured with the
default rules), and it counts against your plan's usage.

## Rules

Plain text, one rule per line, starting with `ALLOW:`, `ASK:` or `DENY:`.

| Layer | File | Scope |
|-------|------|-------|
| Global | `~/.config/auto-approve/rules.txt` | all projects |
| Repo | `<git common dir>/auto-approve-rules.txt` | one repository, every worktree of it |

- The global file is created from [the shipped defaults](rules/default-rules.txt)
  the first time the gate needs it. After that it is yours: edit it freely.
- The repo file lives inside `.git`, so all worktrees share it, it is never committed, and a
  repository you clone cannot ship rules that allow its own commands.
- `XDG_CONFIG_HOME` and `XDG_STATE_HOME` are honored.

## The /auto-approve skill

```
/auto-approve add "allow kubectl port-forward to staging"
/auto-approve add --global "ask before any terraform apply"
/auto-approve list
/auto-approve remove "kubectl port-forward"
/auto-approve learn
```

Every decision is logged to `~/.local/state/auto-approve/log/<session-id>.jsonl`, and so is each
time you approved a call the gate asked about. `/auto-approve learn` reads that history, groups it
by intent, and suggests rules with the evidence. Nothing is written until you confirm. The mod
reminds you once at session start when the last review is more than 7 days old.

## Limits

- The hard layers read Bash commands with regexes, not a shell parser. They are built to fail
  toward asking, but treat the gate as a way to cut prompts, not as a sandbox.
- Rules are judged by a model. Write them clearly and check the log when a verdict surprises you.
- A deny or an ask from a `PreToolUse` hook in your settings is kept as is. The gate only decides
  the calls those hooks let through.

## Develop

```
claude --plugin-dir plugins/auto-approve
claude plugin validate plugins/auto-approve
claude plugin test plugins/auto-approve
```
