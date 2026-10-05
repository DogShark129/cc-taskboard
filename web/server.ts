/// <reference lib="deno.ns" />
// Local web app for cc-taskboard: same event logs as the mod, same fold (hooks/core.ts).
// Run: deno run --allow-read --allow-write --allow-env --allow-net=127.0.0.1 --allow-run=claude,defaults web/server.ts
import { COL_IDS, COLS, DATA_DIR, I18N, LEGACY_DATA_DIR, PRIORITIES, PRIORITY_COLOR, PROJECTS, boardForWeek, descOf, fold, parseLines, projName, setProjects, resolveTheme, titleOf, tl, weeksBack } from '../hooks/core.ts'
import type { Ev, K } from '../hooks/core.ts'
import type { Sess } from '../types/index.d.ts'

type Agents = Map<string, { name: string; status: string }>
export type Opts = {
  data?: string
  // HOME, for the default data dir and the Claude app's config.json; tests point it at a temp dir.
  home?: string
  port?: number
  // ponytail: tests swap this for a stub; the default shells out to `claude agents --json`
  agents?: () => Promise<Agents>
  // The Claude app's config.json (userThemeMode) and the OS appearance (true = dark); tests stub both.
  themeFile?: string
  readAppearance?: () => Promise<boolean>
}

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg) }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

async function realAgents(): Promise<Agents> {
  try {
    const out = await new Deno.Command('claude', { args: ['agents', '--json'], stdout: 'piped', stderr: 'null', signal: AbortSignal.timeout(8000) }).output()
    if (!out.success) return new Map()
    const list = JSON.parse(new TextDecoder().decode(out.stdout)) as { sessionId: string; name?: string; status?: string }[]
    return new Map(list.map(a => [a.sessionId, { name: a.name ?? '', status: a.status ?? '' }]))
  } catch {
    return new Map()
  }
}

async function realAppearance() {
  try {
    const out = await new Deno.Command('defaults', { args: ['read', '-g', 'AppleInterfaceStyle'], stdout: 'piped', stderr: 'null', signal: AbortSignal.timeout(3000) }).output()
    return out.success && new TextDecoder().decode(out.stdout).includes('Dark')
  } catch {
    return false // not macOS, no permission, or Light mode (the key is absent then)
  }
}

const isDir = (p: string) => { try { return Deno.statSync(p).isDirectory } catch { return false } }
// <home>/.claude/cc-taskboard, or the legacy dir while only that one exists (same rule as the mod).
export const defaultData = (home: string) => {
  const own = `${home}/${DATA_DIR}`
  const legacy = `${home}/${LEGACY_DATA_DIR}`
  return !isDir(own) && isDir(legacy) ? legacy : own
}

