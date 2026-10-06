import { expect, test } from 'claude-code/testing'

import { LEGACY_DATA_DIR, colOf, weekStartOf } from './core.ts'
import Row from './row.tsx'

// In-memory fs beneath the plugin: the test env has no disk. HOME is a fake one, fed through env.get.
const HOME = '/home/test'
const DATA = `${HOME}/.claude/cc-taskboard`
// Boards come from projects.json now; the tests use the same four.
const BOARDS = [
  { id: 'SVC', name: 'SVC 重写', name_en: 'SVC Rewrite', match: 'web-app|acme', root: `${HOME}/web-app`, icon: 'flask', color: '#8394e6' },
  { id: 'WB', name: '看板开发', name_en: 'Board Dev', match: 'cc-taskboard|kanban', icon: 'grid', color: '#c98bb9' },
  { id: 'INF', name: 'Infra', match: '/\\.claude(/|$)', icon: 'cube', color: '#a58fd6' },
  { id: 'ME', name: '私人', name_en: 'Personal', match: 'side projects', icon: 'home', color: '#4fae9f' },
]

// opts.env: extra variables for env.get (every name is answered from here); opts.run: a process.run stub (else commands fail).
function memfs(on: any, opts: { env?: Record<string, string>; run?: (_$: any, e: any) => unknown; noDeno?: boolean } = {}) {
  const files = new Map<string, string>()
  files.set(`${DATA}/projects.json`, JSON.stringify(BOARDS))
  const ok = (value?: unknown) => ({ value })
  const env: Record<string, string> = { HOME, ...opts.env }
  on('env.get', (_$: any, e: any) => ok(env[e.name]))
  // Nothing runs for real: ensureWeb's shell line must never start a server on live data.
  on('process.run', (_$: any, e: any) => (e.argv[0] !== '/bin/sh' && opts.run ? opts.run(_$, e) : ok({ exitCode: e.argv[0] === '/bin/sh' && !(opts.noDeno && /command -v deno/.test(e.argv[2])) ? 0 : 1, stdout: '', stderr: '' })))
  on('fs.exists', (_$: any, e: any) => ok([...files.keys()].some(p => p === e.path || p.startsWith(`${e.path}/`))))
  on('fs.read', (_$: any, e: any) => (files.has(e.path) ? ok(files.get(e.path)) : { deny: 'ENOENT' }))
  on('fs.write', (_$: any, e: any) => (files.set(e.path, e.text), ok()))
  // Direct children only, like the real fs: nested paths show up as one directory entry.
  on('fs.list', (_$: any, e: any) =>
    ok([...new Set([...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => p.slice(e.path.length + 1).split('/')[0]))]
      .map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? 'file' : 'directory', size: 0, mtimeMs: 0, isLink: false }))))
  on('session.id', () => ok('sess-1'))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  const store = new Map<string, unknown>()
  on('store.get', (_$: any, e: any) => ok(store.get(e.key)))
  on('store.set', (_$: any, e: any) => (store.set(e.key, e.value), ok()))
  on('clock.every', () => ok())
  on('tool.register', (_$: any, e: any) => ok({ tool: e.name }))
  on('command.register', (_$: any, e: any) => ok({ command: e.name }))
  on('ui.toast', () => ok())
  on('turn.complete', () => ({ text: '' }))
  const panes: string[] = []
  on('ui.panes', () => ok(panes.map(id => ({ id, title: id, isShown: true }))))
  on('ui.open', (_$: any, e: any) => (panes.includes(e.id) || panes.push(e.id), ok({ isPlaced: true })))
  ;(files as any).panes = panes
  return files
}

const LOG = `${DATA}/events/sess-1.jsonl`

// Flat style: no emoji anywhere the pane draws. The comment-count pencil (✎) is a plain text glyph the row uses on purpose.
const EMOJI = /(?!✎)\p{Extended_Pictographic}/u
async function expectNoEmoji(ui: any) {
  const hit = JSON.stringify(await drawnOf(ui)).match(EMOJI)
  expect(hit?.[0] ?? null).toBeNull()
}
const HAN = /\p{Script=Han}/u
// The EN / 中文 button's own label is 中文, so strip it before looking for leftovers.
const noHan = async (ui: any) => expect(JSON.stringify(await drawnOf(ui)).replaceAll('中文', '').match(HAN)?.[0] ?? null).toBeNull()
const RULE = /([─━═—-])\1{5,}/
const noRule = async (ui: any) => expect(JSON.stringify(await drawnOf(ui)).match(RULE)?.[0] ?? null).toBeNull()
// WB-36: a row is a Client (row.tsx) where the surface draws one, else the title Button: click it, or read its title / dimness.
const openRow = async (ui: any, key: string) => (await ui.find({ key: `open-${key}` }))?.type === 'Client'
  ? ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `open-${key}` })
  : ui.press({ key: `open-${key}` })
const rowOf = async (ui: any, key: string) => {
  const el = await ui.find({ key: `open-${key}` })
  if (!el) return undefined
  const p = el.type === 'Client' ? el.props.props : null
  return p ? { label: p.title, dimColor: p.dim } : { label: el.props.label, dimColor: el.props.dimColor }
}
const PANE = (surface: any, bodyColumns: number) => ({
  plugin: 'cc-taskboard', surface, component: 'Pane' as const, requestId: 'cc-taskboard',
  props: { title: '周看板', isFocused: true, bodyColumns, placement: 'dock' } as any,
})
async function seed($: any, on: any, surface: string) {
  const files = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface, isInteractive: true })
  const made = await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  expect(String(made.result)).toContain('SVC-1')
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: 'cc-taskboard mod ✅', project: 'ME', col: 'decide', src: 'me', note: '⏳ 09-22 提出 · 📄 plan.md ⚠️' })
  return files
}
// The drawn tree with each Client row (row.tsx) replaced by what the real module draws, in the engine's node shape,
// so the row assertions below read its Texts as they read any other.
const el = (type: string) => ({ hover, children, ...props }: any) => ({
  type, props: Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)), ...(hover ? { hover } : {}),
  children: [children ?? []].flat(9).filter((c: any) => c !== null && c !== undefined && c !== false),
})
const fakeSurface: any = { elements: { Box: el('Box'), Text: el('Text') }, onPointer() {}, onKey() {}, post() {}, setState() {}, every() {}, columns: 0, rows: 0 }
const expand = (n: any): any => n?.type === 'Client' && n.props?.module === 'hooks/row.tsx' ? Row(n.props.props, fakeSurface)
  : n && typeof n === 'object' ? { ...n, ...(n.children ? { children: n.children.map(expand) } : {}) } : n
const drawnOf = async (ui: any) => expand(await ui.drawn())
// ui.find for a Text, row Texts included
const findText = async (ui: any, text: string) => nodes(await drawnOf(ui), n => n?.type === 'Text' && (n.children ?? []).join('') === text)[0]
// Walk a drawn tree.
const walk = (n: any, f: (n: any) => void) => { f(n); for (const c of n?.children ?? []) if (typeof c === 'object') walk(c, f) }
const nodes = (tree: any, f: (n: any) => boolean) => { const out: any[] = []; walk(tree, n => { if (f(n)) out.push(n) }); return out }
const byKey = async (ui: any, key: string) => nodes(await drawnOf(ui), n => n?.props?.key === key)[0]
// The status sections drawn, in order (sec-decide, ...), and the ticket rows of one.
const sections = async (ui: any) => nodes(await drawnOf(ui), n => n.type === 'Box' && /^sec-/.test(n.props?.key ?? '')).map(n => n.props.key)
const rowsIn = async (ui: any, sec: string) => nodes(await byKey(ui, sec), n => n.type === 'Box' && /^row-/.test(n.props?.key ?? '')).map(n => n.props.key)
const call = ($: any) => (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })

// Narrow pane: a title opens the inline preview, its button the detail; the detail's buttons talk to the session.
test('narrow desktop pane: open, move, hand to Claude, feed', async ($: any, on: any) => {
  const prompts: string[] = []
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 60))
  expect(await ui.find({ key: 'open-SVC-1' })).toBeDefined()
  await ui.press({ key: 'p-SVC' })
  expect(await ui.find({ key: 'open-ME-1' })).toBeUndefined()
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ key: 'ask-owner' })).toBeUndefined() // no other live session worked it
  await expectNoEmoji(ui)
  await ui.press({ key: 'go-here' })
  expect(prompts.at(-1)).toContain('继续做 SVC-1')
  await ui.select({ key: 'status', value: 'follow' })
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('用户刚在看板上调整了本 session 做过的 ticket：SVC-1 → 待跟进')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'tab-feed' })
  expect(await ui.find({ type: 'Text', text: /待跟进/ })).toBeDefined()
  await expectNoEmoji(ui)
  await ui.press({ key: 'p-ME' })
  await ui.press({ key: 'tab-board' })
  await openRow(ui, 'ME-1')
  await expectNoEmoji(ui) // with the preview open: the imported note's emoji are stripped
  await ui.press({ key: 'peek-open' })
  await expectNoEmoji(ui)
  await ui.unmount()
})

