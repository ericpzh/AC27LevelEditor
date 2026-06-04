---
title: Deduplicate Global Event Listeners
impact: LOW
impactDescription: single listener for N components
tags: client, event-listeners, subscription, keyboard
---

## Deduplicate Global Event Listeners

Use a module-level Map to share a single global event listener across multiple hook instances, instead of each instance registering its own listener.

**Incorrect (N instances = N listeners):**

```jsx
function useKeyboardShortcut(key, callback) {
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.key === key) {
        callback()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [key, callback])
}
```

Each `useKeyboardShortcut` call attaches a separate listener, even for the same key combination.

**Correct (N instances = 1 listener):**

```jsx
// Module-level Map to track callbacks per key
const keyCallbacks = new Map()

function useKeyboardShortcut(key, callback) {
  // Register this callback in the Map
  useEffect(() => {
    if (!keyCallbacks.has(key)) {
      keyCallbacks.set(key, new Set())
    }
    keyCallbacks.get(key).add(callback)

    return () => {
      const set = keyCallbacks.get(key)
      if (set) {
        set.delete(callback)
        if (set.size === 0) keyCallbacks.delete(key)
      }
    }
  }, [key, callback])

  // Single global listener registered once per key combination
  useEffect(() => {
    if (keyCallbacks.has(key) && keyCallbacks.get(key).size > 1) return

    const handler = (e) => {
      if (e.ctrlKey && keyCallbacks.has(e.key)) {
        keyCallbacks.get(e.key).forEach(cb => cb())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [key])
}

function Editor() {
  useKeyboardShortcut('s', handleSave)
  useKeyboardShortcut('n', handleNew)
  // Both share a single keydown listener
}
```

This pattern is especially useful in Electron apps where keyboard shortcuts are common across multiple components.
