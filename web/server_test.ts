/// <reference lib="deno.ns" />
// Run: deno test --allow-all web/   (not *.test.ts, so the plugin test runner ignores it)
import assert from 'node:assert/strict'

const assertEquals = (a: unknown, b: unknown, msg?: string) => assert.deepEqual(a, b, msg)
const assertStringIncludes = (a: string, b: string) => assert.ok(a.includes(b), `${JSON.stringify(a)} does not include ${b}`)

import { defaultData, startServer } from './server.ts'
import { DATA_DIR, LEGACY_DATA_DIR } from '../hooks/core.ts'

const H = { 'content-type': 'application/json', 'x-cc-taskboard': '1' }

async function withServer(opts: Partial<Parameters<typeof startServer>[0]> | null, fn: (s: { url: string; data: string; post: (b: unknown, headers?: Record<string, string>) => Promise<Response>; board: (q?: string) => Promise<any> }) => Promise<void>) {
  const data = await Deno.makeTempDir({ prefix: 'wb-test-' })
  await Deno.mkdir(`${data}/events`)
  await Deno.mkdir(`${data}/sessions`)
  const t = Date.now() - 60_000
  const seed = [
    { t, sid: 's1', k: 'create', key: 'SVC-1', project: 'SVC', title: '[T-42] 登录页面', col: 'doing', src: 'claude' },
    { t: t + 1, sid: 's1', k: 'create', key: 'ME-11', project: 'ME', title: 'old key', col: 'todo', src: 'me' },
    { t: t + 2, sid: 's1', k: 'create', key: 'WB-3', project: 'WB', title: 'other', col: 'todo', src: 'me' },
    { t: t + 3, sid: 's1', k: 'rekey', key: 'ME-11', project: 'WB', text: 'WB-10' },
  ]
  await Deno.writeTextFile(`${data}/events/s1.jsonl`, seed.map(e => JSON.stringify(e)).join('\n') + '\n')
  await Deno.writeTextFile(`${data}/projects.json`, JSON.stringify([
    { id: 'SVC', name: 'SVC 重写', name_en: 'SVC Rewrite', match: 'web-app|acme', root: '/home/test/web-app', icon: 'flask', color: '#8394e6' },
    { id: 'WB', name: '看板开发', name_en: 'Board Dev', match: 'cc-taskboard|kanban', icon: 'grid', color: '#c98bb9' },
    { id: 'INF', name: 'Infra', match: '/\\.claude(/|$)', icon: 'cube', color: '#a58fd6' },
    { id: 'ME', name: '私人', name_en: 'Personal', match: 'side projects', icon: 'home', color: '#4fae9f' },
  ]))
  await Deno.writeTextFile(`${data}/sessions/s1.json`, JSON.stringify({ sid: 's1', cwd: '/x', name: 'x', project: 'SVC', seen: Date.now(), state: 'run', ticket: 'SVC-1' }))
  const s = startServer({ data, port: 0, agents: async () => new Map(), themeFile: `${data}/no-such-config.json`, readAppearance: async () => false, ...opts })
  try {
    await fn({
      url: s.url, data,
      post: (b, headers = H) => fetch(`${s.url}/api/action`, { method: 'POST', headers, body: JSON.stringify(b) }),
      board: async (q = '') => (await fetch(`${s.url}/api/board${q}`)).json(),
    })
  } finally {
    await s.close()
    await Deno.remove(data, { recursive: true })
  }
}
const colOf = (b: any, key: string) => b.board.tickets.find((t: any) => t.key === key)?.col
const lines = async (data: string) => (await Deno.readTextFile(`${data}/events/web.jsonl`)).trim().split('\n').map(l => JSON.parse(l))

Deno.test('ping and board shape', () => withServer(null, async ({ url, board }) => {
  assertEquals(await (await fetch(`${url}/api/ping`)).text(), 'ok')
  const b = await board('?lang=en')
  for (const k of ['board', 'asOf', 'weeksBack', 'week', 'projects', 'cols', 'i18n']) assert.ok(k in b, k)
  assertEquals(colOf(b, 'SVC-1'), 'doing')
  assertEquals(b.cols.map((c: any) => c.id), ['decide', 'todo', 'doing', 'follow', 'review', 'done', 'canceled'])
  assertEquals(b.cols[0].name, 'Decision')
  assertEquals(b.projects.find((p: any) => p.id === 'SVC').name, 'SVC Rewrite')
  assertEquals((await board('?lang=zh')).cols[0].name, '等我拍板')
  assertEquals(b.board.sessions[0].sid, 's1')
  assertEquals((await (await fetch(`${url}/`)).text()).includes('<html'), true)
}))

