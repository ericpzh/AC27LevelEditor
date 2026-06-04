---
title: Prevent Waterfall Chains in Async Operations
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallel, waterfalls, IPC
---

## Prevent Waterfall Chains in Async Operations

In any async function (load handlers, save handlers, IPC callers), start independent operations immediately, even if you don't await them yet.

**Incorrect (config waits for auth, data waits for both):**

```js
async function loadEditorData(filePath) {
  const meta = await electronAPI.getFileInfo(filePath)
  const flights = await electronAPI.loadAcl(filePath)
  const timelines = await electronAPI.loadTimelines(filePath)
  return { meta, flights, timelines }
}
```

**Correct (all three start immediately):**

```js
async function loadEditorData(filePath) {
  const metaPromise = electronAPI.getFileInfo(filePath)
  const flightsPromise = electronAPI.loadAcl(filePath)
  const timelinesPromise = electronAPI.loadTimelines(filePath)

  const [meta, flights, timelines] = await Promise.all([
    metaPromise, flightsPromise, timelinesPromise
  ])
  return { meta, flights, timelines }
}
```

For operations where one call depends on another's result, start both early and chain:

```js
const userPromise = getUser()
const profilePromise = userPromise.then(user => getProfile(user.id))

const [user, profile, config] = await Promise.all([
  userPromise,
  profilePromise,
  getConfig()
])
```
