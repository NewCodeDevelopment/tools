---
"@newcode-team/env": minor
---

Public API for scripts: `currentEnvironment`, `listEnvironments`, `loadEnvironment`, `confirmEnvironment` and `EnvironmentError`, with the CLI's loading, checks and confirmation.

```ts
import * as newenv from "@newcode-team/env";

const staging = await newenv.loadEnvironment("staging");
const { DATABASE_URL } = staging.require("DATABASE_URL");
```

- `loadEnvironment` reads only `.envs/.env` and `.envs/.env.<name>` by default. Pass `{ shell: process.env }` to merge the shell like the CLI
- Never writes to `process.env`
