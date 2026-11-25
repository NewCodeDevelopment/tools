# newsync

Copies a database or an S3 bucket from one environment to another, such as production to staging or staging to local. Both sides load through [`@newcode-team/env`](../env), so nobody pastes URLs or keys for the usual cases.

```bash
pnpm add -D @newcode-team/sync @newcode-team/env @newcode-team/config
```

```json
{
  "scripts": {
    "db:sync": "newsync db",
    "s3:sync": "newsync s3"
  }
}
```

Both at once: `newsync s3 production staging && newsync db production staging`. The bucket goes first: a failed S3 sync deletes nothing, so the target still works with its old database. Each asks its own confirmation.

Requires Node 24+, plus `pg_dump`, `pg_restore` and `psql` for the database and `rclone` for S3:

| System | Install |
|---|---|
| macOS | [Postgres.app](https://postgresapp.com) (add its `bin` folder to `PATH`) or `brew install libpq`, and `brew install rclone` |
| Other | [PostgreSQL client](https://www.postgresql.org/download/) and [rclone](https://rclone.org/install/) |

`pg_dump` must be at least the major version of the source server.

## Commands

| Command | Does |
|---|---|
| `newsync db <source> <target>` | Replaces the target database's schemas with a copy of the source's |
| `newsync s3 <source> <target>` | Makes the target S3 bucket an exact copy of the source bucket |
| `--dry-run` | Changes nothing: `s3` lists what would be copied and deleted, `db` checks both connections and lists the tables that would be replaced |

`<source>` and `<target>` are environment names (a `.envs/.env.<name>` file) or `custom`. A missing one is asked, with a list of the environments plus `custom`. `custom` asks for a database URL, or an endpoint, keys and bucket, with the secrets masked.

```bash
pnpm db:sync production staging
pnpm s3:sync staging local --dry-run
```

### Every sync

1. **Tools:** checked first, with an install hint when one is missing.
2. **Both sides:** loaded with `loadEnvironment(name)`, the same files and checks as `newenv`, and the configured variables required. Or the custom prompts.
3. **Same target:** refused when source and target are the same database (host, port and name) or the same bucket on the same endpoint.
4. **Shows** `source → target` as environment, host and database or bucket, such as `staging (db.example.com/app)`. Never a user, password or key.
5. **Confirms** with the target environment's own rule from the `env` section: production types its name, local doesn't ask, others ask y/N. A custom target always asks y/N. A question without a terminal aborts, so agents and CI can't confirm by accident. The source is only read and never asks. `--dry-run` doesn't ask.

Every failure or abort exits with 1. Ctrl+C on a prompt aborts.

### Database

- `pg_dump` of the configured schemas only (custom format, no owner, no privileges). Hosting providers keep their own extensions in other schemas, which a local Postgres can't install.
- Refuses when `pg_dump` is an older major version than the source server, before dumping.
- Restores in one transaction: drops the configured schemas with `CASCADE`, then loads the dump. A failure leaves the target untouched. After a success, tables that only existed in the target are gone.
- The migration history comes along when its table lives in a synced schema, so no migrate run is needed afterwards. Drizzle keeps it in `drizzle`: add that schema.
- The dump goes to a temporary folder that is always removed, also after Ctrl+C.
- Passwords reach `pg_dump` and `psql` through `PGPASSWORD`, never as process arguments.

Doesn't copy roles, extensions or other schemas, and doesn't touch the source.

### S3

Any S3-compatible storage: Cloudflare R2, AWS S3, RustFS, MinIO, …

- `rclone sync`: copies new and changed files, skips unchanged ones (size and modification time), and deletes files that only exist in the target.
- Same endpoint and keys on both sides, such as production → staging on R2: one rclone remote, and R2 copies server-side. Otherwise, such as staging → the local container: two remotes, streaming through this machine.
- Keys reach rclone through `RCLONE_CONFIG_*` variables, never as arguments or an `rclone.conf` on disk.
- Deleting comes last and is skipped after an error, so a failed sync never leaves the target with fewer files.

Doesn't create buckets, or copy bucket settings such as CORS rules or policies.

## Config

Optional. The `sync` section of `newcode.config.ts`, the config file all NewCode tools share. The values below are the defaults, so a project that uses these variable names needs no section:

```ts
import { defineConfig } from "@newcode-team/config";
import { sync } from "@newcode-team/sync";

export default defineConfig({
  sync: sync({
    database: { url: "DATABASE_URL", schemas: ["public"] },
    s3: {
      endpoint: "S3_ENDPOINT",
      accessKeyId: "S3_ACCESS_KEY_ID",
      secretAccessKey: "S3_SECRET_ACCESS_KEY",
      bucket: "S3_BUCKET",
      provider: "auto",
    },
  }),
});
```

Settings name variables in `.envs/`, never hold their values. `sync()` returns the section as is: importing it types the section and adds the `sync` key to the config, so a typo is an error. The section is also checked when loaded, with the path in the message, such as `sync.database.schemas must be a non-empty list of names`.

| Key | Default | Does |
|---|---|---|
| `database` | | `false` switches the database sync off |
| `database.url` | `"DATABASE_URL"` | Variable with the `postgres://` URL |
| `database.schemas` | `["public"]` | Schemas that are copied and replaced. A Drizzle project: `["public", "drizzle"]` |
| `s3` | | `false` switches the S3 sync off |
| `s3.endpoint` | `"S3_ENDPOINT"` | Variable with the `http(s)://` endpoint |
| `s3.accessKeyId` | `"S3_ACCESS_KEY_ID"` | Variable with the access key ID |
| `s3.secretAccessKey` | `"S3_SECRET_ACCESS_KEY"` | Variable with the secret access key |
| `s3.bucket` | `"S3_BUCKET"` | Variable with the bucket name |
| `s3.provider` | `"auto"` | `auto`: Cloudflare R2 when the endpoint is on `r2.cloudflarestorage.com`, otherwise generic S3. Or `cloudflare`, `other` |

Confirmation follows `environments.<name>.confirm` in the `env` section.

## Use in scripts

The same syncs, for scripts:

```ts
import { confirmEnvironment } from "@newcode-team/env";
import { syncDatabase, syncS3 } from "@newcode-team/sync";

if (await confirmEnvironment("staging", "Overwrite staging with production")) {
  await syncS3({ source: "production", target: "staging" });
  await syncDatabase({ source: "production", target: "staging" });
}
```

| Function | Does |
|---|---|
| `syncDatabase({ source, target, dryRun? })` | The database sync |
| `syncS3({ source, target, dryRun? })` | The S3 sync |
| `sync(section)` | The config section helper |
| `SyncError` | Thrown for every refusal and failure, with the command's messages |

- They don't ask: confirming stays in the command. **A script must confirm itself**, for example with `confirmEnvironment` as above.
- A side is an environment name, or a custom object: `{ url }` for a database, `{ endpoint, accessKeyId, secretAccessKey, bucket, provider? }` for S3.
- Both also take `{ cwd }`, default `process.cwd()`, and `log`, default `console.log`.

## Development

Part of the [NewCode tools](../..) monorepo, laid out like `@newcode-team/env`:

```
src/
  cli.ts              the newsync program, registers the commands
  index.ts            the public API
  commands/
    database/         command.ts (newsync db), sync.ts, helpers.ts (Postgres)
    s3/               command.ts (newsync s3), sync.ts, helpers.ts (rclone)
  lib/                config, errors, the command flow, processes, prompts
```

- `command.ts` registers the command. Simple logic used once stays inline.
- `sync.ts` is the public API of the part, exported from `index.ts`.
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

The integration tests run against Postgres 18 and RustFS from `compose.yaml` at the repository root, and start them with `docker compose up`. They skip, with the reason, when Docker, `pg_dump` or `rclone` is missing.

Releases go through Changesets: merging to `main` opens a release PR, and merging that PR publishes to npm.

## License

MIT
