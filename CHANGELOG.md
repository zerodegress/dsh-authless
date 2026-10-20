# Changelog

## 0.1.1

- Adds the package metadata npm needs: `repository`, `homepage`, `bugs`, `keywords`, `author`
  and `publishConfig.access`, so the registry page links back to this repository and the package is
  findable by search.
- Adds this changelog to the published tarball, `prepublishOnly: npm test`, and a check that
  `package.json` and `dsh-plugin.json` carry the same version.
- No behavioural change from 0.1.0: the plugin replaces the same auth owner and touches nothing else.

## 0.1.0

First release.

- Removes the launch-token layer from the local DSH Web UI: `/`, `/api` and the WebSocket upgrade
  admit a request from inside the host's trust boundary without a token or a cookie, and the line
  the host prints carries no `?token=`.
- Keeps the Host/Origin fence: a request from a foreign authority is still refused with 403.
- Disables, renames and reconfigures no upstream row. The plugin replaces the connection service's
  browser-auth owner and puts the host's own owner back on unload.
- Target: `@deepseek-ai/dsh-client-connection` 0.2.1-rc.2.
