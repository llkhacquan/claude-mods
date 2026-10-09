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
  cannot be resolved. Also covers a change to the gate's own rules files: a `Write` or `Edit` aimed
  at one, a command that names one and is not a plain read, and a `cp`, `mv` or `mkdir` that names
  `.git` or `~/.config/auto-approve`. This match is on the spelling of the command, so a path
  built from a variable or reached through a link still goes to the model. No rule can turn this
  off.
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

## Rule offers in the session

When you approve the same kind of call twice in one session, the mod drafts one `ALLOW:` rule
(a sonnet call, after the tool has run) and offers it in a band above the prompt:

```
Save this as a rule? drafted from 2 calls you approved
ALLOW: kubectl port-forward to the staging namespace
  kubectl port-forward svc/a 8080 -n staging
  kubectl port-forward svc/b 9090 -n staging
s: This session  r: This repo  w: Reword  n: No
```

The band shows the whole rule and up to three of the calls behind it, so you can check that the
rule is no wider than what you approved. Press ctrl+x tab or click the band, then the key.

- **This session** keeps the rule in memory until the session ends. No file is written. A session
  holds at most 30 such rules; the oldest goes first.
- **This repo** appends the line to the repo rules file. If the file cannot be written, the offer
  stays open and a toast says so.
- **Reword** lets you edit the line first. A rule is always one `ALLOW:` line of at most 200
  characters, with no control or hidden characters.
- **No** drops it, and the same rule is not offered again in this session. Closing the pane or the
  question with Esc only puts the offer away: the calls behind it are forgotten, and a rule is
  offered again only after two more approvals.

Only a call the model itself answered `ASK` feeds a draft. A call that the hard ask layer stopped,
a destructive command, an oversize command, a call the model answered `DENY`, and a call asked
because the model timed out or gave no verdict never do. No rule is saved without your key press
on the full rule text.

The `learn` option picks where the offer shows: `band` (default), `pane`, `ask` or `off`. Set it in
the config menu, or under `pluginConfigs` in your settings.

- `pane` opens a pane that takes the keys until you answer. The focus starts on **No**, and the
  save buttons have no hotkey there, so a key typed for the prompt cannot save a rule: move with
  Tab or the arrows, then Enter. On a terminal too narrow to place the pane, the offer shows in
  the band.
- `ask` uses the question dialog, with **No** as the first option. Free text rewords the rule.

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
reminds you once at session start when the last review is more than 7 days old. The log also holds
each rule offered, saved or refused in a session, so a rule you keep saving for one session can be
moved to the repo or global file.

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
