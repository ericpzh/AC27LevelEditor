---
title: Parallel Nested Async Operations
impact: CRITICAL
impactDescription: eliminates sequential waterfalls
tags: async, parallel, promise-chaining, Promise.all
---

## Parallel Nested Async Operations

When processing a batch of items where each item needs a follow-up async operation, chain the dependent operation inside each item's promise. This way a single slow item doesn't block the nested operations for all other items.

**Incorrect (a single slow item blocks ALL nested operations):**

```js
const flights = await Promise.all(
  flightIds.map(id => parseFlight(id))
)

const enrichedFlights = await Promise.all(
  flights.map(flight => enrichWithAudio(flight))
)
```

If one `parseFlight(id)` is extremely slow, the audio enrichment of the other 99 flights can't start even though their data is ready.

**Correct (each item chains its own nested operation):**

```js
const enrichedFlights = await Promise.all(
  flightIds.map(id =>
    parseFlight(id).then(flight => enrichWithAudio(flight))
  )
)
```

Each item independently chains `parseFlight` → `enrichWithAudio`, so a slow flight doesn't block enrichment for the others. This applies to any batch of async work — file processing, IPC calls, data transformation — where each item has a dependent follow-up operation.
