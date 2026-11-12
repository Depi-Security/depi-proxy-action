// depi-proxy action, post step (end of the job, also behind depi-proxy/setup-node): stops the proxy
// and reports what it refused, withheld or flagged during the job.
import fs from 'node:fs';
import * as gh from './lib.mjs';
import { depiProxyProcess } from './proxy.mjs';
import { report } from './report.mjs';

/** `proxy` defaults to the real process; tests pass a fake. */
export async function endJob(session, proxy = depiProxyProcess(session)) {
  try {
    const stopped = await proxy.stop();
    if (session.started) report(stopped.report, session.enforcement);
    gh.group('depi-proxy log', stopped.log || '(empty)');
  } finally {
    fs.rmSync(session.tmp, { recursive: true, force: true });
  }
}

const state = gh.getState('session');
if (state) endJob(JSON.parse(state)).catch((e) => gh.warning(`post step: ${e.message}`));