test('git commit / gh pr create / gh pr merge move the current ticket', async ($: any, on: any) => {
  const files = memfs(on)
  const OUT: Record<string, string> = {
    'git commit -m "x"': '[feat/t42 3e7a9b1] 登录页表单校验\n 2 files changed',
    'gh pr create --fill': 'https://github.com/acme/web-app/pull/112\n',
    'gh pr merge 112': 'Merged',
  }
  on('tool.call', { tool: 'Bash' }, (_$: any, e: any) => ({ result: { stdout: OUT[e.command] }, text: OUT[e.command] }))
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: 'T-42' })
  const log = () => files.get(`${DATA}/events/sess-1.jsonl`) ?? ''

  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  expect(log()).toContain('"k":"commit"')
  expect(log()).toContain('3e7a9b1')
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect(log()).toContain('"text":"#112"')
  expect(log()).toContain('"col":"follow"')
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 112' })
  expect(log()).toContain('"col":"review","text":"PR 合并，待你验收"')
})

test('the board docks itself on the first prompt, once', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: null, isInteractive: false })
  expect(files.panes).toEqual([])
  await $.prompt.submit({ text: 'hi', wait: false })
  expect(files.panes).toEqual(['cc-taskboard'])
  await $.prompt.submit({ text: 'again', wait: false })
  expect(files.panes).toEqual(['cc-taskboard'])
})

// v2: review gate, priority, description, comments, session links, spawning a session for a ticket
test('Claude can only reach 待审核; the person accepts; desc/priority/comments; spawn opens a new-session screen', async ($: any, on: any) => {
  const prompts: string[] = []
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  const opened: string[] = []
  const run = (_$: any, e: any) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'open') opened.push(e.argv[1])
    const out = a.includes('--abbrev-ref') ? 'feat/t42\n' : a.includes('--show-toplevel') ? `${HOME}/web-app/.claude/worktrees/t42\n`
      : a.startsWith('claude agents') ? JSON.stringify([{ sessionId: 'sess-1', name: 'T-42 登录页面', status: 'busy' }]) : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  }
  const files: any = memfs(on, { run })
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: '[T-42] 登录页面', priority: 'P1', desc: '## 目标\n去掉 CAS 里的 `@@`' })
  expect(files.get(LOG)).toContain('"branch":"feat/t42"')
  expect(files.get(LOG)).toContain(`"worktree":"${HOME}/web-app/.claude/worktrees/t42"`)
  const done = await call($)({ action: 'update', key: 'SVC-1', col: 'done', comment: '迁移已跑' })
  expect(String(done.result)).toContain('待审核')
  expect(files.get(LOG)).not.toContain('"col":"done"')

  const ui = await $.ui.mount(PANE('desktop', 60))
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ type: 'Text', text: 'T-42 登录页面' })).toBeDefined() // real session title from claude agents
  expect(await ui.find({ type: 'Text', text: /迁移已跑/ })).toBeDefined()
  await ui.select({ key: 'priority', value: 'P0' })
  expect(files.get(LOG)).toContain('"priority":"P0"')
  await ui.input({ key: 'comment', text: '先别合，等 Ian' })
  expect(files.get(LOG)).toContain('"k":"comment","key":"SVC-1","by":"me","text":"先别合，等 Ian"')
  // WB-21: no Claude turn; the app's new-session link, the claim line and the project root filled in
  const before = prompts.length
  await ui.press({ key: 'spawn' })
  expect(prompts.length).toBe(before)
  const link = new URL(opened.at(-1)!)
  expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('claude://code/new')
  expect(link.searchParams.get('q')).toMatch(/^认领 SVC-1：先调用 mcp__cc-taskboard__ticket action:update key:SVC-1 work:true/)
  expect(link.searchParams.get('folder')).toBe(`${HOME}/web-app`) // the project root, not the ticket's worktree
  // the comment wakes this session (it owns SVC-1) at the end of the turn, as a prompt of its own
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(prompts.some(p => p.includes('SVC-1「[T-42] 登录页面」：先别合，等 Ian'))).toBe(true)
  await ui.press({ key: 'accept' })
  expect(files.get(LOG)).toContain('"col":"done","text":"你验收通过"')
  await expectNoEmoji(ui)
  await ui.unmount()
})

test('a spawned session keeps its title as 【date - status】KEY topic', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const titles: string[] = []
  on('classic.UserPromptSubmit', (_$: any, e: any) => ({}))
  const files: any = memfs(on, { env: { CLAUDE_CODE_HOST_SESSION_ID: 'local_x' } })
  files.set(`${HOME}/Library/Application Support/Claude/claude-code-sessions/org/user/local_x.json`, JSON.stringify({ title: '【Oct 3 - in progress】SVC-1 登录页面' }))
  await $.session.start({ cwd: `${HOME}/web-app`, surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面', col: 'todo' })
  const r0 = await $.classic.UserPromptSubmit({ prompt: 'hi' })
  expect(r0.sessionTitle).toBeUndefined() // not spawned by the board: its title is left alone
  await $.prompt.submit({ text: '认领 SVC-1：先调用 mcp__cc-taskboard__ticket action:update key:SVC-1 work:true', wait: false })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'update', key: 'SVC-1', work: true })
  const r1 = await $.classic.UserPromptSubmit({ prompt: 'go' })
  expect(r1.sessionTitle).toMatch(/^【[A-Z][a-z]{2} \d{1,2} - in progress】SVC-1 登录页面$/)
  // WB-24: Claude's own move answers with the rename to make, by the desktop id, at once.
  const moved = await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'update', key: 'SVC-1', col: 'done' })
  expect(String(moved.result)).toMatch(/set_session_title[\s\S]*session_id: local_x  title: 【[A-Z][a-z]{2} \d{1,2} - review】SVC-1 登录页面$/m)
  const r2 = await $.classic.UserPromptSubmit({ prompt: 'next' })
  expect(r2.sessionTitle).toMatch(/ - review】SVC-1 登录页面$/)
  // Creating another ticket from here makes it current, yet the title keeps the KEY it already names.
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '别的事', title_en: 'Other', col: 'todo' })
  const r3 = await $.classic.UserPromptSubmit({ prompt: 'more' })
  expect(r3.sessionTitle).toMatch(/ - review】SVC-1 登录页面$/)
  expect(files.get(`${DATA}/spawned.json`)).toContain('sess-1')
})

// Every string the pane shows a person: Text children and the label-like props, not colors or keys.
function shownText(tree: any): string[] {
  if (typeof tree === 'string' || typeof tree === 'number') return [String(tree)]
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(shownText)
  const p = tree.props ?? {}
  return [...['label', 'placeholder', 'alt', 'submitLabel', 'text'].flatMap(k => (typeof p[k] === 'string' ? [p[k]] : [])), ...shownText(tree.children)]
}

