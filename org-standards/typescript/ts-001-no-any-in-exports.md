---
id: TS-001
title: No any in exported signatures
severity: medium
applies_to: ["**/src/**/*.ts"]
---
Exported functions, classes and types spell out their parameter and return types. `any` never appears in an exported signature, directly or nested (`any[]`, `Promise<any>`, `Record<string, any>`).

**Why:** an exported signature is a contract with every caller. `any` switches type checking off on both sides of it, so a caller passing the wrong shape compiles and fails at runtime. Use `unknown` and narrow it, or a precise type.

Bad:

```ts
export function parseConfig(raw: any): any { ... }
```

Good:

```ts
export function parseConfig(raw: unknown): Config { ... }
```
