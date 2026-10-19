#!/usr/bin/env node
// dsh-authless acceptance: the owner contract, the patch shape, and the fence we
// promise not to touch. Run with `npm test`. No dependencies, no network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(path.join(root, 'src/index.js'))

const results = []
class Skip extends Error {}
async function check(label, run) {
  try {
    await run()
    results.push({ label, ok: true })
  } catch (error) {
    if (error instanceof Skip) results.push({ label, ok: true, skip: true, detail: error.message })
    else results.push({ label, ok: false, detail: `${error?.name ?? 'Error'}: ${error?.message ?? error}` })
  }
}

/** A connection service stand-in: only the field and the five owner methods exist. */
function fakeConnection() {
  const owner = {
    isAuthenticated: () => false,
    authenticateApi: () => undefined,
    authorizeIndex: () => false,
    authorizeConnect: () => {},
    authenticatedUrl: (url) => `${url}${url.includes('?') ? '&' : '?'}token=secret`,
  }
  const service = { browserAuth: owner, admit: () => ({ rejection: 403 }), requestRejection: () => 401 }
  return { service, owner }
}

function fakeCtx(target) {
  const state = { logs: [], effects: [] }
  const ctx = {
    logger: { info: (line) => state.logs.push(line), warn: (line) => state.logs.push(line) },
    inject: (deps, callback) => { assert.deepEqual(deps, ['connection']); state.callback = callback; callback({ connection: target }) },
    effect: (fn) => { state.effects.push(fn()) },
  }
  return { ctx, state }
}

function fakeResponse() {
  const written = { status: undefined, headers: undefined, body: '' }
  return {
    written,
    writeHead: (status, headers) => { written.status = status; written.headers = headers },
    end: (body = '') => { written.body = body },
  }
}

await check('① 属主被换成本插件的：五个决策全放行、URL 不带 token', () => {
  const { service, owner } = fakeConnection()
  const { ctx } = fakeCtx(service)
  plugin.apply(ctx)
  assert.notEqual(service.browserAuth, owner, 'the owner was not replaced')
  const auth = service.browserAuth
  assert.equal(auth.isAuthenticated(), true)
  assert.equal(auth.authenticateApi(), undefined)
  assert.equal(auth.authorizeIndex(), true)
  assert.equal(auth.authenticatedUrl('http://127.0.0.1:3080/?token=abc#frag'), 'http://127.0.0.1:3080/')
  assert.equal(auth.authenticatedUrl('http://127.0.0.1:3080/ui/?token=abc'), 'http://127.0.0.1:3080/ui/')
  assert.equal(auth.authenticatedUrl('not a url'), 'not a url')
})

await check('② /connect 保留声明校验，去掉的是令牌', () => {
  const { service } = fakeConnection()
  const { ctx } = fakeCtx(service)
  plugin.apply(ctx)
  const auth = service.browserAuth
  const bad = fakeResponse()
  auth.authorizeConnect({ url: '/connect?interactions=answer&interactions=none', method: 'GET' }, bad, false, () => 'peer')
  assert.equal(bad.written.status, 400, 'a double declaration must be rejected')
  const alsoBad = fakeResponse()
  auth.authorizeConnect({ url: '/connect?interactions=maybe', method: 'GET' }, alsoBad, false, () => 'peer')
  assert.equal(alsoBad.written.status, 400, 'an unknown declaration must be rejected')
  const published = []
  const ok = fakeResponse()
  auth.authorizeConnect({ url: '/connect?interactions=answer', method: 'GET' }, ok, false, (value) => { published.push(value); return 'peer-1' })
  assert.deepEqual(published, ['answer'], 'the operator was not created')
  assert.equal(ok.written.status, 302, 'a valid exchange must redirect')
  assert.equal(ok.written.headers.location, './api/remote.mux')
  assert.equal(ok.written.headers['set-cookie'], undefined, 'no cookie is minted without auth')
})

await check('③ 幂等与还原：重跑不叠属主，卸载把宿主属主还回去', () => {
  const { service, owner } = fakeConnection()
  const { ctx, state } = fakeCtx(service)
  plugin.apply(ctx)
  const first = service.browserAuth
  state.callback({ connection: service })
  assert.equal(service.browserAuth, first, 'a second inject stacked another owner')
  assert.equal(state.effects.length, 1, 'the disposer was not registered exactly once')
  for (const dispose of state.effects) dispose()
  assert.equal(service.browserAuth, owner, 'the host owner was not restored')
})