// The EN / 中文 button flips every UI string; free text (comments, notes) is ASCII and tickets are bilingual, so any Han left over is a missed string or the zh side of a ticket.
test('en mode shows no Chinese UI text', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: '[main 3e7a9b1] fix markers' }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: '[T-42] 登录页面', title_en: '[T-42] login page', priority: 'P1', desc: '去掉标记', desc_en: 'drop the marker', comment: 'migration ran' })
  await call($)({ action: 'create', title: '周看板插件', title_en: 'task board mod', project: 'ME', col: 'decide', src: 'me', note: 'plan.md' })
  await call($)({ action: 'update', key: 'ME-1', col: 'canceled', comment: 'not needed' }) // a proposal: its row carries the marker (WB-28)
  await call($)({ action: 'update', key: 'SVC-1', col: 'review' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' }) // the activity also carries a commit
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    expect(await ui.find({ type: 'Text', text: /^(进行中|待审核)$/ })).toBeDefined() // SVC-1 is in review, after the first round in doing
    await ui.press({ key: 'lang' })
    expect(await ui.find({ type: 'Text', text: /^(In review|In progress)$/ })).toBeDefined()
    await noHan(ui)
    await ui.press({ key: 'tab-feed' })
    await noHan(ui)
    await ui.press({ key: 'tab-board' })
    await openRow(ui, 'SVC-1')
    expect((await ui.find({ key: 'peek-open' }))?.props.label).toBe('Open details')
    for (const text of [/^Description$/, /Created \d/, /drop the marker/, /migration ran/]) expect(await ui.find({ type: 'Text', text })).toBeDefined()
    expect(JSON.stringify(await drawnOf(ui))).toContain('Add a comment')
    await noHan(ui) // the preview is open: its strings are en too
    await ui.press({ key: 'peek-open' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await noHan(ui)
    await ui.input({ key: 'comment', text: 'noted' })
    await ui.select({ key: 'status', value: cols > 100 ? 'doing' : 'review' }) // SVC-1 starts in review, then sits in doing
    await noHan(ui)
    await ui.press({ key: 'back' })
    await ui.press({ key: 'lang' })
    expect(await ui.find({ type: 'Text', text: /等我拍板|进行中|待审核/ })).toBeDefined() // back to zh, which the next mount starts from
    await ui.unmount()
  }
})

// No line is drawn by repeating a glyph (the desktop's cell metric is not the font's, so such lines wrap).
test('no glyph-repeated rules', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  await seed($, on, 'desktop')
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    await noRule(ui)
    await ui.press({ key: 'tab-feed' })
    await noRule(ui)
    await ui.press({ key: 'tab-board' })
    await ui.press({ key: 'p-SVC' })
    await noRule(ui)
    await openRow(ui, 'SVC-1')
    await noRule(ui) // with the preview open
    await ui.press({ key: 'peek-open' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await noRule(ui)
    await ui.press({ key: 'back' })
    await ui.press({ key: 'p-ALL' })
    await ui.unmount()
  }
})

test('detail at 140 cols: Selects, move, row key, search, quick filter', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files = await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 140))
  expect(await findText(ui, 'SVC-1')).toBeDefined() // the row shows the key
  // search hides non-matching rows, as it is typed
  expect(await ui.find({ key: 'open-ME-1' })).toBeDefined()
  await ui.input({ key: 'search', text: 'T-42', kind: 'change' })
  expect(await ui.find({ key: 'open-SVC-1' })).toBeDefined()
  expect(await ui.find({ key: 'open-ME-1' })).toBeUndefined()
  await ui.input({ key: 'search', text: '' })
  expect(await ui.find({ key: 'open-ME-1' })).toBeDefined()
  // quick filter: only tickets waiting on me (col decide)
  await ui.press({ key: 'qf-me' })
  expect(await ui.find({ key: 'open-SVC-1' })).toBeUndefined()
  expect(await ui.find({ key: 'open-ME-1' })).toBeDefined()
  await ui.press({ key: 'qf-me' })
  // detail: both Selects, status pick writes a move
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ key: 'status' })).toBeDefined()
  expect(await ui.find({ key: 'priority' })).toBeDefined()
  await ui.select({ key: 'status', value: 'follow' })
  expect(files.get(LOG)).toContain('"col":"follow","text":"你手动移动"')
  await ui.select({ key: 'priority', value: 'P1' })
  expect(files.get(LOG)).toContain('"priority":"P1"')
  await expectNoEmoji(ui)
  await ui.unmount()
})

// WB-29: the focus list. Sections decide, doing, review, follow; empty ones absent; todo / done / canceled folded below.
test('sections in order, empty ones absent; todo and done folded behind their fold Buttons', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: 'review one', col: 'review' }) // SVC-1
  await call($)({ action: 'create', title: 'doing one', col: 'doing' }) // SVC-2
  await call($)({ action: 'create', title: 'decide one', col: 'decide' }) // SVC-3
  await call($)({ action: 'create', title: 'todo one', col: 'todo' }) // SVC-4
  await call($)({ action: 'create', title: 'done one', col: 'done', userAccepted: true }) // SVC-5
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    expect(await sections(ui)).toEqual(['sec-decide', 'sec-doing', 'sec-review']) // no 待跟进: empty
    expect(await ui.find({ key: 'open-SVC-4' })).toBeUndefined()
    expect(await ui.find({ key: 'open-SVC-5' })).toBeUndefined()
    expect((await ui.find({ key: 'fold-todo' }))?.props.label).toBe('待开工 1 ›')
    expect(await ui.find({ key: 'fold-canceled' })).toBeUndefined() // nothing canceled
    await ui.press({ key: 'fold-todo' })
    expect(await sections(ui)).toEqual(['sec-decide', 'sec-doing', 'sec-review', 'sec-todo'])
    expect(await ui.find({ key: 'open-SVC-4' })).toBeDefined()
    await ui.press({ key: 'fold-done' })
    expect(await sections(ui)).toEqual(['sec-decide', 'sec-doing', 'sec-review', 'sec-todo', 'sec-done'])
    expect((await rowOf(ui, 'SVC-5'))?.dimColor).toBe(true) // done rows are dim
    await ui.press({ key: 'fold-todo' })
    await ui.press({ key: 'fold-done' })
    expect(await sections(ui)).toEqual(['sec-decide', 'sec-doing', 'sec-review'])
    // one line per ticket, a hover tint on its keyed Box
    const r = await byKey(ui, 'row-SVC-1')
    expect(r.hover).toEqual({ backgroundColor: '#f4f3ef' })
    await expectNoEmoji(ui)
    await ui.unmount()
  }
})

test('narrow: decide shows 5 rows, the more Button expands and collapses it; wide shows all', async ($: any, on: any) => {
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  for (let i = 1; i <= 7; i++) await call($)({ action: 'create', title: `decide ${i}`, col: 'decide' })
  const ui = await $.ui.mount(PANE('desktop', 60))
  expect((await rowsIn(ui, 'sec-decide')).length).toBe(5)
  expect((await ui.find({ key: 'more-decide' }))?.props.label).toBe('还有 2 张 ›')
  await ui.press({ key: 'more-decide' })
  expect((await rowsIn(ui, 'sec-decide')).length).toBe(7)
  expect((await ui.find({ key: 'more-decide' }))?.props.label).toBe('收起')
  await ui.press({ key: 'more-decide' })
  expect((await rowsIn(ui, 'sec-decide')).length).toBe(5)
  await ui.unmount()
  const w = await $.ui.mount(PANE('desktop', 140))
  expect((await rowsIn(w, 'sec-decide')).length).toBe(7)
  expect(await w.find({ key: 'more-decide' })).toBeUndefined()
  await w.unmount()
})

test('legend Buttons hide and show a status: its section and its ribbon segment', async ($: any, on: any) => {
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: 'decide one', col: 'decide' })
  await call($)({ action: 'create', title: 'doing one', col: 'doing' })
  await call($)({ action: 'create', title: 'doing two', col: 'doing' })
  const ui = await $.ui.mount(PANE('desktop', 140))
  const svg = async () => (await ui.find({ type: 'Svg' }))?.props
  expect((await ui.find({ key: 'legend-doing' }))?.props.label).toBe('进行中 2')
  expect(await ui.find({ key: 'legend-review' })).toBeUndefined() // no tickets: no legend entry
  expect((await svg()).alt).toBe('等我拍板 1 · 进行中 2')
  expect([(await svg()).height, (await svg()).width]).toEqual([6, undefined])
  expect((await svg()).source).toContain('rx="3"')
  expect((await svg()).source).toContain(`fill="${colOf('doing').color}"`)
  await ui.press({ key: 'legend-doing' })
  expect(await sections(ui)).toEqual(['sec-decide'])
  expect((await ui.find({ key: 'legend-doing' }))?.props.dimColor).toBe(true)
  expect((await svg()).alt).toBe('等我拍板 1')
  await ui.press({ key: 'legend-doing' })
  expect(await sections(ui)).toEqual(['sec-decide', 'sec-doing'])
  expect((await ui.find({ key: 'legend-doing' }))?.props.dimColor).toBeFalsy()
  await ui.unmount()
})

test('terminal ribbon: one line of runs in the status colors, width - 4 cells', async ($: any, on: any) => {
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'terminal', isInteractive: true })
  await call($)({ action: 'create', title: 'decide one', col: 'decide' })
  for (let i = 0; i < 3; i++) await call($)({ action: 'create', title: `doing ${i}`, col: 'doing' })
  await call($)({ action: 'create', title: 'todo one', col: 'todo' })
  for (const cols of [60, 120]) {
    const ui = await $.ui.mount(PANE('terminal', cols))
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    const runs = nodes(await drawnOf(ui), n => n.type === 'Text' && n.children?.length && n.children.every((c: any) => String(c?.children?.[0] ?? '').startsWith('▇')))[0].children
    expect(runs.map((r: any) => r.props.color)).toEqual(['decide', 'doing', 'todo'].map(c => colOf(c).color))
    expect(runs.map((r: any) => r.children.join('')).join('')).toMatch(/^▇+$/)
    expect(runs.map((r: any) => r.children.join('')).join('').length).toBe(cols - 4)
    await ui.unmount()
  }
})

// WB-33: every row leads with its key in the project color, wide or narrow, ALL or one project; no separate project column.
test('rows lead with the ticket key in the project color', async ($: any, on: any) => {
  await seed($, on, 'desktop')
  const lead = async (ui: any) => JSON.stringify((await byKey(ui, 'row-SVC-1')).children[0])
  const ui = await $.ui.mount(PANE('desktop', 140))
  for (const p of ['', 'p-SVC', 'p-ALL']) { // ALL, one project, ALL again
    if (p) await ui.press({ key: p })
    expect(await lead(ui)).toContain('"color":"#8394e6"},"children":["SVC-1"]')
    expect(JSON.stringify(await byKey(ui, 'row-SVC-1'))).not.toContain('"children":["SVC"]') // no project column
  }
  await ui.unmount()
  const n = await $.ui.mount(PANE('desktop', 60))
  expect(await lead(n)).toContain('"color":"#8394e6"},"children":["SVC-1"]')
  await n.unmount()
})

