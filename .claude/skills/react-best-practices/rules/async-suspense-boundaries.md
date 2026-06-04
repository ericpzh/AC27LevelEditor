---
title: Strategic Suspense Boundaries
impact: HIGH
impactDescription: faster initial paint for complex layouts
tags: async, suspense, loading, layout
---

## Strategic Suspense Boundaries

Instead of blocking an entire screen on data loading, use `<Suspense>` boundaries to show static UI immediately while data-dependent sections load.

**Incorrect (entire screen blocked by data loading):**

```jsx
function EditorScreen() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadAllData().then(d => { setData(d); setLoading(false) })
  }, [])

  if (loading) return <div className="spinner" />

  return (
    <div>
      <Toolbar />
      <FlightTable flights={data.flights} />
      <TimelineEditor timelines={data.timelines} />
      <StatusBar />
    </div>
  )
}
```

**Correct (static UI renders immediately, data sections show skeleton):**

```jsx
import React, { Suspense } from 'react'

function EditorScreen() {
  return (
    <div>
      <Toolbar />
      <Suspense fallback={<div className="skeleton-table" />}>
        <FlightTableSection />
      </Suspense>
      <Suspense fallback={<div className="skeleton-timeline" />}>
        <TimelineSection />
      </Suspense>
      <StatusBar />
    </div>
  )
}

// Each section handles its own data loading internally
function FlightTableSection() {
  const flights = useAppStore(s => s.flights)
  // ...
}
```

For heavy components that aren't needed immediately, use `React.lazy()`:

```jsx
const HeavyChart = React.lazy(() => import('./HeavyChart'))

function Dashboard() {
  return (
    <div>
      <Header />
      <Suspense fallback={<div className="spinner" />}>
        <HeavyChart />
      </Suspense>
    </div>
  )
}
```

**When NOT to use:** Critical data needed for layout decisions, very small/fast components where Suspense overhead isn't worth it, or when avoiding layout shift is prioritized over faster initial render.
