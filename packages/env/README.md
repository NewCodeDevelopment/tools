# newenv

Per-environment env files for any command, with switching and guards. Only reads files: no secrets service, no encryption, no syncing.

```bash
pnpm add -D @newcode-team/env @newcode-team/config
```

```json
{
  "scripts": {
    "dev": "newenv next dev",
    "db:push": "newenv drizzle-kit push",
    "use-env": "newenv use"
  }
}
```

Requires Node 24+.

## Conventions

| File | Holds |
|---|---|
| `.envs/.env` | Shared base of every environment (optional) |
| `.envs/.env.<name>` | One environment: `local`, `staging`, `production`, … |
| `.envs/.env.example` | Template for `newenv init`, committed |
| `.envs/current` | Selected environment. Missing means `local`. In a [monorepo](#monorepos), inherited from the workspace root |

- An environment loads `.envs/.env`, then `.envs/.env.<name>`. Its own file wins over the base, both win over the shell.
- Available environments: the `.envs/.env.*` files that exist.
- No env files in the project root. Frameworks like Next.js load those on their own.
- Values are parsed with `dotenv` and expanded with `dotenv-expand`, exactly like `dotenv-cli -e .envs/.env -e .envs/.env.<name> -o`. So `$VAR` and `${VAR:-default}` expand, and a literal `$` needs `\$`. Expansion runs over the merged env, so shell variables with a `$` in their value expand too.

## Commands

| Command | Does |
|---|---|
| `newenv <command> [args]` | Run with the selected environment |
| `newenv use <name>` | Switch environment (`local` deletes `.envs/current`). At a workspace root: every member |
| `newenv use <name> --keep-overrides` | At a workspace root: switch, but keep the members' own environments |
| `newenv use --inherit` | In a workspace member: drop its override, follow the root again |
| `newenv status` | Active environment, where it comes from and its files, never values. At a workspace root: every member |
| `newenv init` | Create `.envs/`, gitignore rules, `.envs/.env.local` and `newcode.config.ts` |
| `newenv init --shell` | Print the zsh [prompt badge](#prompt), create nothing |
| `newenv -- <command>` | Run a program named `use`, `status` or `init` |

Options go before the command, and parsing stops at the first argument that isn't one: `newenv next dev --turbopack` passes `--turbopack` to Next.

| Option | Does |
|---|---|
| `--confirm` | Ask before running, as for `confirmScripts` |
| `-h`, `--help` | Help |
| `-v`, `--version` | Version |

Outside package scripts, run it with `pnpm newenv use staging` or `pnpm exec newenv status`.

### Running

1. **Passthrough:** with a `passthrough` variable set, the command runs as is with the existing env. None by default.
2. **Root env files** (`.env`, `.env.local`, `.env.development`, `.env.production` and their `.local` variants): refused, with the `mv` command.
3. **Forbidden base keys** (`forbiddenInBase`): refused in `.envs/.env`, since the base applies to every environment. None by default.
4. **Missing environment file:** refused, with a hint.
5. **Banner** on stderr outside local: a yellow badge, red for production, plus the script and files. In a workspace member, also where the choice comes from: `(from workspace root)` or `(app override)`.
6. **Confirmation** for `confirmScripts`, matched on `npm_lifecycle_event`, and for `--confirm`: `y/N`, or typing the name for production. Without a TTY it aborts, so agents and CI can't run them by accident. Local never asks. No scripts by default.
7. **Runs** the command with inherited stdio, passes the exit code through and forwards signals.

### Switching

```bash
pnpm newenv use staging     # .envs/.env + .envs/.env.staging
pnpm newenv use local       # back to .envs/.env + .envs/.env.local
```

Refuses environments without a file. Switching to production asks first. Running processes keep the environment they started with.

### Setting up

```bash
pnpm newenv init
```

```
Created .envs/
Updated .gitignore
Created .envs/.env.local from .envs/.env.example
Created newcode.config.ts
```

The example is the first of `.envs/.env.example`, `.example-env` and `.env.example`. Existing files are kept. No script or base key is guarded by default, so the `env` section starts with `db:push`, `db:migrate`, `db:seed` and `DATABASE_URL` to edit. An existing `newcode.config.ts` is never changed: without an `env` section, `init` prints the section to add. The gitignore rules:

```gitignore
# newenv
/.env*
!/.envs/
/.envs/*
!/.envs/.env.example
```

A `.env*` pattern also matches the `.envs` folder, and git can't re-include a file in an ignored folder. So the folder is re-included first, then its contents ignored, except the example.

## Monorepos

In a pnpm, npm, Yarn or Bun workspace, switch the whole workspace from the root, and override one app from inside it. Env *files* stay per app, each with its own database, bucket, …: the apps inherit the *selection*, not the values.

```
repo/
  pnpm-workspace.yaml
  .envs/current              production: the workspace selection
  apps/antwerpen/.envs/      .env.local, .env.staging, .env.production
  apps/brussel/.envs/        … plus current: staging, an override
  packages/core/.envs/
```

```bash
newenv use production       # at the root: every member, one confirmation
newenv status               # at the root: a table of every member
cd apps/brussel
newenv use staging          # only apps/brussel
newenv use --inherit        # apps/brussel follows the root again
```

**Workspace root:** the first folder from the current one up, stopping at the git root, with a `pnpm-workspace.yaml` that has `packages`, or a `package.json` with `workspaces`. pnpm also keeps settings in `pnpm-workspace.yaml` in single-package repos, so a file without `packages` doesn't count. Without a workspace root, newenv works per folder as above.

**Members:** the workspace packages, from `packages` or `workspaces` with `!` excludes, that have a `.envs/` folder. The root is a member too when it has `.envs/.env.<name>` files of its own. A workspace whose only member is the root works like a single-app repo.

**Effective environment:** the nearest `.envs/current` from the current folder up to the workspace root, or `local` without one. So an app's own file overrides the root's. An empty file doesn't count. Files and config are still read per member: `.envs/.env.<name>` from the folder the command runs in, and its nearest `newcode.config.ts`, so `forbiddenInBase` and the other checks apply per member.

### At the root: `newenv use <name>`

```
Switch the workspace to production:
  apps/antwerpen  local → production
  apps/brussel    staging (override) → production, override cleared
  packages/core   local → production
? Switch the workspace to production? Type "production" to confirm: production
Switched the workspace to production.
```

1. **Checks every member first.** When one that would follow the root lacks `.envs/.env.<name>`, it lists them all and changes nothing. `local` only warns, so going back is never blocked.
2. **Shows the plan:** every member, what it has now and what it gets.
3. **Confirms once**, following `environments.<name>.confirm` of the root config: with `"type-name"`, as for production, you type the name. Without a TTY it aborts.
4. **Writes** the root `.envs/current`, `local` deletes it. A root `.envs/` that newenv creates gets a `.gitignore`, so the selection stays out of git.
5. **Clears the members' overrides**, since a root switch means the whole workspace. They're named in the plan before you confirm. `--keep-overrides` keeps them instead, and skips their files in the check.

### Inside a member

- `newenv use <name>` writes the member's own `.envs/current`: an override. It refuses environments without a file and asks y/N for `"type-name"` environments, as in a single-app repo.
- `newenv use local` writes `local` too, so the member stays local when the root switches. `local` always means local, never "follow the root".
- `newenv use --inherit` deletes the override, and says what the member follows now.
- Outside a member, in a folder without `.envs/`, `use` refuses and points to the root.

### Status

At the root, a table, never values:

```
Workspace    pnpm-workspace.yaml
Selected     production
Config       newcode.config.ts

Member          Environment  From      Problem
apps/antwerpen  production   root
apps/brussel    staging      override
packages/core   production   root      .envs/.env.production not found. Switch back with: newenv use local
```

`From` is `root` (the workspace selection), `override` (the member's own file) or `default` (nothing selected: local). Inside a member, `status` shows the usual lines, plus `From`: `workspace root`, `app override, the root selects production`, or `default, nothing selected`.

### Running

Each member runs with its own files, the way turbo or `pnpm --filter` run its scripts: `newenv next dev` in `apps/brussel` loads `apps/brussel/.envs/.env` and `.envs/.env.<effective name>`. At a root without env files of its own, `newenv <command>` refuses: run it inside a member.

## Use in scripts

The same loading and checks as the CLI, for scripts that need another environment, e.g. a db sync from staging to local:

```ts
import * as newenv from "@newcode-team/env";

const staging = await newenv.loadEnvironment("staging");
const local = await newenv.loadEnvironment("local");
const from = staging.require("DATABASE_URL");
const to = local.require("DATABASE_URL", "S3_BUCKET");

if (!(await newenv.confirmEnvironment("local", "Overwrite local with staging"))) {
  process.exit(1);
}
```

Named imports work too: `import { loadEnvironment } from "@newcode-team/env"`.

| Function | Returns |
|---|---|
| `currentEnvironment()` | Name in `.envs/current`, or `local`. In a workspace, the effective one: the nearest `.envs/current` up to the root |
| `selectedEnvironment()` | `{ name, source, file?, workspace? }`. `source` is `"root"`, `"override"` or `"default"`, as in `status` |
| `listEnvironments()` | Names with a `.envs/.env.<name>` file, sorted |
| `loadEnvironment(name?)` | `{ name, files, values, settings, require }`. The current environment without a name |
| `confirmEnvironment(name, question)` | `true` when confirmed. Follows `environments.<name>.confirm`, throws without a TTY |

- Only `.envs/.env` and `.envs/.env.<name>` by default, not the shell. A script often runs with another environment in `process.env`, which must not fill in keys the file lacks. Pass `{ shell: process.env }` to merge like the CLI.
- Never writes to `process.env`.
- `require(...keys)` returns the keys, and throws when one is missing or empty.
- Refusals throw an `EnvironmentError` with the CLI's messages. With a `passthrough` variable set, `loadEnvironment()` returns `process.env`, and a named environment throws.
- Every function takes `{ cwd }`, default `process.cwd()`.

## Config

Optional. The `env` section of `newcode.config.ts`, the config file all NewCode tools share. It's found by [`@newcode-team/config`](../config): the first `newcode.config.ts`, `.mjs` or `.js` from the current folder up to the git root. `newenv init` creates one:

```ts
import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";

export default defineConfig({
  env: env({
    environments: {
      staging: { color: "yellow", confirm: true },
      production: { color: "red", confirm: "type-name" },
    },
    confirmScripts: ["db:push", "db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  }),
});
```

`env()` returns the section as is. Importing it types the section and adds the `env` key to the config, so a typo is an error. Without a file or an `env` section, every key has its default. `newenv.config.ts` from 0.1 is no longer read: move it into the `env` section.

| Key | Default | Does |
|---|---|---|
| `environments.<name>.color` | `red` for production, else `yellow` | Badge: `red`, `yellow`, `green`, `blue`, `magenta`, `cyan`, `gray` |
| `environments.<name>.confirm` | `"type-name"` for production, `false` for local, else `true` | `true`: y/N. `"type-name"`: type the name, and `use` asks first. `false`: never |
| `confirmScripts` | `[]` | Scripts that ask before running |
| `forbiddenInBase` | `[]` | Keys refused in `.envs/.env` |
| `passthrough` | `[]` | Variables that skip the files, e.g. `["VERCEL"]` on a host that provides the env |
| `example` | | Source for `newenv init` |

## Prompt

Optional, zsh: the environment at the start of your prompt, ` PRODUCTION ` in red, others in yellow, nothing for local. It ships with the package, so save it from a project that has newenv and add `source ~/.config/zsh/newenv.zsh` to the end of `~/.zshrc`:

```bash
mkdir -p ~/.config/zsh && pnpm exec newenv init --shell > ~/.config/zsh/newenv.zsh
```

Run it again after upgrading newenv. A copy of the snippet from the 0.2 README can be replaced as is: the function name stays the same.

- **Pure zsh:** reads files with `$(<file)`, no node or git process, so it stays fast.
- **Resolves like newenv:** the nearest `.envs/current` from `$PWD` up to the git root. Inside an app you see its effective environment: its override, or the workspace root's choice.
- **Mixed state:** at the repo root, a `*` marks that a member's override differs, e.g. ` PRODUCTION* `, or ` LOCAL* ` with nothing selected at the root. It checks members up to two folders deep, like `apps/web`.

<details>
<summary>The snippet</summary>

```zsh
# newenv prompt badge, from: newenv init --shell
# The environment of the folder you're in: the nearest .envs/current from here up to the git root,
# the way newenv resolves it. At the root of a workspace, * marks a member whose override differs
# (members up to two folders deep, e.g. apps/web). Local shows nothing.
_app_env_prompt() {
  local dir=$PWD file app_env mixed= other value
  while true; do
    if [[ -s $dir/.envs/current ]]; then
      file=$dir/.envs/current
      break
    fi
    [[ -e $dir/.git || $dir == / ]] && break
    dir=${dir:h}
  done

  if [[ -n $file ]]; then
    app_env=$(<$file)
    app_env=${app_env//[[:space:]]/}
  fi
  [[ -n $app_env ]] || app_env=local

  if [[ $dir == $PWD && -e $PWD/.git ]]; then
    for other in $PWD/*/.envs/current(N) $PWD/*/*/.envs/current(N); do
      value=$(<$other)
      value=${value//[[:space:]]/}
      if [[ -n $value && $value != $app_env ]]; then
        mixed='*'
        break
      fi
    done
  fi
  [[ $app_env == local && -z $mixed ]] && return

  if [[ $app_env == production ]]; then
    print -n "%K{red}%F{white}%B ${(U)app_env}$mixed %b%f%k "
  else
    print -n "%K{yellow}%F{black} ${(U)app_env}$mixed %f%k "
  fi
}

setopt PROMPT_SUBST
[[ $PROMPT == *_app_env_prompt* ]] || PROMPT='$(_app_env_prompt)'$PROMPT
```

</details>

## Development

Part of the [NewCode tools](../..) monorepo, laid out like `@newcode-team/sync`:

```
src/
  cli.ts              the newenv program, registers the commands
  index.ts            the public API
  commands/
    run/              command.ts (newenv <command>), helpers.ts (banner, confirmation)
    use/              command.ts, helpers.ts (the workspace switch)
    status/           command.ts
    init/             command.ts, templates.ts (gitignore, config, prompt badge)
  lib/                config, environment (loading and the script API), errors, processes, prompts,
                      workspace (root and members)
```

- `command.ts` registers the command. Simple logic used once stays inline.
- `helpers.ts` holds logic that is complex, reused or tested on its own.
- `lib/` never imports from `commands/`.

From the repository root:

```bash
pnpm build        # tsdown, with publint and attw
pnpm test         # Vitest, builds dist/ first for the CLI tests
pnpm lint         # Oxlint
pnpm format       # Oxfmt
pnpm typecheck
pnpm changeset    # describe a change for the next release
```

Releases go through Changesets: merging to `main` opens a release PR, and merging that PR publishes to npm.

## License

MIT
