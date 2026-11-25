---
"@newcode-team/config": patch
---

`loadConfig()` works when a bundler such as Next.js (Turbopack or webpack) bundles it: the import of `newcode.config.ts` is left to Node instead of failing with "Cannot find module as expression is too dynamic".
