import { expect, test } from 'claude-code/testing'

import { CARD_H, GRID_CARD_W, HEAD_H, boardHeight, cardHeight, cardRows, columnLayout, dropBarY, gridLayout, peekGeo, peekRect, proposeHits } from './board-client'
// A card with a short title: the board heights below are made of these (2 rows: 1 title row, meta) unless a test says otherwise.
const SHORT = cardHeight({}, 20)
import { LEGACY_DATA_DIR, colOf, weekStartOf } from './core.ts'
import { headerLayout } from './header-client'

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
function memfs(on: any, opts: { env?: Record<string, string>; run?: (_$: any, e: any) => unknown } = {}) {
  const files = new Map<string, string>()
  files.set(`${DATA}/projects.json`, JSON.stringify(BOARDS))
  const ok = (value?: unknown) => ({ value })
  const env: Record<string, string> = { HOME, ...opts.env }
  on('env.get', (_$: any, e: any) => ok(env[e.name]))
  // Nothing runs for real: ensureWeb's shell line must never start a server on live data.
  on('process.run', (_$: any, e: any) => (e.argv[0] !== '/bin/sh' && opts.run ? opts.run(_$, e) : ok({ exitCode: e.argv[0] === '/bin/sh' ? 0 : 1, stdout: '', stderr: '' })))
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
// Flat style: no emoji anywhere the pane draws, the drag board included.
const EMOJI = /[\p{Extended_Pictographic}]/u
async function expectNoEmoji(ui: any, scopes: string[] = []) {
  for (const tree of [await ui.drawn(), ...(await Promise.all(scopes.map(k => ui.drawn({ in: k }))))]) {
    const hit = JSON.stringify(tree).match(EMOJI)
    expect(hit?.[0] ?? null).toBeNull()
  }
}
const PANE = (surface: any, bodyColumns: number) => ({
  plugin: 'cc-taskboard', surface, component: 'Pane' as const, requestId: 'cc-taskboard',
  props: { title: '周看板', isFocused: true, bodyColumns, placement: 'dock' } as any,
})
// Popup geometry at a pane width, from the exported constants: where a click lands on a popup row (1-based inside the border).
// Wide (> 100 cols): six columns; narrower: the fixed-card grid, whose region is the pane minus 4 and whose popup keeps 2 cells free beside it.
const region = (cols: number) => { const w = Math.floor((cols - 4) / 6); return cols > 100 ? 6 * w + 5 : cols - 4 }
const margin = (cols: number) => (cols > 100 ? 4 : 2)
// rows = the board's own height (HEAD_H + one short card per column); the popup grows with it.
const popupAt = (cols: number, row: number, rows = HEAD_H + SHORT) => { const r = peekRect(region(cols), rows, margin(cols)); return { x: r.left + Math.floor(r.w / 2), y: r.top + row } }
// The 打开详情 / Open details button cell.
// rows: the board's height, HEAD_H + one short card wide (one card per column), 1 + one short card in the grid (one section with one card).
const btnAt = (cols: number, label = '打开详情', rows = cols > 100 ? HEAD_H + SHORT : 1 + SHORT) => { const g = peekGeo(region(cols), rows, label, margin(cols)); return { x: g.left + g.btn.x0 + 1, y: g.top + g.btn.y } }
const click = async (ui: any, x: number, y: number, lane = 'board-SVC') => {
  await ui.pointer({ type: 'down', x, y, button: 'left', in: lane })
  await ui.pointer({ type: 'up', x, y, button: 'left', in: lane })
}
// A lane's only card in the grid: its section header is row 0, the card starts on row 1.
// The header Client (WB-23): a hit area from its own props, and a click on it.
const hdrHit = async (ui: any, kind: string, id?: string) => {
  const c = await ui.find({ key: 'header' })
  return c ? headerLayout(c.props.props, c.props.width as number).hits.find(h => h.kind === kind && (id === undefined || h.id === id)) : undefined
}
const hdr = async (ui: any, kind: string, id?: string) => {
  const h = await hdrHit(ui, kind, id)
  if (!h) throw new Error(`no header ${kind} ${id ?? ''}`)
  await click(ui, h.x0, h.y, 'header')
}
const only = (ui: any, lane = 'board-SVC') => click(ui, 3, 2, lane)
const openBtn = (ui: any, cols: number, label = '打开详情', lane = 'board-SVC') => click(ui, btnAt(cols, label).x, btnAt(cols, label).y, lane)
async function seed($: any, on: any, surface: string) {
  const files = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface, isInteractive: true })
  const made = await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  expect(String(made.result)).toContain('SVC-1')
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: 'cc-taskboard mod ✅', project: 'ME', col: 'decide', src: 'me', note: '⏳ 09-22 提出 · 📄 plan.md ⚠️' })
  return files
}

// Wide pane: the columns are a Client; drag SVC-1 from 进行中 (col 2) to 待跟进 (col 3), then click it open.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`drag a card to another column on ${surface}`, async ($: any, on: any) => {
    const files = await seed($, on, surface)
    const ui = await $.ui.mount(PANE(surface, 140))
    const colW = Math.floor((140 - 4) / 6)
    const at = (col: number) => col * (colW + 1) + 3
    expect(await ui.find({ type: 'Text', text: '[T-42]', in: 'board-SVC' })).toBeDefined()
    await expectNoEmoji(ui, ['board-SVC', 'board-ME'])
    await ui.pointer({ type: 'down', x: at(2), y: 3, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'move', x: at(3), y: 3, button: 'left', in: 'board-SVC' })
    expect(await ui.find({ type: 'Text', text: / 放到 待跟进 /, in: 'board-SVC' })).toBeDefined()
    await ui.pointer({ type: 'up', x: at(3), y: 3, button: 'left', in: 'board-SVC' })
    expect(files.get(LOG)).toContain('"col":"follow","text":"你拖拽移动"')
    // collapse / expand the SVC board
    await ui.press({ key: 'fold-SVC' })
    expect(await ui.find({ key: 'board-SVC' })).toBeUndefined()
    await ui.press({ key: 'fold-SVC' })
    // click without dragging previews it; the popup's open row opens the detail
    await click(ui, at(3), 3)
    expect(await ui.find({ type: 'Text', text: /打开详情/, in: 'board-SVC' })).toBeDefined()
    await click(ui, btnAt(140).x, btnAt(140).y)
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.unmount()
  })
}

// Narrow pane: a Client grid of fixed cards; the detail's buttons talk to the session.
test('narrow desktop pane: open, move, hand to Claude, feed', async ($: any, on: any) => {
  const prompts: string[] = []
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 60))
  expect(await ui.find({ type: 'Text', text: '[T-42]', in: 'board-SVC' })).toBeDefined()
  await hdr(ui, 'proj', 'SVC')
  expect(await ui.find({ key: 'board-ME' })).toBeUndefined()
  await only(ui)
  await openBtn(ui, 60)
  expect(await ui.find({ key: 'ask-owner' })).toBeUndefined() // no other live session worked it
  await expectNoEmoji(ui)
  await ui.press({ key: 'go-here' })
  expect(prompts.at(-1)).toContain('继续做 SVC-1')
  await ui.select({ key: 'status', value: 'follow' })
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('用户刚在看板上调整了本 session 做过的 ticket：SVC-1 → 待跟进')
  await ui.press({ key: 'back' })
  await hdr(ui, 'seg', 'feed')
  expect(await ui.find({ type: 'Text', text: /待跟进/ })).toBeDefined()
  await expectNoEmoji(ui)
  await hdr(ui, 'proj', 'ME')
  await hdr(ui, 'seg', 'board')
  await only(ui, 'board-ME')
  await expectNoEmoji(ui, ['board-ME']) // with the preview open
  await openBtn(ui, 60, '打开详情', 'board-ME')
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
test('Claude can only reach 待审核; the person accepts; desc/priority/comments; spawn asks Claude', async ($: any, on: any) => {
  const prompts: string[] = []
  const contexts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), contexts.push((e.context ?? []).join('\n')), { text: e.text }))
  const run = (_$: any, e: any) => {
    const a = e.argv.join(' ')
    const out = a.includes('--abbrev-ref') ? 'feat/t42\n' : a.includes('--show-toplevel') ? `${HOME}/web-app/.claude/worktrees/t42\n`
      : a.startsWith('claude agents') ? JSON.stringify([{ sessionId: 'sess-1', name: 'T-42 登录页面', status: 'busy' }]) : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  }
  const files: any = memfs(on, { run })
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: '[T-42] 登录页面', priority: 'P1', desc: '## 目标\n去掉 CAS 里的 `@@`' })
  expect(files.get(LOG)).toContain('"branch":"feat/t42"')
  expect(files.get(LOG)).toContain(`"worktree":"${HOME}/web-app/.claude/worktrees/t42"`)
  const done = await call({ action: 'update', key: 'SVC-1', col: 'done', comment: '迁移已跑' })
  expect(String(done.result)).toContain('待审核')
  expect(files.get(LOG)).not.toContain('"col":"done"')

  const ui = await $.ui.mount(PANE('desktop', 60))
  await only(ui)
  await openBtn(ui, 60)
  expect(await ui.find({ type: 'Text', text: 'T-42 登录页面' })).toBeDefined() // real session title from claude agents
  expect(await ui.find({ type: 'Text', text: /迁移已跑/ })).toBeDefined()
  await ui.select({ key: 'priority', value: 'P0' })
  expect(files.get(LOG)).toContain('"priority":"P0"')
  await ui.input({ key: 'comment', text: '先别合，等 Ian' })
  expect(files.get(LOG)).toContain('"k":"comment","key":"SVC-1","by":"me","text":"先别合，等 Ian"')
  await ui.press({ key: 'spawn' })
  expect(prompts.at(-1)).toContain('mcp__ccd_session__spawn_task')
  expect(prompts.at(-1)).toContain('认领 SVC-1')
  expect(prompts.at(-1)).toContain(`${HOME}/web-app`)
  // the person's comment reaches this session's next prompt (the plugin's own submit skips its own hook)
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
  expect(String(moved.result)).toMatch(/set_session_title[\s\S]*session_id: local_x  title: 【[A-Z][a-z]{2} \d{1,2} - review】SVC-1 登录页面$/)
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
  const HAN = /\p{Script=Han}/u
  // the toggle's own label is 中文, so strip it before looking for leftovers
  const noHan = async (ui: any, scopes: string[] = []) => {
    for (const tree of [await ui.drawn(), ...(await Promise.all(scopes.map(k => ui.drawn({ in: k }))))]) {
      expect(JSON.stringify(tree).replaceAll('中文', '').match(HAN)?.[0] ?? null).toBeNull()
    }
  }
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: '[main 3e7a9b1] fix markers' }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: '[T-42] 登录页面', title_en: '[T-42] login page', priority: 'P1', desc: '去掉标记', desc_en: 'drop the marker', comment: 'migration ran' })
  await call({ action: 'create', title: '周看板插件', title_en: 'task board mod', project: 'ME', col: 'decide', src: 'me', note: 'plan.md' })
  await call({ action: 'update', key: 'ME-1', col: 'canceled', comment: 'not needed' }) // a proposal: its card carries the two words (WB-28)
  await call({ action: 'update', key: 'SVC-1', col: 'review' })
  // the activity also carries a commit
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  for (const [cols, scopes] of [[140, ['header', 'board-SVC', 'board-ME']], [60, ['header', 'board-SVC', 'board-ME']]] as const) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    const inB = { in: 'board-SVC' } // the column headers live inside the board Client
    expect(await ui.find({ type: 'Text', text: /进行中|待审核/, ...inB })).toBeDefined()
    await hdr(ui, 'lang')
    expect(await hdrHit(ui, 'lang')).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /In review|In progress|Decision/i, ...inB })).toBeDefined()
    await noHan(ui, scopes)
    await hdr(ui, 'seg', 'feed')
    await noHan(ui, ['header'])
    await hdr(ui, 'seg', 'board')
    // open SVC-1 (in review): a click on its card
    await click(ui, cols > 100 ? 4 * (Math.floor((cols - 4) / 6) + 1) + 3 : 3, cols > 100 ? 3 : 2)
    expect(await ui.find({ type: 'Text', text: /Open details/, ...inB })).toBeDefined()
    for (const text of [/^Details$/, /^Description$/, /Created \d/, /drop the marker/]) expect(await ui.find({ type: 'Text', text, in: 'board-SVC' })).toBeDefined()
    await noHan(ui, scopes) // the preview is open: its strings are en too
    await openBtn(ui, cols, 'Open details')
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await noHan(ui)
    await ui.input({ key: 'comment', text: 'noted' })
    await ui.select({ key: 'status', value: cols > 100 ? 'doing' : 'review' }) // SVC-1 starts in review, then sits in doing
    await noHan(ui)
    await ui.press({ key: 'back' })
    await hdr(ui, 'lang')
    expect(await ui.find({ type: 'Text', text: /等我拍板|进行中|待审核/, ...inB })).toBeDefined() // back to zh, which the next mount starts from
    await ui.unmount()
  }
})

