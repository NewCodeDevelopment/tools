# @newcode-team/config

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- 40bf515: First release: finds, loads and types `newcode.config.ts`, the one config file of the NewCode tools.
  
  - `defineConfig`, `findConfig`, `loadConfig` and `ConfigError`
  - `interface Config` is empty: each tool adds its section through module augmentation
  - Finds the file from the current folder up to the git root, so it works from a subfolder or a monorepo package

### Patch Changes

- 789e32d: `loadConfig()` works when a bundler such as Next.js (Turbopack or webpack) bundles it: the import of `newcode.config.ts` is left to Node instead of failing with "Cannot find module as expression is too dynamic".
