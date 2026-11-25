---
"@newcode-team/sync": patch
---

`newsync db` verifies a database with `sslmode=verify-full` against the system's trusted roots when no root certificate is set up, such as PlanetScale or Neon from a machine without `~/.postgresql/root.crt`. Only that side's connection changes, so a local Postgres without SSL still connects.
