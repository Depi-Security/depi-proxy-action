// The depi-proxy process of the job, seen from the action: is it listening, does it still run, and
// stopping it. Tests use a fake with the same shape: { ready(), running(), stop() }.
import fs from 'node:fs';
import { readJson } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export function depiProxyProcess({ pid, url, reportFile, log }) {
  return {
    running: () => alive(pid),
    /** True once the proxy answers on `url`, false if depi-proxy exits or `timeoutMs` passes first. */
    async ready({ timeoutMs = 30_000, fetch = globalThis.fetch } = {}) {
      for (const t0 = Date.now(); alive(pid) && Date.now() - t0 < timeoutMs; await sleep(20)) {
        try {
          if ((await fetch(new URL('healthz', url))).ok) return true;
        } catch {}
      }
      return false;
    },
    /** Stops depi-proxy and returns its log and the report it writes when it stops. */
    async stop() {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      for (const t0 = Date.now(); !fs.existsSync(reportFile) && alive(pid) && Date.now() - t0 < 5_000; ) await sleep(50);
      // Once the report is written, depi-proxy sends its last ping to Depi (5 s at most) and exits.
      for (const t0 = Date.now(); alive(pid) && Date.now() - t0 < 6_000; ) await sleep(50);
      return { log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', report: readJson(reportFile) };
    },
  };
}