await check('④ 不认识宿主形状时响亮报错、把闸留在原地', () => {
  const { ctx, state } = fakeCtx({ admit: () => ({}) })
  plugin.apply(ctx)
  assert.equal(state.logs.length, 1, `expected exactly one warning, got: ${state.logs.join(' | ')}`)
  assert.match(state.logs[0], /unsupported/, 'the warning does not say the host shape is unsupported')
  assert.match(state.logs[0], /stays in place/, 'the warning does not say the gate stays')
})

await check('⑤ 只动 browserAuth：服务上的其它成员逐字不变', () => {
  const { service } = fakeConnection()
  const before = { admit: service.admit, requestRejection: service.requestRejection }
  const { ctx } = fakeCtx(service)
  plugin.apply(ctx)
  assert.equal(service.admit, before.admit, 'admit was rewritten')
  assert.equal(service.requestRejection, before.requestRejection, 'requestRejection was rewritten')
  assert.equal(Object.keys(service).sort().join(','), 'admit,browserAuth,requestRejection', 'the service gained or lost a member')
})

await check('⑥ 403 信任墙在上游的 browserAuth 之前（改顺序就红）', async () => {
  const candidate = findConnectionSource()
  if (candidate === undefined) throw new Skip('no @deepseek-ai/dsh-client-connection build on this machine; skipping the fence check')
  const source = fs.readFileSync(candidate, 'utf8')
  const admit = source.indexOf('\tadmit(request) {')
  assert.ok(admit > 0, `admit() not found in ${candidate}`)
  const body = source.slice(admit, admit + 700)
  const trust = body.indexOf('this.isTrusted(request)')
  const authCall = body.indexOf('this.browserAuth.')
  assert.ok(trust > 0, 'admit() no longer calls isTrusted')
  assert.ok(authCall > trust, 'admit() consults browserAuth before the trust fence: our "403 is untouched" promise needs a re-read')
  // The WebSocket upgrade must ride the same gate, or "the upgrade works too" is a guess.
  const upgrade = source.indexOf('\tadmitConnection(request) {')
  assert.ok(upgrade > 0, 'admitConnection() not found')
  assert.match(source.slice(upgrade, upgrade + 200), /this\.admit\(request\)/, 'the upgrade path no longer goes through admit()')
})

await check('⑦ 声明闸门：包的接线与 patch 形状', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-authless')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.join(root, 'cordis.patch.yml')), 'the declared patch file is missing')
  assert.ok(fs.existsSync(path.join(root, 'src/index.js')), 'the declared main is missing')
  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')
  assert.match(license, /^MIT License/, 'LICENSE is not MIT')
  assert.match(license, /Copyright \(c\) 2026 zerodegress/, 'the copyright line is not the one the maintainer asked for')
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /disabled:\s*true/, 'the patch disables an upstream row; this plugin only swaps an auth owner')
  for (const row of ['web-startup', 'web-runtime', 'webserver']) {
    assert.doesNotMatch(patch, new RegExp(`id:\\s*${row}`), `the patch still touches the ${row} row`)
  }
  assert.equal((patch.match(/^-\s+insert:/gm) ?? []).length, 1, 'the patch must carry exactly one insert list')
  assert.match(patch, /id:\s*authless\n\s+name:\s*dsh-authless/, 'the patch does not activate `authless` = `dsh-authless`')
  // The scope is "no token only": no flag provider, no dependency, no startup half.
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'the package gained a runtime dependency')
  assert.equal(pkg.exports['./startup'], undefined, 'the package still exports a startup half')
  assert.ok(!(pkg.files ?? []).includes('startup.js'), 'the package still ships startup.js')

  // A public repository ships no absolute local path: a link like
  // /home/<user>/... breaks on every other machine and leaks the author's tree.
  const shipped = ['README.md', 'README_ZH.md', 'docs/design.md', 'docs/design_ZH.md', 'package.json', 'cordis.patch.yml', 'dsh-plugin.json', 'LICENSE']
  for (const file of shipped) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(text, /(^|[^\w])\/(home|Users)\/[\w.-]+/, `${file} contains an absolute local path`)
    assert.doesNotMatch(text, /zice\.top/i, `${file} contains a private domain`)
  }
})

