# dsh-authless design

Removes the launch-token layer from the local DSH Web UI: `http://127.0.0.1:3080/` and `/api`
work without `?token=` and without a cookie. Only that layer goes; the Host/Origin fence stays
where it is.

Target: `@deepseek-ai/dsh-web-app@0.2.1-rc.2`, with the
`@deepseek-ai/dsh-client-connection@0.2.1-rc.2` and `@deepseek-ai/dsh-host-webserver@0.2.1-rc.2`
builds it pulls in. A Chinese version of this document is in [design_ZH.md](design_ZH.md).

## 1. Upstream behaviour (0.2.1-rc.2)

| Surface | Location | What the code does |
| --- | --- | --- |
| Launch token | `dsh-client-connection/lib/index.js:294-300` `processLaunchToken()` | One random token per process; no env var or config switch turns it off |
| Token to cookie | same file, `:440-446` (`authenticatedUrl` appends `?token=`), `:458-497` (`authorizeIndex` trades the token for a signed cookie) | The first browser visit must carry the token; later requests use the cookie |
| `/api` gate | same file, `:742-752` `admit(request)` | `isTrusted(request)` runs first (fail: 403), then the auth owner (fail: 401) |
| Auth owner | same file, `:694-712` (`HostConnectionService.browserAuth`, built by `BrowserAuth.create(...)` in `apply`), `:797-814` | `/connect`, index, `/api` and `authenticatedUrl` all go through it |
| Printed and opened URL | `dsh-web-app/lib/index.js:160-165` | Both call `connection.authenticatedUrl(webUrl)`, so whatever the owner answers is what gets printed and opened |
| WebSocket upgrade | `dsh-client-connection/lib/index.js:756-757` | `admitConnection()` calls `this.admit(request)` first, so the upgrade rides the same gate as `/api` (403, then 401, then admitted) |
| Wildcard bind | `dsh-web-app/lib/startup.js:48` and `dsh-host-webserver/lib/index.js:255` | Both refuse `0.0.0.0`. The error text gives the reason: binding every interface puts the RCE surface on the network |
| `--public-url` | `dsh-web-app/lib/startup.js:25` | Present upstream since 0.2.1; nothing for this plugin to do |

## 2. Removing the token: mechanism and boundaries

The plugin replaces the auth owner that the connection service holds. The service, its routes and
its peers are left alone:

```
connection = ctx.get('connection')            // HostConnectionService, registered upstream
connection.browserAuth = new OpenAuth()       // the only field this plugin writes
```

`OpenAuth` implements the five methods upstream calls on the owner, and each one answers yes:

| Method | Upstream | This plugin |
| --- | --- | --- |
| `isAuthenticated(req, secure)` | checks the signed cookie | `true` |
| `authenticateApi(req, secure)` | checks API credentials | `undefined` (unreachable once the first check answers true) |
| `authorizeIndex(req, res, secure)` | token to cookie, or cookie to index | `true`, and no 401 is written |
| `authorizeConnect(req, res, secure, publish)` | token to operator, then 302 | validate the `interactions` declaration, `publish()`, then 302, with no token and no cookie |
| `authenticatedUrl(baseUrl)` | appends `?token=` | drops `token` and `#`, keeps everything else |

That is enough because `admit()` (`:742-746`) calls `isTrusted(request)` first. The 403 branch
belongs to `HostConnectionService` and never reaches the owner, so replacing the owner removes the
401 branch only. The fence built from loopback, the listener's bind address and `--trusted-host`
is unchanged word for word.

The plugin does not rewrite `admit`, `requestRejection`, the routes or the upgrade path, injects
nothing into index.html, and mints no cookie. The token and the cookie become unnecessary; no check
is bypassed.

Contract: `inject = ['connection']`, and the owner is swapped inside the inject callback. A host
reload rebuilds the connection service and its owner, so the callback runs again; a
`Symbol.for('dsh-authless.open-auth')` marker stops a second inject from stacking owners. Nothing
is awaited, no capability outside `ctx.root` is used, and `ctx.effect` puts the previous owner back
on unload.

## 3. Scope

No-token only. That decision also removes `startup.js`, `commander` and
`@deepseek-ai/dsh-cmdline`: the startup half existed to invert `--no-open`, which means patching
the `web-runtime` row, and to reopen `--host 0.0.0.0`, which §5 covers. `--public-url` needs no
work because upstream already has it.

`cordis.patch.yml` therefore carries one insert (`id: authless`, `name: dsh-authless`) and the
package has no runtime dependencies.

## 4. Threat model

| Surface | Before | After |
| --- | --- | --- |
| A web page you visit, reaching `127.0.0.1` (DNS rebinding) | foreign Host: 403; matching Host but no cookie: 401 | foreign Host: 403, unchanged; matching Host: admitted |
| Another user or process on this machine | needs the launch token, so 401 | can connect directly; do not use this on a shared machine |
| Another machine on the network | not bound to it, and its authority fails: 403 | unchanged, still 403 unless you declare it with `--trusted-host` |

This is a deliberate downgrade. After installing, a browser or a process on this machine gets in
without a session; an authority from another machine still does not. The default listener is
`127.0.0.1`.

## 5. Why `--host 0.0.0.0` stays refused

dsh refuses the wildcard bind in two places: the CLI (`startup.js:48`) and the webserver's config
check (`webserver/lib/index.js:255`). Its error text gives the reason, binding every interface puts
the RCE surface on the network. Reopening it would mean replacing the `web-startup` row and the
`webserver` row, the second being a webserver of our own, which is well past a token-removal
plugin. LAN access stays reverse-proxied to `127.0.0.1`; `--public-url` declares the URL clients
should use and `--trusted-host` admits that authority.

## 6. Verification (`npm test` runs `scripts/verify.mjs`)

1. Declaration gate: `dsh.bundle.patch` in `package.json` points at a file that exists; the patch
   carries exactly one `insert` (`id: authless`, `name: dsh-authless`), mentions no
   `web-startup`, `web-runtime` or `webserver` row, sets no `disabled: true`, and the package has
   no dependencies.
2. Owner contract: a fake connection service drives `apply`, and the five methods are asserted
   (all admitted, token dropped from the URL, the `/connect` `interactions` validation still
   enforced), plus idempotence, so a second inject does not stack owners.
3. Nothing else touched: the test asserts that `admit`, `requestRejection` and route registration
   are not rewritten (only the `browserAuth` field is assigned) and that the disposer restores the
   previous owner.
4. Fence intact: the test reads the upstream `admit` source and asserts that the 403 decision
   happens before `browserAuth` is consulted, and that `admitConnection()` calls `admit()`. An
   upstream reorder or a moved upgrade path fails the test instead of passing silently.
5. Docs match the code: both READMEs mention the retained 403 fence and the fact that another local
   user or process can use the API, and at least one document says this is a downgrade.

## 7. Compatibility

- Only `@deepseek-ai/dsh-client-connection` 0.2.1-rc.2 is promised. The owner's method names and
  the field name come from upstream `HostConnectionService`; §1 records the lines, and this
  document moves with them.
- No third-party dependencies, ESM, Node `^22.19 || >=24`, same as upstream.
- Version probe: when `browserAuth` is missing, the plugin logs a warning and leaves the token gate
  in place. It never logs a successful install it did not perform.
