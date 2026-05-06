# Static Benchmark Demo

This directory contains a static GitHub Pages build for an InfiniKV benchmark
demo. It is intended for public, read-only presentation.

## Contents

- Static Next.js pages
- Anonymous benchmark history data from `public/history.json`
- Read-only replay views for long-context, multi-node, and steady-state tests

## Privacy Notes

- No backend credentials are included.
- No local machine paths are included.
- No personal Git identity is included.
- Public demo data is kept as benchmark sample data.

## Deployment

The project is deployed through GitHub Actions. GitHub Pages should use
`GitHub Actions` as the source.

```bash
npm ci
npm run build
```

The workflow sets `NEXT_PUBLIC_BASE_PATH` for the target repository path before
building the static output.