// Jira-style board: no line is drawn by repeating a glyph (the desktop's cell metric is not the font's, so such lines wrap).
test('no glyph-repeated rules', async ($: any, on: any) => {
  const RULE = /([─━═—-])\1{5,}/
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  await seed($, on, 'desktop')
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    const scopes = cols > 100 ? ['header', 'board-SVC', 'board-ME'] : ['header', 'board-SVC'] // the view is SVC from the second round on
    const check = async (inScopes: string[] = []) => {
      for (const tree of [await ui.drawn(), ...(await Promise.all(inScopes.map(k => ui.drawn({ in: k }))))]) {
        expect(JSON.stringify(tree).match(RULE)?.[0] ?? null).toBeNull()
      }
    }
    await check(scopes)
    await hdr(ui, 'seg', 'feed')
    await check(['header'])
    await hdr(ui, 'seg', 'board')
    await hdr(ui, 'proj', 'SVC')
    await check(['header', 'board-SVC'])
    const x = 2 * (Math.floor((cols - 4) / 6) + 1) + 3
    await click(ui, cols > 100 ? x : 3, cols > 100 ? 3 : 2)
    await check(['board-SVC']) // with the preview open
    await openBtn(ui, cols)
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await check()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('detail at 140 cols: Selects, move, card footer, search, quick filter', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files = await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 140))
  // card footer shows the key
  expect(await ui.find({ type: 'Text', text: 'SVC-1', in: 'board-SVC' })).toBeDefined()
  // search hides non-matching cards
  expect(await ui.find({ key: 'board-ME' })).toBeDefined()
  await hdr(ui, 'search')
  for (const key of 'T-42') await ui.key({ key, in: 'header' })
  expect(await ui.find({ key: 'board-SVC' })).toBeDefined()
  expect(await ui.find({ key: 'board-ME' })).toBeUndefined()
  for (const _ of 'T-42') await ui.key({ key: 'backspace', in: 'header' })
  await ui.key({ key: 'return', in: 'header' })
  expect(await ui.find({ key: 'board-ME' })).toBeDefined()
  // quick filter: only tickets waiting on me (col decide)
  await hdr(ui, 'filter', 'me')
  expect(await ui.find({ key: 'board-SVC' })).toBeUndefined()
  expect(await ui.find({ key: 'board-ME' })).toBeDefined()
  await hdr(ui, 'filter', 'me')
  // detail: both Selects, status pick writes a move
  const x = 2 * (Math.floor((140 - 4) / 6) + 1) + 3
  await click(ui, x, 3)
  await click(ui, btnAt(140).x, btnAt(140).y)
  expect(await ui.find({ key: 'status' })).toBeDefined()
  expect(await ui.find({ key: 'priority' })).toBeDefined()
  await ui.select({ key: 'status', value: 'follow' })
  expect(files.get(LOG)).toContain('"col":"follow","text":"你手动移动"')
  await ui.select({ key: 'priority', value: 'P1' })
  expect(files.get(LOG)).toContain('"priority":"P1"')
  await expectNoEmoji(ui)
  await ui.unmount()
})

// Click a card: a preview popup opens over the board; title / open row go to the detail, anywhere else closes it.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`peek popup over the wide board on ${surface}`, async ($: any, on: any) => {
    const files = await seed($, on, surface)
    const ui = await $.ui.mount(PANE(surface, 140))
    const colW = Math.floor((140 - 4) / 6)
    const card = 2 * (colW + 1) + 3
    const shown = () => ui.find({ type: 'Text', text: /打开详情/, in: 'board-SVC' })
    await click(ui, card, 3)
    expect(await shown()).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    // Jira layout: header breadcrumb, details panel, status lozenge, description, comments, footer
    for (const text of [/^详情$/, /优先级/, / 进行中 ▾ /, /^描述$/, /评论 0/, /创建 \d\d-\d\d/, /SVC 重写 \//]) {
      expect(await ui.find({ type: 'Text', text, in: 'board-SVC' })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /^标签$/, in: 'board-SVC' })).toBeUndefined() // empty fields are hidden
    // outside the popup closes it, just past its right edge too
    await click(ui, 1, 17)
    expect(await shown()).toBeUndefined()
    await click(ui, card, 3)
    const r = peekRect(region(140))
    await click(ui, r.left + r.w, r.top + 3)
    expect(await shown()).toBeUndefined()
    // the x closes it too
    await click(ui, card, 3)
    await click(ui, r.left + r.w - 3, r.top + 1)
    expect(await shown()).toBeUndefined()
    // an inside click that is not title / open button does nothing
    await click(ui, card, 3)
    await click(ui, popupAt(140, 6).x, popupAt(140, 6).y)
    expect(await shown()).toBeDefined()
    // no drag while it is open: down on a card, up in another column writes no move
    // (the popup covers the middle columns, so pile cards up in the first column, outside it, press the top one and release in the last column, also outside)
    for (const n of [1, 2, 3]) await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: `filler ${n}`, col: 'decide', src: 'me' })
    const before = files.get(LOG)
    await ui.pointer({ type: 'down', x: 3, y: 3, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'move', x: 120, y: 3, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'up', x: 120, y: 3, button: 'left', in: 'board-SVC' })
    expect(files.get(LOG)).toBe(before)
    expect(await shown()).toBeUndefined() // that press was outside the popup, so it only closed it
    // the open button goes to the detail (the board grew to 3 cards, so the popup did too)
    await click(ui, card, 3)
    await click(ui, btnAt(140, '打开详情', HEAD_H + 3 * SHORT + 2).x, btnAt(140, '打开详情', HEAD_H + 3 * SHORT + 2).y)
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await expectNoEmoji(ui)
    await ui.unmount()
  })
}

// Comment straight from the preview popup (WB-13): the same event as the detail's box, and the popup stays open.
for (const [cols, where] of [[140, 'wide board'], [60, 'narrow grid']] as const) {
  test(`comment from the peek popup: ${where}`, async ($: any, on: any) => {
    on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
    const files = await seed($, on, 'desktop')
    const ui = await $.ui.mount(PANE('desktop', cols))
    const inB = { in: 'board-SVC' }
    const shown = () => ui.find({ type: 'Text', text: /打开详情/, ...inB })
    await click(ui, cols > 100 ? 2 * (Math.floor((cols - 4) / 6) + 1) + 3 : 3, cols > 100 ? 3 : 2)
    expect(await shown()).toBeDefined()
    const logged = () => files.get(LOG).split('\n').filter((l: string) => l.includes('"k":"comment"')).length
    await ui.input({ key: 'peek-comment', text: '   ', ...inB }) // empty writes nothing
    expect(files.get(LOG)).not.toContain('"k":"comment"')
    await ui.input({ key: 'peek-comment', text: ' 先别合 ', ...inB })
    expect(files.get(LOG)).toContain('"k":"comment","key":"SVC-1","by":"me","text":"先别合"')
    expect(logged()).toBe(1)
    expect(await ui.find({ type: 'Text', text: /先别合/, ...inB })).toBeDefined() // shown in the popup, which is still open
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    if (cols > 100) {
      // a pointer click on the input's row (the left column's last body row) is inside: no close, no open-detail
      const g = peekGeo(region(cols), HEAD_H + SHORT, '打开详情')
      await click(ui, g.left + 3, g.top + g.h - 3)
      expect(await shown()).toBeDefined()
      expect(await ui.find({ key: 'back' })).toBeUndefined()
    } else expect(await shown()).toBeDefined()
    await expectNoEmoji(ui, ['board-SVC'])
    await ui.unmount()
  })
}

