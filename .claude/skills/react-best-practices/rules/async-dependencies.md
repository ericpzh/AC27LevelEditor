---
title: Dependency-Based Parallelization
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, dependencies, Promise.all
---

## Dependency-Based Parallelization

For operations with partial dependencies, create promises early and compose them to maximize parallelism. Start each task at the earliest possible moment.

**Incorrect (profile waits for config unnecessarily):**

```js
const [user, config] = await Promise.all([
  fetchUser(),
  fetchConfig()
])
const profile = await fetchProfile(user.id)
```

`fetchProfile` waits for `user` even though `config` could also fetch in parallel.

**Correct (config and profile run in parallel):**

```js
const userPromise = fetchUser()
const profilePromise = userPromise.then(user => fetchProfile(user.id))

const [user, config, profile] = await Promise.all([
  userPromise,
  fetchConfig(),
  profilePromise
])
```

This pattern works for any async work — IPC calls, file reads, data processing — where some operations depend on others but independent work can proceed concurrently. The key insight: create the promise early, then await later.
