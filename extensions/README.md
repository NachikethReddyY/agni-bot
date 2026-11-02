# Agni extensions

This directory is reserved for Agni plugins/extensions. The loader is not
implemented yet — this is a placeholder for future scope.

## Layout (planned)

```
extensions/
  <plugin-id>/
    plugin.json          # manifest: id, name, version, entry, permissions
    index.ts             # plugin entry (run in the server process)
    README.md
```

## Manifest (planned)

```json
{
  "id": "tasks",
  "name": "Tasks",
  "version": "0.1.0",
  "entry": "index.ts",
  "permissions": ["db:read", "db:write", "tools:register"]
}
```

Plugins will be discovered from `~/.agni/plugins` and activated via
`plugins.json`. See `docs/plugins.md`.