// en mode: the popup with the comment input has no Han.
test('en mode: peek popup with the comment input has no Chinese', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] login page', comment: 'migration ran' })
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    await hdr(ui, 'lang')
    await click(ui, cols > 100 ? 2 * (Math.floor((cols - 4) / 6) + 1) + 3 : 3, cols > 100 ? 3 : 2)
    const trees = [await ui.drawn(), await ui.drawn({ in: 'board-SVC' })]
    const text = JSON.stringify(trees)
    expect(text).toContain('Add a comment')
    expect(text.replaceAll('中文', '').match(/\p{Script=Han}/u)?.[0] ?? null).toBeNull()
    await hdr(ui, 'lang')
    await ui.unmount()
  }
})

// Jira's Details panel: WB-11 fields show their rows, a bare ticket hides them.
test('peek details rows: WB-11 fields show, empty ones hide', async ($: any, on: any) => {
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: 'blocker', col: 'todo' }) // SVC-1
  await call({ action: 'create', title: 'child', col: 'todo', labels: ['hold'], due: '2099-01-01', blockedBy: ['SVC-1'], parent: 'SVC-1', comment: 'first look' }) // SVC-2
  const ui = await $.ui.mount(PANE('desktop', 140))
  const colW = Math.floor((140 - 4) / 6)
  const todo = 1 * (colW + 1) + 3
  const row = (text: RegExp) => ui.find({ type: 'Text', text, in: 'board-SVC' })
  await click(ui, todo, HEAD_H + SHORT + 1 + 1) // SVC-2 is the second card of 待开工 (short titles: one card is SHORT rows, 1 gap)
  for (const text of [/^标签$/, /#hold/, /^截止$/, /01-01/, /^阻塞于$/, /^SVC-1$/, /^父任务$/, /^关联会话$/, /Claude · \d\d-\d\d \d\d:\d\d/, /first look/, /更新 刚刚/])
    expect(await row(text)).toBeDefined()
  await click(ui, 1, 17)
  await click(ui, todo, 3) // SVC-1: none of those fields
  for (const text of [/^标签$/, /^截止$/, /^阻塞于$/, /^父任务$/]) expect(await row(text)).toBeUndefined()
  expect(await row(/^优先级$/)).toBeDefined()
  await expectNoEmoji(ui, ['board-SVC'])
  await ui.unmount()
})

// History weeks (and surfaces without a Client): the Button list and the peek block stay.
test('peek in the Button fallback (past week)', async ($: any, on: any) => {
  const files = memfs(on)
  const t = weekStartOf(Date.now()) - 3 * 86_400_000 // last week's Friday: exactly one week back, any weekday
  files.set(`${DATA}/events/old.jsonl`, `${JSON.stringify({ k: 'create', key: 'SVC-1', project: 'SVC', title: '[T-42] 登录页面', col: 'doing', src: 'claude', t, sid: 'old' })}\n`)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(PANE('desktop', 60))
  await hdr(ui, 'nav', 'prev')
  expect(await ui.find({ key: 'board-SVC' })).toBeUndefined()
  await ui.press({ key: 'open-SVC-1' })
  expect(await ui.find({ key: 'peek-open' })).toBeDefined()
  expect(await ui.find({ key: 'peek-close' })).toBeDefined()
  await ui.press({ key: 'peek-close' })
  expect(await ui.find({ key: 'peek-open' })).toBeUndefined()
  await ui.press({ key: 'open-SVC-1' })
  await ui.press({ key: 'peek-open' })
  expect(await ui.find({ key: 'back' })).toBeDefined()
  await ui.unmount()
})

// The popup follows the Claude app's theme (config.json userThemeMode, else the OS) until the button picks one.
const CFG = `${HOME}/Library/Application Support/Claude/config.json`
const DARK = '#262b36'
const LIGHT = '#ffffff'
async function themed($: any, on: any, config: string | null, appearance = 'Light') {
  // `defaults read -g AppleInterfaceStyle`: prints Dark in Dark mode, fails in Light mode
  const run = (_$: any, e: any) => ({ value: e.argv[0] === 'defaults' ? { exitCode: appearance === 'Dark' ? 0 : 1, stdout: appearance === 'Dark' ? 'Dark\n' : '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } })
  const files = memfs(on, { run })
  if (config !== null) files.set(CFG, config)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: '[T-42] 登录页面' })
  const ui = await $.ui.mount(PANE('desktop', 140))
  const bg = async () => JSON.stringify(await ui.drawn({ in: 'board-SVC' }))
  await click(ui, 2 * (Math.floor((140 - 4) / 6) + 1) + 3, 3)
  return { ui, bg, files }
}
for (const [mode, own, other] of [['light', LIGHT, DARK], ['dark', DARK, LIGHT]] as const) {
  test(`theme follows the Claude app (${mode}); the button cycles auto, light, dark`, async ($: any, on: any) => {
    const { ui, bg } = await themed($, on, JSON.stringify({ userThemeMode: mode }), mode === 'light' ? 'Dark' : 'Light') // the OS says the opposite: the app wins
    expect(await bg()).toContain(own)
    expect(await bg()).not.toContain(other)
    const head = async () => JSON.stringify(await ui.drawn({ in: 'header' }))
    expect(await head()).toContain('跟随 Claude')
    await hdr(ui, 'theme')
    expect(await head()).toContain('"浅色"')
    expect(await bg()).toContain(LIGHT)
    expect(await bg()).not.toContain(DARK)
    await hdr(ui, 'theme')
    expect(await head()).toContain('"深色"')
    expect(await bg()).toContain(DARK)
    expect(await bg()).not.toContain(LIGHT)
    await hdr(ui, 'theme')
    expect(await head()).toContain('跟随 Claude')
    expect(await bg()).toContain(own)
    await ui.unmount()
  })
}

test('theme: system mode follows the OS appearance; a picked theme survives a restart', async ($: any, on: any) => {
  const { ui, bg } = await themed($, on, JSON.stringify({ userThemeMode: 'system' }), 'Dark')
  expect(await bg()).toContain(DARK)
  await hdr(ui, 'theme') // light
  expect(await bg()).toContain(LIGHT)
  await ui.unmount()
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true }) // the store keeps 'light'
  const again = await $.ui.mount(PANE('desktop', 140))
  expect(JSON.stringify(await again.drawn({ in: 'board-SVC' }))).toContain(LIGHT)
  await again.unmount()
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

// Web app hooks: the header link (en says Web, no Han, no emoji) and /kanban-web replying with the server's address.
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

test('kanban-web and the web link', async ($: any, on: any) => {
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 140))
  // the header Client draws it as a Link: the engine has no open-URL call, so its hit area posts nothing
  expect(await ui.find({ type: 'Link', text: '网页版', in: 'header' })).toBeDefined()
  await hdr(ui, 'web')
  await hdr(ui, 'lang')
  const link = await ui.find({ type: 'Link', in: 'header' })
  expect([link?.props.label, link?.props.href]).toEqual(['Web', 'http://localhost:4790/'])
  await expectNoEmoji(ui, ['header'])
  await hdr(ui, 'lang')
  await ui.unmount()
  const r = await $.command.run({ command: 'kanban-web' })
  expect(String(r.text)).toContain('http://127.0.0.1:4790')
})

