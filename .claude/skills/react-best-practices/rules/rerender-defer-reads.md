---
title: Defer State Reads to Usage Point
impact: MEDIUM
impactDescription: avoids unnecessary re-renders from store subscriptions
tags: rerender, zustand, store, optimization
---

## Defer State Reads to Usage Point

Don't subscribe to store state in a component if you only read it inside callbacks. Use `getState()` for one-time reads instead.

**Incorrect (subscribes to all store changes, re-renders on every update):**

```jsx
import { useAppStore } from './store'

function ShareButton({ id }) {
  const currentPath = useAppStore(s => s.currentPath)

  const handleShare = () => {
    exportFile(currentPath, id)
  }

  return <button onClick={handleShare}>Share</button>
}
```

**Correct (reads on demand, no subscription):**

```jsx
import { useAppStore } from './store'

function ShareButton({ id }) {
  const handleShare = () => {
    const { currentPath } = useAppStore.getState()
    exportFile(currentPath, id)
  }

  return <button onClick={handleShare}>Share</button>
}
```

This pattern avoids unnecessary re-renders when the component only needs the value inside an event handler. The component won't re-render when `currentPath` changes — it reads it fresh each time the button is clicked.
