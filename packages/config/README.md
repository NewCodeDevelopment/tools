# @newcode-team/config

Finds, loads and types `newcode.config.ts`, the one config file of the NewCode tools. Each tool reads its own section. No command, no validation of sections: the tools do that.

```bash
pnpm add -D @newcode-team/config
```

Requires Node 24+.

## The file

One file in the project root, a section per tool. Every section is optional; without a file or a section, a tool uses its defaults.

```ts
import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";

export default defineConfig({
  env: env({
    confirmScripts: ["db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  }),
});
```

- Names: `newcode.config.ts`, `.mjs` or `.js`. Two of them in one folder is an error.
- `export default` an object, wrapped in `defineConfig` for types.
- Plain values only, no functions. Settings name variables (`url: "DATABASE_URL"`), never hold their values: those stay in `.envs/`.
- `.ts` needs no build step: Node 24 strips the types itself.

## Finding

From the current folder up to the first folder with a config file, stopping at the git root or the filesystem root. So a tool finds it from a subfolder or a monorepo package. No file anywhere means `{}`.

## Types

`Config` is an empty interface. Each tool adds its section through module augmentation, so a new tool never needs a change here:

```ts
// inside a tool
declare module "@newcode-team/config" {
  interface Config {
    sync?: SyncConfig;
  }
}
```

TypeScript sees a section once its tool is imported, which the section helper (`env()`, `sync()`) takes care of. Installed tools get full types and autocomplete, a typo like `snyc:` is an error, and a project without a tool has no key for it.

## API

| Export | Does |
|---|---|
| `defineConfig(config)` | Returns the config unchanged, typed as `Config` |
| `interface Config` | Empty. Tools add their section through module augmentation |
| `findConfig({ cwd? })` | Path of the config file, or `undefined`. Synchronous |
| `loadConfig({ cwd? })` | The default export with `root` (its folder) and `file` (its path). `{}` without a file |
| `ConfigError` | Thrown for every problem with the file itself |

```ts
import { loadConfig } from "@newcode-team/config";

const { env, root, file } = await loadConfig();
```

- `loadConfig` imports each file once per process, so tools in one process share the result.
- An import that throws, such as a syntax error or a missing package, becomes a `ConfigError` naming the file, with the original error as `cause`. So does a file without a default export object.
- `cwd` defaults to `process.cwd()`.

## Development

Part of the [NewCode tools](../..) monorepo. From the repository root:

```bash
pnpm build        # tsdown, with publint and attw
pnpm test         # Vitest
pnpm lint         # Oxlint
pnpm format       # Oxfmt
pnpm typecheck
pnpm changeset    # describe a change for the next release
```

Releases go through Changesets: merging to `main` opens a release PR, and merging that PR publishes to npm.

## License

MIT