// Narrow: the preview opens inline under its row; the same title folds it again.
test('narrow inline preview: open under the row, fold again, comment, status Select moves and closes', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 60))
  await openRow(ui, 'SVC-1')
  expect(await ui.find({ key: 'peek-pop' })).toBeUndefined()
  const kids = (await byKey(ui, 'sec-doing')).children.map((c: any) => c.props?.key)
  expect(kids.indexOf('pv-SVC-1')).toBe(kids.indexOf('row-SVC-1') + 1)
  expect((await byKey(ui, 'pv-SVC-1')).props.backgroundColor).toBe('#f4f3ef')
  expect(await ui.find({ type: 'Text', text: /再点一次标题收起/ })).toBeDefined()
  await openRow(ui, 'SVC-1')
  expect(await ui.find({ key: 'pv-SVC-1' })).toBeUndefined()
  await openRow(ui, 'SVC-1')
  const comments = () => files.get(LOG).split('\n').filter((l: string) => l.includes('"k":"comment"')).length
  await ui.input({ key: 'peek-comment', text: '   ' }) // empty writes nothing
  expect(comments()).toBe(0)
  await ui.input({ key: 'peek-comment', text: ' 先别合 ' })
  expect(files.get(LOG)).toContain('"k":"comment","key":"SVC-1","by":"me","text":"先别合"')
  expect(comments()).toBe(1)
  expect(await ui.find({ type: 'Text', text: /先别合/ })).toBeDefined() // shown in the preview, which stays open
  expect(await ui.find({ key: 'back' })).toBeUndefined()
  await ui.select({ key: 'peek-status', value: 'follow' })
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"follow","text":"你手动移动"')
  expect(await ui.find({ key: 'pv-SVC-1' })).toBeUndefined()
  expect(await rowsIn(ui, 'sec-follow')).toEqual(['row-SVC-1'])
  await openRow(ui, 'SVC-1')
  await ui.select({ key: 'peek-priority', value: 'P0' })
  expect(files.get(LOG)).toContain('"priority":"P0"')
  await expectNoEmoji(ui)
  await ui.unmount()
})

// Wide: no popup either (WB-32); the preview opens inline under its row, another title opens its own, the same title folds it.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`wide inline preview on ${surface}: opens, switches, folds`, async ($: any, on: any) => {
    await seed($, on, surface)
    const ui = await $.ui.mount(PANE(surface, 140))
    await openRow(ui, 'SVC-1')
    expect(await ui.find({ key: 'peek-pop' })).toBeUndefined()
    const kids = (await byKey(ui, 'sec-doing')).children.map((c: any) => c.props?.key)
    expect(kids.indexOf('pv-SVC-1')).toBe(kids.indexOf('row-SVC-1') + 1)
    expect(await ui.find({ key: 'peek-status' })).toBeDefined()
    expect(await ui.find({ key: 'peek-comment' })).toBeDefined()
    expect(await ui.find({ key: 'peek-cancel' })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await openRow(ui, 'ME-1') // another row switches it
    expect(await ui.find({ key: 'pv-SVC-1' })).toBeUndefined()
    expect(await ui.find({ key: 'pv-ME-1' })).toBeDefined()
    await openRow(ui, 'ME-1') // the same title folds it
    expect(await ui.find({ key: 'pv-ME-1' })).toBeUndefined()
    await openRow(ui, 'ME-1')
    await ui.press({ key: 'peek-open' })
    expect(await ui.find({ type: 'Text', text: 'ME-1' })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await expectNoEmoji(ui)
    await ui.unmount()
  })
}

// en mode: the preview with the comment input has no Han.
test('en mode: the preview with the comment input has no Chinese', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: '[T-42] login page', comment: 'migration ran' })
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    await ui.press({ key: 'lang' })
    await openRow(ui, 'SVC-1')
    expect(JSON.stringify(await drawnOf(ui))).toContain('Add a comment')
    await noHan(ui)
    await openRow(ui, 'SVC-1')
    await ui.press({ key: 'lang' })
    await ui.unmount()
  }
})

// History weeks are read-only: the preview has no Select, no Input, no act buttons.
test('past week: the preview is read-only', async ($: any, on: any) => {
  const files = memfs(on)
  const t = weekStartOf(Date.now()) - 3 * 86_400_000 // last week's Friday: exactly one week back, any weekday
  files.set(`${DATA}/events/old.jsonl`, `${JSON.stringify({ k: 'create', key: 'SVC-1', project: 'SVC', title: '[T-42] 登录页面', col: 'doing', src: 'claude', t, sid: 'old' })}\n`)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  for (const cols of [60, 140]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    await ui.press({ key: 'wk-prev' })
    expect(await ui.find({ key: 'wk-prev' })).toBeUndefined() // only one week back
    expect(await ui.find({ type: 'Text', text: /历史周只读/ })).toBeDefined()
    await openRow(ui, 'SVC-1')
    expect(await ui.find({ key: 'pv-SVC-1' })).toBeDefined()
    for (const key of ['peek-status', 'peek-priority', 'peek-comment', 'peek-cancel', 'peek-mv-todo']) expect(await ui.find({ key })).toBeUndefined()
    expect(await ui.find({ key: 'peek-open' })).toBeDefined()
    await ui.press({ key: 'peek-open' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'wk-next' })
    await ui.unmount()
  }
})

