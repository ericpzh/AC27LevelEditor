---
title: Defer Non-Critical Libraries
impact: MEDIUM
impactDescription: loads after initial render
tags: bundle, third-party, analytics, defer, react-lazy
---

## Defer Non-Critical Libraries

Analytics, logging, and error tracking don't block user interaction. Load them lazily after the initial render.

**Incorrect (blocks initial bundle):**

```jsx
import { Analytics } from './analytics'

function App() {
  useEffect(() => {
    Analytics.track('page_view')
  }, [])
  return <Main />
}
```

**Correct (loads after initial render):**

```jsx
import React, { Suspense } from 'react'

const Analytics = React.lazy(() =>
  import('./analytics').then(m => ({ default: m.Analytics }))
)

function App() {
  return (
    <>
      <Main />
      <Suspense fallback={null}>
        <Analytics />
      </Suspense>
    </>
  )
}
```

In a Vite/Electron context, `import()` is handled by Vite's code-splitting and works natively in Chromium.
