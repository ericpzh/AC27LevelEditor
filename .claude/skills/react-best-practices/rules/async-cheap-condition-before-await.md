---
title: Check Cheap Conditions Before Async Work
impact: HIGH
impactDescription: avoids unnecessary async work when a synchronous guard already fails
tags: async, await, short-circuit, conditional
---

## Check Cheap Conditions Before Async Work

When a branch uses `await` for an async value and also requires a **cheap synchronous** condition (local props, config, already-loaded state), evaluate the cheap condition **first**. Otherwise you pay for the async call even when the compound condition can never be true.

This is a specialization of [Defer Await Until Needed](./async-defer-await.md) for `flag && cheapCondition` style checks.

**Incorrect (IPC call made even when condition is false):**

```js
const result = await electronAPI.getConfig()

if (result.success && someCondition) {
  // ...
}
```

**Correct (cheap check first, avoids unnecessary IPC):**

```js
if (someCondition) {
  const result = await electronAPI.getConfig()
  if (result.success) {
    // ...
  }
}
```

This matters when the async operation hits the filesystem, makes an IPC call, or does heavy computation: skipping it when `someCondition` is false removes that cost on the cold path.

Keep the original order if `someCondition` is expensive, depends on the async result, or you must run side effects in a fixed order.
