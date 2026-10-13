# Two Sum Online Count

A single chart showing the number of people online on LeetCode's **Two Sum** problem each hour.

**[View the live chart](https://littlekitchen.github.io/twosum-count/)**

GitHub Actions collects the counts and GitHub Pages hosts the website. Collection runs entirely in the cloud and does not require a local computer, an open browser, an API key, or a paid third-party service.

## How it works

1. GitHub Actions is scheduled to open a fresh connection to LeetCode's public Two Sum counter at `wss://collaboration-ws.leetcode.com/problems/two-sum` every hour at minute **7**.
2. The collector accepts a numeric text message and records the count together with the time it was received.
3. The first successful sample for that hour is saved in [`web/data/history.json`](web/data/history.json). The same workflow publishes the updated chart to GitHub Pages.
4. The page checks for newly published data every minute. One responsive chart fits the most recent **30 days** on screen without horizontal scrolling; before a full month has accumulated, it shows the available history. Hover or tap the chart to see a sample's count and actual collection time.

The chart uses **Pacific Time (PT)** through `America/Los_Angeles`, including daylight saving time. Stored timestamps use UTC. GitHub's scheduler can run late, so the recorded timestamp reflects the actual measurement rather than the planned start time.

Initial records include setup and manual validation samples, so their intervals are irregular. A configured schedule does not guarantee exact 60-minute intervals: GitHub Actions may delay or drop scheduled events. The [workflow run history](https://github.com/littleKitchen/twosum-count/actions/workflows/collect-hourly.yml) distinguishes automatic (`schedule`) runs from manual (`workflow_dispatch`) runs.

Points and x-axis labels use actual `capturedAt` timestamps, including seconds, and tooltips show that same time. A count collected at 2:36:37 PM is plotted and labeled at 2:36:37 PM. Longer histories use a readable selection of real sample times as axis labels. The hourly bucket remains only a storage key to keep the first successful sample per hour.

Failed or missing samples remain gaps. They are never replaced with zero, estimates, or fabricated historical values. A genuine zero received from the source is valid.

The page is entirely in English. `history.json` keeps at most **six calendar months** of samples. Each collection run removes older records automatically, including runs where the current hour is already recorded or the source read fails. Stored history keeps six months while the chart displays only the most recent 30 days.

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

Live source reads are restricted to GitHub Actions. To verify a fresh count without changing history, manually run the [source verification workflow](https://github.com/littleKitchen/twosum-count/actions/workflows/source-probe.yml). To collect and publish a sample, run the [hourly collection workflow](https://github.com/littleKitchen/twosum-count/actions/workflows/collect-hourly.yml).

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `collect-hourly.yml` | Hourly schedule or manual run | Collect, save, and publish a sample |
| `pages.yml` | Push to `main` or manual run | Publish the static website |
| `source-probe.yml` | Manual run | Read a fresh source count without modifying history |

The collector reads public data without authentication. Local environment files, private keys, and common browser-state files are excluded by `.gitignore`; credentials should never be committed.
