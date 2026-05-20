/**
 * Crawlmind GitHub Action — entry point.
 *
 * Flow:
 *   1. Read inputs (token, website-id, optional target-url, …).
 *   2. POST /api/v1/public/ci/audits to kick off a CI-mode crawl.
 *   3. Poll GET /api/v1/public/ci/audits/:id every 5s until terminal,
 *      with overall timeout from `poll-timeout-seconds`.
 *   4. Build a markdown PR comment from the delta payload, post it
 *      (sticky / append / none per `comment-mode`).
 *   5. Compute the regression score; exit non-zero if it crosses the
 *      `fail-threshold` (or 0 to never fail the check).
 *
 * Why a thin Node script vs. shell + curl: GitHub Actions environments
 * already have Node 20; pulling in @actions/core for input parsing and
 * @actions/github for the PR comment is much cleaner than `gh pr
 * comment` + manual error handling. ~100 lines + a JSON↔markdown
 * formatter, all bundled into dist/index.js via @vercel/ncc.
 */
import * as core from '@actions/core';
import * as github from '@actions/github';

interface AuditDelta {
  crawlJobId: string;
  organizationId: string;
  websiteId: string;
  previousCrawlJobId: string | null;
  scores: {
    overall: number | null;
    technicalSeo: number | null;
    structuredData: number | null;
    aiCrawlerAccess: number | null;
    llmReadability: number | null;
    entityClarity: number | null;
    citationReadiness: number | null;
    performanceBasic: number | null;
  };
  delta: {
    overall: number | null;
    technicalSeo: number | null;
    structuredData: number | null;
    aiCrawlerAccess: number | null;
    llmReadability: number | null;
    entityClarity: number | null;
    citationReadiness: number | null;
    performanceBasic: number | null;
  };
  issues: {
    new: number;
    resolved: number;
    continuing: number;
    regressed: number;
    samples?: Array<{
      ruleId: string;
      severity: string;
      url: string;
      title?: string;
    }>;
  };
  trigger: string;
}

interface AuditStatusResponse {
  runId: string;
  status: 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  pagesCrawled?: number;
  pagesFailed?: number;
  overallScore?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  delta?: AuditDelta | null;
}

const TERMINAL = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
const COMMENT_MARKER = '<!-- crawlmind-audit -->';

