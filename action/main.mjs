// depi-proxy action, main step: starts the proxy that npm, pnpm and bun use in every following step
// of the job. The post step (post.mjs) stops it and reports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as gh from './lib.mjs';
import { pullRequest, reportIdentity } from './github.mjs';
import { depiProxyProcess } from './proxy.mjs';

const ACTION_DIR = path.dirname(fileURLToPath(import.meta.url));

export function target(platform = process.platform, arch = process.arch) {
  const t = { 'linux-x64': 'linux_amd64', 'linux-arm64': 'linux_arm64', 'darwin-arm64': 'darwin_arm64' }[`${platform}-${arch}`];
  if (!t) throw new Error(`unsupported runner ${platform}/${arch}`);
  return t;
}

/**
 * The binary ships inside the action's release commit: pinning the action by SHA pins the binary.
 * Its checksum is checked before anything is extracted to `tmp`.
 */
export function resolveBinary(tmp, { actionDir = ACTION_DIR, platform = process.platform, arch = process.arch } = {}) {
  const override = gh.input('binary-path');
  if (override) return path.resolve(process.env.GITHUB_WORKSPACE ?? '.', override);
  const t = target(platform, arch);
  const manifest = JSON.parse(fs.readFileSync(path.join(actionDir, 'checksums.json'), 'utf8'));
  const archive = path.join(actionDir, '..', 'bin', `depi-proxy-${t}.tar.gz`);
  const expected = manifest.sha256?.[t];
  if (!expected || !fs.existsSync(archive)) {
    throw new Error(`no depi-proxy binary for ${t} in this action ref: use a release tag/SHA (or the binary-path input)`);
  }
  const actual = gh.sha256File(archive);
  if (actual !== expected) throw new Error(`checksum mismatch for ${path.basename(archive)}: expected ${expected}, got ${actual}`);
  execFileSync('tar', ['-xzf', archive, '-C', tmp]);
  const bin = path.join(tmp, 'depi-proxy');
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Writes each secret to a 0600 file read once by depi-proxy at startup, then deleted. */
function secretFiles(tmp) {
  const env = {};
  const files = [];
  for (const [inputName, envName] of [['depi-org-token', 'DEPI_ORG_TOKEN_FILE'], ['depi-api-key', 'DEPI_API_KEY_FILE']]) {
    const value = gh.input(inputName);
    if (!value) continue;
    gh.mask(value);
    const file = path.join(tmp, envName.toLowerCase());
    fs.writeFileSync(file, value, { mode: 0o600 });
    env[envName] = file;
    files.push(file);
  }
  return { env, wipe: () => files.forEach((f) => fs.rmSync(f, { force: true })) };
}

/** Scoped registries in .npmrc are not overridden by npm_config_registry: they bypass the proxy. */
function warnScopedRegistries(dir) {
  for (const rc of [path.join(dir, '.npmrc'), path.join(os.homedir(), '.npmrc')]) {
    if (!fs.existsSync(rc)) continue;
    for (const m of fs.readFileSync(rc, 'utf8').matchAll(/^\s*(@[^:\s]+):registry\s*=\s*(\S+)/gm)) {
      gh.warning(`${m[1]} packages use their own registry (${m[2]}, from ${rc}): they bypass depi-proxy`);
    }
  }
}

async function main() {
  const enforcement = gh.input('enforcement', 'warn');
  if (!['warn', 'enforce'].includes(enforcement)) throw new Error(`unknown enforcement "${enforcement}" (warn | enforce)`);
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    gh.warning('pull_request_target runs with secrets: never install dependencies from the pull request head in this workflow');
  }
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  warnScopedRegistries(path.resolve(workspace, gh.input('working-directory', '.')));

  const tmp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'depi-proxy-'));
  const bin = resolveBinary(tmp);
  const secrets = secretFiles(tmp);
  // Whatever happens next, no secret file outlives this step. depi-proxy reads them before it
  // listens, so once it is ready they are already consumed.
  process.on('exit', secrets.wipe);
  // Two threads leave the runner's CPU to npm. At the end of the job npm is done: a request still
  // open must not hold the report back (stop() waits 5 s for it).
  // This job's proxy is reported to Depi under this repository and workflow (with a Depi token).
  const identity = reportIdentity();
  const env = gh.childEnv({
    ...secrets.env,
    GITHUB_ACTIONS: 'true',
    DEPI_PROXY_CONSUME_SECRET_FILES: '1',
    DEPI_PROXY_THREADS: '2',
    DEPI_PROXY_DRAIN_SECS: '2',
    ...(identity && { DEPI_PROXY_CONTEXT: JSON.stringify(identity.context) }),
  });
  const port = gh.input('port', '4873');
  const url = `http://127.0.0.1:${port}/`;
  const log = path.join(tmp, 'depi-proxy.log');
  const reportFile = path.join(tmp, 'report.json');
  const registry = gh.input('registry', 'https://registry.npmjs.org');
  const args = ['serve', '--listen', `127.0.0.1:${port}`, '--upstream', registry, '--report-file', reportFile, '--verifier', 'depi', '--depi-url', gh.input('depi-url', 'https://api.landh.tech'), '--registry', registry, '--enforcement', enforcement];
  if (gh.bool('fail-closed')) args.push('--fail-closed');
  if (identity) args.push('--name', identity.name);
  // Fork pull requests get no secrets: a missing token is expected there, not a failure.
  if (pullRequest()?.fromFork) args.push('--token-optional');

  const fd = fs.openSync(log, 'a');
  // depi-proxy deletes the secret files itself once read.
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd], env });
  const spawnError = await new Promise((resolve) => {
    child.once('error', resolve);
    setImmediate(() => resolve(null));
  });
  if (spawnError) {
    secrets.wipe();
    throw new Error(`cannot start depi-proxy: ${spawnError.message}`);
  }
  child.unref();
  const session = { tmp, pid: child.pid, url, reportFile, log, enforcement };
  gh.saveState('session', JSON.stringify(session));

  if (!(await depiProxyProcess(session).ready())) {
    secrets.wipe();
    gh.group('depi-proxy log', fs.readFileSync(log, 'utf8') || '(empty)');
    throw new Error('depi-proxy did not start (see its log above): nothing can be installed through it');
  }
  // Only now does the post step report: the failure above is already the whole story.
  gh.saveState('session', JSON.stringify({ ...session, started: true }));
  // Only the upstream registry's URLs are sent to the proxy: a tarball the lockfile takes from
  // elsewhere (e.g. https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz) would 404 behind it.
  for (const [k, v] of Object.entries({ npm_config_registry: url, npm_config_replace_registry_host: new URL(registry).host, BUN_CONFIG_REGISTRY: url })) gh.setEnv(k, v);
  gh.setOutput('registry-url', url);
  console.log(`depi-proxy: proxy ready on ${url} (enforcement: ${enforcement})`);
}

// Run as the action's entry point, not when a test imports it.
if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    gh.error(e.message);
    process.exitCode = 1;
  });
}
