---
title: Dynamic Imports for Heavy Components
impact: CRITICAL
impactDescription: directly affects startup time
tags: bundle, dynamic-import, code-splitting, react-lazy
---

## Dynamic Imports for Heavy Components

Use `React.lazy()` + `<Suspense>` to lazy-load large components not needed on initial render. Vite supports dynamic `import()` natively.

**Incorrect (heavy editor bundles with main chunk):**

```jsx
import { MonacoEditor } from './monaco-editor'

function CodePanel({ code }) {
  return <MonacoEditor value={code} />
}
```

**Correct (editor loads on demand):**

```jsx
import React, { Suspense } from 'react'

const MonacoEditor = React.lazy(() =>
  import('./monaco-editor').then(m => ({ default: m.MonacoEditor }))
)

function CodePanel({ code }) {
  return (
    <Suspense fallback={<div className="spinner" />}>
      <MonacoEditor value={code} />
    </Suspense>
  )
}
```
