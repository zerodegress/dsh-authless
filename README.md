# dsh-authless

Removes the launch-token check from the local DSH Web UI. After installing, `dsh` prints a plain
`http://127.0.0.1:3080/`, the page opens without a cookie, and `/api` answers a request that
already cleared the authority check instead of replying 401. The WebSocket upgrade the UI opens
rides the same path.

The token was the only check between a process on this machine and the harness API, so installing
this plugin is a downgrade. Read [Known limitations](#known-limitations) first.

## Install

```sh
dsh plugin --profile web add dsh-authless
dsh --profile web
```

Open the URL it prints. The bundle adds one row (`id: authless`) and leaves the host's own rows
alone, so a later patch layer (your profile's `cordis.patch.yml`, `$DSH_HOME`'s patch, `--patch`)
still overrides it. To undo:

```sh
dsh plugin --profile web remove dsh-authless
```

## What it changes

The connection service keeps its browser-auth owner in the `browserAuth` field, and every token,
cookie and index decision goes through it. The plugin puts its own owner in that field and answers
every check with yes, so a request that reached the service is served. Unloading puts the host's
owner back.

`admit()` checks the request authority before it asks the owner: loopback, the listener's own bind
address, or an authority declared with `--trusted-host`. A request from anywhere else still gets
403, and the plugin does not touch that path.

## Known limitations

- Any process on this machine that can reach the port can use the harness API, including another
  local user. Run it on a single-user machine.
- A reverse proxy or a LAN client needs its authority declared with `--trusted-host`; without it
  the answer stays 403.
- Written for `@deepseek-ai/dsh-client-connection` 0.2.1-rc.2. On a host whose connection service
  has no `browserAuth` field, the plugin logs one warning and leaves the token gate in place.
- `--host 0.0.0.0` is still refused by dsh. This plugin does not change that check.

## Development

```sh
npm test    # scripts/verify.mjs
```

Design notes: [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