Deno.test('POST needs the header and JSON; move lands in web.jsonl', () => withServer(null, async ({ data, post, board }) => {
  const noHeader = await post({ type: 'move', key: 'SVC-1', col: 'review' }, { 'content-type': 'application/json' })
  assertEquals(noHeader.status, 403)
  await noHeader.body?.cancel()
  const notJson = await post({ type: 'move', key: 'SVC-1', col: 'review' }, { 'content-type': 'text/plain', 'x-cc-taskboard': '1' })
  assertEquals(notJson.status, 415)
  await notJson.body?.cancel()
  assertEquals(colOf(await board(), 'SVC-1'), 'doing')

  const ok = await post({ type: 'move', key: 'SVC-1', col: 'review' })
  assertEquals(ok.status, 200)
  await ok.body?.cancel()
  const [ev] = await lines(data)
  assertEquals([ev.sid, ev.k, ev.key, ev.col, ev.text], ['web', 'move', 'SVC-1', 'review', '你拖拽移动'])
  assertEquals(colOf(await board(), 'SVC-1'), 'review')

  for (const [body, status] of [
    [{ type: 'move', key: 'SVC-1', col: 'nope' }, 400],
    [{ type: 'meta', key: 'SVC-1', priority: 'P9' }, 400],
    [{ type: 'create', title: 'x', project: 'NOPE' }, 400],
    [{ type: 'create', title: '  ', project: 'SVC' }, 400],
    [{ type: 'move', key: 'SVC-99', col: 'todo' }, 404],
  ] as const) {
    const r = await post(body)
    assertEquals(r.status, status, JSON.stringify(body))
    await r.body?.cancel()
  }
}))

Deno.test('accept, reject, comment, meta, create', () => withServer(null, async ({ data, post, board }) => {
  const send = async (b: unknown) => { const r = await post(b); const j = await r.json(); assertEquals(r.status, 200, JSON.stringify(j)); return j }
  await send({ type: 'accept', key: 'SVC-1' })
  assertEquals(colOf(await board(), 'SVC-1'), 'done')
  await send({ type: 'reject', key: 'SVC-1' })
  assertEquals(colOf(await board(), 'SVC-1'), 'doing')
  await send({ type: 'comment', key: 'SVC-1', text: '先别合' })
  await send({ type: 'meta', key: 'SVC-1', desc: '## 目标\nx', priority: 'P1' })
  const tk = (await board()).board.tickets.find((t: any) => t.key === 'SVC-1')
  assertEquals([tk.priority, tk.desc, tk.comments.at(-1).by, tk.comments.at(-1).text], ['P1', '## 目标\nx', 'me', '先别合'])
  const texts = (await lines(data)).filter(l => l.k === 'move').map(l => l.text)
  assertEquals(texts, ['你验收通过', '你打回'])

  const made = await send({ type: 'create', title: '新票', project: 'SVC', priority: 'P0', desc: 'd' })
  assertEquals(made.key, 'SVC-2')
  const n = (await board()).board.tickets.find((t: any) => t.key === 'SVC-2')
  assertEquals([n.col, n.src, n.priority, n.desc, n.title], ['todo', 'me', 'P0', 'd', '新票'])
  // numbering counts rekey targets: WB has WB-3 and the rekeyed WB-10
  assertEquals((await send({ type: 'create', title: 'wb', project: 'WB', col: 'decide' })).key, 'WB-11')
  assertEquals(colOf(await board(), 'WB-11'), 'decide')
}))

Deno.test('an old key acts on the rekeyed ticket', () => withServer(null, async ({ post, board }) => {
  assertEquals(colOf(await board(), 'WB-10'), 'todo')
  const r = await post({ type: 'move', key: 'ME-11', col: 'follow' })
  assertEquals(r.status, 200)
  assertEquals((await r.json()).key, 'WB-10')
  assertEquals(colOf(await board(), 'WB-10'), 'follow')
}))

Deno.test('concurrent posts keep every line whole', () => withServer(null, async ({ data, post }) => {
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => post({ type: 'comment', key: 'SVC-1', text: `c${i}` })))
  for (const r of rs) { assertEquals(r.status, 200); await r.body?.cancel() }
  assertEquals((await lines(data)).length, 20)
}))