// WB-11: labels, due, blockedBy, parent, canceled.
test('labels, due, blockedBy, parent, canceled: tool validation, list, cards, detail', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = async (x: any) => String((await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })).result)
  await call({ action: 'create', title: 'blocker' }) // SVC-1
  expect(await call({ action: 'create', title: 'bad', due: '10/5' })).toContain('没建')
  expect(await call({ action: 'create', title: 'bad', blockedBy: ['SVC-99'] })).toContain('没有 ticket SVC-99')
  expect(files.get(LOG)).not.toContain('"title":"bad"')
  await call({ action: 'create', title: 'child', col: 'todo', labels: ['#缺陷', 'hold', 'hold'], due: '2020-01-01', blockedBy: ['SVC-1'], parent: 'SVC-1' }) // SVC-2
  expect(await call({ action: 'update', key: 'SVC-2', blockedBy: ['SVC-2'] })).toContain('不能卡住自己')
  expect(await call({ action: 'update', key: 'SVC-1', parent: 'SVC-2' })).toContain('成环')
  expect(await call({ action: 'list', q: 'hold' })).toMatch(/SVC-2 \[待开工 截止 2020-01-01 卡于 SVC-1 父 SVC-1\] #缺陷 #hold child/)
  expect(await call({ action: 'update', key: 'SVC-2', work: true })).toContain('还被 SVC-1 卡着')

  // wide: no 已取消 column until something is canceled
  const ui = await $.ui.mount(PANE('desktop', 160))
  expect(await ui.find({ type: 'Text', text: '已取消', in: 'board-SVC' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '卡于 SVC-1', in: 'board-SVC' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '#缺陷 #hold', in: 'board-SVC' })).toBeDefined()
  await call({ action: 'update', key: 'SVC-1', col: 'canceled', userAccepted: true }) // the person said so in chat (WB-28)
  expect(await ui.find({ type: 'Text', text: '已取消', in: 'board-SVC' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /卡于/, in: 'board-SVC' })).toBeUndefined() // a canceled blocker no longer blocks
  expect(await call({ action: 'list' })).not.toContain('SVC-1 ')
  await expectNoEmoji(ui, ['board-SVC'])
  await ui.unmount()

  // narrow detail: relations both ways, overdue, panel edits
  const nu = await $.ui.mount(PANE('desktop', 60))
  const lay = gridLayout([{ id: 'todo', cards: [{ key: 'SVC-2' }] }, { id: 'canceled', cards: [{ key: 'SVC-1' }] }], 56)
  const svcAt = lay.sections[1].cards[0] // canceled comes after todo
  await click(nu, 55, lay.sections[1].y) // canceled is folded like done: open it first (WB-28)
  await click(nu, svcAt.x + 2, svcAt.y + 1)
  await click(nu, btnAt(60, '打开详情', 15).x, btnAt(60, '打开详情', 15).y)
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
test('dragging 待开工 → 进行中 asks Claude to spawn a session; other moves do not', async ($: any, on: any) => {
  const prompts: string[] = []
  on('prompt.submit', (_$: any, e: any) => (prompts.push(e.text), { text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: '[T-42] 登录页面', col: 'todo' }) // SVC-1
  const ui = await $.ui.mount(PANE('desktop', 140))
  const colW = Math.floor((140 - 4) / 6)
  const at = (col: number) => col * (colW + 1) + 3
  const drag = async (from: number, to: number) => {
    await ui.pointer({ type: 'down', x: at(from), y: 3, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'move', x: at(to), y: 3, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'up', x: at(to), y: 3, button: 'left', in: 'board-SVC' })
  }
  await drag(1, 2) // 待开工 → 进行中
  expect(files.get(LOG)).toContain('"col":"doing","text":"你拖拽移动"')
  expect(prompts.filter(p => p.includes('mcp__ccd_session__spawn_task')).length).toBe(1)
  expect(prompts.at(-1)).toContain('认领 SVC-1')
  await drag(2, 3) // 进行中 → 待跟进: no spawn
  expect(prompts.filter(p => p.includes('spawn_task')).length).toBe(1)
  await ui.unmount()
  // Claude claiming a todo ticket moves it to doing without spawning
  await call({ action: 'create', title: 'other', col: 'todo' }) // SVC-2
  await call({ action: 'update', key: 'SVC-2', work: true })
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
  const left = async (ui: any, scopes: string[] = []) => {
    const all = [await ui.drawn(), ...(await Promise.all(scopes.map(k => ui.drawn({ in: k }))))].flatMap(shownText).join(' | ')
    return all.replace(/\bEN\b|\bClaude\b|\bPR\b|\bSVC\b|\bInfra\b|[A-Z]+-\d+|\bP[0-3]\b|\bW\d+\b|web-app|YYYY-MM-DD|https?:\S+/g, '').match(/[A-Za-z]{2,}/g) ?? []
  }
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: '[T-42] 登录页面', title_en: '[T-42] login page', priority: 'P1', desc: '去掉标记', desc_en: 'drop the marker', comment: '迁移已跑', labels: ['缺陷'], due: '2099-01-01' })
  await call({ action: 'create', title: '周看板插件', title_en: 'task board mod', project: 'ME', col: 'decide', src: 'me', note: '计划' })
  await call({ action: 'update', key: 'ME-1', col: 'canceled', comment: '不需要了' }) // a proposal (WB-28)
  await call({ action: 'update', key: 'SVC-1', col: 'review', blockedBy: ['ME-1'] })
  for (const [cols, scopes] of [[140, ['header', 'board-SVC', 'board-ME']], [60, ['header', 'board-SVC', 'board-ME']]] as const) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    expect(await left(ui, scopes)).toEqual([])
    await hdr(ui, 'seg', 'feed')
    expect(await left(ui, ['header'])).toEqual([])
    await hdr(ui, 'seg', 'board')
    await click(ui, cols > 100 ? 4 * (Math.floor((cols - 4) / 6) + 1) + 3 : 3, cols > 100 ? 3 : 2)
    expect(await left(ui, scopes)).toEqual([]) // the preview
    await openBtn(ui, cols)
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).toContain('去掉标记')
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
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  const one = await call({ action: 'create', title: '登录页面', desc: '去掉标记' })
  expect(String(one.result)).toContain('缺 title_en、desc_en')
  expect(String((await call({ action: 'list' })).result)).toContain('登录页面（缺双语）')
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('SVC-1「登录页面」缺 title_en、desc_en')
  const both = await call({ action: 'update', key: 'SVC-1', title_en: 'login page', desc_en: 'drop the marker' })
  expect(String(both.result)).not.toContain('缺')
  // polishing one side of a pair whose other side is there is fine
  expect(String((await call({ action: 'update', key: 'SVC-1', title_en: 'login page' })).result)).not.toContain('缺')
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).not.toContain('缺 ')
  const ui = await $.ui.mount(PANE('desktop', 60))
  await only(ui)
  await openBtn(ui, 60)
  expect(await ui.find({ type: 'Text', text: /^登录页面$/ })).toBeDefined()
  await ui.press({ key: 'back' })
  await hdr(ui, 'lang')
  await only(ui)
  await openBtn(ui, 60, 'Open details')
  expect(await ui.find({ type: 'Text', text: /^login page$/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('drop the marker')
  // the person rewrites the description: one language, the stale English goes, Claude is told
  await ui.input({ key: 'desc', text: 'keep the marker' })
  expect(files.get(LOG)).toContain('"desc":"keep the marker","desc_en":""')
  expect(JSON.stringify(await ui.drawn())).toContain('keep the marker') // en falls back to the only side
  await $.prompt.submit({ text: 'next', wait: false })
  expect(contexts.at(-1)).toContain('SVC-1「登录页面」缺 desc_en')
  await ui.press({ key: 'back' })
  await hdr(ui, 'lang')
  await ui.unmount()
})

// WB-22: the narrow board is a grid of fixed-size cards.
test('gridLayout: cards per row, section offsets, no overlap, short cards share one height', () => {
  const keys = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ key: `${p}${i}` }))
  const cols = [{ id: 'doing', cards: keys(5, 'a') }, { id: 'follow', cards: keys(1, 'b') }, { id: 'done', cards: keys(2, 'c') }]
  // [regionW, cards per row, card width]: one fits (full width), two, three
  for (const [w, per, cw] of [[20, 1, 20], [46, 1, 46], [60, 1, 60], [61, 2, GRID_CARD_W], [66, 2, GRID_CARD_W], [93, 3, GRID_CARD_W]] as const) {
    const lay = gridLayout(cols, w)
    expect([lay.per, lay.w]).toEqual([per, cw])
    const rects = lay.sections.flatMap(s => s.cards)
    expect(rects.length).toBe(8)
    for (const r of rects) {
      expect(r.h).toBe(SHORT) // key-only cards have an empty title: one title row
      expect(r.w).toBe(cw)
      expect(r.x + r.w).toBeLessThanOrEqual(w)
    }
    for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1)) {
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
    }
    // sections: header row, card rows 1 apart, one blank row between sections
    let y = 0
    for (const s of lay.sections) {
      expect(s.y).toBe(y)
      const rows = Math.ceil(s.cards.length / per)
      expect(s.h).toBe(1 + rows * SHORT + (rows - 1))
      expect(s.cards[0].y).toBe(s.y + 1)
      y += s.h + 1
    }
    expect(lay.height).toBe(y - 1)
  }
  expect(gridLayout(cols, 66).sections.map(s => s.y)).toEqual([0, 1 + 3 * SHORT + 2 + 1, 1 + 3 * SHORT + 2 + 1 + 1 + SHORT + 1])
})

// Walk a drawn tree.
const walk = (n: any, f: (n: any) => void) => { f(n); for (const c of n?.children ?? []) if (typeof c === 'object') walk(c, f) }
const nodes = (tree: any, f: (n: any) => boolean) => { const out: any[] = []; walk(tree, n => { if (f(n)) out.push(n) }); return out }
// A Client card: a tinted Box whose first child is the 1-cell stripe column of ▎ rows.
const isCard = (n: any) => n.type === 'Box' && n.props?.backgroundColor && n.children?.[0]?.props?.width === 1 && n.children[0].props.flexDirection === 'column'
const stripeText = (c: any) => c.children[0].children.map((t: any) => t.children.join(''))

