---
"@newcode-team/sync": patch
---

`newsync db` no longer fails with `out of shared memory` on a hosted Postgres with a small lock table, such as PlanetScale. The restore no longer runs in one transaction, which locked every table, index, sequence and type of the old and the new schema at once: a Payload-sized schema needs thousands of locks. The target's schemas are renamed aside first, the dump loads statement by statement, and the old contents are dropped one table at a time. A failed or aborted restore still leaves the target as it was: the half-loaded copy is dropped and the old schemas are renamed back.
