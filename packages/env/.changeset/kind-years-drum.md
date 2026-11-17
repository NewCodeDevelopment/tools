---
"@newcode-team/env": patch
---

No scripts or base keys are guarded by default.

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