for (const cols of [50, 70]) {
  test(`narrow pane at ${cols}: content-height cards drawn by the Client, wrapping titles, click to peek, drag to a section`, async ($: any, on: any) => {
    on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
    const files = memfs(on)
    await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
    const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
    const long = '[T-42] ingredient version validation rules and variant code migration notes that run well past one line of the pane'
    await call({ action: 'create', title: '[T-42] 登录页面校验规则与变体码迁移的说明文档，内容很长，一行放不下，需要在卡片里折行显示出来', title_en: long, priority: 'P1', labels: ['bug'] })
    await call({ action: 'create', title: '短标题', title_en: 'short', col: 'follow' })
    await call({ action: 'create', title: '第三张', title_en: 'third' })
    const ui = await $.ui.mount(PANE('desktop', cols))
    const W = cols - 4
    // the cards as the Client got them (titles included): the layout depends on them
    const all = ((await ui.find({ key: 'board-SVC' })).props.props.cols as any[]).flatMap(c => c.cards)
    const sections = (doing: string[], follow: string[]) => gridLayout([{ id: 'doing', cards: doing.map(key => all.find(c => c.key === key)) }, { id: 'follow', cards: follow.map(key => all.find(c => c.key === key)) }], W)
    // the Client draws it, not Buttons
    expect(await ui.find({ key: 'board-SVC' })).toBeDefined()
    expect(await ui.find({ key: 'open-SVC-1' })).toBeUndefined()
    const tree = await ui.drawn({ in: 'board-SVC' })
    // every card is a tinted Box whose height follows its title: the long one is taller than the short ones
    const cards = nodes(tree, isCard)
    expect(cards.length).toBe(3)
    const cw = sections(['SVC-1'], []).sections[0].cards[0].w
    for (const k of all) expect(cards.find(c => JSON.stringify(c).includes(`"${k.key}"`))!.props.height).toBe(cardHeight(k, cw))
    const hOf = (key: string) => cardHeight(all.find(c => c.key === key), cw)
    expect(hOf('SVC-1')).toBeGreaterThan(hOf('SVC-2'))
    expect(hOf('SVC-1')).toBe(CARD_H) // capped at 3 title rows
    expect(hOf('SVC-2')).toBe(SHORT)
    expect(new Set(cards.map(c => c.props.height)).size).toBe(2)
    expect(cards.every(c => c.props.borderStyle === undefined && stripeText(c).length === c.props.height)).toBe(true) // no border, a ▎ on every row
    // the long title is a wrapping Text: whole, no truncate wrap, no ellipsis
    const title = nodes(tree, n => n.type === 'Text' && JSON.stringify(n.children).includes('登录页面校验规则'))
    expect(title.length).toBe(1)
    expect(String(title[0].props?.wrap ?? '')).not.toContain('truncate')
    expect(JSON.stringify(tree)).not.toContain('…')
    await expectNoEmoji(ui, ['board-SVC'])
    // drag SVC-1 (first card of 进行中) onto 待跟进's section
    const before = sections(['SVC-1', 'SVC-3'], ['SVC-2'])
    const from = before.sections[0].cards[0]
    const toY = before.sections[1].y + 1
    await ui.pointer({ type: 'down', x: from.x + 2, y: from.y + 2, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'move', x: from.x + 2, y: toY, button: 'left', in: 'board-SVC' })
    expect(await ui.find({ type: 'Text', text: / 放到 待跟进 /, in: 'board-SVC' })).toBeDefined()
    // the dragged card's stripe turns into full blocks
    const dragged = nodes(await ui.drawn({ in: 'board-SVC' }), isCard).find(c => JSON.stringify(c).includes('"SVC-1"'))!
    expect(new Set(stripeText(dragged))).toEqual(new Set(['█']))
    await ui.pointer({ type: 'up', x: from.x + 2, y: toY, button: 'left', in: 'board-SVC' })
    expect(files.get(LOG)).toContain('"key":"SVC-1","col":"follow","text":"你拖拽移动"')
    // click SVC-3 (now alone in 进行中, first card): the peek opens, centered in the region
    const solo = sections(['SVC-3'], ['SVC-1', 'SVC-2']).sections[0].cards[0]
    await click(ui, solo.x + 2, solo.y + 1)
    expect(await ui.find({ type: 'Text', text: /打开详情/, in: 'board-SVC' })).toBeDefined()
    const h = sections(['SVC-3'], ['SVC-1', 'SVC-2']).height
    const g = peekGeo(W, h, '打开详情', 2)
    expect([g.w, g.left]).toEqual([Math.min(96, W - 2), Math.floor((W - g.w) / 2)])
    // drag is off while it is open: a press on a card and release on another section moves nothing
    const moves = () => (files.get(LOG).match(/"k":"move"/g) ?? []).length
    const n = moves()
    await ui.pointer({ type: 'down', x: solo.x + 2, y: solo.y + 1, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'up', x: solo.x + 2, y: toY + 10, button: 'left', in: 'board-SVC' })
    expect(moves()).toBe(n)
    await click(ui, btnAt(cols, '打开详情', h).x, btnAt(cols, '打开详情', h).y)
    expect(await ui.find({ key: 'back' })).toBeDefined()
    await ui.press({ key: 'back' })
    // en mode: no Han in the pane or the board, no glyph-repeated rule
    await hdr(ui, 'lang')
    for (const tree of [await ui.drawn(), await ui.drawn({ in: 'board-SVC' })]) {
      const text = JSON.stringify(tree)
      expect(text.replaceAll('中文', '').match(/\p{Script=Han}/u)?.[0] ?? null).toBeNull()
      expect(text.match(/([─━═—-])\1{5,}/)?.[0] ?? null).toBeNull()
    }
    expect(await ui.find({ type: 'Text', text: /In progress/i, in: 'board-SVC' })).toBeDefined()
    await hdr(ui, 'lang')
    await ui.unmount()
  })
}

// WB-23 (style C): accent-stripe cards.
const TINT = { light: '#f3f4f7', dark: '#262a31' }
const LIVE_COLOR = '#3f9a6b'
const cardBoxes = (tree: any, tint = TINT.light) => nodes(tree, n => isCard(n) && n.props.backgroundColor === tint)
// A desktop board: SVC-1 in 进行中 and live (its session is busy), SVC-2 in 待审核, SVC-3 done and accepted.
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
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: '进行中的', title_en: 'busy one', col: 'doing', work: true }) // SVC-1
  await call({ action: 'update', key: 'SVC-1', work: true })
  await call({ action: 'create', title: '待审核的', title_en: 'review one', col: 'review' }) // SVC-2
  await call({ action: 'create', title: '做完的', title_en: 'finished one', col: 'done', userAccepted: true }) // SVC-3
  await call({ action: 'update', key: 'SVC-1', work: true })
  await $.prompt.submit({ text: 'go', wait: false })
  return $.ui.mount(PANE('desktop', cols))
}

for (const cols of [140, 60]) {
  test(`cards at ${cols}: no border, a ▎ stripe on every row of a tint, live color while a session works it, done folded`, async ($: any, on: any) => {
    const ui = await striped($, on, cols)
    const tree = await ui.drawn({ in: 'board-SVC' })
    const cards = cardBoxes(tree)
    expect(cards.length).toBe(2) // the done card is folded away
    for (const c of cards) {
      expect([c.props.borderStyle, c.props.borderColor]).toEqual([undefined, undefined])
      expect(stripeText(c)).toEqual(Array(c.props.height).fill('▎'))
    }
    const stripeOf = (key: string) => cards.find(c => JSON.stringify(c).includes(key))!.children[0].children[0].props.color
    expect(stripeOf('SVC-1')).toBe(LIVE_COLOR) // live wins over the 进行中 color
    expect(stripeOf('SVC-2')).toBe(colOf('review').color)
    expect(await ui.find({ type: 'Text', text: '做完的', in: 'board-SVC' })).toBeUndefined()
    // the header: bold status-colored name, muted count, the toggle
    expect(await ui.find({ type: 'Text', text: '已完成', in: 'board-SVC' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '展开', in: 'board-SVC' })).toBeDefined()
    await expectNoEmoji(ui, ['board-SVC'])
    await ui.unmount()
  })
}

// Done is folded until the toggle on its header row is pressed (the Client posts toggleDone), at both widths.
test('done folded by default; the header toggle opens and closes it (wide board and grid)', async ($: any, on: any) => {
  const ui = await striped($, on, 140)
  const done = () => ui.find({ type: 'Text', text: '做完的', in: 'board-SVC' })
  const colW = Math.floor((140 - 4) / 6)
  const wideX = COLS_ORDER.indexOf('done') * (colW + 1) + colW - 2 // inside the right-aligned toggle
  expect(await done()).toBeUndefined()
  await click(ui, wideX, 0)
  expect(await done()).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '收起', in: 'board-SVC' })).toBeDefined()
  await click(ui, wideX, 0)
  expect(await done()).toBeUndefined()
  await ui.unmount()
  // grid: the done section's header row, toggle at the right edge of the region
  const g = await $.ui.mount(PANE('desktop', 60))
  const lay = gridLayout([{ id: 'doing', cards: [{ key: 'a' }] }, { id: 'review', cards: [{ key: 'b' }] }, { id: 'done', cards: [] }], 56)
  const gy = lay.sections[2].y
  await click(g, 5, gy) // the name, not the toggle: nothing
  expect(await g.find({ type: 'Text', text: '做完的', in: 'board-SVC' })).toBeUndefined()
  await click(g, 54, gy)
  expect(await g.find({ type: 'Text', text: '做完的', in: 'board-SVC' })).toBeDefined()
  await click(g, 54, gy)
  expect(await g.find({ type: 'Text', text: '做完的', in: 'board-SVC' })).toBeUndefined()
  await g.unmount()
})
const COLS_ORDER = ['decide', 'todo', 'doing', 'follow', 'review', 'done']

// With done expanded: en mode has no Han, no glyph-repeated rule, no emoji, at both widths.
test('done expanded: no Chinese in en, no rules, no emoji', async ($: any, on: any) => {
  const ui0 = await striped($, on, 140)
  await ui0.unmount()
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    const colW = Math.floor((cols - 4) / 6)
    const lay = gridLayout([{ id: 'doing', cards: [{ key: 'a' }] }, { id: 'review', cards: [{ key: 'b' }] }, { id: 'done', cards: [] }], cols - 4)
    const toggle = () => click(ui, cols > 100 ? COLS_ORDER.indexOf('done') * (colW + 1) + colW - 2 : cols - 6, cols > 100 ? 0 : lay.sections[2].y)
    await toggle()
    expect(await ui.find({ type: 'Text', text: '做完的', in: 'board-SVC' })).toBeDefined()
    await hdr(ui, 'lang')
    expect(await ui.find({ type: 'Text', text: 'finished one', in: 'board-SVC' })).toBeDefined()
    for (const tree of [await ui.drawn(), await ui.drawn({ in: 'board-SVC' })]) {
      const text = JSON.stringify(tree)
      expect(text.replaceAll('中文', '').match(/\p{Script=Han}/u)?.[0] ?? null).toBeNull()
      expect(text.match(/([─━═—-])\1{5,}/)?.[0] ?? null).toBeNull()
    }
    await expectNoEmoji(ui, ['board-SVC'])
    await hdr(ui, 'lang')
    await toggle() // folded again for the next width
    await ui.unmount()
  }
})

// cardRows: the title area's rows, from the exact drawn text (code + space + rest) over the inner width (card - 3), capped at 3.
test('cardRows / cardHeight: 1 row short, 2 medium, capped at 3; Han counts two cells', () => {
  const w = 30 // inner width 27
  expect(cardRows({ code: '', rest: 'short' }, w)).toBe(1)
  expect(cardRows({ code: '', rest: 'a'.repeat(27) }, w)).toBe(1)
  expect(cardRows({ code: '', rest: 'a'.repeat(28) }, w)).toBe(2)
  expect(cardRows({ code: '[T-42]', rest: 'a'.repeat(30) }, w)).toBe(2) // the code and its space count: 6 + 1 + 30 = 37
  expect(cardRows({ code: '', rest: 'a'.repeat(500) }, w)).toBe(3)
  expect(cardRows({ code: '', rest: '汉'.repeat(13) }, w)).toBe(1) // 26 cells
  expect(cardRows({ code: '', rest: '汉'.repeat(14) }, w)).toBe(2) // 28 cells: the same count in ASCII fits one row
  expect(cardRows({ code: '', rest: '汉'.repeat(200) }, w)).toBe(3)
  expect(cardRows({}, 1)).toBe(1) // a width below the chrome is clamped, never divides by zero
  expect([cardHeight({}, w), cardHeight({ rest: 'a'.repeat(28) }, w), cardHeight({ rest: 'a'.repeat(500) }, w)]).toEqual([2, 3, CARD_H])
})

