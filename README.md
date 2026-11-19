# claude-mods

Mods and skills for [Claude Code](https://claude.com/claude-code). One plugin per folder under `plugins/`, each with its own README.

| Plugin | What it does |
|--------|--------------|
| [`auto-approve`](plugins/auto-approve/README.md) | Answers permission prompts for you: allows routine tool calls, asks you on risky ones |
| [`qboard`](plugins/qboard/README.md) | Question board: Claude puts open questions on a side pane with stable `Q<n>` ids, you answer with a click or `Q<n> <option>` |
| [`sidebar`](plugins/sidebar/README.md) | Shows every live Claude Code session as a card in a side pane, with an optional tmux jump |

## Install

```
/plugin install <plugin> --marketplace llkhacquan/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## License

MIT
