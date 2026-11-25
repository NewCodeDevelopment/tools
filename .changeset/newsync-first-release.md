---
"@newcode-team/sync": minor
---

First release: `newsync` copies a database or an S3 bucket from one environment to another.

- `newsync db|s3 [source] [target] [--dry-run]`, with environments loaded through `@newcode-team/env`, or `custom`
- `db`: `pg_dump` of the configured schemas, restored in one transaction, so a failure leaves the target untouched
- `s3`: `rclone sync`, server-side on one remote when both buckets share an endpoint and keys
- Confirms with the target environment's rule, and refuses without a terminal
- The `sync` section of `newcode.config.ts`, and `syncDatabase` and `syncS3` for scripts