const CFG = `${HOME}/Library/Application Support/Claude/config.json`
const DARK = '#262624'
const LIGHT = '#f4f3ef'
// The pane follows the Claude app's theme (config.json userThemeMode, else the OS); it has no theme button of its own (WB-29).
async function themed($: any, on: any, config: string | null, appearance = 'Light') {
  // `defaults read -g AppleInterfaceStyle`: prints Dark in Dark mode, fails in Light mode
  const run = (_$: any, e: any) => ({ value: e.argv[0] === 'defaults' ? { exitCode: appearance === 'Dark' ? 0 : 1, stdout: appearance === 'Dark' ? 'Dark\n' : '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } })
  const files = memfs(on, { run })
  if (config !== null) files.set(CFG, config)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  const ui = await $.ui.mount(PANE('desktop', 140))
  await openRow(ui, 'SVC-1')
  const bg = async () => (await byKey(ui, 'pv-SVC-1')).props.backgroundColor
  return { ui, bg, files }
}
for (const [mode, own, other] of [['light', LIGHT, DARK], ['dark', DARK, LIGHT]] as const) {
  test(`theme follows the Claude app (${mode}); no theme button`, async ($: any, on: any) => {
    const { ui, bg } = await themed($, on, JSON.stringify({ userThemeMode: mode }), mode === 'light' ? 'Dark' : 'Light') // the OS says the opposite: the app wins
    expect(await bg()).toBe(own)
    expect(JSON.stringify(await drawnOf(ui))).not.toContain(other)
    expect(await ui.find({ key: 'theme' })).toBeUndefined()
    await ui.unmount()
  })
}

test('theme: system mode follows the OS appearance', async ($: any, on: any) => {
  const { ui, bg } = await themed($, on, JSON.stringify({ userThemeMode: 'system' }), 'Dark')
  expect(await bg()).toBe(DARK)
  await ui.unmount()
})

test('theme: a missing config.json falls back to the OS appearance', async ($: any, on: any) => {
  const { ui, bg } = await themed($, on, null, 'Light')
  expect(await bg()).toContain(LIGHT)
  await ui.unmount()
})

test('data dir: the legacy one while the new one does not exist; CC_TASKBOARD_DATA wins', async ($: any, on: any) => {
  const files = memfs(on)
  const legacy = `${HOME}/${LEGACY_DATA_DIR}`
  files.set(`${legacy}/projects.json`, files.get(`${DATA}/projects.json`)!)
  files.delete(`${DATA}/projects.json`)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  expect(files.get(`${legacy}/events/sess-1.jsonl`)).toContain('"key":"SVC-1"')
  expect([...files.keys()].some(k => k.startsWith(`${DATA}/`))).toBe(false)
})

test('data dir: CC_TASKBOARD_DATA overrides HOME', async ($: any, on: any) => {
  const files = memfs(on, { env: { CC_TASKBOARD_DATA: '/elsewhere/board' } })
  files.set('/elsewhere/board/projects.json', files.get(`${DATA}/projects.json`)!)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  expect(files.get('/elsewhere/board/events/sess-1.jsonl')).toContain('"key":"SVC-1"')
})
test('init wizard: scan, preview writes nothing, confirm writes projects.json and one init log, rerun adds nothing', async ($: any, on: any) => {
  const files = memfs(on)
  files.delete(`${DATA}/projects.json`) // a fresh install
  const SESS = `${HOME}/Library/Application Support/Claude/claude-code-sessions/o/u`
  const now = Date.now()
  files.set(`${SESS}/local_1.json`, JSON.stringify({ cliSessionId: 'c1', title: '修登录', cwd: '/Users/x/app', createdAt: now - 7200_000, lastActivityAt: now - 3600_000, postTurnSummary: JSON.stringify({ status_category: 'blocked', needs_action: '重启后端' }) }))
  files.set(`${SESS}/local_2.json`, JSON.stringify({ cliSessionId: 'c2', title: '拉取最新提交', cwd: '/Users/x/app/.claude/worktrees/w1', createdAt: now - 7200_000, lastActivityAt: now - 1800_000 }))
  await $.session.start({ cwd: '/Users/x/app', surface: 'desktop', isInteractive: true })
  const empty = await $.ui.mount(PANE('desktop', 140)) // no boards shipped: the board says so and points at the wizard
  expect(await empty.find({ type: 'Text', text: /还没有 board.*action:init/ })).toBeDefined()
  await empty.unmount()
  const call = async (x: any) => String((await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })).result)
  expect(await call({ action: 'create', title: 'x', title_en: 'x' })).toContain('init')
  const scan = await call({ action: 'init' })
  expect(scan).toContain('/Users/x/app 2') // the worktree counts toward its repo
  expect(scan).toContain('等用户：重启后端')
  expect(scan).toContain('无（还没有 projects.json）')
  const plan = {
    projects: [{ id: 'APP', name: '应用', name_en: 'App', match: '/Users/x/app' }],
    tickets: [{ project: 'APP', title: '修登录', title_en: 'Fix login', col: 'decide', sids: ['c1'] }],
  }
  const preview = await call({ action: 'init', plan })
  expect(preview).toContain('APP-1 [等我拍板] 修登录')
  expect(files.has(`${DATA}/projects.json`)).toBe(false)
  expect([...files.keys()].some(k => k.includes('/events/init-'))).toBe(false)
  expect(await call({ action: 'init', plan: { tickets: [{ project: 'NOPE', title: 'a', title_en: 'a', col: 'todo', sids: ['c1'] }] } })).toContain('方案不对')
  const done = await call({ action: 'init', plan, confirm: true })
  expect(done).toContain('已写入')
  expect(JSON.parse(files.get(`${DATA}/projects.json`)!)[0].id).toBe('APP')
  const log = [...files.keys()].find(k => k.includes('/events/init-'))!
  expect(files.get(log)!.trim().split('\n').length).toBe(2) // create + move
  expect(await call({ action: 'list' })).toContain('APP-1 [等我拍板] 修登录')
  expect(await call({ action: 'init', plan, confirm: true })).toContain('跳过')
  expect(files.get(log)!.trim().split('\n').length).toBe(2)
  // The session now belongs to the new board.
  expect(await call({ action: 'create', title: '新票', title_en: 'new' })).toContain('APP-2')
})

// The fold row's web Link (en says Web, no Han, no emoji; spelled as new URL(href).href, WB-26) and /kanban-web replying with the server's address.
test('kanban-web and the web link', async ($: any, on: any) => {
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 140))
  const link = async () => (await ui.find({ type: 'Link' }))?.props
  expect([(await link()).label, (await link()).href]).toEqual(['网页版', 'http://localhost:4790/'])
  expect((await link()).href).toBe(new URL((await link()).href).href)
  await ui.press({ key: 'lang' })
  expect([(await link()).label, (await link()).href]).toEqual(['Web', 'http://localhost:4790/'])
  await expectNoEmoji(ui)
  await ui.press({ key: 'lang' })
  await ui.unmount()
  const r = await $.command.run({ command: 'kanban-web' })
  expect(String(r.text)).toContain('http://127.0.0.1:4790')
})

// WB-11: labels, due, blockedBy, parent, canceled.
test('labels, due, blockedBy, parent, canceled: tool validation, list, rows, detail', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const c = async (x: any) => String((await call($)(x)).result)
  await c({ action: 'create', title: 'blocker' }) // SVC-1
  expect(await c({ action: 'create', title: 'bad', due: '10/5' })).toContain('没建')
  expect(await c({ action: 'create', title: 'bad', blockedBy: ['SVC-99'] })).toContain('没有 ticket SVC-99')
  expect(files.get(LOG)).not.toContain('"title":"bad"')
  await c({ action: 'create', title: 'child', col: 'todo', labels: ['#缺陷', 'hold', 'hold'], due: '2020-01-01', blockedBy: ['SVC-1'], parent: 'SVC-1' }) // SVC-2
  expect(await c({ action: 'update', key: 'SVC-2', blockedBy: ['SVC-2'] })).toContain('不能卡住自己')
  expect(await c({ action: 'update', key: 'SVC-1', parent: 'SVC-2' })).toContain('成环')
  expect(await c({ action: 'list', q: 'hold' })).toMatch(/SVC-2 \[待开工 截止 2020-01-01 卡于 SVC-1 父 SVC-1\] #缺陷 #hold child/)
  expect(await c({ action: 'update', key: 'SVC-2', work: true })).toContain('还被 SVC-1 卡着')

  // no 已取消 fold until something is canceled; the overdue row shows its due date in the late color
  const ui = await $.ui.mount(PANE('desktop', 160))
  expect(await ui.find({ key: 'fold-canceled' })).toBeUndefined()
  expect((await findText(ui, '截止 01-01'))?.props.color).toBe('#d9777a')
  await c({ action: 'update', key: 'SVC-1', col: 'canceled', userAccepted: true }) // the person said so in chat (WB-28)
  expect((await ui.find({ key: 'fold-canceled' }))?.props.label).toBe('已取消 1 ›')
  expect(await c({ action: 'list' })).not.toContain('SVC-1 ')
  await expectNoEmoji(ui)
  await ui.unmount()

  // narrow detail: relations both ways, overdue, panel edits
  const nu = await $.ui.mount(PANE('desktop', 60))
  await nu.press({ key: 'fold-canceled' }) // canceled is folded like done: open it first (WB-28)
  await openRow(nu, 'SVC-1')
  await nu.press({ key: 'peek-open' })
  expect(await nu.find({ key: 'rel-blocks-SVC-2' })).toBeDefined()
  expect(await nu.find({ key: 'rel-kids-SVC-2' })).toBeDefined()
  await nu.press({ key: 'rel-kids-SVC-2' })
  expect(await nu.find({ key: 'rel-by-SVC-1' })).toBeDefined()
  expect(await nu.find({ type: 'Text', text: /逾期 \d+ 天/ })).toBeDefined()
  await nu.input({ key: 'labels', text: '特性, phase-1' })
  expect(files.get(LOG)).toContain('"labels":["特性","phase-1"]')
  await nu.input({ key: 'due', text: 'tomorrow' })
  expect(files.get(LOG)).not.toContain('"due":"tomorrow"')
  await nu.input({ key: 'due', text: '' })
  expect(files.get(LOG)).toContain('"due":""')
  await expectNoEmoji(nu)
  await nu.unmount()
})

// WB-15: the person starting a ticket on the board readies a new session for it; Claude's moves never do.
test('the status Select 待开工 → 进行中 asks Claude to spawn a session; other moves do not', async ($: any, on: any) => {
  const prompts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: '[T-42] 登录页面', col: 'todo' }) // SVC-1
  const ui = await $.ui.mount(PANE('desktop', 140))
  await ui.press({ key: 'fold-todo' })
  await openRow(ui, 'SVC-1')
  await ui.select({ key: 'peek-status', value: 'doing' })
  expect(files.get(LOG)).toContain('"col":"doing","text":"你手动移动"')
  expect(prompts.filter(p => p.includes('mcp__ccd_session__spawn_task')).length).toBe(1)
  expect(prompts.at(-1)).toContain('认领 SVC-1')
  await openRow(ui, 'SVC-1')
  await ui.select({ key: 'peek-status', value: 'follow' }) // 进行中 → 待跟进: no spawn
  expect(prompts.filter(p => p.includes('spawn_task')).length).toBe(1)
  await ui.unmount()
  // Claude claiming a todo ticket moves it to doing without spawning
  await call($)({ action: 'create', title: 'other', col: 'todo' }) // SVC-2
  await call($)({ action: 'update', key: 'SVC-2', work: true })
  expect(files.get(LOG)).toContain('"key":"SVC-2","col":"doing","text":"认领"')
  expect(prompts.filter(p => p.includes('spawn_task')).length).toBe(1)
})

