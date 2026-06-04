---
title: Hoist Static Data to Module Level
impact: HIGH
impactDescription: avoids repeated I/O across invocations
tags: io, performance, module-init, caching
---

## Hoist Static Data to Module Level

When loading static assets (config files, templates, lookup tables) that don't change during the application lifetime, hoist the load to module level. Module-level code runs once when the module is first imported, not on every function call.

**Incorrect (reads config on every call):**

```js
async function processData(data) {
  const config = JSON.parse(
    await fs.readFile('./config.json', 'utf-8')
  )
  const template = await fs.readFile('./template.html', 'utf-8')
  return render(template, data, config)
}
```

**Correct (hoists config and template to module level):**

```js
const configPromise = fs
  .readFile('./config.json', 'utf-8')
  .then(JSON.parse)
const templatePromise = fs.readFile('./template.html', 'utf-8')

async function processData(data) {
  const [config, template] = await Promise.all([
    configPromise, templatePromise
  ])
  return render(template, data, config)
}
```

**Also works with synchronous reads at module level:**

```js
import { readFileSync } from 'fs'

// Blocks only during module init, then cached in memory
const STATIC_CONFIG = JSON.parse(
  readFileSync('./config.json', 'utf-8')
)

function processData(data) {
  return render(STATIC_CONFIG, data)
}
```

**When to use:** Config files, templates, lookup tables, field definitions, airline code maps — any static data loaded from disk that doesn't change at runtime.

**When NOT to use:** Data that varies per operation, files that change during runtime (use caching with invalidation instead), very large files that would consume too much memory if kept loaded.
