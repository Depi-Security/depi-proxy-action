// GitHub, as the action sees it: the event of the run.
import fs from 'node:fs';

/** Pull request context, when the job runs for one (from GITHUB_EVENT_PATH). */
export function pullRequest(env = process.env) {
  let pr;
  try {
    pr = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).pull_request;
  } catch {
    return null;
  }
  if (!pr) return null;
  return {
    number: pr.number,
    baseSha: pr.base?.sha,
    headSha: pr.head?.sha,
    fromFork: Boolean(pr.head?.repo && pr.base?.repo && pr.head.repo.full_name !== pr.base.repo.full_name),
  };
}

/**
 * How this job's proxy reports to Depi: named after the repository and the workflow file (one
 * proxy per workflow), with the job as its `github_actions` context (the binary knows nothing of
 * GitHub, ADR 0004). Depi refuses the whole ping when that context lacks a field, so a job missing
 * one sends none. `null` outside GitHub Actions.
 */
export function reportIdentity(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) return null;
  // `owner/repo/.github/workflows/ci.yml@refs/heads/main` → `ci.yml`
  const workflow = env.GITHUB_WORKFLOW_REF?.split('@')[0].split('/').pop() || env.GITHUB_WORKFLOW || 'workflow';
  const github_actions = {
    server_url: env.GITHUB_SERVER_URL || 'https://github.com',
    repository: repo,
    workflow_ref: env.GITHUB_WORKFLOW_REF,
    job: env.GITHUB_JOB,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: Number.parseInt(env.GITHUB_RUN_ATTEMPT, 10) || undefined,
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
  };
  const complete = Object.values(github_actions).every((v) => v !== undefined && v !== '');
  return { name: `${repo}:${workflow}`, context: complete ? { github_actions } : {} };
}