test('a comment by the person wakes the session that owns the ticket, once', async ($: any, on: any) => {
  const prompts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  // the web app writes the person's comment into its own log
  files.set(`${DATA}/events/web.jsonl`,
    JSON.stringify({ t: Date.now() + 1, sid: 'web', k: 'comment', key: 'SVC-1', by: 'me', text: '先别合，等 Ian' }) + '\n')
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'update', key: 'SVC-1', note: 'x' }) // refreshes the board
  expect(prompts.filter(p => p.includes('留了评论')).length).toBe(0) // never from inside a tool call
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  const woke = prompts.filter(p => p.includes('[cc-taskboard] 用户在看板上给你负责的 ticket 留了评论'))
  expect(woke.length).toBe(1)
  expect(woke[0]).toContain('SVC-1「[T-42] 登录页面」：先别合，等 Ian')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  expect(prompts.filter(p => p.includes('留了评论')).length).toBe(1) // handled once
  expect(files.get(`${DATA}/sessions/sess-1.json`)).toContain('"wokeUntil"')
})

// WB-20: the web board has no Claude behind it; the owning session readies the new session instead.
test('a web move 待开工 → 进行中 has the owning session spawn, once; other web moves do not', async ($: any, on: any) => {
  const prompts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面', col: 'todo' }) // SVC-1
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: 'other', col: 'doing' }) // SVC-2
  const WEB = `${DATA}/events/web.jsonl`
  const web = (...evs: any[]) => files.set(WEB, (files.get(WEB) ?? '') + evs.map(e => JSON.stringify({ sid: 'web', k: 'move', text: '你拖拽移动', ...e }) + '\n').join(''))
  web({ t: Date.now() + 1, key: 'SVC-1', col: 'doing' }, { t: Date.now() + 2, key: 'SVC-2', col: 'follow' })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'update', key: 'SVC-1', note: 'x' }) // refreshes the board
  const spawns = () => prompts.filter(p => p.includes('mcp__ccd_session__spawn_task'))
  expect(spawns().length).toBe(0) // never from inside a tool call
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(spawns().length).toBe(1)
  expect(spawns()[0]).toContain('认领 SVC-1')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  expect(spawns().length).toBe(1) // handled once
  web({ t: Date.now() + 3, key: 'SVC-2', col: 'doing' }) // follow → doing is not a start
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'update', key: 'SVC-1', note: 'y' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3' })
  expect(spawns().length).toBe(1)
  expect(files.get(`${DATA}/sessions/sess-1.json`)).toContain('"webUntil"')
})

// The other way round: in zh no English UI word is left. Allowed: the EN toggle, names (Claude, PR, the SVC / Infra project names), keys, codes, P0-P3, Wnn, the session's folder name.
test('zh mode shows no English UI text', async ($: any, on: any) => {
  const left = async (ui: any) => shownText(await drawnOf(ui)).join(' | ')
    .replace(/\bEN\b|\bClaude\b|\bPR\b|\bSVC\b|\bME\b|\bInfra\b|[A-Z]+-\d+|\bP[0-3]\b|\bW\d+\b|web-app|YYYY-MM-DD|https?:\S+/g, '').match(/[A-Za-z]{2,}/g) ?? []
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: '[T-42] 登录页面', title_en: '[T-42] login page', priority: 'P1', desc: '去掉标记', desc_en: 'drop the marker', comment: '迁移已跑', labels: ['缺陷'], due: '2099-01-01' })
  await call($)({ action: 'create', title: '周看板插件', title_en: 'task board mod', project: 'ME', col: 'decide', src: 'me', note: '计划' })
  await call($)({ action: 'update', key: 'ME-1', col: 'canceled', comment: '不需要了' }) // a proposal (WB-28)
  await call($)({ action: 'update', key: 'SVC-1', col: 'review', blockedBy: ['ME-1'] })
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    expect(await left(ui)).toEqual([])
    await ui.press({ key: 'tab-feed' })
    expect(await left(ui)).toEqual([])
    await ui.press({ key: 'tab-board' })
    await openRow(ui, 'SVC-1')
    expect(await left(ui)).toEqual([]) // the preview
    await ui.press({ key: 'peek-open' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(JSON.stringify(await drawnOf(ui))).toContain('去掉标记')
    expect(await left(ui)).toEqual([]) // the detail
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

// Bilingual tickets: the tool names the missing side; the person's one-language edit is clear in the next prompt's context.
test('bilingual title / desc: tool asks for the other language, the pane shows the right side, person edits nudge Claude', async ($: any, on: any) => {
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const one = await call($)({ action: 'create', title: '登录页面', desc: '去掉标记' })
  expect(String(one.result)).toContain('缺 title_en、desc_en')
  expect(String((await call($)({ action: 'list' })).result)).toContain('登录页面（缺双语）')
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('SVC-1「登录页面」缺 title_en、desc_en')
  const both = await call($)({ action: 'update', key: 'SVC-1', title_en: 'login page', desc_en: 'drop the marker' })
  expect(String(both.result)).not.toContain('缺')
  // polishing one side of a pair whose other side is there is fine
  expect(String((await call($)({ action: 'update', key: 'SVC-1', title_en: 'login page' })).result)).not.toContain('缺')
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).not.toContain('缺 ')
  const ui = await $.ui.mount(PANE('desktop', 60))
  expect((await rowOf(ui, 'SVC-1'))?.label).toBe('登录页面')
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ type: 'Text', text: /^登录页面$/ })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'lang' })
  expect((await rowOf(ui, 'SVC-1'))?.label).toBe('login page')
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ type: 'Text', text: /^login page$/ })).toBeDefined()
  expect(JSON.stringify(await drawnOf(ui))).toContain('drop the marker')
  // the person rewrites the description: one language, the stale English goes, Claude is told
  await ui.input({ key: 'desc', text: 'keep the marker' })
  expect(files.get(LOG)).toContain('"desc":"keep the marker","desc_en":""')
  expect(JSON.stringify(await drawnOf(ui))).toContain('keep the marker') // en falls back to the only side
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('SVC-1「登录页面」缺 desc_en')
  await ui.press({ key: 'back' })
  await ui.press({ key: 'lang' })
  await ui.unmount()
})

// A desktop board: SVC-1 in 进行中 and live (its session is busy), SVC-2 in 待审核, SVC-3 done and accepted.
const TINT = { light: '#f4f3ef', dark: '#262624' }
const LIVE_COLOR = '#3f9a6b'
async function striped($: any, on: any, cols: number, mode = 'light') {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const run = (_$: any, e: any) => ({
    value: {
      exitCode: e.argv[0] === 'defaults' ? 1 : 0, stderr: '',
      stdout: e.argv.join(' ').startsWith('claude agents') ? JSON.stringify([{ sessionId: 'sess-1', name: 'work', status: 'busy' }]) : '',
    },
  })
  const files = memfs(on, { run })
  files.set(CFG, JSON.stringify({ userThemeMode: mode }))
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: '进行中的', title_en: 'busy one', col: 'doing', work: true }) // SVC-1
  await call($)({ action: 'update', key: 'SVC-1', work: true })
  await call($)({ action: 'create', title: '待审核的', title_en: 'review one', col: 'review' }) // SVC-2
  await call($)({ action: 'create', title: '做完的', title_en: 'finished one', col: 'done', userAccepted: true }) // SVC-3
  await call($)({ action: 'update', key: 'SVC-1', work: true })
  await $.prompt.submit({ text: 'go', wait: false })
  return $.ui.mount(PANE('desktop', cols))
}

// Done is folded until its fold Button is pressed, at both widths; a live row says so in the live color.
for (const cols of [140, 60]) {
  test(`done folded by default, the fold Button opens and closes it; live marker (${cols})`, async ($: any, on: any) => {
    const ui = await striped($, on, cols)
    const done = () => rowOf(ui, 'SVC-3')
    expect(await done()).toBeUndefined()
    expect((await ui.find({ key: 'fold-done' }))?.props.label).toBe('已完成 1 ›')
    await ui.press({ key: 'fold-done' })
    expect((await done())?.label).toBe('做完的')
    expect((await ui.find({ key: 'fold-done' }))?.props.label).toBe('已完成 1 ⌄')
    await ui.press({ key: 'fold-done' })
    expect(await done()).toBeUndefined()
    const live = nodes(await byKey(ui, 'row-SVC-1'), n => n.type === 'Text' && n.props?.color === LIVE_COLOR)
    expect(live.map(n => n.children.join(''))).toEqual(['在做'])
    expect(nodes(await byKey(ui, 'row-SVC-2'), n => n.type === 'Text' && n.props?.color === LIVE_COLOR)).toEqual([])
    await expectNoEmoji(ui)
    await ui.unmount()
  })
}

