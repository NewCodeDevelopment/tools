# NewCode tools

Command-line tools for NewCode projects, released as separate packages under `@newcode-team`.

| Package | Command | Does |
| --- | --- | --- |
| [`@newcode-team/config`](packages/config) | | Finds, loads and types `newcode.config.ts`, the config file the tools share |
| [`@newcode-team/env`](packages/env) | `newenv` | Runs commands with per-environment env files, switches environments, guards dangerous scripts |
| [`@newcode-team/sync`](packages/sync) | `newsync` | Copies databases and files between environments |

The packages always share one version, so matching versions work together. Each has its own changelog, and a project installs only the tools it uses.

## Development

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

| Script | Does |
| --- | --- |
| `pnpm build` | Builds every package with tsdown |
| `pnpm test` / `pnpm test:ci` | Runs Vitest in every package |
| `pnpm lint` / `pnpm format:check` | oxlint and oxfmt |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm changeset` | Adds a changeset for the packages a change touches |

## Releases

Changesets with one fixed group: a release bumps every package to the same version, also those without changes. Private packages (`sync` until its first release) are bumped but not published. Add a changeset with `pnpm changeset` in the pull request; merging to `main` opens a release pull request, and merging that publishes to npm.

## License

MIT
