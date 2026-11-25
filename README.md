# NewCode tools

Command-line tools for NewCode projects, released as separate packages under `@newcode-team`.

| Package | Command | Does |
| --- | --- | --- |
| [`@newcode-team/env`](packages/env) | `newenv` | Runs commands with per-environment env files, switches environments, guards dangerous scripts |
| [`@newcode-team/sync`](packages/sync) | `newsync` | Copies databases and files between environments |

Each package has its own version and changelog. A project installs only the tools it uses.

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

Changesets in independent mode: every package is versioned and published on its own. Add a changeset with `pnpm changeset` in the pull request; merging to `main` opens a release pull request, and merging that publishes to npm.

## License

MIT