// With done expanded: en mode has no Han, no glyph-repeated rule, no emoji, at both widths.
test('done expanded: no Chinese in en, no rules, no emoji', async ($: any, on: any) => {
  const ui0 = await striped($, on, 140)
  await ui0.unmount()
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    await ui.press({ key: 'fold-done' })
    expect(await ui.find({ key: 'open-SVC-3' })).toBeDefined()
    await ui.press({ key: 'lang' })
    expect((await rowOf(ui, 'SVC-3'))?.label).toBe('finished one')
    await noHan(ui)
    await noRule(ui)
    await expectNoEmoji(ui)
    await ui.press({ key: 'lang' })
    await ui.press({ key: 'fold-done' }) // folded again for the next width
    await ui.unmount()
  }
})

// The row tint (hover, the open inline preview) follows the app's theme.
for (const [mode, own, other] of [['light', TINT.light, TINT.dark], ['dark', TINT.dark, TINT.light]] as const) {
  test(`row tint follows the theme (${mode})`, async ($: any, on: any) => {
    const ui = await striped($, on, 140, mode)
    const tree = async () => JSON.stringify(await drawnOf(ui))
    expect(await tree()).toContain(own)
    expect(await tree()).not.toContain(other)
    await ui.unmount()
  })
}

// The header: plain text buttons on every surface; ALL first; the active project tab is a bold underlined Text; the decide count follows its tab.
for (const surface of ['desktop', 'mobile'] as const) {
  test(`header on ${surface}: plain text buttons, ALL first, the active tab underlined`, async ($: any, on: any) => {
    const files: any = await seed($, on, surface)
    const ui = await $.ui.mount(PANE(surface, 140))
    const buttons = async (prefix: string) => nodes(await drawnOf(ui), n => n.type === 'Button' && String(n.props?.key).startsWith(prefix))
    expect((await buttons('p-')).map(b => b.props.key)).toEqual(['p-SVC', 'p-WB', 'p-INF', 'p-ME']) // ALL is the active tab at the start: a Text
    expect(nodes(await drawnOf(ui), n => n.type === 'Box' && /^pj-/.test(n.props?.key ?? '')).map(n => n.props.key)).toEqual(['pj-ALL', 'pj-SVC', 'pj-WB', 'pj-INF', 'pj-ME'])
    for (const k of ['p-', 'qf-', 'tab-', 'lang', 'legend-', 'fold-', 'open-']) for (const b of await buttons(k)) {
      expect(b.props.plain).toBe(true)
      expect(b.props.variant).toBeUndefined()
    }
    const underlined = async () => nodes(await drawnOf(ui), n => n.type === 'Text' && n.props?.underline).map(n => [n.children.join(''), n.props.bold, n.props.color])
    expect(await underlined()).toEqual([['全部', true, '#1f2a44']])
    expect(nodes(await byKey(ui, 'pj-ME'), n => n.type === 'Text' && n.props?.color === '#d9777a').map(n => n.children.join(''))).toEqual(['1'])
    await ui.press({ key: 'p-SVC' })
    expect(await underlined()).toEqual([['SVC 重写', true, '#1f2a44']])
    expect(await ui.find({ key: 'p-ALL' })).toBeDefined()
    // every key still works
    for (const key of ['qf-me', 'qf-me', 'qf-live', 'qf-live', 'tab-feed', 'tab-board', 'p-ALL', 'lang', 'lang']) await ui.press({ key })
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(Boolean(await ui.find({ key: 'search' }))).toBe(surface !== 'mobile') // mobile has no Input
    await ui.press({ key: 'qf-me' }) // only tickets waiting on me: ME-1 (decide) stays, SVC-1 goes
    expect(await ui.find({ key: 'open-ME-1' })).toBeDefined()
    expect(await ui.find({ key: 'open-SVC-1' })).toBeUndefined()
    await ui.press({ key: 'qf-me' })
    // mobile has no Select either: the preview falls back to the move / priority Button rows
    await openRow(ui, 'SVC-1')
    if (surface === 'mobile') {
      expect(await ui.find({ key: 'peek-status' })).toBeUndefined()
      await ui.press({ key: 'peek-pri-P1' })
      expect(files.get(LOG)).toContain('"priority":"P1"')
      await ui.press({ key: 'peek-mv-review' })
      expect(files.get(LOG)).toContain('"key":"SVC-1","col":"review","text":"你手动移动"')
      expect(await ui.find({ key: 'peek-pop' })).toBeUndefined()
    } else expect(await ui.find({ key: 'peek-mv-review' })).toBeUndefined()
    await expectNoEmoji(ui)
    await ui.unmount()
  })
}

// Desktop: the board title is a Markdown heading (the one element the desktop draws larger). Terminal: a bold Text title.
for (const [surface, big] of [['desktop', true], ['terminal', false]] as const) {
  test(`board title on ${surface}: ${big ? 'Markdown heading' : 'bold Text'}`, async ($: any, on: any) => {
    await seed($, on, surface)
    const ui = await $.ui.mount(PANE(surface, 60))
    const tree = JSON.stringify(await drawnOf(ui))
    if (big) expect(tree).toContain('"## 全部项目 看板 · W')
    else {
      expect(tree).not.toContain('"## ')
      expect(nodes(await drawnOf(ui), n => n.type === 'Text' && n.props?.bold && n.children?.[0] === '全部项目 看板').length).toBe(1)
    }
    await ui.unmount()
  })
}

// WB-28: canceling is the person's call. Claude only proposes (decide + a reason); the person confirms or keeps it on the board,
// cancels any ticket, and restores a canceled one to where it was.
test('WB-28: Claude cancel lands in decide with a reason; the person keeps, confirms, cancels, restores; userAccepted passes', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const c = async (x: any) => String((await call($)(x)).result)
  const log = () => files.get(LOG) as string
  await c({ action: 'create', title: 'A', col: 'follow' }) // SVC-1
  await c({ action: 'create', title: 'B', col: 'todo' }) // SVC-2
  // no reason: refused, nothing moves
  expect(await c({ action: 'update', key: 'SVC-1', col: 'canceled' })).toContain('没改')
  expect(log()).not.toContain('"col":"decide"')
  // with one: a proposal in 等我拍板, never canceled
  expect(await c({ action: 'update', key: 'SVC-1', col: 'canceled', comment: '需求撤了' })).toContain('已提议取消，等用户在看板确认')
  expect(log()).toContain('"key":"SVC-1","col":"decide","text":"Claude 建议取消"')
  expect(log()).toContain('"proposeCancel":{"reason":"需求撤了","from":"follow"}')
  expect(log()).not.toContain('"col":"canceled"')

  // the proposed row says so; its preview offers 确认取消 / 保留; 保留 sends it back to 待跟进
  const ui = await $.ui.mount(PANE('desktop', 140))
  expect((await findText(ui, '建议取消'))?.props.color).toBe('#d9777a')
  await openRow(ui, 'SVC-1')
  expect((await ui.find({ key: 'peek-confirm' }))?.props.label).toBe('确认取消')
  await ui.press({ key: 'peek-keep' })
  expect(log()).toContain('"key":"SVC-1","col":"follow","text":"你保留"')
  expect(await ui.find({ key: 'peek-confirm' })).toBeUndefined() // the move cleared the proposal; the preview stays on its new state
  expect(await ui.find({ type: 'Text', text: '建议取消' })).toBeUndefined()
  // proposed again (note as the reason); 确认取消 cancels with Claude's reason
  await c({ action: 'update', key: 'SVC-1', col: 'canceled', note: '重复了' })
  await ui.press({ key: 'peek-confirm' })
  expect(log()).toContain('"key":"SVC-1","col":"canceled","by":"me","text":"重复了"')
  // canceled folds like done: the fold Button, no row until opened
  expect(await ui.find({ key: 'open-SVC-1' })).toBeUndefined()
  await ui.press({ key: 'fold-canceled' })
  expect(await ui.find({ key: 'open-SVC-1' })).toBeDefined()
  // its preview, still open under the row: 恢复 sends it back to the column it left before the proposal
  await ui.press({ key: 'peek-restore' })
  expect(log()).toContain('"key":"SVC-1","col":"follow","text":"你恢复"')
  // the feed says who canceled what, and why
  await ui.press({ key: 'tab-feed' })
  expect(await ui.find({ type: 'Text', text: /你取消了「A」：重复了/ })).toBeDefined()
  await ui.press({ key: 'tab-board' })
  // any ticket: the preview's 取消工单 (no reason), then the detail's reason box, then 恢复
  await ui.press({ key: 'fold-todo' })
  await openRow(ui, 'SVC-2')
  await ui.press({ key: 'peek-cancel' })
  expect(log()).toContain('"key":"SVC-2","col":"canceled","by":"me","text":""')
  await ui.press({ key: 'peek-restore' }) // the preview stays open on the ticket's new state
  const restored = () => log().split('\n').filter(l => l.includes('"key":"SVC-2","col":"todo","text":"你恢复"')).length
  expect(restored()).toBe(1)
  await ui.press({ key: 'peek-open' })
  await ui.input({ key: 'cancel-reason', text: ' 不做了 ' })
  expect(log()).toContain('"key":"SVC-2","col":"canceled","by":"me","text":"不做了"')
  await ui.press({ key: 'restore' })
  expect(restored()).toBe(2)
  await expectNoEmoji(ui)
  await ui.unmount()

  // the person said so in chat: userAccepted cancels at once, with the reason
  expect(await c({ action: 'update', key: 'SVC-2', col: 'canceled', userAccepted: true, comment: '用户说不做了' })).not.toContain('已提议取消')
  expect(log()).toContain('"key":"SVC-2","col":"canceled","by":"me","text":"用户说不做了"')
})