// Cards are as tall as their titles; a gap row between them; a row of the grid is as tall as its tallest card.
test('gridLayout: per-card heights, row height = tallest card, no overlap, 1-row gaps', () => {
  const t = (key: string, n: number) => ({ key, rest: 'a'.repeat(n) })
  const one = gridLayout([{ id: 'doing', cards: [t('a', 3), t('b', 80), t('c', 30)] }], 20) // inner 17: 1, 3, 2 rows
  expect(one.sections[0].cards.map(c => [c.y, c.h])).toEqual([[1, 2], [4, 4], [9, 3]])
  expect(one.sections[0].h).toBe(1 + 2 + 1 + 4 + 1 + 3)
  expect(one.height).toBe(one.sections[0].h)
  // two per row (66 wide, cards 30, inner 27): [1 row, 3 rows] then [2 rows] then a second section
  const lay = gridLayout([{ id: 'doing', cards: [t('a', 3), t('b', 80), t('c', 40)] }, { id: 'follow', cards: [t('d', 3)] }], 66)
  const [s0, s1] = lay.sections
  expect(s0.cards.map(c => [c.x, c.y, c.h])).toEqual([[0, 1, 2], [31, 1, 4], [0, 6, 3]]) // top-aligned; a keeps its own height, the row is 4
  expect(s0.rowH).toEqual([4, 3])
  expect(s0.h).toBe(1 + 4 + 1 + 3)
  expect(s1.y).toBe(s0.h + 1)
  expect(lay.height).toBe(s1.y + s1.h)
  const rects = lay.sections.flatMap(s => s.cards)
  for (const [i, a] of rects.entries()) for (const b of rects.slice(i + 1))
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
})
test('columnLayout: the wide column stacks its cards below the header with 1-row gaps', () => {
  expect(columnLayout([{ key: 'a', rest: 'x' }, { key: 'b', rest: 'x'.repeat(100) }, { key: 'c' }], 20).map(c => [c.y, c.h])).toEqual([[HEAD_H, 2], [HEAD_H + 3, 4], [HEAD_H + 8, 2]])
})

// Content-height cards on the real pane: wide board (140) and grid (50, 70). Titles of different lengths give cards of different heights;
// a click lands on the card the layout puts there (not on a fixed step); a drag from a tall card to another section still moves it.
for (const cols of [140, 50, 70]) {
  test(`content-height cards at ${cols}: heights differ, click opens that card's peek, drag from a tall card moves it`, async ($: any, on: any) => {
    on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
    const files = memfs(on)
    await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
    const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
    const long = 'a very long english title that needs well more than two rows even on a wide card, so it is capped at three rows'
    await call({ action: 'create', title: '短', title_en: 'short', col: 'decide' }) // SVC-1
    await call({ action: 'create', title: '很长的标题，要占满三行还有富余，一直写到卡片放不下为止，再多写一些字来保证超过三行的上限，看它是不是被截断', title_en: long, col: 'decide' }) // SVC-2
    await call({ action: 'create', title: '第三张', title_en: 'third', col: 'decide' }) // SVC-3
    await call({ action: 'create', title: '另一列', title_en: 'other column', col: 'follow' }) // SVC-4
    const ui = await $.ui.mount(PANE('desktop', cols))
    const wide = cols > 100
    const lane = 'board-SVC'
    const props = async () => (await ui.find({ key: lane })).props.props
    const colW = (await props()).colW as number
    // where each decide card sits: [key, x, y, h], from the layout the Client itself uses
    const spots = async () => {
      const pr = await props()
      if (wide) return columnLayout(pr.cols[0].cards, colW).map(c => ({ ...c, x: 3 }))
      return gridLayout(pr.cols, pr.grid).sections[0].cards.map(c => ({ ...c, x: c.x + 3 }))
    }
    const [a, b, c] = await spots()
    expect(a.h).toBe(SHORT)
    expect(b.h).toBe(CARD_H)
    expect(c.h).toBe(SHORT)
    expect(new Set([a.h, b.h]).size).toBe(2)
    // the drawn card Boxes carry those heights
    const drawn = nodes(await ui.drawn({ in: lane }), isCard)
    expect(drawn.map(n => n.props.height).sort()).toEqual([a.h, b.h, c.h, SHORT].sort())
    const peeked = async () => (await props()).peek?.key
    // the third card starts where the layout says (a fixed step of CARD_H + 1 would put it lower): its first row opens SVC-3, the gap above it nothing
    expect(c.y).toBeLessThan(a.y + 2 * (CARD_H + 1))
    await click(ui, c.x, c.y - 1, lane)
    expect(await peeked()).toBeUndefined()
    await click(ui, c.x, c.y, lane)
    expect(await peeked()).toBe('SVC-3')
    expect(await ui.find({ type: 'Text', text: /打开详情/, in: lane })).toBeDefined()
    await click(ui, 0, 0, lane) // outside the popup: closes it
    expect(await peeked()).toBeUndefined()
    // the second card (the tall one): its last row opens SVC-2
    await click(ui, b.x, b.y + b.h - 1, lane)
    expect(await peeked()).toBe('SVC-2')
    await click(ui, 0, 0, lane)
    expect(await peeked()).toBeUndefined()
    // drag from the tall card to the other column / section: the move is written
    const to = wide ? { x: 3 * (colW + 1) + 3, y: 3 } : { x: 3, y: gridLayout((await props()).cols, (await props()).grid).sections[1].y + 1 }
    await ui.pointer({ type: 'down', x: b.x, y: b.y + 2, button: 'left', in: lane })
    await ui.pointer({ type: 'move', x: to.x, y: to.y, button: 'left', in: lane })
    await ui.pointer({ type: 'up', x: to.x, y: to.y, button: 'left', in: lane })
    expect(files.get(LOG)).toContain('"key":"SVC-2","col":"follow","text":"你拖拽移动"')
    await expectNoEmoji(ui, [lane])
    // en: no Han, no glyph-repeated rule
    await hdr(ui, 'lang')
    for (const tree of [await ui.drawn(), await ui.drawn({ in: lane })]) {
      const text = JSON.stringify(tree)
      expect(text.replaceAll('中文', '').match(/\p{Script=Han}/u)?.[0] ?? null).toBeNull()
      expect(text.match(/([─━═—-])\1{5,}/)?.[0] ?? null).toBeNull()
    }
    await hdr(ui, 'lang')
    await ui.unmount()
  })
}

// The card tint follows the app theme.
for (const [mode, own, other] of [['light', TINT.light, TINT.dark], ['dark', TINT.dark, TINT.light]] as const) {
  test(`card tint follows the theme (${mode})`, async ($: any, on: any) => {
    const ui = await striped($, on, 140, mode)
    const board = async () => JSON.stringify(await ui.drawn({ in: 'board-SVC' }))
    expect(await board()).toContain(own)
    expect(await board()).not.toContain(other)
    await hdr(ui, 'theme') // light
    await hdr(ui, 'theme') // dark
    expect(await board()).toContain(TINT.dark)
    expect(await board()).not.toContain(TINT.light)
    await ui.unmount()
  })
}

// The Button header, where the surface has no Client (mobile, whose table also lacks Input: no search field there): plain text buttons; the active project tab is an underlined, bold Text.
test('header fallback: plain text buttons, the active project tab is underlined', async ($: any, on: any) => {
  await seed($, on, 'mobile')
  const ui = await $.ui.mount(PANE('mobile', 140))
  expect(await ui.find({ key: 'header' })).toBeUndefined()
  const buttons = async (prefix: string) => nodes(await ui.drawn(), n => n.type === 'Button' && String(n.props?.key).startsWith(prefix))
  expect((await buttons('p-')).map(b => b.props.key).sort()).toEqual(['p-INF', 'p-ME', 'p-SVC', 'p-WB']) // ALL is the active tab at the start: a Text
  for (const k of ['p-', 'qf-', 'tab-', 'theme', 'lang']) for (const b of await buttons(k)) {
    expect(b.props.plain).toBe(true)
    expect(b.props.variant).toBeUndefined()
  }
  const underlined = async () => nodes(await ui.drawn(), n => n.type === 'Text' && n.props?.underline).map(n => JSON.stringify(n.children))
  expect(await underlined()).toEqual([JSON.stringify(['全部'])])
  await ui.press({ key: 'p-SVC' })
  expect(await underlined()).toEqual([JSON.stringify(['SVC 重写'])])
  expect(await ui.find({ key: 'p-ALL' })).toBeDefined()
  // every fallback key still works
  for (const key of ['qf-me', 'qf-me', 'qf-live', 'qf-live', 'tab-feed', 'tab-board', 'p-ALL', 'theme', 'lang', 'lang']) await ui.press({ key })
  expect(await ui.find({ type: 'Link', text: '网页版' })).toBeDefined() // web-link
  await ui.press({ key: 'qf-me' }) // only tickets waiting on me: ME-1 (decide) stays, SVC-1 goes
  expect(await ui.find({ key: 'open-ME-1' })).toBeDefined()
  expect(await ui.find({ key: 'open-SVC-1' })).toBeUndefined()
  await ui.unmount()
})

// Past weeks and surfaces without a Client: the Button cards keep the stripe look, and done folds behind a plain Button.
test('Button fallback: stripe cards, done folded behind fold-done', async ($: any, on: any) => {
  const files = memfs(on)
  const t = weekStartOf(Date.now()) - 3 * 86_400_000 // last week's Friday: exactly one week back, any weekday
  const ev = (o: any) => JSON.stringify({ project: 'SVC', src: 'claude', t, sid: 'old', k: 'create', ...o })
  files.set(`${DATA}/events/old.jsonl`, [
    ev({ key: 'SVC-1', title: '[T-42] 登录页面', col: 'doing' }),
    ev({ key: 'SVC-2', title: '做完的', col: 'done' }),
  ].join('\n') + '\n')
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(PANE('desktop', 60))
  await hdr(ui, 'nav', 'prev')
  expect(await hdrHit(ui, 'nav', 'prev')).toBeUndefined() // only one week back
  const tree = await ui.drawn()
  const cards = nodes(tree, n => n.type === 'Box' && n.props?.backgroundColor === TINT.light && n.children?.[0]?.props?.width === 1)
  expect(cards.length).toBe(1)
  expect(cards[0].props.borderStyle).toBeUndefined()
  expect(cards[0].children[0].props.backgroundColor).toBe(colOf('doing').color)
  expect(await ui.find({ key: 'open-SVC-2' })).toBeUndefined()
  await ui.press({ key: 'fold-done' })
  expect(await ui.find({ key: 'open-SVC-2' })).toBeDefined()
  await ui.press({ key: 'fold-done' })
  expect(await ui.find({ key: 'open-SVC-2' })).toBeUndefined()
  await expectNoEmoji(ui)
  await ui.unmount()
})

