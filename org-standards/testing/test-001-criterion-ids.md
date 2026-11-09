---
id: TEST-001
title: Tests name the acceptance criterion they cover
severity: low
applies_to: ["**/test/**/*.test.ts"]
---
When a change implements a spec, each test that covers one of its acceptance criteria starts its name with the criterion's ID, so a reviewer can trace every criterion to its tests.

**Why:** without the ID, checking that every criterion is tested means reading every test. With it, a search for `AC3:` answers the question, and a criterion with no matching test stands out.

Bad:

```ts
it("refills fractional tokens", ...)
```

Good:

```ts
it("AC3: refills fractional tokens", ...)
```
