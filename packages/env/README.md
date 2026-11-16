# newenv

Per-environment env files for any command, with switching and guards. Only reads files: no secrets service, no encryption, no syncing.

```bash
pnpm add -D @newcode-team/env
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
| `.envs/current` | Selected environment. Missing means `local` |

- An environment loads `.envs/.env`, then `.envs/.env.<name>`. Its own file wins over the base, both win over the shell.
- Available environments: the `.envs/.env.*` files that exist.
- No env files in the project root. Frameworks like Next.js load those on their own.
- Values are parsed with `dotenv` and expanded with `dotenv-expand`, exactly like `dotenv-cli -e .envs/.env -e .envs/.env.<name> -o`. So `$VAR` and `${VAR:-default}` expand, and a literal `$` needs `\$`. Expansion runs over the merged env, so shell variables with a `$` in their value expand too.

## Commands

| Command | Does |
|---|---|
| `newenv <command> [args]` | Run with the selected environment |
| `newenv use <name>` | Switch environment (`local` deletes `.envs/current`) |
| `newenv status` | Active environment and its files, never values |
| `newenv init` | Create `.envs/`, gitignore rules and `.envs/.env.local` |
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
3. **Forbidden base keys** (`DATABASE_URL`): refused in `.envs/.env`, since the base applies to every environment.
4. **Missing environment file:** refused, with a hint.
5. **Banner** on stderr outside local: a yellow badge, red for production, plus the script and files.
6. **Confirmation** for `confirmScripts` (`db:push`, `db:migrate`, `db:seed`), matched on `npm_lifecycle_event`: `y/N`, or typing the name for production. Without a TTY it aborts, so agents and CI can't run them by accident. Local never asks.
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
```

The example is the first of `.envs/.env.example`, `.example-env` and `.env.example`. Existing files are kept. The gitignore rules:

```gitignore
# newenv
/.env*
!/.envs/
/.envs/*
!/.envs/.env.example
```

A `.env*` pattern also matches the `.envs` folder, and git can't re-include a file in an ignored folder. So the folder is re-included first, then its contents ignored, except the example.

## Config

Optional. `newenv.config.ts`, `.mjs` or `.js` in the project root, for exceptions:

```ts
import { defineConfig } from "@newcode-team/env";

export default defineConfig({
  environments: {
    staging: { color: "yellow", confirm: true },
    production: { color: "red", confirm: "type-name" },
  },
  confirmScripts: ["db:push", "db:migrate", "db:seed"],
  forbiddenInBase: ["DATABASE_URL"],
});
```

| Key | Default | Does |
|---|---|---|
| `environments.<name>.color` | `red` for production, else `yellow` | Badge: `red`, `yellow`, `green`, `blue`, `magenta`, `cyan`, `gray` |
| `environments.<name>.confirm` | `"type-name"` for production, `false` for local, else `true` | `true`: y/N. `"type-name"`: type the name, and `use` asks first. `false`: never |
| `confirmScripts` | `["db:push", "db:migrate", "db:seed"]` | Scripts that ask before running |
| `forbiddenInBase` | `["DATABASE_URL"]` | Keys refused in `.envs/.env` |
| `passthrough` | `[]` | Variables that skip the files, e.g. `["VERCEL"]` on a host that provides the env |
| `example` | | Source for `newenv init` |

## Prompt

Optional, zsh: the environment at the start of your prompt. Reads `.envs/current` directly, so it stays fast. Save as `~/.config/zsh/newenv.zsh` and add `source ~/.config/zsh/newenv.zsh` to the end of `~/.zshrc`:

```zsh
_app_env_prompt() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || return
  [[ -f $root/.envs/current ]] || return

  local app_env=$(<$root/.envs/current)

  if [[ $app_env == production ]]; then
    print -n "%K{red}%F{white}%B PRODUCTION %b%f%k "
  else
    print -n "%K{yellow}%F{black} ${(U)app_env} %f%k "
  fi
}

setopt PROMPT_SUBST
[[ $PROMPT == *_app_env_prompt* ]] || PROMPT='$(_app_env_prompt)'$PROMPT
```

## Development

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