async function run(): Promise<void> {
  try {
    const token = core.getInput('crawlmind-token', { required: true });
    const websiteId = core.getInput('website-id', { required: true });
    const targetUrl = core.getInput('target-url') || undefined;
    const maxPages = Number(core.getInput('max-pages') || '50');
    const failThreshold = Number(core.getInput('fail-threshold') || '5');
    const apiBaseUrl = (core.getInput('api-base-url') || 'https://api.crawlmind.ai').replace(/\/$/, '');
    const pollTimeoutSec = Number(core.getInput('poll-timeout-seconds') || '600');
    const commentMode = (core.getInput('comment-mode') || 'sticky') as 'sticky' | 'append' | 'none';

    if (!Number.isFinite(maxPages) || maxPages < 1 || maxPages > 200) {
      core.setFailed(`max-pages must be between 1 and 200 (got ${maxPages})`);
      return;
    }
    if (!Number.isFinite(failThreshold) || failThreshold < 0) {
      core.setFailed(`fail-threshold must be a non-negative number (got ${failThreshold})`);
      return;
    }
    if (!['sticky', 'append', 'none'].includes(commentMode)) {
      core.setFailed(`comment-mode must be 'sticky', 'append', or 'none' (got '${commentMode}')`);
      return;
    }

    const apiUrl = `${apiBaseUrl}/api/v1/public/ci`;

    // ── 1. Kick off the audit ──
    core.info(`Starting audit for website ${websiteId}${targetUrl ? ` against ${targetUrl}` : ''}…`);
    const startBody: Record<string, unknown> = { websiteId, maxPages };
    if (targetUrl) startBody.urlOverride = targetUrl;

    const startRes = await fetch(`${apiUrl}/audits`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(startBody),
    });
    if (!startRes.ok) {
      const body = await startRes.text();
      core.setFailed(
        `Failed to start audit (${startRes.status}): ${body.slice(0, 500)}\n` +
        `Common causes:\n` +
        `  - CRAWLMIND_TOKEN missing the 'ci:audit' scope (regenerate the key with that scope)\n` +
        `  - websiteId doesn't belong to the token's organization\n` +
        `  - Plan doesn't include CI audits (requires Pro or higher)`,
      );
      return;
    }
    const { runId } = (await startRes.json()) as { runId: string; status: string };
    core.info(`Started runId=${runId}. Polling for completion…`);
    core.setOutput('run-id', runId);

    // ── 2. Poll ──
    const deadline = Date.now() + pollTimeoutSec * 1000;
    let final: AuditStatusResponse | null = null;
    let lastStatus = '';
    while (Date.now() < deadline) {
      await sleep(5000);
      const statusRes = await fetch(`${apiUrl}/audits/${runId}`, {
        headers: { 'authorization': `Bearer ${token}` },
      });
      if (!statusRes.ok) {
        // Transient errors: keep polling unless we've exhausted the window.
        core.warning(`Status fetch returned ${statusRes.status}; retrying…`);
        continue;
      }
      const j = (await statusRes.json()) as AuditStatusResponse;
      if (j.status !== lastStatus) {
        core.info(`  status=${j.status}${j.pagesCrawled != null ? ` pagesCrawled=${j.pagesCrawled}` : ''}`);
        lastStatus = j.status;
      }
      if (TERMINAL.has(j.status)) {
        final = j;
        break;
      }
    }

    if (!final) {
      core.setFailed(`Audit ${runId} did not finish within ${pollTimeoutSec}s. Bump 'poll-timeout-seconds' for larger sites.`);
      return;
    }

    core.setOutput('status', final.status);
    core.setOutput('overall-score', final.overallScore != null ? String(final.overallScore) : '');

    // ── 3. Hard-failure short circuit ──
    if (final.status === 'FAILED' || final.status === 'CANCELLED') {
      const errLine = final.errorMessage ?? final.errorCode ?? 'unknown';
      if (commentMode !== 'none') {
        await postComment(buildFailureBody(runId, final.status, errLine, apiBaseUrl), commentMode);
      }
      core.setFailed(`Crawl ${final.status.toLowerCase()}: ${errLine}`);
      return;
    }

    // ── 4. Build the markdown comment + post ──
    const delta = final.delta ?? null;
    const body = buildBody({
      runId,
      status: final.status,
      pagesCrawled: final.pagesCrawled ?? 0,
      pagesFailed: final.pagesFailed ?? 0,
      durationMs: final.durationMs ?? 0,
      overallScore: final.overallScore ?? null,
      delta,
      apiBaseUrl,
      websiteId,
    });
    if (commentMode !== 'none') {
      await postComment(body, commentMode);
    }

    // ── 5. Regression score + threshold gate ──
    const regression = computeRegression(delta);
    core.setOutput('regression-score', String(regression));
    core.info(`Regression score: ${regression} (threshold: ${failThreshold})`);
    if (failThreshold > 0 && regression >= failThreshold) {
      core.setFailed(
        `Regression score ${regression} >= fail-threshold ${failThreshold}. ` +
        `See PR comment for details, or open ${publicReportUrl(apiBaseUrl, runId)}.`,
      );
      return;
    }
    core.info('Audit OK.');
  } catch (err) {
    core.setFailed(`Unexpected error: ${(err as Error).message}`);
  }
}

function computeRegression(delta: AuditDelta | null): number {
  if (!delta) return 0;
  // Score-drop component: how many overall points did we lose. Negative
  // deltas mean improvement → contribute 0.
  const drop = delta.delta.overall != null ? Math.max(0, -delta.delta.overall) : 0;
  // Issue-weighted component: new HIGH issues are 3 pts, CRITICAL 5 pts.
  // We don't have severity breakdown in the top-level counts, so use the
  // `samples` array (which carries severity) as a proxy when present.
  let weighted = 0;
  const samples = delta.issues.samples ?? [];
  for (const s of samples) {
    if (s.severity === 'CRITICAL') weighted += 5;
    else if (s.severity === 'HIGH') weighted += 3;
    else if (s.severity === 'MEDIUM') weighted += 1;
  }
  // Cap the per-issue contribution at 4× the threshold worth of samples
  // — if a new feature ships 50 critical issues, the threshold should
  // still allow the maintainer to merge and follow up, not infinitely
  // block the PR.
  return drop + Math.min(weighted, delta.issues.new * 5);
}

