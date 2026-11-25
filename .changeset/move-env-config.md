---
"@newcode-team/env": minor
---

The config moves from `newenv.config.ts` to the `env` section of `newcode.config.ts`, the config file all NewCode tools share. `newenv.config.ts` is no longer read.

To switch, install `@newcode-team/config` and move the config into the `env` section. Keys and defaults are the same.

Before, `newenv.config.ts`:

```ts
import { defineConfig } from "@newcode-team/env";

export default defineConfig({
  confirmScripts: ["db:migrate", "db:seed"],
  forbiddenInBase: ["DATABASE_URL"],
  passthrough: ["VERCEL"],
});
```

After, `newcode.config.ts`:

```ts
import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";

export default defineConfig({
  env: env({
    confirmScripts: ["db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
    passthrough: ["VERCEL"],
  }),
});
```

```bash
pnpm add -D @newcode-team/config
rm newenv.config.ts
```

- `@newcode-team/config` is a peer dependency
- `defineConfig` and the `Config` type are no longer exported by `@newcode-team/env`: use `defineConfig` from `@newcode-team/config`, and `env()` or the `EnvConfig` type for the section
- The config is found from the current folder up to the git root
- `newenv init` creates `newcode.config.ts` with an `env` section. An existing config is never changed: without an `env` section, `init` prints the section to add
