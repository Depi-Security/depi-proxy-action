# depi-proxy action

Checks every npm package your GitHub Actions job installs against [Depi](https://www.landh.tech)'s
threat intel. A local registry proxy runs for the length of the job: npm, pnpm and bun download
through it, and a blocked version is refused before its install scripts run.

You need a Depi account. Create the proxy and its organisation token in Depi, under
**Threat Intel › Threat Proxy › Set up proxy**. Depi shows this workflow with the right commit for
your setup.

## Usage

Replace `actions/setup-node` in each job that installs packages. Add the token as the
`DEPI_ORG_TOKEN` repository secret.

```yaml
permissions:
  contents: read
steps:
  - uses: actions/checkout@v4
  # Replaces actions/setup-node. Pin the commit of a release tag.
  - uses: Depi-Security/depi-proxy-action/setup-node@<commit> # vX.Y.Z
    with:
      node-version: 22
      depi-org-token: ${{ secrets.DEPI_ORG_TOKEN }}
      depi-url: https://depi-threat-intel.landh.tech
      enforcement: enforce
  - run: npm ci
```

`setup-node` takes every input of `actions/setup-node`, plus:

| Input | Default | |
| --- | --- | --- |
| `depi-org-token` | | Organisation token (`do_…`). Pass it from a secret. |
| `depi-url` | `https://api.landh.tech` | Depi endpoint, as Depi shows it. |
| `enforcement` | `warn` | `warn` installs blocked packages and reports them. `enforce` refuses them, so the install fails. |
| `fail-closed` | `false` | With `enforce`, also refuse downloads while Depi is unreachable. |
| `registry` | `https://registry.npmjs.org` | Upstream npm registry. |
| `working-directory` | `.` | Directory of the npm project. |

A job that installs packages without `actions/setup-node` can run the proxy alone, as a step before
its first install, with the same inputs: `uses: Depi-Security/depi-proxy-action@<commit>`.

At the end of the job, the summary lists what was refused, warned or served without a check. Every
install also shows up in Depi, under the proxy's name.

## What is checked

The packages the job downloads. A package restored from a cache (`cache:` of `actions/setup-node`,
or a restored `node_modules`) is not downloaded, so it does not go through the proxy.

## Releases

Each release is one commit on `main`, tagged `vX.Y.Z`. Pin its commit, not the tag. `bin/` holds the
depi-proxy binaries for Linux (x64, arm64) and macOS (Apple silicon); `action/checksums.json` holds
their SHA-256, which the action checks before it runs one.

## License

See [LICENSE](LICENSE).