// WB-23 header Client: the layout is pure; the hit areas never overlap, tabs wrap whole, the week nav moves down when it does not fit.
test('headerLayout: no overlapping hits, tabs wrap by whole tab, the right group fits or the nav moves to row 2', () => {
  const props: any = {
    width: 0, title: '看板开发 看板', week: ' W40', meta: '09-28 ~ 10-04 · 剩 1 天 · 新建 44 · 完成 20 · 提交 0',
    nav: [{ id: 'prev', label: '上一周 W39' }],
    tabs: [['SVC', 'SVC 重写', 5], ['WB', '看板开发', 1], ['INF', 'Infra', 0], ['ME', '私人', 0], ['ALL', '全部', 0]].map(([id, label, decide]) => ({ id, label, decide, active: id === 'WB' })),
    filters: [{ id: 'me', label: '只看等我的', on: false }, { id: 'live', label: '正在做的', on: false }],
    segs: [{ id: 'board', label: '看板', active: true }, { id: 'feed', label: '动态', active: false }],
    search: { q: '', placeholder: '搜索…' }, live: '在做：kanban → WB-23',
    web: { label: '网页版', href: 'http://localhost:4790/' }, theme: '浅色', lang: 'EN', surf: {},
  }
  for (const w of [136, 96, 56, 40]) {
    const { hits, height } = headerLayout(props, w)
    for (const [i, a] of hits.entries()) {
      expect(a.x0 >= 0 && a.x1 <= w && a.x0 < a.x1).toBe(true)
      for (const b of hits.slice(i + 1)) expect(a.y !== b.y || a.x1 <= b.x0 || b.x1 <= a.x0).toBe(true)
    }
    // every tab is whole: label plus its decide count, on one row
    for (const tb of props.tabs) {
      const h = hits.find(x => x.kind === 'proj' && x.id === tb.id)!
      expect(h.x1 - h.x0).toBe(cellsOf(tb.label) + (tb.decide ? 1 + String(tb.decide).length : 0))
    }
    for (const k of ['nav', 'web', 'theme', 'lang', 'filter', 'search', 'seg']) expect(hits.some(h => h.kind === k)).toBe(true)
    expect(height).toBeGreaterThanOrEqual(5)
  }
  const at = (w: number, kind: string, id?: string) => headerLayout(props, w).hits.find(h => h.kind === kind && (id === undefined || h.id === id))!
  // wide: nav, web, theme, lang all on row 1, right-aligned
  expect([at(96, 'nav').y, at(96, 'lang').y, at(96, 'lang').x1]).toEqual([0, 0, 96])
  // narrow: the nav ends row 2 (after the meta), the text actions stay on row 1
  expect([at(40, 'nav').y, at(40, 'nav').x1, at(40, 'lang').y, at(40, 'lang').x1]).toEqual([1, 40, 0, 40])
  // 40 cells: 全部 does not fit after 私人, so it starts the next row
  expect([at(40, 'proj', 'ALL').x0, at(40, 'proj', 'ALL').y]).toEqual([0, at(40, 'proj', 'SVC').y + 1])
  expect(at(96, 'proj', 'ALL').y).toBe(at(96, 'proj', 'SVC').y)
})
const cellsOf = (s: string) => [...s].reduce((n, c) => n + (/[⺀-鿿＀-￯]/.test(c) ? 2 : 1), 0)

// The header Client on the pane: tabs, filters, segments, theme / lang and the box-less search field, by pointer clicks.
test('header Client: tab / filter / segment / theme / lang / search clicks, styles as mockup C', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 140))
  const H = { in: 'header' }
  const ACCENT = '#5b6cf0'
  const SUB = '#5b6478'
  const exact = (t: string) => new RegExp(`^${t.replace(/[|\\]/g, '\\$&')}$`)
  const txt = async (text: string) => { const p = (await ui.find({ type: 'Text', text: exact(text), ...H }))?.props ?? {}; return { ...p, bold: Boolean(p.bold), underline: Boolean(p.underline) } }
  expect(await ui.find({ key: 'p-SVC' })).toBeUndefined() // no header Buttons where the Client draws it
  // active tab: bold + underline + accent; inactive: sub, plain
  const underlined = async () => nodes(await ui.drawn(H), n => n.type === 'Text' && n.props?.underline).map(n => n.children.join(''))
  expect(await underlined()).toEqual(['全部'])
  expect([(await txt('全部')).bold, (await txt('全部')).color]).toEqual([true, ACCENT])
  expect([(await txt('SVC 重写')).bold, (await txt('SVC 重写')).underline, (await txt('SVC 重写')).color]).toEqual([false, false, SUB])
  // the decide count follows its tab in the decide color
  expect((await txt(' 1')).color).toBe('#d9777a')
  await hdr(ui, 'proj', 'SVC')
  expect(await underlined()).toEqual(['SVC 重写'])
  expect(await ui.find({ key: 'board-SVC' })).toBeDefined()
  expect(await ui.find({ key: 'board-ME' })).toBeUndefined()
  await hdr(ui, 'proj', 'ALL')
  expect(await ui.find({ key: 'board-ME' })).toBeDefined()
  // filter: on = bold + accent, off = sub
  expect([(await txt('只看等我的')).bold, (await txt('只看等我的')).color]).toEqual([false, SUB])
  await hdr(ui, 'filter', 'me')
  expect([(await txt('只看等我的')).bold, (await txt('只看等我的')).color]).toEqual([true, ACCENT])
  expect(await ui.find({ key: 'board-SVC' })).toBeUndefined()
  await hdr(ui, 'filter', 'me')
  expect(await ui.find({ key: 'board-SVC' })).toBeDefined()
  // segments: the active one bold in the text color
  expect((await txt('看板')).bold).toBe(true)
  await hdr(ui, 'seg', 'feed')
  expect([(await txt('动态')).bold, (await txt('看板')).bold]).toEqual([true, false])
  expect(await ui.find({ key: 'board-SVC' })).toBeUndefined()
  await hdr(ui, 'seg', 'board')
  expect(await ui.find({ key: 'board-SVC' })).toBeDefined()
  // theme and lang
  expect(await ui.find({ type: 'Text', text: '跟随 Claude', ...H })).toBeDefined()
  await hdr(ui, 'theme')
  expect(await ui.find({ type: 'Text', text: '浅色', ...H })).toBeDefined()
  await hdr(ui, 'lang')
  expect(await ui.find({ type: 'Text', text: 'Board', ...H })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Light', ...H })).toBeDefined()
  await hdr(ui, 'lang')
  await hdr(ui, 'theme')
  await hdr(ui, 'theme')
  // search: no box; a click puts a caret after the text, keys type, backspace deletes, return leaves
  expect(await ui.find({ type: 'Text', text: '搜索…', ...H })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await hdr(ui, 'search')
  expect(await ui.find({ type: 'Text', text: '|', ...H })).toBeDefined()
  for (const key of 'T-42') await ui.key({ key, ...H })
  expect(await ui.find({ type: 'Text', text: 'T-42|', ...H })).toBeDefined()
  expect(await ui.find({ key: 'board-ME' })).toBeUndefined()
  await ui.key({ key: 'backspace', ...H })
  expect(await ui.find({ type: 'Text', text: 'T-4|', ...H })).toBeDefined()
  await ui.key({ key: 'return', ...H })
  expect(await ui.find({ type: 'Text', text: 'T-4', ...H })).toBeDefined() // the query stays, the caret goes
  await ui.key({ key: 'x', ...H }) // not editing: ignored
  expect(await ui.find({ type: 'Text', text: 'T-4', ...H })).toBeDefined()
  await hdr(ui, 'search')
  for (const _ of 'T-4') await ui.key({ key: 'backspace', ...H })
  await ui.key({ key: 'return', ...H })
  expect(await ui.find({ key: 'board-ME' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '搜索…', ...H })).toBeDefined()
  await expectNoEmoji(ui, ['header'])
  await ui.unmount()
})

// Labels sit on the card's meta row after the priority, so the title keeps its rows; they are cut before the key and priority are.
test('card meta row shows labels; the title height is the card\'s own row count', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: '[T-42] 登录页面', priority: 'P1', labels: ['特性', '缺陷'] }) // SVC-1
  await call({ action: 'create', title: '标签很多', col: 'todo', priority: 'P2', labels: ['特性', '缺陷', '长长长长长长的标签', 'phase-1', 'hold'] }) // SVC-2
  for (const cols of [140, 60]) {
    const ui = await $.ui.mount(PANE('desktop', cols))
    const cards = cardBoxes(await ui.drawn({ in: 'board-SVC' }))
    expect(cards.length).toBe(2)
    for (const c of cards) {
      const [title, meta] = c.children[1].children
      expect(title.props.height).toBe(1) // short titles: one row
      expect(JSON.stringify(title)).not.toContain('#特性')
      const left = meta.children[0].children.map((n: any) => n.children.join(''))
      expect(left[0]).toMatch(/^SVC-\d$/)
      expect(left[1]).toMatch(/^ P\d $/)
      expect(left[2]).toMatch(/^#特性/)
    }
    const labelsOf = (key: string) => cards.find(c => JSON.stringify(c).includes(key))!.children[1].children[1].children[0].children[2].children.join('')
    // 140 cols: a 22-cell column leaves 8 cells after the key and P1, so the labels are cut; the 56-cell grid card fits two
    expect(labelsOf('SVC-1')).toBe(cols > 100 ? '#特性 #…' : '#特性 #缺陷')
    expect(labelsOf('SVC-2').endsWith('…')).toBe(true)
    await ui.unmount()
  }
})

