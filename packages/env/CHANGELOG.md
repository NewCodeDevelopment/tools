# @newcode-team/env

## 0.2.2

### Patch Changes

- @newcode-team/config@0.2.2

## 0.2.1

### Patch Changes

- @newcode-team/config@0.2.1

## 0.2.0

### Minor Changes

- b5b4f96: Public API for scripts: `currentEnvironment`, `listEnvironments`, `loadEnvironment`, `confirmEnvironment` and `EnvironmentError`, with the CLI's loading, checks and confirmation.
  
  ```ts
  import * as newenv from "@newcode-team/env";
  
  const staging = await newenv.loadEnvironment("staging");
  const { DATABASE_URL } = staging.require("DATABASE_URL");
  ```
  
  - `loadEnvironment` reads only `.envs/.env` and `.envs/.env.<name>` by default. Pass `{ shell: process.env }` to merge the shell like the CLI
  - Never writes to `process.env`
- 40bf515: The config moves from `newenv.config.ts` to the `env` section of `newcode.config.ts`, the config file all NewCode tools share. `newenv.config.ts` is no longer read.
  
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

### Patch Changes

- Updated dependencies [789e32d]
- Updated dependencies [40bf515]
  - @newcode-team/config@0.2.0

## 0.1.2

### Patch Changes

- 0320fd3: No scripts or base keys are guarded by default.
  
  - `confirmScripts` and `forbiddenInBase` default to empty. Before, `db:push`, `db:migrate` and `db:seed` asked for confirmation and `DATABASE_URL` was refused in `.envs/.env`
  - `newenv init` creates a `newenv.config.ts` with those values as a starting point, and keeps an existing config
  - To keep the old behaviour in an existing project, add them to `newenv.config.ts`:
  
  ```ts
  import { defineConfig } from "@newcode-team/env";
  
  export default defineConfig({
    confirmScripts: ["db:push", "db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  });
  ```

## 0.1.1

### Patch Changes

- 48b7177: First release.
  
  - `newenv <command>` runs a command with `.envs/.env` and `.envs/.env.<name>` of the selected environment
  - `newenv use <name>` switches environment, `newenv status` shows it and `newenv init` sets up `.envs/` and the gitignore rules
  - Guards: refuses env files in the project root and `DATABASE_URL` in the shared base, and asks before `db:push`, `db:migrate` and `db:seed` outside local
  - Optional `newenv.config.ts` for per-environment colors and confirmation, confirm scripts, forbidden base keys and passthrough variables
