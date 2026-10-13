# Two Sum Online Count

A single chart showing the number of people online on LeetCode's **Two Sum** problem each hour.

**[View the live chart](https://littlekitchen.github.io/twosum-count/)**

GitHub Actions collects the counts and GitHub Pages hosts the website. Collection runs entirely in the cloud and does not require a local computer, an open browser, an API key, or a paid third-party service.

## How it works

1. Every hour at minute **17**, GitHub Actions opens a fresh connection to LeetCode's public Two Sum counter at `wss://collaboration-ws.leetcode.com/problems/two-sum`.
2. The collector accepts a numeric text message and records the count together with the time it was received.
3. The first successful sample for that hour is saved in [`web/data/history.json`](web/data/history.json). The same workflow publishes the updated chart to GitHub Pages.
4. The page checks for newly published data every minute. Scroll horizontally to view older hours; hover over a point to see its actual collection time.

The chart uses **Pacific Time (PT)** through `America/Los_Angeles`, including daylight saving time. Stored timestamps use UTC. GitHub's scheduler can run late, so the recorded timestamp reflects the actual measurement rather than the planned start time.

Failed or missing samples remain gaps. They are never replaced with zero, estimates, or fabricated historical values. A genuine zero received from the source is valid.

## Repository layout

```text
.github/workflows/       Hourly collection, deployment, and manual source verification
scripts/                Source reader and history collector
tests/                  Collection and source-adapter tests
web/                    Static page and recorded history
requirements.txt        Pinned Python source-reader dependency
```

## Development

Use Node.js 22 or newer to run the offline tests:

```sh
npm ci
npm test
```

The cloud workflows use Node.js 24 and Python 3.12. The Python reader's dependency is pinned in `requirements.txt`.

Live source reads are restricted to GitHub Actions. To verify a fresh count without changing history, manually run the [source verification workflow](https://github.com/littleKitchen/twosum-count/actions/workflows/source-probe.yml). To collect and publish a sample, run the [hourly collection workflow](https://github.com/littleKitchen/twosum-count/actions/workflows/hourly.yml).

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `hourly.yml` | Hourly schedule or manual run | Collect, save, and publish a sample |
| `pages.yml` | Push to `main` or manual run | Publish the static website |
| `source-probe.yml` | Manual run | Read a fresh source count without modifying history |

The collector reads public data without authentication. Local environment files, private keys, and common browser-state files are excluded by `.gitignore`; credentials should never be committed.
