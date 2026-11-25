---
"@newcode-team/config": minor
---

First release: finds, loads and types `newcode.config.ts`, the one config file of the NewCode tools.

- `defineConfig`, `findConfig`, `loadConfig` and `ConfigError`
- `interface Config` is empty: each tool adds its section through module augmentation
- Finds the file from the current folder up to the git root, so it works from a subfolder or a monorepo package
