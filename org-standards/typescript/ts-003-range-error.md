---
id: TS-003
title: Invalid arguments throw RangeError naming the value
severity: low
applies_to: ["**/src/**/*.ts"]
---
A public function that receives an argument outside its valid range (a negative capacity, a zero interval, a non-integer count, `NaN`) throws a `RangeError` whose message names the parameter and the value it got. It does not clamp, default, or carry on silently.

**Why:** a silently clamped `capacity: -1` turns a caller's bug into wrong behavior far from its cause. A message like `capacity must be a positive integer; got -1` points straight at it.

Bad:

```ts
const size = Math.max(1, capacity);
```

Good:

```ts
if (!Number.isInteger(capacity) || capacity <= 0) {
  throw new RangeError(`capacity must be a positive integer; got ${capacity}`);
}
```
