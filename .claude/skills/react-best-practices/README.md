# React Best Practices (Desktop/Client Edition)

Performance optimization guide for client-rendered React apps — Electron, Vite SPAs, zustand. 57 rules across 7 categories. Adapted from [@shuding](https://x.com/shuding)'s original Vercel guide.

## Structure

- `rules/` — 57 individual rule files (one per rule)
  - `_sections.md` — Section metadata (titles, impacts, descriptions)
  - `_template.md` — Template for creating new rules
- `SKILL.md` — Skill entry point with quick reference (loaded by Claude Code)
- `metadata.json` — Version and attribution metadata

## Rule Categories

| # | Category | Prefix | Rules |
|---|----------|--------|-------|
| 1 | Eliminating Waterfalls | `async-` | 7 |
| 2 | Bundle Size Optimization | `bundle-` | 6 |
| 3 | Client-Side Data Patterns | `client-` | 3 |
| 4 | Re-render Optimization | `rerender-` | 15 |
| 5 | Rendering Performance | `rendering-` | 7 |
| 6 | JavaScript Performance | `js-` | 16 |
| 7 | Advanced Patterns | `advanced-` | 4 |

## Creating a New Rule

1. Copy `rules/_template.md` to `rules/prefix-description.md`
2. Choose the prefix from the table above
3. Fill in frontmatter (`title`, `impact`, `impactDescription`, `tags`)
4. Include clear **Incorrect** / **Correct** code examples with explanations
5. Use plain JS/JSX (not TypeScript) for examples — this is a JS project

## Rule File Structure

```markdown
---
title: Rule Title Here
impact: MEDIUM
impactDescription: Optional description
tags: tag1, tag2, tag3
---

## Rule Title Here

Brief explanation of the rule and why it matters.

**Incorrect (description of what's wrong):**

```js
// Bad code example
```

**Correct (description of what's right):**

```js
// Good code example
```

Optional explanatory text after examples.
```

## Impact Levels

- `CRITICAL` — Highest priority, major performance gains
- `HIGH` — Significant performance improvements
- `MEDIUM` — Moderate performance improvements
- `LOW-MEDIUM` — Low-medium gains
- `LOW` — Incremental improvements

## Acknowledgments

Originally created by [@shuding](https://x.com/shuding) at [Vercel](https://vercel.com). Tailored for Electron/desktop React apps by removing SSR/Next.js/server-specific rules and adapting examples for IPC, zustand, and Vite.
