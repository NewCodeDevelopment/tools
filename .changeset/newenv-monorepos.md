---
"@newcode-team/env": minor
---

Monorepo support: switch a whole pnpm, npm, Yarn or Bun workspace from its root, override one app from inside it.

- **Resolution:** an app's environment is the nearest `.envs/current` from its folder up to the workspace root. Env files stay per app: the selection is inherited, not the values. The workspace root is the first folder up with a `pnpm-workspace.yaml` that has `packages`, or a `package.json` with `workspaces`. Members are its packages with a `.envs/` folder.
- **`newenv use <name>` at the root** checks every member first and changes nothing when one lacks `.envs/.env.<name>`, shows the plan, confirms once (typing the name for production), writes the root `.envs/current` and clears the members' overrides. `--keep-overrides` keeps them.
- **Inside a member**, `newenv use <name>` writes an override for that member, `local` included. `newenv use --inherit` follows the root again.
- **`newenv status`** at the root shows every member with its environment, where it comes from (`root`, `override`, `default`) and any problem. Inside a member it adds `From`.
- **Banner:** in a member, `(from workspace root)` or `(app override)` after the files.
- **Prompt badge:** `newenv init --shell` prints the zsh snippet. It now finds the nearest `.envs/current` from the current folder up, and marks a differing override at the root with `*`.
- **Script API:** `currentEnvironment` and `loadEnvironment` resolve the same way. New `selectedEnvironment()` returns the name with its source.

Migration:

- Single-app repos, and pnpm repos whose `pnpm-workspace.yaml` has no `packages`, work as before.
- In a workspace whose root already had a `.envs/current`, members without their own now follow it instead of defaulting to `local`. Check with `newenv status` at the root.
- Inside a member, `newenv use local` now writes `local` instead of deleting `.envs/current`, so the member stays local when the root switches. Use `newenv use --inherit` to follow the root.
- Replace a saved prompt snippet with the output of `newenv init --shell`. The function name is the same.