await check('⑨ 插件声明：id 是反写域名，且能过宿主的 parser', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dsh-plugin.json'), 'utf8'))
  assert.equal(manifest.id, 'com.zerodegress.dsh-authless')
  assert.equal(manifest.name, 'dsh-authless')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.facets.host.entry, 'src/index.js')
  assert.ok(fs.existsSync(path.join(root, manifest.facets.host.entry)), 'the declared facet entry is missing')
  assert.equal(manifest.description, undefined, 'description is not a community v0.15 field; use x-description')
  assert.ok(Array.isArray(manifest.subscriptions), 'subscriptions is required by the schema')
  // A public repository must not carry a private domain. The reverse-domain id
  // (`com.zerodegress.…`) is the maintainer's public namespace, not a private host.
  assert.doesNotMatch(JSON.stringify(manifest), /zice\.top/i, 'the manifest carries a private domain')
  const parser = findManifestParser()
  if (parser === undefined) throw new Skip('no @dsh-std/manifest on this machine; skipping the parser gate')
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(parser).href)
  const parsed = mod.parseManifest(JSON.stringify(manifest))
  const projected = mod.projectManifest(parsed.manifest ?? parsed)
  assert.equal(projected.metadata.name, manifest.id, 'the host keys the plugin identity on the manifest id')
})

await check('⑩ 文档为读者保留两条事实：403 信任墙、同机的其他用户或进程能直接用', () => {
  // Wording is the reviewer's call, the facts are not: both reader-facing files
  // keep the retained fence and the local-process warning, and at least one file
  // says out loud that this is a security downgrade.
  const local = /(同机|本机|这台机器|同一台机器|共享主机|shared host)|(local|another|other)[^.]{0,40}(user|process|program)/i
  const downgrade = /(降级|降低安全|downgrade|weaken(s|ed)? (the )?(auth|security)|not a hardening)/i
  for (const file of ['README.md', 'README_ZH.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(text, /\b403\b/, `${file} does not mention the retained 403 fence`)
    assert.match(text, local, `${file} does not warn that other local users or processes can use the API`)
  }
  // The design note ships in both languages once the English one lands; read
  // whichever are present so a split never silently drops the fact check.
  const designNotes = ['docs/design.md', 'docs/design_ZH.md'].filter((file) => fs.existsSync(path.join(root, file)))
  assert.ok(designNotes.length >= 1, 'no design note is shipped')
  const all = ['README.md', 'README_ZH.md', ...designNotes]
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n')
  assert.match(all, downgrade, 'no document says this is a security downgrade')
})

/** Find the host's manifest parser, if this machine has one. */
function findManifestParser() {
  const relative = 'lib/index.js'
  const profiles = [path.join(process.env.HOME ?? '', '.dsh/profiles'), path.join(process.env.HOME ?? '', '.dsbot/profiles')]
  for (const dir of profiles) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const nested = path.join(dir, name, 'node_modules/@deepseek-harness-tui')
      if (!fs.existsSync(nested)) continue
      for (const app of fs.readdirSync(nested)) {
        const candidate = path.join(nested, app, 'node_modules/@dsh-std/manifest', relative)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/** Find the installed connection build, if this machine has one. */
function findConnectionSource() {
  const relative = '@deepseek-ai/dsh-client-connection/lib/index.js'
  const homes = [process.env.DSH_HOME, path.join(process.env.HOME ?? '', '.dsh'), path.join(process.env.HOME ?? '', '.dsbot')]
  for (const home of homes) {
    if (!home) continue
    const profiles = path.join(home, 'profiles')
    if (!fs.existsSync(profiles)) continue
    for (const name of fs.readdirSync(profiles)) {
      const candidate = path.join(profiles, name, 'node_modules', relative)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  // dsh also runs out of the pnpm dlx store, which is where the very same
  // package lands for a `dlx` invocation; check it before giving up. The layout
  // is dlx/<hash>/<slot>/node_modules/.pnpm (older entries drop the <slot>).
  const store = path.join(process.env.HOME ?? '', '.cache/pnpm/dlx')
  if (!fs.existsSync(store)) return undefined
  for (const hash of fs.readdirSync(store)) {
    const outer = path.join(store, hash)
    for (const inner of ['', ...fs.readdirSync(outer).map((name) => path.join(outer, name))]) {
      const pnpm = path.join(inner, 'node_modules/.pnpm')
      if (!fs.existsSync(pnpm)) continue
      for (const entry of fs.readdirSync(pnpm)) {
        if (!entry.startsWith('@deepseek-ai+dsh-client-connection@')) continue
        const candidate = path.join(pnpm, entry, 'node_modules', relative)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  const tag = entry.skip ? 'SKIP' : entry.ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${entry.label}${entry.ok && !entry.skip ? '' : `\n      ${entry.detail ?? ''}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exitCode = failed.length === 0 ? 0 : 1
