# @newcode-team/env

## 0.1.1

### Patch Changes

- 48b7177: First release.
  
  - `newenv <command>` runs a command with `.envs/.env` and `.envs/.env.<name>` of the selected environment
  - `newenv use <name>` switches environment, `newenv status` shows it and `newenv init` sets up `.envs/` and the gitignore rules
  - Guards: refuses env files in the project root and `DATABASE_URL` in the shared base, and asks before `db:push`, `db:migrate` and `db:seed` outside local
  - Optional `newenv.config.ts` for per-environment colors and confirmation, confirm scripts, forbidden base keys and passthrough variables
