// Minimal GitHub Actions toolkit: no npm dependency, so the action adds nothing to the supply chain
// it is meant to protect.
import fs from 'node:fs';
import crypto from 'node:crypto';

// INPUT_DEPI-ORG-TOKEN (JavaScript action) or INPUT_DEPI_ORG_TOKEN (scripts run by a composite action).
export const input = (name, fallback = '') => {
  const key = `INPUT_${name.toUpperCase()}`;
  return (process.env[key] ?? process.env[key.replace(/-/g, '_')] ?? '').trim() || fallback;
};
export const bool = (name) => input(name, 'false').toLowerCase() === 'true';

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** Where workflow commands go: the runner reads stdout. Tests replace `write`. */
export const commands = { write: (text) => process.stdout.write(text) };

/** `::error file=…,title=…::message` */
export function command(name, message = '', props = {}) {
  const p = Object.entries(props).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${escapeProp(v)}`).join(',');
  commands.write(`::${name}${p ? ' ' + p : ''}::${escapeData(message)}\n`);
}
export const error = (msg, props) => command('error', msg, { title: 'depi-proxy', ...props });
export const warning = (msg, props) => command('warning', msg, { title: 'depi-proxy', ...props });
export const notice = (msg, props) => command('notice', msg, { title: 'depi-proxy', ...props });
export const mask = (secret) => secret && command('add-mask', secret);
/**
 * A collapsed section of the log. The body is not trusted: the proxy's log quotes registry and Depi
 * answers, so workflow commands in it (`::error::`, `::add-mask::`…) must not run.
 */
export const group = (title, body) => {
  const token = crypto.randomUUID();
  const text = body.endsWith('\n') ? body : body + '\n';
  commands.write(`::group::${title}\n::stop-commands::${token}\n${text}::${token}::\n::endgroup::\n`);
};

function appendTo(fileVar, text) {
  const file = process.env[fileVar];
  if (file) fs.appendFileSync(file, text);
}
const kv = (k, v) => {
  if (/[\r\n]/.test(String(v))) throw new Error(`refusing multi-line value for ${k}`);
  return `${k}=${v}\n`;
};
export const setEnv = (k, v) => appendTo('GITHUB_ENV', kv(k, v));
export const setOutput = (k, v) => appendTo('GITHUB_OUTPUT', kv(k, v));
export const saveState = (k, v) => appendTo('GITHUB_STATE', kv(k, v));
export const getState = (k) => process.env[`STATE_${k}`] ?? '';
export const summary = (md) => appendTo('GITHUB_STEP_SUMMARY', md.endsWith('\n') ? md : md + '\n');

/**
 * What depi-proxy may inherit from the action's environment: only what it reads. It runs until the
 * post step as the job's user, so a package's install script can read its environment
 * (`/proc/<pid>/environ`): the runner's own tokens (`ACTIONS_RUNTIME_TOKEN`, cache URLs) and the
 * raw inputs must not be there.
 *
 * `DEPI_PROXY_DEPI_HEADERS_FILE` is a path, never the headers: a file of extra headers for the Depi
 * API, e.g. the credentials of a gateway in front of the Depi URL.
 */
const CHILD_ENV = /^(PATH|HOME|TMPDIR|LANG|LC_[A-Z]+|RUST_BACKTRACE|DEPI_PROXY_(LOG|DENYLIST|DEPI_PROTO|DEPI_HEADERS_FILE|LOCAL_FILTER|REPORT))$/;

/**
 * Environment for depi-proxy: `CHILD_ENV` of the action's, plus `extra`. Credentials only come
 * through `extra`, as files: a raw `DEPI_ORG_TOKEN` in the job's environment would also make the
 * binary skip the token file, which then stays on disk.
 */
export function childEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => CHILD_ENV.test(k)));
  return { ...env, ...extra };
}

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A JSON file written atomically by depi-proxy (the report), or null when absent or unreadable. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
