# @newcode-team/sync

## 0.3.0

### Patch Changes

- Updated dependencies [fa6d565]
  - @newcode-team/env@0.3.0
  - @newcode-team/config@0.3.0

## 0.2.2

### Patch Changes

- 0fec70b: `newsync db` no longer fails with `out of shared memory` on a hosted Postgres with a small lock table, such as PlanetScale. The restore no longer runs in one transaction, which locked every table, index, sequence and type of the old and the new schema at once: a Payload-sized schema needs thousands of locks. The target's schemas are renamed aside first, the dump loads statement by statement, and the old contents are dropped one table at a time. A failed or aborted restore still leaves the target as it was: the half-loaded copy is dropped and the old schemas are renamed back.
- @newcode-team/config@0.2.2
  - @newcode-team/env@0.2.2

## 0.2.1

### Patch Changes

- 737868d: `newsync db` verifies a database with `sslmode=verify-full` against the system's trusted roots when no root certificate is set up, such as PlanetScale or Neon from a machine without `~/.postgresql/root.crt`. Only that side's connection changes, so a local Postgres without SSL still connects.
- @newcode-team/config@0.2.1
  - @newcode-team/env@0.2.1

## 0.2.0

### Minor Changes

- b5f2139: First release: `newsync` copies a database or an S3 bucket from one environment to another.
  
  - `newsync db|s3 [source] [target] [--dry-run]`, with environments loaded through `@newcode-team/env`, or `custom`
  - `db`: `pg_dump` of the configured schemas, restored in one transaction, so a failure leaves the target untouched
  - `s3`: `rclone sync`, server-side on one remote when both buckets share an endpoint and keys
  - Confirms with the target environment's rule, and refuses without a terminal
  - The `sync` section of `newcode.config.ts`, and `syncDatabase` and `syncS3` for scripts

### Patch Changes

- Updated dependencies [b5b4f96]
- Updated dependencies [789e32d]
- Updated dependencies [40bf515]
- Updated dependencies [40bf515]
  - @newcode-team/env@0.2.0
  - @newcode-team/config@0.2.0