test('WB-28: the narrow inline preview and the detail confirm / keep a proposal', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await call($)({ action: 'create', title: 'A', col: 'doing' }) // SVC-1
  await call($)({ action: 'update', key: 'SVC-1', col: 'canceled', comment: 'dup' })
  const ui = await $.ui.mount(PANE('desktop', 60))
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-keep' })
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"doing","text":"你保留"')
  await call($)({ action: 'update', key: 'SVC-1', col: 'canceled', comment: 'dup' })
  expect(await ui.find({ key: 'peek-confirm' })).toBeDefined() // still open, now under its row in 等我拍板
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ type: 'Text', text: /Claude 建议取消：dup/ })).toBeDefined()
  await ui.press({ key: 'confirm-cancel' })
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"canceled","by":"me","text":"dup"')
  expect(await ui.find({ key: 'restore' })).toBeDefined()
  await ui.unmount()
})

for (const cols of [140, 60]) {
  test(`WB-28: the status Select into 已取消 cancels with no reason and shows it (${cols})`, async ($: any, on: any) => {
    on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
    const files: any = memfs(on)
    await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
    await call($)({ action: 'create', title: 'A', col: 'follow' }) // SVC-1
    const ui = await $.ui.mount(PANE('desktop', cols))
    await openRow(ui, 'SVC-1')
    await ui.select({ key: 'peek-status', value: 'canceled' })
    expect(files.get(LOG)).toContain('"key":"SVC-1","col":"canceled","by":"me","text":""')
    expect(await ui.find({ key: 'pv-SVC-1' })).toBeUndefined()
    expect(await sections(ui)).toEqual(['sec-canceled']) // opened below the fold row, where it now is
    await ui.unmount()
  })
}

test('WB-28: a search finds canceled tickets archived in earlier weeks, and 恢复 brings one back', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  const t = weekStartOf(Date.now()) - 10 * 86_400_000
  files.set(`${DATA}/events/old.jsonl`, [
    { t, sid: 'old', k: 'create', key: 'SVC-1', project: 'SVC', title: '旧需求', col: 'doing', src: 'me' },
    { t: t + 1, sid: 'old', k: 'move', key: 'SVC-1', col: 'canceled', by: 'me', text: '没人要' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(PANE('desktop', 140))
  expect(await ui.find({ key: 'open-SVC-1' })).toBeUndefined() // archived: off the board
  await ui.input({ key: 'search', text: 'SVC-1', kind: 'change' })
  expect((await rowOf(ui, 'SVC-1'))?.label).toBe('旧需求') // the search opens 已取消
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-restore' })
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"doing","text":"你恢复"')
  await ui.unmount()
})

// WB-30: 跳到 session opens the ticket's newest other session through the app's own link; archived or unknown ones are skipped.
test('preview: go to session opens claude://claude.ai/epitaxy/<local id>, skipping archived ones', async ($: any, on: any) => {
  const opened: string[][] = []
  const files = memfs(on, { run: (_$: any, e: any) => (e.argv[0] === 'open' && opened.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }) })
  const SESS = `${HOME}/Library/Application Support/Claude/claude-code-sessions/o/u`
  const t = Date.now() - 3_600_000
  files.set(`${DATA}/events/old.jsonl`, `${JSON.stringify({ k: 'create', key: 'SVC-1', project: 'SVC', title: '[T-42] 登录页面', col: 'doing', src: 'claude', t, sid: 'old' })}\n`)
  files.set(`${SESS}/local_old-1.json`, JSON.stringify({ cliSessionId: 'old', title: '登录页面' }))
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-43] 本会话的票' }) // SVC-2: only this session
  for (const cols of [60, 140]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    await openRow(ui, 'SVC-2')
    expect(await ui.find({ key: 'peek-jump' })).toBeUndefined() // nowhere else to go
    await openRow(ui, 'SVC-1')
    await ui.press({ key: 'peek-jump' })
    expect(opened.at(-1)).toEqual(['open', 'claude://claude.ai/epitaxy/local_old-1'])
    await openRow(ui, 'SVC-1') // fold it: the view outlives the mount
    await ui.unmount()
  }
  // archived in the app: nothing opens (a toast says so)
  files.set(`${SESS}/local_old-1.json`, JSON.stringify({ cliSessionId: 'old', title: '登录页面', isArchived: true }))
  const n = opened.length
  const ui = await $.ui.mount(PANE('desktop', 140))
  await openRow(ui, 'SVC-1')
  await ui.press({ key: 'peek-jump' })
  expect(opened.length).toBe(n)
  await ui.unmount()
})


// WB-36: a click anywhere on a row opens its preview, and folds it again: the key, the title, the right-hand side.
test('a click anywhere on a row opens its preview; a right click does nothing', async ($: any, on: any) => {
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 140))
  expect((await ui.find({ key: 'open-SVC-1' }))?.type).toBe('Client')
  const click = (x: number, button = 'left') => ui.pointer({ type: 'down', x, y: 0, button, in: 'open-SVC-1' })
  await click(120, 'right')
  expect(await byKey(ui, 'pv-SVC-1')).toBeUndefined()
  for (const x of [0, 30, 120]) {
    await click(x)
    expect(await byKey(ui, 'pv-SVC-1')).toBeDefined()
    await click(x)
    expect(await byKey(ui, 'pv-SVC-1')).toBeUndefined()
  }
  await ui.unmount()
})

// WB-40: no board yet, the first prompt has Claude offer the init wizard, later ones only on request; no deno, the first prompt offers to install it.
test('first prompt offers init and a deno install, later prompts do not nag', async ($: any, on: any) => {
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  const files = memfs(on, { noDeno: true })
  files.delete(`${DATA}/projects.json`)
  await $.session.start({ cwd: '/Users/x/app', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi', wait: false })
  expect(contexts.at(-1)).toContain('主动问用户要不要现在初始化')
  expect(contexts.at(-1)).toContain('brew install deno')
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('用户要建票或说初始化时')
  expect(contexts.at(-1)).not.toContain('deno')
})

test('deno found: no install offer', async ($: any, on: any) => {
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi', wait: false })
  expect(contexts.at(-1)).not.toContain('deno')
})

// WB-41: the app may start the new session with no folder: a scratch cwd, a system-reminder ahead of the claim line.
test('a claim from a no-folder session still titles it and joins the ticket board', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('classic.UserPromptSubmit', () => ({}))
  const files: any = memfs(on)
  files.set(`${DATA}/events/other.jsonl`, JSON.stringify({ k: 'create', key: 'SVC-1', project: 'SVC', title: '登录页面', title_en: 'Login page', col: 'todo', src: 'me', t: 1, sid: 'other' }) + '\n')
  await $.session.start({ cwd: `${HOME}/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-x`, surface: null, isInteractive: false })
  await $.prompt.submit({ text: '<system-reminder>\nscratch workspace\n</system-reminder>\n认领 SVC-1:先调用 mcp__cc-taskboard__ticket action:update key:SVC-1 work:true', wait: false })
  // The ticket's other session sits in the board's sidebar group: the claim answer opens with filing this one beside it.
  files.set(`${DATA}/sessions/other.json`, JSON.stringify({ sid: 'other', cwd: `${HOME}/web-app`, name: 'web-app', project: 'SVC', seen: Date.now(), state: 'idle', app: 'local_peer' }))
  // The new-session screen can start it in manual: the first step switches it to auto.
  await $.classic.UserPromptSubmit({ prompt: '认领 SVC-1', permission_mode: 'default' })
  const claimed = String((await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'update', key: 'SVC-1', work: true })).result)
  expect(claimed).toMatch(/^已更新 SVC-1，设为本 session 当前 ticket\n先做完这几步再干别的：\n1\. 本会话现在是 default 模式.*set_session_permission_mode.*"auto"/)
  expect(claimed).toMatch(/\n2\. 归侧边栏分组：.*local_peer.*mcp__ccd_sidebar__move_sessions/)
  expect(claimed.indexOf('move_sessions')).toBeLessThan(claimed.indexOf('描述：'))
  expect(JSON.parse(files.get(`${DATA}/sessions/sess-1.json`)).project).toBe('SVC')
  expect((await $.classic.UserPromptSubmit({ prompt: 'go' })).sessionTitle).toMatch(/ - in progress】SVC-1 登录页面$/)
})
