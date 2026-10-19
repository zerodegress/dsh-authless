/**
 * dsh-authless: the host half.
 *
 * Serves the local DSH Web UI without the launch-token layer: the printed URL
 * carries no `?token=`, `/` answers without a cookie, and `/api` no longer
 * replies 401 to a request that clears the Host/Origin fence.
 *
 * What stays: the fence itself. `HostConnectionService.admit()` checks
 * `isTrusted(request)` (loopback, the listener's own bind address, or an
 * authority declared with `--trusted-host`) **before** it consults the browser
 * auth owner, so a request from a foreign authority still gets 403. This plugin
 * only replaces the owner (the object every token and cookie decision goes
 * through). It never touches the service, its routes, its peers or its
 * WebSocket upgrade path.
 *
 * Target: @deepseek-ai/dsh-client-connection 0.2.1-rc.2. The field
 * (`HostConnectionService.browserAuth`) and the five owner methods below are
 * read from that build; see docs/design.md for the file:line evidence.
 */
export const name = 'dsh-authless'

/** `connection` mounts after the web runtime resolves; inject re-fires on reload. */
export const inject = ['connection']

/** Marks our own owner, so a reload or a second inject never stacks owners. */
const MARK = Symbol.for('dsh-authless.open-auth')

/**
 * Drop the token and the fragment from a URL, keeping everything else (mount
 * path included). Upstream's owner appends `?token=`; ours must not.
 * @param baseUrl - the URL the host would advertise.
 * @returns the same URL without `token` or `#`, unparsable input unchanged.
 */
function withoutToken(baseUrl) {
  try {
    const url = new URL(baseUrl)
    url.searchParams.delete('token')
    url.hash = ''
    return url.href
  } catch {
    return baseUrl
  }
}

/**
 * The permissive auth owner. Every decision the connection service can ask for
 * is answered "yes", and the one exchange that must still produce an operator
 * (`/connect`) keeps its request validation and simply skips the token.
 */
class OpenBrowserAuth {
  /** @param logger - the plugin logger, for the one line that matters. */
  constructor(logger) {
    this[MARK] = true
    this.logger = logger
  }

  /** A browser request is always authenticated. @returns true. */
  isAuthenticated() {
    return true
  }

  /** Unreferenced while {@link isAuthenticated} answers true. @returns undefined. */
  authenticateApi() {
    return undefined
  }

  /** Serve index.html without minting a cookie. @returns true. */
  authorizeIndex() {
    return true
  }

  /**
   * The API-client exchange: validation stays, the token requirement goes.
   * @param request - the incoming `/connect` request.
   * @param response - response owned to completion when this returns.
   * @param secure - whether the receiving listener serves TLS (unused without a cookie).
   * @param publish - creates the operator peer and returns its id.
   */
  authorizeConnect(request, response, secure, publish) {
    // Same declaration contract as the host: `interactions` is optional, but a
    // second one or an unknown value is a client error, not a silent default.
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const declared = url.searchParams.getAll('interactions')
    const interactions = declared[0] ?? 'none'
    if (declared.length > 1 || (interactions !== 'none' && interactions !== 'answer')) {
      response.writeHead(400, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      response.end('interactions must be declared once as answer or none\n')
      return
    }
    // No token check and no signed cookie: the peer is created so the client's
    // RPC has an owner, and later requests pass on their own.
    publish(interactions)
    response.writeHead(302, {
      'cache-control': 'no-store',
      location: './api/remote.mux',
      'referrer-policy': 'no-referrer',
    })
    response.end()
  }

  /** @param baseUrl - URL the host advertises. @returns it without a token. */
  authenticatedUrl(baseUrl) {
    return withoutToken(baseUrl)
  }
}

/**
 * Swap the connection service's auth owner for ours, once per mount.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scoped) => {
    const service = scoped.connection
    const owner = service?.browserAuth
    if (owner === undefined || owner === null || typeof owner !== 'object') {
      // Fail loud and leave the gate in place: an unknown host shape must never
      // look like a working authless install.
      ctx.logger?.warn?.('[dsh-authless] connection.browserAuth is missing; this host shape is unsupported, the token gate stays in place')
      return
    }
    if (owner[MARK] === true) return
    try {
      service.browserAuth = new OpenBrowserAuth(ctx.logger)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-authless] could not replace the auth owner (${error?.name ?? 'unknown'}); the token gate stays in place`)
      return
    }
    // Put the host's own owner back when this plugin unloads, so a later
    // reload starts from the host's state rather than from ours.
    ctx.effect(() => () => {
      if (service.browserAuth?.[MARK] === true) service.browserAuth = owner
    })
    ctx.logger?.info?.('[dsh-authless] token gate disabled: the printed URL needs no ?token=')
  })
}