export function startServer(opts: Opts = {}) {
  const home = opts.home ?? Deno.env.get('HOME') ?? ''
  const data = opts.data ?? Deno.env.get('CC_TASKBOARD_DATA') ?? Deno.env.get('WB_DATA') ?? defaultData(home)
  const port = opts.port ?? Number(Deno.env.get('WB_PORT') ?? 4790)
  const getAgents = opts.agents ?? realAgents
  const themeFile = opts.themeFile ?? `${home}/Library/Application Support/Claude/config.json`
  const getAppearance = opts.readAppearance ?? realAppearance
  const webLog = `${data}/events/web.jsonl`

  async function files(dir: string) {
    const out: string[] = []
    try {
      for await (const f of Deno.readDir(`${data}/${dir}`)) if (f.isFile) out.push(f.name)
    } catch { /* directory not created yet */ }
    return out.sort()
  }
  // Boards come from projects.json (the mod's init wizard writes it); re-read on every load so a new init shows up.
  async function loadProjects() {
    const text = await Deno.readTextFile(`${data}/projects.json`).catch(() => '')
    if (text) try { setProjects(JSON.parse(text)) } catch { /* half-written: keep the last good one */ }
  }
  async function loadAll() {
    await loadProjects()
    const evs: Ev[] = []
    for (const f of await files('events')) if (f.endsWith('.jsonl')) evs.push(...parseLines(await Deno.readTextFile(`${data}/events/${f}`).catch(() => '')))
    const sessions: Sess[] = []
    for (const f of await files('sessions')) {
      try { sessions.push(JSON.parse(await Deno.readTextFile(`${data}/sessions/${f}`))) } catch { /* half-written file: next poll gets it */ }
    }
    return { evs, sessions }
  }

  // Same enrichment as the mod's refresh(); `claude agents` is polled at most every 15 s.
  let agents: Agents = new Map()
  let agentsAt = 0
  async function enrich(sessions: Sess[]): Promise<Sess[]> {
    if (Date.now() - agentsAt >= 15_000) {
      agentsAt = Date.now()
      const got = await getAgents()
      if (got.size) agents = got
    }
    if (!agents.size) return sessions
    return sessions.map(s => {
      const a = agents.get(s.sid)
      return { ...s, label: a?.name || undefined, isGone: !a, state: !a ? 'idle' : a.status === 'busy' ? 'run' : s.state === 'wait' ? 'wait' : 'idle' } as Sess
    })
  }

  // The Claude app's theme, re-read at most every 10 s.
  let appTheme: 'light' | 'dark' = 'light'
  let appThemeAt = 0
  async function getAppTheme() {
    if (Date.now() - appThemeAt < 10_000) return appTheme
    appThemeAt = Date.now()
    const mode: string | undefined = await Deno.readTextFile(themeFile).then(x => JSON.parse(x).userThemeMode).catch(() => undefined)
    return (appTheme = resolveTheme(mode, mode === 'light' || mode === 'dark' ? false : await getAppearance().catch(() => false)))
  }

  async function board(url: URL) {
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
    const { evs, sessions } = await loadAll()
    const now = Date.now()
    const back = weeksBack(evs, now)
    const week = Math.max(0, Math.min(Number(url.searchParams.get('week')) || 0, back))
    const known = await enrich(sessions)
    const r = week ? boardForWeek(evs, now, week, lang) : { board: fold(evs, known, now, lang), asOf: now }
    // The page shows title / desc as they are: hand it the side for this language (the other when that one is missing).
    const tickets = r.board.tickets.map(tk => ({ ...tk, title: titleOf(tk, lang), desc: descOf(tk, lang) || undefined }))
    return {
      board: { ...r.board, tickets, ...(week ? { sessions: known } : {}) },
      asOf: r.asOf, weeksBack: back, week,
      projects: PROJECTS.map(p => ({ id: p.id, name: projName(lang, p.id), color: p.color, icon: p.icon })),
      cols: COLS.map(c => ({ id: c.id, name: tl(lang, `col.${c.id}` as K), color: c.color, icon: c.icon })),
      priorities: PRIORITIES.map(id => ({ id, color: PRIORITY_COLOR[id] })),
      i18n: I18N[lang],
      appTheme: await getAppTheme(),
    }
  }

  // ---------- writes: one promise chain so concurrent posts cannot interleave lines ----------
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>) => {
    const run = chain.then(fn)
    chain = run.catch(() => {})
    return run
  }
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string') throw new HttpError(400, `${what} must be a string`)
    return v
  }
  async function act(body: Record<string, unknown>) {
    await loadProjects()
    const type = body.type
    const col = body.col === undefined ? undefined : String(body.col)
    if (col !== undefined && !COL_IDS.includes(col as never)) throw new HttpError(400, `unknown col ${col}`)
    const priority = body.priority === undefined ? undefined : String(body.priority)
    if (priority !== undefined && priority !== '' && !PRIORITIES.includes(priority as never)) throw new HttpError(400, `unknown priority ${priority}`)
    return await serial(async () => {
      const { evs } = await loadAll()
      const alias = new Map(evs.filter(e => e.k === 'rekey' && e.text).sort((a, b) => a.t - b.t).map(e => [e.key, e.text as string]))
      const resolve = (k: string) => { for (let i = 0; alias.has(k) && i < 10; i++) k = alias.get(k) as string; return k }
      const append = async (...lines: Omit<Ev, 't' | 'sid'>[]) => {
        const t = Date.now()
        await Deno.mkdir(`${data}/events`, { recursive: true })
        await Deno.writeTextFile(webLog, lines.map(l => JSON.stringify({ ...l, t, sid: 'web' })).join('\n') + '\n', { append: true })
      }

      if (type === 'create') {
        const title = str(body.title, 'title').trim()
        if (!title) throw new HttpError(400, 'title is empty')
        const project = str(body.project, 'project')
        if (!PROJECTS.some(p => p.id === project)) throw new HttpError(400, `unknown project ${project}`)
        const desc = body.desc === undefined ? '' : str(body.desc, 'desc').trim()
        // same numbering as the mod: max over create keys and rekey targets with this prefix, +1
        const used = evs.flatMap(x => (x.k === 'create' ? [x.key] : x.k === 'rekey' && x.text ? [x.text] : [])).filter(k => k.startsWith(`${project}-`))
        const key = `${project}-${Math.max(0, ...used.map(k => Number(k.split('-')[1]) || 0)) + 1}`
        const meta = { ...(desc ? { desc } : {}), ...(priority ? { priority } : {}) }
        await append(
          { k: 'create', key, project, title, col: (col ?? 'todo') as never, src: 'me' },
          ...(Object.keys(meta).length ? [{ k: 'meta' as const, key, meta: meta as never }] : []),
        )
        return { ok: true, key }
      }

      const key = resolve(str(body.key, 'key'))
      if (!evs.some(e => e.k === 'create' && resolve(e.key) === key)) throw new HttpError(404, `no ticket ${body.key}`)
      if (type === 'move' || type === 'accept' || type === 'reject') {
        const to = type === 'accept' ? 'done' : type === 'reject' ? 'doing' : col
        if (!to) throw new HttpError(400, 'col required')
        const text = type === 'accept' ? '你验收通过' : type === 'reject' ? '你打回' : '你拖拽移动'
        await append({ k: 'move', key, col: to as never, text })
      } else if (type === 'comment') {
        const text = str(body.text, 'text').trim()
        if (!text) throw new HttpError(400, 'text is empty')
        await append({ k: 'comment', key, by: 'me', text })
      } else if (type === 'meta') {
        if (body.desc === undefined && priority === undefined) throw new HttpError(400, 'desc or priority required')
        // the person writes one language: it goes in desc and the stale English is cleared, which also nudges Claude to fill it
        await append({ k: 'meta', key, meta: { ...(body.desc !== undefined ? { desc: str(body.desc, 'desc'), desc_en: '' } : {}), ...(priority !== undefined ? { priority } : {}) } as never })
      } else throw new HttpError(400, `unknown type ${type}`)
      return { ok: true, key }
    })
  }

  // ---------- SSE: one poller for all clients ----------
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const enc = new TextEncoder()
  const push = (s: string) => {
    for (const c of clients) try { c.enqueue(enc.encode(s)) } catch { clients.delete(c) }
  }
  async function signature() {
    const parts: string[] = []
    for (const dir of ['events', 'sessions']) {
      for (const f of await files(dir)) {
        const st = await Deno.stat(`${data}/${dir}/${f}`).catch(() => null)
        if (st) parts.push(`${dir}/${f}:${st.size}:${st.mtime?.getTime()}`)
      }
    }
    return parts.join('|')
  }
  let last = ''
  let polling = false
  const poll = setInterval(async () => {
    if (polling) return
    polling = true
    try {
      const sig = await signature()
      if (sig !== last) { last = sig; push('event: changed\ndata: 1\n\n') }
    } finally { polling = false }
  }, 1000)
  const beat = setInterval(() => push(': heartbeat\n\n'), 15_000)
  signature().then(s => { if (!last) last = s })

  // ---------- routes ----------
  const hostOk = (req: Request, p: number) => ['127.0.0.1', 'localhost'].some(h => req.headers.get('host') === `${h}:${p}`)
  const server = Deno.serve({ hostname: '127.0.0.1', port, onListen: () => {} }, async req => {
    try {
      const url = new URL(req.url)
      // DNS rebinding: a page on another name that resolves to 127.0.0.1 must not read the board
      if (!hostOk(req, server.addr.port)) return json({ error: 'bad host' }, 403)
      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(await Deno.readTextFile(new URL('./index.html', import.meta.url)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      }
      if (req.method === 'GET' && url.pathname === '/api/ping') return new Response('ok')
      if (req.method === 'GET' && url.pathname === '/api/board') return json(await board(url))
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        let ctl: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({
          start(c) { ctl = c; clients.add(c); c.enqueue(enc.encode(': connected\n\n')) },
          cancel() { clients.delete(ctl) },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } })
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        // A custom header forces a CORS preflight, which this server never approves: blocks cross-site posts.
        if (req.headers.get('x-cc-taskboard') !== '1') return json({ error: 'missing X-CC-Taskboard header' }, 403)
        if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'content-type must be application/json' }, 415)
        const body = await req.json().catch(() => null)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'body must be a JSON object' }, 400)
        return json(await act(body as Record<string, unknown>))
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      console.error(e)
      return json({ error: 'internal error' }, 500)
    }
  })
  return {
    port: server.addr.port,
    url: `http://127.0.0.1:${server.addr.port}`,
    async close() {
      clearInterval(poll); clearInterval(beat)
      for (const c of clients) try { c.close() } catch { /* already closed */ }
      clients.clear()
      await server.shutdown()
    },
  }
}

if (import.meta.main) {
  const s = startServer()
  console.log(`cc-taskboard web on ${s.url}`)
}
