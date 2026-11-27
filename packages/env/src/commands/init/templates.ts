// `.env*` patterns in existing gitignores also match the .envs folder, and git can't re-include a
// file in an ignored folder. So the folder is re-included first, then its contents ignored.
export const gitignoreBlock = [
  "# newenv",
  "/.env*",
  "!/.envs/",
  "/.envs/*",
  "!/.envs/.env.example",
].join("\n");

/**
 * Where .envs/.env.local is copied from: the first that exists, after the configured `example`
 */
export const exampleFiles = [".envs/.env.example", ".example-env", ".env.example"];

// newenv guards no script or base key by default, so init writes a starting point to edit
export const envSection = `  env: env({
    confirmScripts: ["db:push", "db:migrate", "db:seed"],
    forbiddenInBase: ["DATABASE_URL"],
  }),`;

export const configTemplate = `import { defineConfig } from "@newcode-team/config";
import { env } from "@newcode-team/env";

export default defineConfig({
${envSection}
});
`;

/**
 * The zsh prompt badge, printed by `newenv init --shell`. Pure zsh, no node or git process, so it
 * stays fast. Keeps the function name of the README snippet from 0.2, so a saved copy can be
 * replaced as is
 */
export const shellSnippet = `# newenv prompt badge, from: newenv init --shell
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
    dir=\${dir:h}
  done

  if [[ -n $file ]]; then
    app_env=$(<$file)
    app_env=\${app_env//[[:space:]]/}
  fi
  [[ -n $app_env ]] || app_env=local

  if [[ $dir == $PWD && -e $PWD/.git ]]; then
    for other in $PWD/*/.envs/current(N) $PWD/*/*/.envs/current(N); do
      value=$(<$other)
      value=\${value//[[:space:]]/}
      if [[ -n $value && $value != $app_env ]]; then
        mixed='*'
        break
      fi
    done
  fi
  [[ $app_env == local && -z $mixed ]] && return

  if [[ $app_env == production ]]; then
    print -n "%K{red}%F{white}%B \${(U)app_env}$mixed %b%f%k "
  else
    print -n "%K{yellow}%F{black} \${(U)app_env}$mixed %f%k "
  fi
}

setopt PROMPT_SUBST
[[ $PROMPT == *_app_env_prompt* ]] || PROMPT='$(_app_env_prompt)'$PROMPT`;