// Desktop: the board title is a Markdown heading (the one element the desktop draws larger); the header Client then
// opens with the meta line. Terminal: no Markdown title, the bold title stays on the header's first row.
for (const [surface, big] of [['desktop', true], ['terminal', false]] as const) {
  test(`board title on ${surface}: ${big ? 'Markdown heading above the header' : 'bold title in the header'}`, async ($: any, on: any) => {
    await seed($, on, surface)
    const ui = await $.ui.mount(PANE(surface, 60))
    const tree = JSON.stringify(await ui.drawn())
    const header = await ui.find({ key: 'header' })
    const lay = headerLayout(header.props.props, header.props.width as number)
    const row0 = lay.items.filter(it => it.y === 0).map(it => it.kind)
    if (big) {
      expect(tree).toContain('"## ')
      expect(row0).toContain('meta')
      expect(row0).not.toContain('title')
    } else {
      expect(tree).not.toContain('"## ')
      expect(row0).toContain('title')
    }
    await ui.unmount()
  })
}

// WB-26: the desktop page refuses a Client tree whose Link href is not spelled as new URL(href).href (the mount does not
// check it), and then draws only the fallback header. Every Link the header Client draws keeps the canonical spelling.
test('the header Client on desktop draws Links the page accepts', async ($: any, on: any) => {
  await seed($, on, 'desktop')
  const ui = await $.ui.mount(PANE('desktop', 60))
  const links: any[] = []
  const walk = (n: any) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === 'Link') links.push(n.props); Object.values(n.props ?? {}).forEach(walk); walk(n.children) }
  walk(await ui.drawn({ in: 'header' }))
  expect(links.length).toBeGreaterThan(0)
  for (const l of links) expect(l.href).toBe(new URL(l.href).href)
  await ui.unmount()
})

// WB-28: canceling is the person's call. Claude only proposes (decide + a reason); the person confirms or keeps it on the board,
// cancels any ticket, and restores a canceled one to where it was.
// The board Client's own props, and a click on one of the popup's act buttons (after 打开详情) by its label.
const boardOf = async (ui: any, lane = 'board-SVC') => (await ui.find({ key: lane })).props
const actBtn = async (ui: any, label: string, lane = 'board-SVC') => {
  const c = await boardOf(ui, lane)
  const p = c.props
  const g = peekGeo(c.width, boardHeight(p.cols, p.colW, p.grid), p.peek.open, p.grid ? 2 : 4, p.peek.acts.map((a: any) => a.label))
  const i = p.peek.acts.findIndex((a: any) => a.label === label)
  if (i < 0) throw new Error(`no act ${label}`)
  await click(ui, g.left + g.acts[i].x0 + 1, g.top + g.btn.y, lane)
}

test('WB-28: Claude cancel lands in decide with a reason; the person keeps, confirms, cancels, restores; userAccepted passes', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = async (x: any) => String((await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })).result)
  const log = () => files.get(LOG) as string
  await call({ action: 'create', title: 'A', col: 'follow' }) // SVC-1
  await call({ action: 'create', title: 'B', col: 'todo' }) // SVC-2
  // no reason: refused, nothing moves
  expect(await call({ action: 'update', key: 'SVC-1', col: 'canceled' })).toContain('没改')
  expect(log()).not.toContain('"col":"decide"')
  // with one: a proposal in 等我拍板, never canceled
  expect(await call({ action: 'update', key: 'SVC-1', col: 'canceled', comment: '需求撤了' })).toContain('已提议取消，等用户在看板确认')
  expect(log()).toContain('"key":"SVC-1","col":"decide","text":"Claude 建议取消"')
  expect(log()).toContain('"proposeCancel":{"reason":"需求撤了","from":"follow"}')
  expect(log()).not.toContain('"col":"canceled"')

  // wide board: the proposed card's meta row carries 确认取消 / 保留; 保留 sends it back to 待跟进
  const ui = await $.ui.mount(PANE('desktop', 140))
  const [ok, keep] = proposeHits({ x: 0, y: HEAD_H, h: SHORT }, '确认取消', '保留') // SVC-1 is 等我拍板's only card
  expect([ok.x0, ok.y, keep.x0]).toEqual([2, HEAD_H + SHORT - 1, 11]) // after the ▎ and 1 cell of padding, on the card's last (meta) row
  expect(await ui.find({ type: 'Text', text: '确认取消', in: 'board-SVC' })).toBeDefined()
  await click(ui, keep.x0, keep.y)
  expect(log()).toContain('"key":"SVC-1","col":"follow","text":"你保留"')
  expect(await ui.find({ type: 'Text', text: '确认取消', in: 'board-SVC' })).toBeUndefined() // the move cleared the proposal
  // proposed again (note as the reason); 确认取消 cancels with Claude's reason
  await call({ action: 'update', key: 'SVC-1', col: 'canceled', note: '重复了' })
  await click(ui, ok.x0 + 1, ok.y)
  expect(log()).toContain('"key":"SVC-1","col":"canceled","by":"me","text":"重复了"')
  // canceled folds like done: header and count, no card until expanded
  expect(await ui.find({ type: 'Text', text: '已取消', in: 'board-SVC' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A', in: 'board-SVC' })).toBeUndefined()
  const colW = (await boardOf(ui)).props.colW
  await click(ui, 6 * (colW + 1) + colW - 2, 0) // the toggle on 已取消's header row
  expect(await ui.find({ type: 'Text', text: 'A', in: 'board-SVC' })).toBeDefined()
  // its popup: 恢复 sends it back to the column it left before the proposal
  await click(ui, 6 * (colW + 1) + 3, 3)
  await actBtn(ui, '恢复')
  expect(log()).toContain('"key":"SVC-1","col":"follow","text":"你恢复"')
  // the feed says who canceled what, and why
  await hdr(ui, 'seg', 'feed')
  expect(await ui.find({ type: 'Text', text: /你取消了「A」：重复了/ })).toBeDefined()
  await hdr(ui, 'seg', 'board')
  // any ticket: the popup's 取消工单 (no reason), then the detail's reason box, then 恢复
  await click(ui, 1 * (Math.floor((140 - 4) / 6) + 1) + 3, 3) // SVC-2 in 待开工
  await actBtn(ui, '取消工单')
  expect(log()).toContain('"key":"SVC-2","col":"canceled","by":"me","text":""')
  await actBtn(ui, '恢复') // the popup stays open on the ticket's new state
  const restored = () => log().split('\n').filter(l => l.includes('"key":"SVC-2","col":"todo","text":"你恢复"')).length
  expect(restored()).toBe(1)
  await openBtn(ui, 140)
  await ui.input({ key: 'cancel-reason', text: ' 不做了 ' })
  expect(log()).toContain('"key":"SVC-2","col":"canceled","by":"me","text":"不做了"')
  await ui.press({ key: 'restore' })
  expect(restored()).toBe(2)
  await expectNoEmoji(ui)
  await ui.unmount()

  // the person said so in chat: userAccepted cancels at once, with the reason
  expect(await call({ action: 'update', key: 'SVC-2', col: 'canceled', userAccepted: true, comment: '用户说不做了' })).not.toContain('已提议取消')
  expect(log()).toContain('"key":"SVC-2","col":"canceled","by":"me","text":"用户说不做了"')
})

test('WB-28: the detail and the narrow grid confirm / keep a proposal', async ($: any, on: any) => {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  const files: any = memfs(on)
  await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
  const call = (x: any) => $.tool.call({ tool: 'mcp__cc-taskboard__ticket', ...x })
  await call({ action: 'create', title: 'A', col: 'doing' }) // SVC-1
  await call({ action: 'update', key: 'SVC-1', col: 'canceled', comment: 'dup' })
  const ui = await $.ui.mount(PANE('desktop', 60))
  // grid: SVC-1 is the only card, in the 等我拍板 section
  const c = gridLayout([{ id: 'decide', cards: [{ key: 'SVC-1' }] }], 56).sections[0].cards[0]
  const [, keep] = proposeHits(c, '确认取消', '保留')
  await click(ui, keep.x0, keep.y)
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"doing","text":"你保留"')
  await call({ action: 'update', key: 'SVC-1', col: 'canceled', comment: 'dup' })
  await click(ui, 3, c.y) // the title row: the meta row's left side is the two words
  await openBtn(ui, 60)
  expect(await ui.find({ type: 'Text', text: /Claude 建议取消：dup/ })).toBeDefined()
  await ui.press({ key: 'confirm-cancel' })
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"canceled","by":"me","text":"dup"')
  expect(await ui.find({ key: 'restore' })).toBeDefined()
  await ui.unmount()
})

for (const cols of [140, 60]) {
  test(`WB-28: while a card is dragged a row without cards is a drop bar for 已取消 (${cols})`, async ($: any, on: any) => {
    on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
    const files: any = memfs(on)
    await $.session.start({ cwd: `${HOME}/web-app`, surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'mcp__cc-taskboard__ticket', action: 'create', title: 'A', col: 'follow' }) // SVC-1
    const ui = await $.ui.mount(PANE('desktop', cols))
    const p = (await boardOf(ui)).props
    const bar = dropBarY(p.grid)
    const x = cols > 100 ? 3 * (p.colW + 1) + 3 : 3 // 待跟进, or the grid's only card
    expect(await ui.find({ type: 'Text', text: / 放到 已取消 /, in: 'board-SVC' })).toBeUndefined() // only while dragging
    await ui.pointer({ type: 'down', x, y: 2, button: 'left', in: 'board-SVC' })
    await ui.pointer({ type: 'move', x, y: bar, button: 'left', in: 'board-SVC' })
    expect(await ui.find({ type: 'Text', text: / 放到 已取消 /, in: 'board-SVC' })).toBeDefined()
    await ui.pointer({ type: 'up', x, y: bar, button: 'left', in: 'board-SVC' })
    expect(files.get(LOG)).toContain('"key":"SVC-1","col":"canceled","by":"me","text":""')
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
  expect(await ui.find({ key: 'board-SVC' })).toBeUndefined() // archived: off the board
  await hdr(ui, 'search')
  for (const key of 'SVC-1') await ui.key({ key, in: 'header' })
  expect(await ui.find({ type: 'Text', text: '旧需求', in: 'board-SVC' })).toBeDefined() // the search opens 已取消
  const colW = (await boardOf(ui)).props.colW
  await click(ui, 6 * (colW + 1) + 3, 3)
  await actBtn(ui, '恢复')
  expect(files.get(LOG)).toContain('"key":"SVC-1","col":"doing","text":"你恢复"')
  await ui.unmount()
})