Deno.test('SSE sends changed after a write', () => withServer(null, async ({ url, post }) => {
  const res = await fetch(`${url}/api/stream`)
  assertEquals(res.headers.get('content-type'), 'text/event-stream')
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let seen = dec.decode((await reader.read()).value)
  const w = await post({ type: 'move', key: 'SVC-1', col: 'follow' })
  await w.body?.cancel()
  const deadline = Date.now() + 5000
  while (!seen.includes('event: changed') && Date.now() < deadline) {
    const r = await reader.read()
    if (r.value) seen += dec.decode(r.value)
    if (r.done) break
  }
  await reader.cancel()
  assertStringIncludes(seen, 'event: changed')
}))

Deno.test('index.html has no emoji', async () => {
  const html = await Deno.readTextFile(new URL('./index.html', import.meta.url))
  assertEquals(html.match(/\p{Extended_Pictographic}️|\p{Emoji_Presentation}/u), null)
})

Deno.test('board carries the canceled column and WB-11 fields', async () => {
  await withServer(null, async ({ data, board }) => {
    const t = Date.now()
    await Deno.writeTextFile(`${data}/events/s2.jsonl`, [
      { t, sid: 's2', k: 'meta', key: 'WB-3', meta: { labels: ['hold'], due: '2026-10-05', blockedBy: ['SVC-1'], parent: 'ME-11' } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n')
    const d = await board()
    assertEquals(d.cols.map((c: any) => c.id).at(-1), 'canceled')
    const wb3 = d.board.tickets.find((x: any) => x.key === 'WB-3')
    assertEquals([wb3.labels, wb3.due, wb3.blockedBy, wb3.parent], [['hold'], '2026-10-05', ['SVC-1'], 'WB-10']) // parent resolved through the rekey
    assertStringIncludes(d.i18n['rel.blockedBy'], '卡')
  })
})

Deno.test('index.html: the peek popup has a comment box that posts type comment', async () => {
  const html = await Deno.readTextFile(new URL('./index.html', import.meta.url))
  assertStringIncludes(html, 'id="pkCmt"')
  assertStringIncludes(html, 'data-act="peekcomment"')
  assertStringIncludes(html, "post({ type: 'comment', key, text })")
})

Deno.test('index.html follows data-theme, not the OS media query', async () => {
  const html = await Deno.readTextFile(new URL('./index.html', import.meta.url))
  assertEquals(html.includes('prefers-color-scheme'), false)
  assertEquals(html.includes('data-theme'), true)
})

Deno.test('/api/board carries appTheme: the Claude app setting wins, system follows the OS', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'wb-theme-' })
  try {
    const cfg = async (body: string) => { const f = `${dir}/${crypto.randomUUID()}.json`; await Deno.writeTextFile(f, body); return f }
    for (const [themeFile, dark, want] of [
      [await cfg('{"userThemeMode":"light"}'), true, 'light'], // the app says light though the OS is dark
      [await cfg('{"userThemeMode":"dark"}'), false, 'dark'],
      [await cfg('{"userThemeMode":"system"}'), true, 'dark'],
      [await cfg('{"userThemeMode":"system"}'), false, 'light'],
      [`${dir}/missing.json`, true, 'dark'],
    ] as const) {
      await withServer({ themeFile, readAppearance: async () => dark }, async ({ board }) => {
        assertEquals((await board()).appTheme, want, `${themeFile} dark=${dark}`)
      })
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('title / desc follow ?lang (falling back to the other side); a web desc edit clears the stale English', () => withServer(null, async ({ data, post, board }) => {
  const t = Date.now()
  await Deno.writeTextFile(`${data}/events/s2.jsonl`, [
    { t, sid: 's2', k: 'title', key: 'SVC-1', title_en: '[T-42] login page' },
    { t: t + 1, sid: 's2', k: 'meta', key: 'SVC-1', meta: { desc: '去掉标记', desc_en: 'drop the marker' } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const tk = async (lang: string, key = 'SVC-1') => (await board(`?lang=${lang}`)).board.tickets.find((x: any) => x.key === key)
  assertEquals([(await tk('en')).title, (await tk('en')).desc], ['[T-42] login page', 'drop the marker'])
  assertEquals([(await tk('zh')).title, (await tk('zh')).desc], ['[T-42] 登录页面', '去掉标记'])
  assertEquals((await tk('en', 'WB-3')).title, 'other') // no English yet: the only side shows
  assertEquals((await post({ type: 'meta', key: 'SVC-1', desc: 'keep it' })).status, 200)
  assertEquals((await lines(data)).at(-1).meta, { desc: 'keep it', desc_en: '' })
  assertEquals((await tk('en')).desc, 'keep it')
  const en = await board('?lang=en')
  assertEquals(Object.values(en.i18n).join(' ').replace('中文', '').match(/\p{Script=Han}/u), null)
}))

Deno.test('index.html: no UI words written into the markup, everything goes through t()', async () => {
  const html = (await Deno.readTextFile(new URL('./index.html', import.meta.url))).replace(/<title>.*<\/title>/, '')
  assertEquals(html.match(/>[A-Za-z]{2,}[A-Za-z ]*<|(kv|row)\('(?!PR')[A-Za-z]+'|return '[A-Z][a-z]+'/g), null)
})

Deno.test('data dir: <home>/.claude/cc-taskboard, the legacy dir while only that one exists', async () => {
  const home = await Deno.makeTempDir({ prefix: 'wb-home-' })
  try {
    assertEquals(defaultData(home), `${home}/${DATA_DIR}`) // fresh install: neither exists
    await Deno.mkdir(`${home}/${LEGACY_DATA_DIR}`, { recursive: true })
    assertEquals(defaultData(home), `${home}/${LEGACY_DATA_DIR}`)
    await Deno.mkdir(`${home}/${DATA_DIR}`)
    assertEquals(defaultData(home), `${home}/${DATA_DIR}`)
  } finally {
    await Deno.remove(home, { recursive: true })
  }
})

// WB-28: cancel (with a reason), confirm / keep Claude's proposal, restore; a move into canceled is the person's cancel too.
Deno.test('cancel, confirm, keep, restore; archived canceled tickets come along for the search', () => withServer(null, async ({ data, post, board }) => {
  const send = async (b: unknown, status = 200) => { const r = await post(b); const j = await r.json(); assertEquals(r.status, status, JSON.stringify(j)); return j }
  const t = Date.now()
  const old = t - 10 * 86_400_000
  await Deno.writeTextFile(`${data}/events/s2.jsonl`, [
    { t: old, sid: 's2', k: 'create', key: 'SVC-9', project: 'SVC', title: 'old', col: 'doing' },
    { t: old + 1, sid: 's2', k: 'move', key: 'SVC-9', col: 'canceled', by: 'me', text: '' },
    { t: t - 2, sid: 's2', k: 'move', key: 'WB-3', col: 'decide', text: 'Claude 建议取消' },
    { t: t - 1, sid: 's2', k: 'meta', key: 'WB-3', meta: { proposeCancel: { reason: 'dup', from: 'todo' } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const tk = async (key: string) => (await board()).board.tickets.find((x: any) => x.key === key)
  assertEquals((await tk('WB-3')).proposeCancel, { reason: 'dup', from: 'todo' })
  await send({ type: 'keep', key: 'WB-3' })
  assertEquals([(await tk('WB-3')).col, (await tk('WB-3')).proposeCancel], ['todo', undefined])
  await send({ type: 'keep', key: 'WB-3' }, 400) // nothing proposed any more
  await send({ type: 'cancel', key: 'SVC-1', text: ' 不要了 ' })
  const last = (await lines(data)).at(-1)
  assertEquals([last.k, last.col, last.by, last.text], ['move', 'canceled', 'me', '不要了'])
  assertEquals((await board()).board.feed[0].text, '你取消了「[T-42] 登录页面」：不要了')
  await send({ type: 'restore', key: 'SVC-1' })
  assertEquals(colOf(await board(), 'SVC-1'), 'doing')
  await send({ type: 'restore', key: 'SVC-1' }, 400) // not canceled
  await send({ type: 'move', key: 'SVC-1', col: 'canceled' })
  assertEquals([(await lines(data)).at(-1).by, colOf(await board(), 'SVC-1')], ['me', 'canceled'])
  // archived: off the board, in `archived` for the page's search
  const d = await board()
  assertEquals([colOf(d, 'SVC-9'), d.archived.map((x: any) => x.key)], [undefined, ['SVC-9']])
  assertEquals((await board('?week=1')).archived, [])
}))

Deno.test('index.html: cancel / confirm / keep / restore buttons post their own types', async () => {
  const html = await Deno.readTextFile(new URL('./index.html', import.meta.url))
  for (const s of ["b('confirm', 'cancel.ok'", "b('keep', 'cancel.keep')", "b('restore', 'restore')", "b('cancel', 'cancel')", "run({ type: 'cancel', key: d.key, text: why })", 'drop-only']) assertStringIncludes(html, s)
})

// WB-34: the board settings page saves prefixes and names; a new prefix rekeys the board, old keys keep working.
Deno.test('boards: rename a prefix and names, and back again; stale or clashing prefixes are refused', () => withServer(null, async ({ data, post, board }) => {
  const b0 = await board()
  assertEquals(b0.projects.find((p: any) => p.id === 'WB'), { id: 'WB', name: '看板开发', name_zh: '看板开发', name_en: 'Board Dev', color: '#c98bb9', icon: 'grid' })
  const rows = b0.projects.map((p: any) => ({ from: p.id, id: p.id, name: p.name_zh, name_en: p.name_en }))
  const wb = rows.find((r: any) => r.from === 'WB')
  wb.id = 'kb'; wb.name = '任务看板'
  const r = await post({ type: 'boards', boards: rows })
  assertEquals([r.status, await r.json()], [200, { ok: true, rekeyed: 2 }])
  const b = await board()
  assertEquals(b.projects.map((p: any) => p.id), ['SVC', 'KB', 'INF', 'ME'])
  assertEquals(b.projects[1].name, '任务看板')
  assertEquals(b.board.tickets.filter((t: any) => t.project === 'KB').map((t: any) => t.key).sort(), ['KB-10', 'KB-3'])
  const conf = JSON.parse(await Deno.readTextFile(`${data}/projects.json`))
  assertEquals([conf[1].id, conf[1].match, conf[1].color], ['KB', 'cc-taskboard|kanban', '#c98bb9']) // the rest of the board stays
  // old keys still act on the ticket; a new ticket continues the numbers
  assertEquals((await post({ type: 'move', key: 'WB-3', col: 'review' })).status, 200)
  assertEquals(colOf(await board(), 'KB-3'), 'review')
  assertEquals((await (await post({ type: 'create', title: 'n', project: 'KB' })).json()).key, 'KB-11')
  // a stale page (still lists WB) is refused
  const stale = rows.map((x: any) => ({ ...x, id: x.from }))
  assertEquals((await post({ type: 'boards', boards: stale })).status, 409)
  // back to WB: allowed; every key the ticket had still finds it
  const back = rows.map((x: any) => ({ ...x, from: x.from === 'WB' ? 'KB' : x.from, id: x.from === 'WB' ? 'WB' : x.id }))
  assertEquals(await (await post({ type: 'boards', boards: back })).json(), { ok: true, rekeyed: 3 })
  for (const k of ['KB-3', 'WB-3']) assertEquals((await post({ type: 'comment', key: k, text: k })).status, 200)
  const t3 = (await board()).board.tickets.find((t: any) => t.key === 'WB-3')
  assertEquals([t3.project, t3.aliases, t3.comments.map((c: any) => c.text)], ['WB', ['KB-3'], ['KB-3', 'WB-3']])
  assertEquals((await (await post({ type: 'create', title: 'm', project: 'WB' })).json()).key, 'WB-12')
  // a prefix another board's tickets carry is refused, so is a duplicate board id
  const clash = (await board()).projects.map((p: any) => ({ from: p.id, id: p.id === 'WB' ? 'SVC' : p.id, name: p.name_zh, name_en: p.name_en }))
  assertEquals((await post({ type: 'boards', boards: clash })).status, 400)
  const dup = (await board()).projects.map((p: any) => ({ from: p.id, id: p.id === 'INF' ? 'SVC' : p.id, name: p.name_zh, name_en: p.name_en }))
  assertEquals((await post({ type: 'boards', boards: dup })).status, 400)
}))

Deno.test('index.html: the board settings form posts type boards', async () => {
  const html = await Deno.readTextFile(new URL('./index.html', import.meta.url))
  for (const s of ["data-act=\"boards\"", "id=\"cfgForm\"", "type: 'boards'"]) assertStringIncludes(html, s)
  // a field named id would shadow form.id and the submit handler would never see cfgForm
  const form = html.slice(html.indexOf('id="cfgForm"'), html.indexOf('</form>', html.indexOf('id="cfgForm"')))
  assert.ok(!/name="(id|name)"/.test(form), 'cfgForm has a field named id or name')
})
