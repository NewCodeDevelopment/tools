# @newcode-team/env

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