function buildBody(opts: {
  runId: string;
  status: string;
  pagesCrawled: number;
  pagesFailed: number;
  durationMs: number;
  overallScore: number | null;
  delta: AuditDelta | null;
  apiBaseUrl: string;
  websiteId: string;
}): string {
  const { runId, status, pagesCrawled, pagesFailed, durationMs, overallScore, delta, apiBaseUrl } = opts;
  const lines: string[] = [];
  lines.push(COMMENT_MARKER);
  lines.push('### 🔍 Crawlmind audit');
  lines.push('');
  const headlineScore = overallScore != null ? `${overallScore}/100` : '—';
  const headlineDelta =
    delta && delta.delta.overall != null
      ? formatDelta(delta.delta.overall)
      : '';
  lines.push(`**Overall: ${headlineScore}** ${headlineDelta}`);
  lines.push('');
  lines.push(`* status: \`${status}\` · pages: ${pagesCrawled} crawled${pagesFailed ? `, ${pagesFailed} failed` : ''} · took ${formatDuration(durationMs)}`);
  if (delta?.previousCrawlJobId) {
    lines.push(`* baseline: previous crawl on \`main\` (id \`${delta.previousCrawlJobId.slice(0, 10)}…\`)`);
  } else {
    lines.push(`* baseline: none — this is the first crawl for this website. Future PRs will show deltas.`);
  }
  lines.push('');

  if (delta) {
    lines.push('| Dimension | Score | Δ vs. main |');
    lines.push('|---|---:|---:|');
    const rows: Array<[string, keyof AuditDelta['scores']]> = [
      ['Technical SEO', 'technicalSeo'],
      ['Structured data', 'structuredData'],
      ['AI crawler access', 'aiCrawlerAccess'],
      ['LLM readability', 'llmReadability'],
      ['Entity clarity', 'entityClarity'],
      ['Citation readiness', 'citationReadiness'],
      ['Performance', 'performanceBasic'],
    ];
    for (const [label, key] of rows) {
      const s = delta.scores[key];
      const d = delta.delta[key];
      lines.push(`| ${label} | ${s != null ? s : '—'} | ${d != null ? formatDelta(d) : '—'} |`);
    }
    lines.push('');
    lines.push(`**Issues:** ${delta.issues.new} new · ${delta.issues.regressed} regressed · ${delta.issues.resolved} resolved · ${delta.issues.continuing} continuing`);

    if (delta.issues.samples && delta.issues.samples.length > 0) {
      lines.push('');
      lines.push('<details><summary>Top new issues</summary>');
      lines.push('');
      for (const s of delta.issues.samples.slice(0, 10)) {
        lines.push(`* \`${s.severity}\` · \`${s.ruleId}\` · ${s.url}${s.title ? ` — ${s.title}` : ''}`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }

  lines.push('');
  // Prefer the orgId from the delta response so the link routes to
  // the right org page directly. Fallback to '_' (the unknown-org
  // placeholder) only when delta is null — in that case the web app
  // bounces the user to their dashboard, which is still better than
  // a hard 404.
  const reportOrgId = delta?.organizationId ?? '_';
  lines.push(`<sub>[Full report →](${publicReportUrl(apiBaseUrl, reportOrgId, runId)}) · runId \`${runId}\`</sub>`);
  return lines.join('\n');
}

function buildFailureBody(runId: string, status: string, errLine: string, apiBaseUrl: string): string {
  return [
    COMMENT_MARKER,
    '### 🔍 Crawlmind audit',
    '',
    `**Crawl ${status.toLowerCase()}.**`,
    '',
    `\`\`\``,
    errLine.slice(0, 500),
    `\`\`\``,
    '',
    // Failure case: the API status response doesn't include orgId on
    // FAILED crawls, so the link goes to the unknown-org placeholder.
    // The web app handles `_` by bouncing the user to their dashboard.
    `<sub>runId \`${runId}\` · [open in Crawlmind →](${publicReportUrl(apiBaseUrl, '_', runId)})</sub>`,
  ].join('\n');
}

function publicReportUrl(apiBaseUrl: string, orgId: string, runId: string): string {
  // Best-effort: derive the web app's host from the API host (api.X → X).
  const webHost = apiBaseUrl.replace(/^https?:\/\/(api\.)?/, 'https://');
  return `${webHost}/orgs/${orgId}/crawls/${runId}`;
}

function formatDelta(d: number): string {
  if (d === 0) return '`±0`';
  return d > 0 ? `\`+${d}\` 🟢` : `\`${d}\` 🔴`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

async function postComment(body: string, mode: 'sticky' | 'append' | 'none'): Promise<void> {
  if (mode === 'none') return;
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('Not a pull_request event — skipping comment.');
    return;
  }
  // Prefer the explicit input (action.yml defaults it to ${{ github.token }})
  // over the env var. process.env.GITHUB_TOKEN is NOT auto-set on the
  // runner — the workflow has to pass it through. Taking it as an input
  // is the GitHub Actions standard pattern and avoids confusing "I set
  // permissions but the comment never posts" failures.
  const token = core.getInput('github-token') || process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('No github-token available. The action.yml input defaults to `${{ github.token }}`; if you overrode it to empty, restore the default and ensure `permissions: pull-requests: write` is set on the job.');
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const issueNumber = pr.number;

  if (mode === 'append') {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    return;
  }

  // Sticky: find an existing crawlmind-audit comment and update it,
  // or create a fresh one.
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: issueNumber, per_page: 100,
  });
  const existing = comments.find((c) => (c.body ?? '').includes(COMMENT_MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

void run();
