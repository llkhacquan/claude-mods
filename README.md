# claude-mods

Mods and skills for [Claude Code](https://claude.com/claude-code), one plugin per folder under `plugins/`.

## Install

Each plugin installs on its own:

```
/plugin install <plugin> --marketplace llkhacquan/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

## Plugins

None published yet.

## Layout

```
.claude-plugin/marketplace.json   lists every plugin
plugins/<name>/
  .claude-plugin/plugin.json
  hooks/                          the mod
  skills/                         skills the plugin ships
  tests/
```

## Develop

Run a plugin from its folder without installing it:

```
claude --plugin-dir plugins/<name>
```

Check and test it:

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```

## License

MIT
