# Crawlmind audit — GitHub Action

> Run a [Crawlmind](https://crawlmind.ai) SEO + AI-visibility audit on every PR. Posts a delta-vs-`main` score comment, fails the check when regressions exceed your threshold.

## What it does

On every PR open + push, this action:

1. **Triggers a CI-mode crawl** of your registered Crawlmind website (or your PR preview URL).
2. **Waits** for the crawl + analyzer to finish (~30 seconds for a 50-page audit).
3. **Posts a sticky PR comment** with the score across 7 dimensions (Technical SEO, Structured data, AI crawler access, LLM readability, …) and the **delta vs. the last `main` crawl**.
4. **Fails the check** when the regression score exceeds `fail-threshold` so you can gate merges on SEO/AI-visibility regressions the same way you gate on tests.

## Quick start

1. **Generate a CI token**: https://crawlmind.ai → org settings → API keys → create with scope `ci:audit`. Copy the token.
2. **Add as repo secret** `CRAWLMIND_TOKEN` (repo Settings → Secrets and variables → Actions).
3. **Find your website id**: it's the cuid in the URL when viewing the website in Crawlmind (`/orgs/.../websites/<id>`).
4. **Drop this in** `.github/workflows/crawlmind-audit.yml`:

```yaml
name: Crawlmind audit
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: crawlmind/crawlmind-action@v1
        with:
          crawlmind-token: ${{ secrets.CRAWLMIND_TOKEN }}
          website-id: cmp32fohc000cgfir9fa053fs
          fail-threshold: 5
```

That's it. The next PR you open will get an audit comment.

## With a preview deployment

If you use Vercel / Netlify / Cloudflare Pages, point the audit at your PR's preview URL — that way you catch regressions in the PR's actual rendered output, not stale production:

```yaml
jobs:
  audit:
    runs-on: ubuntu-latest
    permissions: { pull-requests: write, contents: read }
    steps:
      - name: Wait for Vercel preview
        uses: patrickedqvist/wait-for-vercel-preview@v1.3.1
        id: preview
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          max_timeout: 300

      - uses: crawlmind/crawlmind-action@v1
        with:
          crawlmind-token: ${{ secrets.CRAWLMIND_TOKEN }}
          website-id: cmp32fohc000cgfir9fa053fs
          target-url: ${{ steps.preview.outputs.url }}
          fail-threshold: 5
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `crawlmind-token` | ✅ | — | API key with `ci:audit` scope |
| `website-id` | ✅ | — | Crawlmind website id (cuid) |
| `target-url` | | (registered URL) | Override the URL to crawl (preview deploys) |
| `max-pages` | | `50` | How many pages to crawl. 1-200 |
| `fail-threshold` | | `5` | Regression score that fails the job. `0` = comment-only |
| `comment-mode` | | `sticky` | `sticky` updates one comment, `append` adds new ones, `none` skips commenting |
| `poll-timeout-seconds` | | `600` | How long to wait for the crawl to finish |
| `api-base-url` | | `https://api.crawlmind.ai` | For self-hosted Crawlmind deployments |

## Outputs

| Output | Example |
|---|---|
| `run-id` | `cmp32fohc000cgfir9fa053fs` |
| `overall-score` | `87` |
| `regression-score` | `3` |
| `status` | `SUCCEEDED` / `PARTIAL` / `FAILED` |

## How the regression score is computed

```
regression = (score drop in overall points)
           + sum(severity weight per new issue, capped at 5×count)

severity weights: CRITICAL=5, HIGH=3, MEDIUM=1
```

A `fail-threshold: 5` roughly means "one new CRITICAL issue, OR two new HIGHs, OR a 5-point overall drop." Tune per your tolerance:

- **Strict** (large team, mature site): `fail-threshold: 2`
- **Balanced** (default): `fail-threshold: 5`
- **Loose** (early-stage, lots of churn): `fail-threshold: 15`
- **Comment-only** (no blocking): `fail-threshold: 0`

## Plan requirements

CI audits require **Pro plan or higher**. The Free plan can use the rest of Crawlmind but cannot kick off CI audits. Upgrade at https://crawlmind.ai/pricing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Failed to start audit (401)` | Token is wrong or missing `ci:audit` scope. Regenerate. |
| `Failed to start audit (403)` | Plan doesn't include CI audits. Upgrade to Pro. |
| `did not finish within Xs` | Site is bigger than the timeout. Bump `poll-timeout-seconds: 900`. |
| `pull-requests: write` warning | Add the permission to your job: see Quick Start. |
| Comment shows but score is `—` | First-ever crawl for this website. Future PRs will show real deltas. |

## License

MIT. See `LICENSE`.
