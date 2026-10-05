import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Col, Lang, Priority, Resolved, Sess, Ticket, View } from '../types'
import {
  BAD, DATA_DIR, LEGACY_DATA_DIR, COL_IDS, COLS, DUE, I18N, MUTE, OK, PRIORITIES, PRIORITY_COLOR, PROJECTS, WARN,
  LIVE_MS, ago, archivedCanceled, boardForWeek, cancelEv, cells, clean, clip, colOf, days, descOf, dueColor, dueIn, fold, hhmm, isOpen, isoWeek, keepTo, md, missingLang, openBlockers, ownerOf, parseLabels, parseLines, planInit, projectFor, projectsJson, projName, projOf, resolveTheme, restoreTo, scanRow, scanText, setProjects, sessionTitle, splitCode, staleTitles, titleKey, titleOf, tl, weeksBack,
} from './core.ts'
import type { Ev, InitPlan, K, ScanRow } from './core.ts'

// The tests import these from here.
export { boardForWeek, dayLabel, fold, ownerOf, resolveTheme, sessionTitle, splitCode, weeksBack } from './core.ts'

// Paths under HOME, resolved once at session.start (resolvePaths) before anything reads them.
let DATA = ''
// The Claude desktop app's config.json (theme) and its session files (init wizard, session titles); macOS layout.
let APP_CONFIG = ''
let APP_SESSIONS = ''
async function resolvePaths($: $) {
  const home = (await $.env.get('HOME')) ?? ''
  const own = `${home}/${DATA_DIR}`
  const legacy = `${home}/${LEGACY_DATA_DIR}`
  DATA = (await $.env.get('CC_TASKBOARD_DATA')) || (!(await $.fs.exists(own)) && (await $.fs.exists(legacy)) ? legacy : own)
  APP_CONFIG = `${home}/Library/Application Support/Claude/config.json`
  APP_SESSIONS = `${home}/Library/Application Support/Claude/claude-code-sessions`
}
const PANE = 'cc-taskboard'
const TOOL = 'mcp__cc-taskboard__ticket'
const WEB = 'http://127.0.0.1:4790'
// Link refuses 127.0.0.1 (https or http://localhost only); the server binds IPv4 loopback, which localhost reaches.
// Spelled as new URL(href).href (trailing slash): the desktop page refuses a Client tree with any other spelling (WB-26).
const WEB_LINK = 'http://localhost:4790/'

// Current UI language: session.start loads it from the store, the EN / 中文 button flips it.
let lang: Lang = 'zh'
const t = (key: K, ...args: (string | number)[]) => tl(lang, key, ...args)
// The pane always follows the Claude app's theme (its config.json, else the OS): the app draws the pane background and every Button label
// in its own theme, so a theme of the plugin's own would put light text on a light tint (WB-29). The web UI keeps its own switch.
let resolved: Resolved = 'light'
// The board's surface colors per theme: row tint (hover, open preview; warm grey in the app's own hue, Fan picked it), text levels, accent, live (a session is working it).
const SURFACE: Record<Resolved, { tint: string; text: string; sub: string; mute: string; accent: string; live: string }> = {
  light: { tint: '#f4f3ef', text: '#1f2a44', sub: '#5b6478', mute: '#8b93a3', accent: '#5b6cf0', live: '#3f9a6b' },
  dark: { tint: '#262624', text: '#e3e6ec', sub: '#a6adbb', mute: '#7c8496', accent: '#8c99ff', live: '#62c08f' },
}
const cn = (id: Col) => t(`col.${id}` as K)
const pn = (id: string) => projName(lang, id)
// What Claude reads (prompts, session titles) stays Chinese, falling back to the English title.
const zhTitle = (tk: Ticket) => titleOf(tk, 'zh')


// Markdown to plain words for the preview: drop heading marks, bullets, emphasis and backticks, keep the text.
const plain = (md: string) =>
  md.split('\n').map(l => clean(l.replace(/[*`]/g, '').replace(/^\s*(#+|[-+])\s+/, ''))).filter(Boolean)

const EMPTY: Board = { tickets: [], sessions: [], feed: [], weekStart: 0, commitsThisWeek: 0, createdThisWeek: 0 }
const board = atom({ plugin: 'cc-taskboard', key: 'board' } as const, EMPTY)
const view = atom({ plugin: 'cc-taskboard', key: 'view' } as const, { proj: 'ALL', tab: 'board', sel: null } as View)




type $ = EngineInterface

// Switching project / week / tab drops an open preview.
const patchView = ($: $, patch: Partial<View>) =>
  update($, view, cur => ({ ...cur, ...patch, ...('proj' in patch || 'week' in patch || 'tab' in patch ? { peek: null } : {}) }))

// Module state: restarts on each reload; session.start rebuilds it from disk.
let sid = ''
let me: Sess = { sid: '', cwd: '', name: '', project: null, seen: 0, state: 'idle' }
let mine: Ev[] = []
let all: Ev[] = []
let lastJson = ''
let lastBoard: Board | null = null
let briefed = false
let lastBrief = Date.now()
// The board docks itself in the pane sidebar; closing it by hand keeps it closed for the rest of the session.
let paneWanted = true
// Sessions the board spawned (their first prompt starts with 「认领 <KEY>」), listed in a shared file.
const spawned = () => `${DATA}/spawned.json`
const spawnedList = ($: $) => $.fs.read(spawned()).then(t => JSON.parse(t) as string[]).catch(() => [] as string[])
async function isSpawned($: $) {
  return (await spawnedList($)).includes(sid)
}
async function markSpawned($: $) {
  const list = await spawnedList($)
  if (!list.includes(sid)) await $.fs.write(spawned(), JSON.stringify([...list, sid]))
}
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>) {
  return (chain = chain.then(fn, fn)) as Promise<T>
}

// Boards live in projects.json (init writes it); re-read with the logs so a fresh init shows up in every session.
async function loadProjects($: $) {
  const text = await $.fs.read(`${DATA}/projects.json`).catch(() => '')
  if (text) try { setProjects(JSON.parse(text)) } catch {}
  if (me.cwd && !me.project) me.project = projectFor(me.cwd)
}

async function loadAll($: $) {
  await loadProjects($)
  const evs: Ev[] = []
  const sessions: Sess[] = []
  for (const [dir, into] of [['events', evs], ['sessions', sessions]] as const) {
    if (!(await $.fs.exists(`${DATA}/${dir}`))) continue
    for (const f of await $.fs.list(`${DATA}/${dir}`)) {
      const text = await $.fs.read(`${DATA}/${dir}/${f.name}`).catch(() => '')
      if (dir === 'events') evs.push(...parseLines(text))
      else try { sessions.push(JSON.parse(text)) } catch {}
    }
  }
  all = evs
  return { evs, sessions }
}

// The person's comment wakes the session that owns the ticket: its own mod submits a prompt, which runs
// as soon as the session is idle. Each comment is handled once (wokeUntil), by one session (ownerOf).
// Called from the 5 s timer and turn.complete only: the engine refuses prompt.submit inside a tool.call.
async function wakeOnComments($: $, b: Board) {
  const fresh = all.filter(x => x.k === 'comment' && x.by === 'me' && x.t > (me.wokeUntil ?? 0))
  if (!fresh.length) return
  me.wokeUntil = Math.max(...fresh.map(x => x.t))
  await saveSess($)
  const mine = fresh
    .map(ev => ({ ev, tk: findTicket(b.tickets, ev.key) }))
    .filter(({ tk }) => tk && ownerOf(tk, b.sessions, Date.now()) === sid)
  if (!mine.length) return
  lastBrief = Date.now() // delivered here; don't repeat them as next-prompt context
  const lines = mine.map(({ ev, tk }) => `- ${tk?.key}「${tk && zhTitle(tk)}」：${ev.text}`)
  await $.prompt.submit({ text: `[cc-taskboard] 用户在看板上给你负责的 ticket 留了评论，请按评论处理：先用 mcp__cc-taskboard__ticket action:update key:<KEY> work:true 认领，做完用 comment 回复用户做了什么，并移到 review。\n${lines.join('\n')}` })
  $.ui.toast(t('toast.woke', mine.map(x => x.tk?.key).join(', ')))
}

async function refresh($: $) {
  const { evs, sessions } = await loadAll($)
  await loadAgents($)
  const known = sessions.map(s => {
    const a = agents.get(s.sid)
    if (!agents.size) return s
    return { ...s, label: a?.name || undefined, isGone: !a, state: !a ? 'idle' : a.status === 'busy' ? 'run' : s.state === 'wait' ? 'wait' : 'idle' } as Sess
  })
  const next = fold(evs, known, Date.now(), lang)
  const json = JSON.stringify(next)
  if (json !== lastJson) {
    const before = new Map((lastBoard?.tickets ?? []).map(t => [t.key, t.col]))
    for (const t of lastBoard ? next.tickets : []) {
      const was = before.get(t.key)
      if (!was || was === t.col) continue
      const by = evs.filter(x => x.key === t.key && x.k === 'move').reduce((a, x) => (x.t > a.t ? x : a))
      if (by.sid !== sid) $.ui.toast(tl(lang, 'toast.moved', t.key, cn(t.col), next.sessions.find(x => x.sid === by.sid)?.name ?? tl(lang, 'toast.other')))
    }
    lastJson = json
    lastBoard = next
    await update($, board, () => next)
  }
}

async function setLang($: $, next: Lang) {
  lang = next
  await $.store.set('lang', next)
  await update($, view, cur => ({ ...cur, lang: next }))
  lastJson = ''
  await refresh($)
}

// The app's theme, read at session.start and at most every 30 s after: config.json userThemeMode, and for `system` the macOS appearance.
let appMode: string | undefined
let appDark = false
let themeAt = 0
async function readAppTheme($: $) {
  themeAt = Date.now()
  appMode = await $.fs.read(APP_CONFIG).then(x => JSON.parse(x).userThemeMode as string).catch(() => undefined)
  appDark = false
  if (appMode !== 'light' && appMode !== 'dark') {
    const r = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 3000 }).catch(() => null)
    appDark = r?.exitCode === 0 && r.stdout.includes('Dark')
  }
}
async function applyTheme($: $) {
  resolved = resolveTheme(appMode, appDark)
  await update($, view, cur => ({ ...cur, themeResolved: resolved }))
}
// From the 5 s timer: cheap unless 30 s passed; redraws only when the resolved theme changed.
async function checkTheme($: $) {
  if (Date.now() - themeAt < 30_000) return
  const before = resolved
  await readAppTheme($)
  if (resolveTheme(appMode, appDark) !== before) await applyTheme($)
}

function saveSess($: $) {
  return serial(() => $.fs.write(`${DATA}/sessions/${sid}.json`, JSON.stringify({ ...me, seen: Date.now() })))
}

async function emit($: $, ev: Omit<Ev, 't' | 'sid'>) {
  mine.push({ ...ev, t: Date.now(), sid })
  await serial(() => $.fs.write(`${DATA}/events/${sid}.jsonl`, mine.map(e => JSON.stringify(e)).join('\n') + '\n'))
  await refresh($)
}

// The person's comment, from the detail or the inline preview: one event, which also wakes the ticket's session.
const sendComment = ($: $, key: string, text: string) => (text.trim() ? emit($, { k: 'comment', key, by: 'me', text: text.trim() }) : undefined)

const current = (): Ticket | undefined => (me.ticket ? findTicket(fold(all, [], Date.now()).tickets, me.ticket) : undefined)
const findTicket = (list: Ticket[], key?: string) => list.find(t => t.key === key || (key !== undefined && t.aliases?.includes(key)))

// Branch and worktree of the session's checkout, recorded on the ticket it works.
async function linkHere($: $, tk: { key: string; branch?: string; worktree?: string }) {
  const git = (args: string[]) =>
    $.process.run(['git', '-C', me.cwd, ...args], { timeoutMs: 3000 }).then(r => (r.exitCode === 0 ? r.stdout.trim() : '')).catch(() => '')
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const worktree = await git(['rev-parse', '--show-toplevel'])
  const meta = { ...(branch && branch !== tk.branch ? { branch } : {}), ...(worktree && worktree !== tk.worktree ? { worktree } : {}) }
  if (Object.keys(meta).length) await emit($, { k: 'meta', key: tk.key, meta })
}

// Real session titles and liveness, desktop sessions included.
// ponytail: every session polls `claude agents` every 15 s; one shared poller if that ever shows up in CPU
let agents = new Map<string, { name: string; status: string }>()
let agentsAt = 0
async function loadAgents($: $) {
  if (Date.now() - agentsAt < 15_000) return
  agentsAt = Date.now()
  const r = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 8000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return
  try {
    const list = JSON.parse(r.stdout) as { sessionId: string; name?: string; status?: string }[]
    agents = new Map(list.map(a => [a.sessionId, { name: a.name ?? '', status: a.status ?? '' }]))
  } catch {}
}

// Starts the local web server if nothing answers its ping; detached (all stdio redirected) so the call returns at once. Errors are ignored.
async function ensureWeb($: $) {
  // ponytail: the test runner executes real processes (not stubbed), so a dev copy must not leave a server running on live data
  if ($.plugin.root.includes('/dev-mods/')) return
  const server = `${$.plugin.root}/web/server.ts`
  // deno from PATH, else its installer's default location; the server gets the resolved data dir.
  const deno = `$(command -v deno || echo "$HOME/.deno/bin/deno")`
  const sh = `if ! curl -s --max-time 1 ${WEB}/api/ping >/dev/null 2>&1; then mkdir -p '${DATA}'; CC_TASKBOARD_DATA='${DATA}' nohup "${deno}" run --allow-read --allow-write --allow-env --allow-net=127.0.0.1 --allow-run=claude,defaults '${server}' >> '${DATA}/web.log' 2>&1 </dev/null & fi`
  await $.process.run(['/bin/sh', '-c', sh], { timeoutMs: 5000 }).catch(() => null)
}

async function openPane($: $) {
  if (!paneWanted || (await $.ui.panes()).some(p => p.id === PANE)) return
  await refresh($)
  await $.ui.open({ id: PANE, title: t('pane.title') })
}

async function setState($: $, state: Sess['state']) {
  if (me.state === state) return
  me.state = state
  await saveSess($)
  await refresh($)
}

async function move($: $, key: string, col: Col, why: string) {
  await emit($, { k: 'move', key, col, text: why })
}
// Only the person cancels (WB-28): a drag or status pick into 已取消, the 取消工单 button, a confirmed proposal; the reason may be empty.
const cancel = ($: $, key: string, reason = '') => emit($, cancelEv(key, reason))
// The person's buttons on a ticket: cancel (with an optional reason), confirm / keep Claude's proposal, restore a canceled one.
async function ticketAct($: $, act: string, key: string, reason = '') {
  await loadAll($)
  const tk = findTicket(fold(all, [], 0).tickets, key)
  if (!tk) return
  if ((act === 'cancel' || act === 'confirm') && tk.col !== 'canceled') await cancel($, tk.key, act === 'confirm' ? tk.proposeCancel?.reason : reason)
  if (act === 'keep' && tk.proposeCancel) await move($, tk.key, keepTo(tk), '你保留')
  if (act === 'restore' && tk.col === 'canceled') await move($, tk.key, restoreTo(tk), '你恢复')
}

// Has this session's Claude prepare a new session for a ticket: spawn_task leaves a chip the person clicks to enter, or ignores.
const spawnPrompt = (tk: Ticket) =>
  `为 ${tk.key}「${zhTitle(tk)}」开一个新 session：调用 mcp__ccd_session__spawn_task，title 用「${sessionTitle(tk.key, zhTitle(tk), 'doing', [Date.now()])}」，cwd 用这张票实际所在的、有提交的 git 仓库根目录（先看要点、描述和分支里的路径，没有再用「${tk.worktree || projOf(tk.project)?.root || me.cwd}」；上层目录如果是还没有提交的 git 仓库，开不了 worktree，不能用，要选这张票真正所在的仓库），先用 git status 看相关材料有没有提交——worktree 里只有已提交的文件，未提交的要在 prompt 里写明原目录绝对路径、并叮嘱不要 git add；prompt 第一句写「认领 ${tk.key}：先调用 mcp__cc-taskboard__ticket action:update key:${tk.key} work:true，再看 ticket 描述和评论开工」，后面附上描述、要点和最近评论。`

// The person moving a ticket in the pane. Starting one (待开工 → 进行中) also readies a new session for it,
// unless a session is already working it; Claude's own moves (认领, edits) never spawn. Web moves: spawnForWebStarts.
// The same for a ticket the person starts on the web board: the web server has no Claude behind it, so one session
// picks it up — the ticket's owner, else the most recently seen live session. Each move is looked at once (webUntil).
// Runs where wakeOnComments runs (timer, turn.complete): prompt.submit is refused inside a tool.call.
// ponytail: "most recently seen" is a guess at where the person is looking; the chip lands in that session
async function spawnForWebStarts($: $, b: Board) {
  const fresh = all.filter(x => x.k === 'move' && x.sid === 'web' && x.col === 'doing' && x.t > (me.webUntil ?? 0))
  if (!fresh.length) return
  me.webUntil = Math.max(...fresh.map(x => x.t))
  await saveSess($)
  const now = Date.now()
  const live = b.sessions.filter(s => !s.isGone && now - s.seen < LIVE_MS).sort((x, y) => y.seen - x.seen)
  for (const ev of fresh) {
    const was = findTicket(fold(all.filter(x => x.t < ev.t), [], ev.t).tickets, ev.key)
    const tk = findTicket(b.tickets, ev.key)
    if (!was || !tk || was.col !== 'todo' || tk.col !== 'doing') continue
    if (b.sessions.some(s => s.ticket === tk.key && s.state !== 'idle' && !s.isGone)) continue
    if ((ownerOf(tk, b.sessions, now) ?? live[0]?.sid) !== sid) continue
    await $.prompt.submit({ text: spawnPrompt(tk) })
    $.ui.toast(t('toast.spawn', tk.key))
  }
}

async function personMove($: $, key: string, col: Col, why: string) {
  if (col === 'canceled') return ticketAct($, 'cancel', key)
  await loadAll($)
  const tk = findTicket(fold(all, [], Date.now()).tickets, key)
  await move($, key, col, why)
  if (!tk || tk.col !== 'todo' || col !== 'doing') return
  if ((await read($, board)).sessions.some(s => s.ticket === tk.key && s.state !== 'idle')) return
  await $.prompt.submit({ text: spawnPrompt(tk) })
  $.ui.toast(t('toast.spawn', tk.key))
}


// Desktop sessions as the app stores them (APP_SESSIONS/<org>/<user>/local_*.json); the init wizard reads the newest 50.

// WB-24: a spawned session's title follows its ticket wherever the move came from. A mod can title only its own
// session, at its next prompt (classic.UserPromptSubmit), so one session's Claude calls set_session_title for all of
// them, running or not: Claude moving it through the tool renames right away (the tool's answer lists them); the
// person's moves wake one session from the timer / turn.complete: the one whose pane moved it, else (web) the
// ticket's owner or the newest live session. Each title is asked for once per session that asks (asked).
// ponytail: asked is per process; a reload may ask once more for a rename that failed
const asked = new Map<string, string>()
// A session's title as the desktop app holds it (undefined: not found, or archived).
async function appTitle($: $, app: string) {
  const ls = (p: string) => $.fs.list(p).catch(() => [] as { name: string }[])
  for (const org of await ls(APP_SESSIONS)) for (const user of await ls(`${APP_SESSIONS}/${org.name}`)) {
    const d = await $.fs.read(`${APP_SESSIONS}/${org.name}/${user.name}/${app}.json`).then(JSON.parse).catch(() => null)
    if (d) return !d.isArchived && typeof d.title === 'string' ? d.title as string : undefined
  }
}
// WB-30: the desktop app opens a session from its own link, claude://claude.ai/epitaxy/<local id> (list_sessions' `link`).
const APP_ID = /^local_[A-Za-z0-9-]{1,64}$/
// The desktop id of a CLI session, not archived: Sess.app when this plugin saw it start, else the app's local_<id>.json whose cliSessionId it is.
async function appIdOf($: $, cli: string, known?: string) {
  if (known && APP_ID.test(known)) return (await appTitle($, known)) === undefined ? undefined : known
  const ls = (p: string) => $.fs.list(p).catch(() => [] as { name: string }[])
  for (const org of await ls(APP_SESSIONS)) for (const user of await ls(`${APP_SESSIONS}/${org.name}`)) {
    const dir = `${APP_SESSIONS}/${org.name}/${user.name}`
    for (const f of await ls(dir)) {
      const id = f.name.replace(/\.json$/, '')
      if (!APP_ID.test(id)) continue
      const d = await $.fs.read(`${dir}/${f.name}`).then(JSON.parse).catch(() => null)
      if (d?.cliSessionId === cli) return d.isArchived ? undefined : id
    }
  }
}
// Switch the desktop app to the first of these CLI sessions it still has; a toast says which, or that none could open.
async function jumpTo($: $, sessions: Sess[]) {
  for (const s of sessions) {
    const app = await appIdOf($, s.sid, s.app)
    if (!app) continue
    const r = await $.process.run(['open', `claude://claude.ai/epitaxy/${app}`], { timeoutMs: 5000 }).catch(() => null)
    $.ui.toast(r?.exitCode === 0 ? t('toast.jump', s.label || s.name) : t('jump.fail'))
    return
  }
  $.ui.toast(t('jump.none'))
}
// WB-21: a new session for a ticket through the app's own link, claude://code/new?q=&folder=: the app switches to a new-session
// screen in the ticket's folder with the claim line typed in, and the person presses send. That first prompt, 「认领 <KEY>」,
// marks it spawned (markSpawned), so its title follows the ticket. The pane's own 进行中 moves still only leave a chip.
async function newSessionFor($: $, tk: Ticket) {
  const folder = tk.worktree || projOf(tk.project)?.root || me.cwd
  const q = `认领 ${tk.key}：先调用 mcp__cc-taskboard__ticket action:update key:${tk.key} work:true，再看 ticket 描述和评论开工。`
  const r = await $.process.run(['open', `claude://code/new?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(folder)}`], { timeoutMs: 5000 }).catch(() => null)
  $.ui.toast(r?.exitCode === 0 ? t('toast.spawn', tk.key) : t('spawn.fail'))
}
async function staleNow($: $, b: Board) {
  const spawned = await spawnedList($)
  const titles: Record<string, string> = {}
  for (const s of b.sessions) {
    const title = s.app && spawned.includes(s.sid) ? await appTitle($, s.app) : undefined
    if (title !== undefined) titles[s.sid] = title
  }
  return staleTitles(b, spawned, titles).filter(x => asked.get(x.sid) !== x.title)
}
const titleLines = (list: { sid: string; app: string; title: string }[]) => {
  for (const x of list) asked.set(x.sid, x.title)
  return list.map(x => `- session_id: ${x.app}  title: ${x.title}`).join('\n')
}
async function syncTitles($: $, b: Board) {
  if (me.state !== 'idle') return // a turn is on: its own tool answer, or turn.complete, covers it
  const now = Date.now()
  const live = b.sessions.filter(s => !s.isGone && now - s.seen < LIVE_MS).sort((x, y) => y.seen - x.seen)
  const lastMove = (key: string) => all.filter(x => x.k === 'move' && x.key === key).reduce<Ev | undefined>((a, x) => (!a || x.t > a.t ? x : a), undefined)
  const mine = (await staleNow($, b)).filter(x => {
    const by = lastMove(x.key)?.sid
    const tk = findTicket(b.tickets, x.key)
    return (by && live.some(s => s.sid === by) ? by : (tk && ownerOf(tk, b.sessions, now)) ?? live[0]?.sid) === sid
  })
  if (!mine.length) return
  await $.prompt.submit({ text: `[cc-taskboard] 看板上的工单状态变了，这些看板开出来的会话标题要跟着改：依次调用 mcp__ccd_session_mgmt__set_session_title（session_id 和 title 照抄），改完一句话说明即可，不要做别的。\n${titleLines(mine)}` })
}
async function scanSessions($: $, n = 50) {
  const rows: ScanRow[] = []
  const ls = (p: string) => $.fs.list(p).catch(() => [] as { name: string }[])
  for (const org of await ls(APP_SESSIONS)) for (const user of await ls(`${APP_SESSIONS}/${org.name}`)) {
    const dir = `${APP_SESSIONS}/${org.name}/${user.name}`
    for (const f of await ls(dir)) {
      if (!/^local_.*\.json$/.test(f.name)) continue
      const r = scanRow(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))
      if (r && r.sid !== sid) rows.push(r)
    }
  }
  return rows.sort((x, y) => y.last - x.last).slice(0, n)
}

// No plan: the scan. Plan: the preview. Plan + confirm: writes projects.json (when the plan has boards) and one
// events/init-<date>.jsonl, so a whole run can be undone by deleting that file.
async function initWizard($: $, plan?: InitPlan, confirm?: boolean) {
  const rows = await scanSessions($)
  if (!plan) return scanText(rows, all)
  const before = PROJECTS.slice()
  if (plan.projects) {
    const err = setProjects(plan.projects)
    if (err.length) return `方案不对：${err.join('；')}`
  }
  const r = planInit(plan, all, rows, Date.now())
  const boards = PROJECTS.map(p => `${p.id}=${p.name}${p.name_en ? `/${p.name_en}` : ''}（目录匹配 /${p.match.source}/）`).join('；')
  if (r.err.length || !confirm) {
    PROJECTS.splice(0, PROJECTS.length, ...before)
    if (r.err.length) return `方案不对：${r.err.join('；')}`
    return [`预览（还没写）。board：${boards}`, ...r.lines, '用户确认后带同一个 plan 和 confirm:true 再调一次。'].join('\n')
  }
  if (plan.projects) await serial(() => $.fs.write(`${DATA}/projects.json`, JSON.stringify(projectsJson(), null, 1) + '\n'))
  const d = new Date()
  const file = `${DATA}/events/init-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`
  const old = await $.fs.read(file).catch(() => '')
  if (r.evs.length) await serial(() => $.fs.write(file, old + r.evs.map(x => JSON.stringify(x)).join('\n') + '\n'))
  if (!me.project) me.project = projectFor(me.cwd)
  lastJson = ''
  await refresh($)
  return [`已写入${plan.projects ? ' projects.json 和' : ''} ${file}（${r.evs.length} 条事件；删掉这个文件即可整批撤销）。board：${boards}`, ...r.lines].join('\n')
}

export const register: Register = on => {
  // ---------- session ----------
  on('session.start', async ($, e, next) => {
    await resolvePaths($)
    sid = await $.session.id()
    lang = (await $.store.get('lang')) === 'en' ? 'en' : 'zh'
    await readAppTheme($)
    await applyTheme($)
    await update($, view, cur => ({ ...cur, lang }))
    const cwd = e.cwd
    await loadProjects($)
    const dirs = ((await $.store.get('dirs')) ?? {}) as Record<string, string>
    const project = dirs[cwd] ?? projectFor(cwd)
    const prev = await $.fs.read(`${DATA}/sessions/${sid}.json`).then(JSON.parse).catch(() => null)
    me = { sid, cwd, name: cwd.split('/').slice(-1)[0], project, seen: Date.now(), state: 'idle', ticket: prev?.ticket, days: prev?.days ?? [], wokeUntil: prev?.wokeUntil ?? Date.now(), webUntil: prev?.webUntil ?? Date.now(), app: (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID').catch(() => undefined)) || prev?.app }
    mine = parseLines(await $.fs.read(`${DATA}/events/${sid}.jsonl`).catch(() => ''))
    await saveSess($)
    await refresh($)

    for (const name of ['kanban', 'taskboard']) await $.command.register({ name, description: '打开任务看板（所有 session 的 ticket）' })
    await $.command.register({ name: 'kanban-web', description: '启动网页版任务看板并给出地址' })
    void ensureWeb($)
    await $.tool.register({
      name: 'ticket',
      description: [
        'cc-taskboard 任务看板的 ticket 工具，跨所有 Claude Code session 共享。',
        '粒度：一个 ticket = 一个可交付的功能 / 修复 / 文档任务，不要为小步骤建票。',
        '开始做一件具体的事之前：先 action:"list" 查有没有现成的；有就 action:"update" 带 work:true 认领，没有就 action:"create"。',
        '用户在对话里说「加到看板 / 记个 ticket」时 action:"create" 并带 src:"me"。',
        '状态（col）：decide 等用户拍板、todo 待开工、doing 进行中、follow 等别人（PR 评审、对方回复）、review 待审核、done 已完成、canceled 已取消（决定不做了）。',
        '做完一张票就移到 review（待审核）；done 只能由用户验收，你传 done 也会落到 review。',
        '取消也只能由用户决定：你传 canceled 会落到 decide（等我拍板）并标成「建议取消」，必须同时用 comment（或 note）写理由，用户在看板上确认取消或保留；用户在对话里明确说验收 / 取消时才带 userAccepted:true 直接生效。',
        '可写 desc（Markdown 描述）、priority（P0 最急 ~ P3）、comment（一条评论，用户在看板上看得到）。',
        '标题和描述是双语的：title / desc 写中文，title_en / desc_en 写英文。create 时、以及 update 改标题或描述时，两种语言必须同时给；用户用英文写的，你补中文进 title / desc。评论、要点不用翻译。',
        'labels 标签（如 缺陷 / 特性 / hold，整组替换）；due 截止日期 YYYY-MM-DD；blockedBy 被哪些 ticket 卡着（整组替换，卡点完成或取消后自动不再算阻塞）；parent 父 ticket（拆子任务时用）。传 "" 或 [] 清除。',
        `用户要为某张 ticket 开新 session 时：调用 mcp__ccd_session__spawn_task，title 用「【<今天的英文月日，如 Oct 3> - in progress】<KEY> <标题>」（session 命名惯例，例：${sessionTitle('APP-3', '[UI] 登录页改版', 'doing', [Date.now()])}），cwd 用这张票实际所在的、有提交的 git 仓库根目录（先看要点/描述/分支里的路径，没有再用项目默认：${PROJECTS.filter(p => p.root).map(p => `${p.id}=${p.root}`).join('，') || '无'}；上层目录如果是还没有提交的 git 仓库，开不了 worktree，不能用，要选这张票真正所在的仓库），新 session 的 worktree 只含已提交的文件，所以要在 prompt 里写明未提交材料的原目录绝对路径；prompt 第一句写「认领 <KEY>：先调用 mcp__cc-taskboard__ticket action:update key:<KEY> work:true，再看 ticket 描述和评论开工」，后面附上描述与要点。`,
        'git commit、gh pr create、gh pr merge、向用户提问会自动更新状态，不用手动改；其余变化（例如阻塞、搁置、完成但没走 PR）用 update 改 col。',
        '初始化向导（新装、或用户要按最近的 session 重建 / 补全看板时）：① action:"init" 不带 plan，拿最近 50 个 session 的扫描（标题、目录、分支、PR、app 记的状态摘要、已挂在哪张票）；② 归纳成方案：board 怎么分（默认每个项目 / 仓库一个；id 是编号前缀，match 是匹配 cwd 的正则）、一个 session 主题一张票、同主题已有票就挂上去、纯查询的跳过，按状态摘要定 col；③ 带 plan 调 init 拿预览，用 AskUserQuestion 给用户看并确认或调整；④ 用户确认后带同一个 plan 和 confirm:true 再调一次才写入。可重跑：已挂上的 session 会自动跳过。',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'init'] },
          key: { type: 'string', description: 'update 时必填，如 APP-12' },
          title: { type: 'string', description: '中文标题；create 必填（和 title_en 一起给）；update 时改标题' },
          title_en: { type: 'string', description: '英文标题，和 title 同时给' },
          col: { type: 'string', enum: COL_IDS },
          note: { type: 'string', description: '一句要点，追加到 ticket（最多保留 8 条）' },
          desc: { type: 'string', description: '中文 Markdown 描述，整段替换' },
          desc_en: { type: 'string', description: '英文 Markdown 描述，和 desc 同时给，整段替换' },
          priority: { type: 'string', enum: PRIORITIES },
          comment: { type: 'string', description: '一条评论，追加' },
          userAccepted: { type: 'boolean', description: '仅当用户在对话里明确说这张票验收通过（允许 col:done）或明确说取消（允许 col:canceled）时为 true' },
          work: { type: 'boolean', description: 'true = 本 session 现在在做这张票' },
          src: { type: 'string', enum: ['claude', 'me'], description: 'me = 用户明确要求加的' },
          project: { type: 'string', description: '当前目录未归属项目时必填（board 编号前缀，如 APP）；问用户后再填' },
          plan: {
            type: 'object',
            description: 'init 用：{ projects?: [{ id, name, name_en?, match, root?, color?, icon? }]（给了就整份替换 board 配置）, tickets?: [{ project, title, title_en, col, sids: [session id], desc?, desc_en?, note? }], links?: [{ key, sids, note? }] }',
          },
          confirm: { type: 'boolean', description: 'init 用：true = 用户已确认预览，写入' },
          q: { type: 'string', description: 'list 的关键词过滤（也匹配标签）' },
          labels: { type: 'array', items: { type: 'string' }, description: '标签，整组替换；[] 清空' },
          due: { type: 'string', description: '截止日期 YYYY-MM-DD；"" 清除' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: '被哪些 ticket 卡着（key），整组替换；[] 清除' },
          parent: { type: 'string', description: '父 ticket 的 key；"" 清除' },
        },
        required: ['action'],
      },
    })

    // A terminal REPL can seat it now (if wide enough); the desktop draws nothing until the first prompt.
    if (e.isInteractive && e.surface) void openPane($)
    $.clock.every(5_000, () => { void checkTheme($); void refresh($).then(async () => { if (lastBoard) { await wakeOnComments($, lastBoard); await spawnForWebStarts($, lastBoard); await syncTitles($, lastBoard) } }) })
    $.clock.every(60_000, () => void saveSess($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const today = new Date().setHours(0, 0, 0, 0)
    if (!(me.days ?? []).includes(today)) me.days = [...(me.days ?? []), today]
    if (/^认领 [A-Z]+-\d+/.test(e.text)) await markSpawned($)
    await setState($, 'run')
    // Opened while answering the person's prompt counts as asked, so it seats at any width.
    void openPane($)
    const tk = current()
    const proj = projOf(me.project)
    const lines = [
      `[cc-taskboard] 本 session 项目：${proj ? `${proj.id}（${proj.name}）` : PROJECTS.length ? `未归属（建票时要先问用户归到 ${PROJECTS.map(p => p.id).join(' / ')} 哪个）` : '看板还没初始化（没有 board）：先跑 ticket 工具的 action:"init" 向导'}；当前 ticket：${tk ? `${tk.key}「${zhTitle(tk)}」${colOf(tk.col).name}` : '无'}。`,
    ]
    await loadAll($)
    const mineKeys = new Set(fold(all, [], Date.now()).tickets.filter(t => t.sids.includes(sid)).map(t => t.key))
    const moved = all.filter(x => x.k === 'move' && x.t > lastBrief && (x.by === 'me' || x.text?.startsWith('你')) && mineKeys.has(x.key))
    if (moved.length) lines.push(`用户刚在看板上调整了本 session 做过的 ticket：${moved.map(x => `${x.key} → ${colOf(x.col ?? 'todo').name}（${hhmm(x.t)}）`).join('；')}。按这个调整接下来的工作。`)
    const said = all.filter(x => x.k === 'comment' && x.by === 'me' && x.t > lastBrief && mineKeys.has(x.key))
    if (said.length) lines.push(`用户在看板上给本 session 做过的 ticket 留了评论：${said.map(x => `${x.key}：${x.text}`).join('；')}。`)
    // Titles / descriptions with one language only (the person's own edits, or a Claude that skipped one): this session's tickets, and unowned ones of its project.
    // ponytail: two sessions of one project prompted together may both fill an unowned ticket; harmless, the later write wins
    const owner = (x: Ticket) => ownerOf(x, lastBoard?.sessions ?? [], Date.now())
    const half = (lastBoard?.tickets ?? []).filter(x => isOpen(x) && missingLang(x).length && (owner(x) === sid || (!owner(x) && x.project === me.project))).slice(0, 5)
    if (half.length) lines.push(`这些 ticket 的标题 / 描述还缺一种语言（多半是用户在看板上自己写的，语言不定）：${half.map(x => `${x.key}「${titleOf(x, 'zh')}」缺 ${missingLang(x).join('、')}`).join('；')}。顺手用 mcp__cc-taskboard__ticket update 补齐：title / desc 放中文，title_en / desc_en 放英文。`)
    lastBrief = Date.now()
    if (!briefed) lines.push('开始做一个具体功能 / 修复前，用 mcp__cc-taskboard__ticket 先 list 查重再 create 或认领（规则见工具说明）；用户说「加到看板」时直接 create。')
    briefed = true
    return next({ ...e, context: [...(e.context ?? []), lines.join('\n')] })
  })

  // A spawned session's title tracks its ticket: 【days - status】KEY topic, refreshed each prompt.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (!(await isSpawned($))) return result
    const k = titleKey(me.app ? await appTitle($, me.app) : undefined)
    const tk = (k && findTicket(fold(all, [], Date.now()).tickets, k)) || current()
    if (!tk) return result
    return { ...result, sessionTitle: sessionTitle(tk.key, zhTitle(tk), tk.col, me.days ?? []) }
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await setState($, 'idle')
    const done = await next(e)
    if (!e.agentId && lastBoard) { await wakeOnComments($, lastBoard); await spawnForWebStarts($, lastBoard); await syncTitles($, lastBoard) }
    return done
  })

  // ---------- 自动规则 ----------
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const tk = current()
    if (!tk || ran.deny !== undefined || ran.isError) return ran
    const cmd = e.command
    const out = ran.text ?? ''
    if (/\bgit\s+commit\b/.test(cmd)) {
      const m = out.match(/\[[^\]\s]+(?:\s\([^)]*\))?\s([0-9a-f]{7,})\]\s(.+)/)
      if (m) await emit($, { k: 'commit', key: tk.key, text: `${m[1]} ${m[2].slice(0, 60)}` })
    } else if (/\bgh\s+pr\s+create\b/.test(cmd)) {
      const pr = out.match(/\/pull\/(\d+)/)?.[1]
      if (pr) await emit($, { k: 'pr', key: tk.key, text: `#${pr}` })
      await move($, tk.key, 'follow', pr ? `PR #${pr}` : 'gh pr create')
    } else if (/\bgh\s+pr\s+merge\b/.test(cmd)) {
      await move($, tk.key, 'review', 'PR 合并，待你验收')
    }
    return ran
  })

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    on('tool.call', { tool }, async ($, e, next) => {
      const tk = current()
      if (tk && (tk.col === 'todo' || tk.col === 'follow')) await move($, tk.key, 'doing', '开始改代码')
      return next(e)
    })
  }

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const tk = current()
    if (!tk || tk.col === 'decide') return next(e)
    const back = tk.col
    await move($, tk.key, 'decide', 'Claude 提问')
    await setState($, 'wait')
    try {
      return await next(e)
    } finally {
      await setState($, 'run')
      await move($, tk.key, back, '已回复')
    }
  })

  // ---------- ticket 工具 ----------
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const a = e as unknown as {
      action: 'list' | 'create' | 'update' | 'init'; plan?: InitPlan; confirm?: boolean; key?: string; title?: string; title_en?: string; col?: Col; note?: string
      work?: boolean; src?: 'claude' | 'me'; project?: string; q?: string
      desc?: string; desc_en?: string; priority?: Priority; comment?: string; userAccepted?: boolean
      labels?: string[]; due?: string; blockedBy?: string[]; parent?: string
    }
    // Only the person accepts into done: on the board, or by saying so in chat (userAccepted).
    // The same for canceled (WB-28): Claude's "canceled" is a proposal in decide, with its reason, that the person confirms or keeps.
    const proposing = a.col === 'canceled' && !a.userAccepted
    const col = a.col === 'done' && !a.userAccepted ? 'review' : proposing ? 'decide' : a.col
    const reviewNote = a.col === 'done' && !a.userAccepted ? '（已放进「待审核」，等用户验收后才算完成；用户在对话里明确验收时带 userAccepted:true）' : ''
    const why = (a.comment ?? a.note ?? '').trim()
    const needWhy = '你不能直接取消工单：传 col:"canceled" 时必须用 comment（或 note）写理由，它会作为「建议取消」等用户在看板上确认；用户在对话里明确说取消时才带 userAccepted:true。'
    const proposeNote = '。已提议取消，等用户在看板确认（放进了「等我拍板」，标为建议取消；用户也可能选择保留）'
    await loadAll($)
    if (a.action === 'init') return { result: await initWizard($, a.plan, a.confirm) }
    const b = fold(all, [], Date.now())
    // Every ticket ever, archived ones included: relations may point at them.
    const every = fold(all, [], 0).tickets
    // The meta fields this call sets, validated before anything is written; self = the ticket being updated.
    const metaOf = (self?: string) => {
      const err: string[] = []
      const keyOf = (k: string) => { const f = findTicket(every, k.trim()); if (!f) err.push(`没有 ticket ${k}`); return f?.key ?? '' }
      const meta: NonNullable<Ev['meta']> = {}
      if (a.desc !== undefined) meta.desc = a.desc
      if (a.desc_en !== undefined) meta.desc_en = a.desc_en
      if (a.priority) meta.priority = a.priority
      if (a.labels) meta.labels = parseLabels(a.labels)
      if (a.due !== undefined) { if (a.due && !DUE.test(a.due)) err.push(`due 要写成 YYYY-MM-DD，收到 ${a.due}`); else meta.due = a.due }
      if (a.blockedBy) meta.blockedBy = [...new Set(a.blockedBy.map(keyOf).filter(Boolean))]
      if (a.parent !== undefined) meta.parent = a.parent ? keyOf(a.parent) : ''
      if (self && meta.blockedBy?.includes(self)) err.push(`${self} 不能卡住自己`)
      // ponytail: blockedBy cycles are allowed (only drawn); parent cycles would make the tree endless, so they are refused
      for (let k = meta.parent, i = 0; self && k && i < 50; k = every.find(t => t.key === k)?.parent, i++) {
        if (k === self) { err.push(`parent 成环：${self} 不能是 ${meta.parent} 的祖先`); break }
      }
      return { meta, err: err.join('；') }
    }
    // The call gave one language of a pair and the ticket still lacks the other: name it so Claude fills it now.
    const pairs = [['title', 'title_en'], ['desc', 'desc_en']] as const
    const lackNote = (key: string, old: Partial<Ticket> = {}) => {
      const m = pairs.flatMap(([zh, en]) => {
        if ((a[zh] === undefined) === (a[en] === undefined)) return []
        const other = a[zh] === undefined ? zh : en
        return old[other] ? [] : [other]
      })
      return m.length ? `。注意：标题和描述要双语，这次缺 ${m.join('、')}，请马上 update key:${key} 补上` : ''
    }

    if (a.action === 'list') {
      const q = a.q?.toLowerCase()
      const rows = b.tickets
        .filter(t => isOpen(t) && (!q || `${t.key} ${t.title} ${t.title_en ?? ''} ${(t.labels ?? []).join(' ')}`.toLowerCase().includes(q)))
        .sort((x, y) => (x.project === me.project ? 0 : 1) - (y.project === me.project ? 0 : 1))
        .map(t => {
          const bl = openBlockers(t, b.tickets)
          const tags = [colOf(t.col).name, t.priority, t.due && `截止 ${t.due}`, bl.length && `卡于 ${bl.join(',')}`, t.parent && `父 ${t.parent}`].filter(Boolean).join(' ')
          return `${t.key} [${tags}]${t.labels?.length ? ` ${t.labels.map(l => `#${l}`).join(' ')}` : ''} ${zhTitle(t)}${missingLang(t).length ? '（缺双语）' : ''}${t.key === me.ticket ? '  ← 本 session' : ''}`
        })
      return { result: rows.length ? rows.join('\n') : '没有未完成的 ticket' }
    }

    if (a.action === 'create') {
      if (!a.title && !a.title_en) return { result: 'create 需要 title 和 title_en' }
      const { meta, err } = metaOf()
      if (err) return { result: `没建：${err}` }
      if (proposing && !why) return { result: `没建：${needWhy}` }
      if (proposing) meta.proposeCancel = { reason: why }
      const project = a.project ?? me.project
      if (!project || !projOf(project)) {
        if (!PROJECTS.length) return { result: '看板还没有 board：先用 action:"init" 跑初始化向导。' }
        return { result: `当前目录 ${me.cwd} 还没归属项目。先问用户归到哪个：${PROJECTS.map(p => `${p.id}=${p.name}`).join(' / ')}，再带 project 重新 create。` }
      }
      if (!me.project) {
        me.project = project
        const dirs = ((await $.store.get('dirs')) ?? {}) as Record<string, string>
        await $.store.set('dirs', { ...dirs, [me.cwd]: project })
      }
      // ponytail: max+1 over the shared logs; two sessions creating in the same second could collide
      const used = all.flatMap(x => (x.k === 'create' ? [x.key] : x.k === 'rekey' && x.text ? [x.text] : [])).filter(k => k.startsWith(`${project}-`))
      const n = Math.max(0, ...used.map(k => Number(k.split('-')[1]) || 0)) + 1
      const key = `${project}-${n}`
      await emit($, { k: 'create', key, project, title: a.title ?? '', ...(a.title_en ? { title_en: a.title_en } : {}), col: col ?? 'doing', src: a.src ?? 'claude', text: a.note })
      if (Object.keys(meta).length) await emit($, { k: 'meta', key, meta })
      if (a.comment) await emit($, { k: 'comment', key, by: 'claude', text: a.comment })
      me.ticket = key
      await saveSess($)
      await linkHere($, { key })
      return { result: `已建 ${key}「${a.title || a.title_en}」→ ${colOf(col ?? 'doing').name}，并设为本 session 当前 ticket。${reviewNote}${proposing ? proposeNote : ''}${lackNote(key)}` }
    }

    const tk = findTicket(b.tickets, a.key) ?? findTicket(fold(all, [], 0).tickets, a.key)
    if (!tk) return { result: `没有 ticket ${a.key}；先 list 看看` }
    const { meta, err } = metaOf(tk.key)
    if (err) return { result: `没改：${err}` }
    if (proposing && !why) return { result: `没改：${needWhy}` }
    // already canceled: nothing to propose
    const propose = proposing && tk.col !== 'canceled'
    if (propose) meta.proposeCancel = { reason: why, ...(tk.col !== 'decide' ? { from: tk.col } : {}) }
    const retitle = { ...(a.title && a.title !== tk.title ? { title: a.title } : {}), ...(a.title_en && a.title_en !== tk.title_en ? { title_en: a.title_en } : {}) }
    if (Object.keys(retitle).length) await emit($, { k: 'title', key: tk.key, ...retitle })
    if (col === 'canceled') { if (tk.col !== 'canceled') await cancel($, tk.key, why) } // the person said so in chat
    else if (col && col !== tk.col && (propose || !proposing)) await move($, tk.key, col, col === 'done' && a.userAccepted ? '你在对话中验收' : propose ? 'Claude 建议取消' : 'Claude 更新')
    if (a.note) await emit($, { k: 'note', key: tk.key, text: a.note })
    if (Object.keys(meta).length) await emit($, { k: 'meta', key: tk.key, meta })
    if (a.comment) await emit($, { k: 'comment', key: tk.key, by: 'claude', text: a.comment })
    if (a.work) { me.ticket = tk.key; await saveSess($); await linkHere($, tk) }
    if (a.work && !col && (tk.col === 'todo' || tk.col === 'decide')) await move($, tk.key, 'doing', '认领')
    const bl = openBlockers({ ...tk, ...meta }, b.tickets)
    const extra = a.work ? `${bl.length ? `；注意：还被 ${bl.join('、')} 卡着` : ''}${tk.due ? `；截止 ${tk.due}` : ''}；描述：${descOf(tk, 'zh') || '无'}；评论 ${tk.comments.length} 条${tk.comments.length ? `，最近：${tk.comments.slice(-3).map(c => `${c.by === 'me' ? '用户' : 'Claude'}：${c.text}`).join(' / ')}` : ''}` : ''
    const stale = lastBoard ? (await staleNow($, lastBoard)).filter(x => x.key === tk.key) : []
    const titleNote = stale.length ? `。这张票的状态变了，看板开出来的这些会话标题要跟着改，现在依次调用 mcp__ccd_session_mgmt__set_session_title（session_id 和 title 照抄）：\n${titleLines(stale)}` : ''
    return { result: `已更新 ${tk.key}${a.work ? '，设为本 session 当前 ticket' : ''}${reviewNote}${propose ? proposeNote : ''}${extra}${lackNote(tk.key, tk)}${titleNote}` }
  })

  // ---------- 面板 ----------
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') paneWanted = false
    return next(e)
  })

  // /taskboard is an alias of /kanban.
  for (const command of ['kanban', 'taskboard']) on('command.run', { command }, async $ => {
    paneWanted = true
    await refresh($)
    await $.ui.open({ id: PANE, title: t('pane.title'), focus: true })
    return { text: t('cmd.opened') }
  })

  on('command.run', { command: 'kanban-web' }, async $ => {
    await ensureWeb($)
    return { text: t('cmd.web', WEB) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = { ...($.ui.resolve(e) as any) }
    // resolve may hand out elements a surface's table lacks, drawn as empty Boxes: terminal has no Svg, mobile no Input or Select.
    if (e.surface === 'terminal') delete els.Svg
    if (e.surface === 'mobile') { delete els.Input; delete els.Select }
    // Font size is not a prop; a Markdown heading is the one thing the desktop draws larger (as in a reply). Elsewhere a bold Text title.
    const bigTitle = e.surface === 'desktop' && Boolean(els.Markdown)
    const { Box, Text, Button } = els
    const cur = await read($, board)
    const v = await read($, view)
    const maxBack = weeksBack(all, Date.now())
    const wk = Math.min(v.week ?? 0, maxBack)
    const past = wk > 0 ? boardForWeek(all, Date.now(), wk, lang) : null
    const b = past ? past.board : cur
    const now = past ? past.asOf : Date.now()
    const width = e.props.bodyColumns || 100
    const setView = (patch: Partial<View>) => patchView($, patch)
    // Jira's small status pill: inverse text with a space of padding each side.
    const lozenge = (text: string, color?: string) => <Text color={color} inverse bold> {text} </Text>

    const sessName = (id: string) => { const x = b.sessions.find(s => s.sid === id); return x ? x.label || x.name : id.slice(0, 6) }
    const isLive = (t: Ticket) => b.sessions.some(s => s.ticket === t.key && s.state !== 'idle')
    const proj = projOf(v.proj)
    const q = (v.q ?? '').trim().toLowerCase()
    // Canceled tickets archived in earlier weeks: a search reaches them, and they open from the results (WB-28).
    const archived = () => (wk ? [] : archivedCanceled(all, b, lang))
    const projScope = (q ? [...b.tickets, ...archived()] : b.tickets).filter(t => v.proj === 'ALL' || t.project === v.proj)
    const filtered = Boolean(v.me || v.live || q)
    const scope = projScope.filter(t =>
      (!v.me || t.col === 'decide') && (!v.live || isLive(t)) && (!q || `${t.key} ${t.title} ${t.title_en ?? ''}`.toLowerCase().includes(q)))
    const count = (col: Col, list = scope) => list.filter(t => t.col === col).length
    const surf = SURFACE[v.themeResolved ?? resolved]
    const dueText = (tk: Ticket) => { const n = dueIn(tk, now); return n === null ? null : { text: `${t('l.due')} ${tk.due?.slice(5)}`, color: dueColor(n) } }
    const tagText = (tk: Ticket) => (tk.labels ?? []).map(l => `#${l}`).join(' ')

    // The person's buttons on a ticket (WB-28): confirm / keep Claude's proposal, restore a canceled one, else cancel it.
    const actsOf = (tk: Ticket): { id: 'cancel' | 'confirm' | 'keep' | 'restore'; label: string }[] =>
      tk.proposeCancel ? [{ id: 'confirm', label: t('cancel.ok') }, { id: 'keep', label: t('cancel.keep') }]
        : tk.col === 'canceled' ? [{ id: 'restore', label: t('restore') }] : [{ id: 'cancel', label: t('cancel') }]
    // A ticket's sessions other than this one, the most recently active first: where 跳到 session goes.
    const linkedOf = (tk: Ticket) => tk.sids.filter(x => x !== sid)
      .map(id => b.sessions.find(x => x.sid === id) ?? { sid: id, cwd: '', name: id.slice(0, 6), project: null, seen: 0, state: 'idle' as const, isGone: true })
      .sort((x, y) => y.seen - x.seen)
    const findShown = (key?: string | null) => (key ? b.tickets.find(x => x.key === key) ?? archived().find(x => x.key === key) : undefined)

    // ----- detail -----
    const sel = findShown(v.sel)
    if (sel) {
      const c = colOf(sel.col)
      const P = projOf(sel.project)
      const { code, rest } = splitCode(titleOf(sel, lang))
      const linked: Sess[] = sel.sids.map(id => b.sessions.find(x => x.sid === id) ?? { sid: id, cwd: '', name: id.slice(0, 6), project: null, seen: 0, state: 'idle', isGone: true })
      // Another live session that worked this ticket: the one a progress question goes to.
      const owner = linked.find(x => x.sid !== sid && x.state !== 'idle' && !x.isGone)
      const ask = async (text: string, note: string) => { await $.prompt.submit({ text }); $.ui.toast(note) }
      const sessState = (x: Sess) => (x.isGone ? t('ss.gone') : x.state === 'run' ? t('ss.run') : x.state === 'wait' ? t('waiting.you') : t('ss.idle'))
      const wide = width >= 100
      const toCol = (to: string) => { if (to !== sel.col) void personMove($, sel.key, to as Col, '你手动移动') }
      const toPri = (p: string) => { if (p !== (sel.priority ?? '')) void emit($, { k: 'meta', key: sel.key, meta: { priority: p as Priority } }) } // '' clears it
      const kv = (k: string, val: unknown) => <Box gap={1}><Box width={9}><Text color={MUTE}>{k}</Text></Box>{val}</Box>

      const side = (
        <Box flexDirection="column" gap={1} width={wide ? 34 : undefined}>
          {wk ? null : els.Select ? (
            <Box flexDirection="column" gap={1}>
              <els.Select key="status" label={t('status')} value={sel.col} options={COLS.map(x => ({ value: x.id, label: cn(x.id) }))} onSelect={toCol} />
              <els.Select key="priority" label={t('priority')} value={sel.priority ?? ''}
                options={[{ value: '', label: t('none') }, ...PRIORITIES.map(p => ({ value: p, label: p }))]} onSelect={toPri} />
            </Box>
          ) : (
            // surfaces without Select (mobile): the old button rows
            <Box flexDirection="column" gap={1}>
              <Box gap={1} flexWrap="wrap">
                <Text color={MUTE}>{t('move.to')}</Text>
                {COLS.filter(x => x.id !== sel.col).map(x => <Button key={`mv-${x.id}`} label={cn(x.id)} onPress={() => toCol(x.id)} />)}
              </Box>
              <Box gap={1}>
                <Text color={MUTE}>{t('priority')}</Text>
                {PRIORITIES.map(p => <Button key={`pri-${p}`} label={p} variant={sel.priority === p ? 'primary' : 'secondary'} onPress={() => toPri(p)} />)}
              </Box>
            </Box>
          )}
          <Box flexDirection="column">
            <Text color={MUTE} bold>{t('details')}</Text>
            {kv(t('d.src'), <Text>{sel.src === 'me' ? t('src.me') : t('src.claude')}</Text>)}
            {kv(t('d.stay'), <Text>{days(sel.since, now)}{t('l.days')}</Text>)}
            {kv(t('d.commits'), <Text>{sel.commits}</Text>)}
            {sel.pr ? kv('PR', <Text color={OK}>{sel.pr}</Text>) : null}
            {sel.branch ? kv(t('d.branch'), <Text wrap="truncate-end">{sel.branch}</Text>) : null}
            {sel.worktree ? kv(t('d.worktree'), <Text wrap="truncate-start">{sel.worktree}</Text>) : null}
            {sel.labels?.length ? kv(t('d.labels'), <Text color={MUTE}>{tagText(sel)}</Text>) : null}
            {(() => {
              const n = dueIn(sel, now)
              return sel.due ? kv(t('d.due'), <Text color={n === null ? MUTE : dueColor(n)}>{sel.due}{n === null ? '' : ` · ${n < 0 ? t('due.late', -n) : n === 0 ? t('due.today') : t('due.left', n)}`}</Text>) : null
            })()}
            {wk || !els.Input ? null : (
              <Box flexDirection="column">
                <els.Input key="labels" placeholder={t('labels.ph')} onSubmit={(text: string) => emit($, { k: 'meta', key: sel.key, meta: { labels: parseLabels(text.split(/[,，\s]+/)) } })} />
                <els.Input key="due" placeholder={t('due.ph')} onSubmit={(text: string) => {
                  const d = text.trim()
                  if (d && !DUE.test(d)) $.ui.toast(t('due.bad'))
                  else void emit($, { k: 'meta', key: sel.key, meta: { due: d } })
                }} />
              </Box>
            )}
          </Box>
          {(() => {
            // Relations both ways; the reverse sides (blocks, subtasks) are derived, never stored.
            const pool = wk ? b.tickets : fold(all, [], 0, lang).tickets
            const kids = pool.filter(x => x.parent === sel.key)
            const rows = [
              ['parent', t('rel.parent'), sel.parent ? [sel.parent] : []],
              ['by', t('rel.blockedBy'), sel.blockedBy ?? []],
              ['blocks', t('rel.blocks'), pool.filter(x => x.blockedBy?.includes(sel.key)).map(x => x.key)],
              ['kids', t('rel.children', kids.filter(x => !isOpen(x)).length, kids.length), kids.map(x => x.key)],
            ] as const
            if (rows.every(r => !r[2].length)) return null
            return (
              <Box flexDirection="column">
                <Text color={MUTE} bold>{t('relations')}</Text>
                {rows.map(([id, label, keys]) => keys.length ? (
                  <Box key={`rel-${id}`} gap={1} flexWrap="wrap">
                    <Text color={MUTE}>{label}</Text>
                    {keys.map(k => {
                      const x = b.tickets.find(y => y.key === k)
                      return x
                        ? <Button key={`rel-${id}-${k}`} plain label={`${k} ${cn(x.col)}`} onPress={() => setView({ sel: k })} />
                        : <Text key={`rel-${id}-${k}`} color={MUTE}>{k} {t('rel.archived')}</Text>
                    })}
                  </Box>
                ) : null)}
              </Box>
            )
          })()}
          <Box flexDirection="column">
            <Text color={MUTE} bold>{t('sessions')}</Text>
            {linked.length ? linked.map(x => (
              <Box key={`ss-${x.sid}`} gap={1} flexWrap="wrap">
                <Text color={x.isGone ? MUTE : x.state === 'run' ? OK : x.state === 'wait' ? WARN : undefined}>{x.label || x.name}</Text>
                <Text color={MUTE}>{sessState(x)}{x.sid === sid ? t('this.session') : ''}</Text>
                {x.sid !== sid ? <Button key={`jump-${x.sid}`} label={t('jump')} onPress={() => jumpTo($, [x])} /> : null}
              </Box>
            )) : <Text color={MUTE}>{t('sessions.none')}</Text>}
          </Box>
        </Box>
      )

      const main = (
        <Box flexDirection="column" gap={1} flexGrow={1}>
          {wk ? null : (
            <Box gap={1} flexWrap="wrap">
              <Text color={MUTE}>{t('hand')}</Text>
              <Button key="spawn" label={t('spawn')} variant="primary" onPress={() => newSessionFor($, sel)} />
              <Button key="go-here" label={t('go.here')} onPress={() => ask(`继续做 ${sel.key}「${zhTitle(sel)}」：先用 mcp__cc-taskboard__ticket update work:true 认领，再按描述、要点和评论推进。`, t('toast.go', sel.key))} />
              {owner ? (
                <Button key="ask-owner" label={t('ask.owner', owner.label || owner.name)} onPress={async () => {
                  await $.session.send({ to: { sessionId: owner.sid }, text: `[cc-taskboard] 用户在看板上问 ${sel.key}「${zhTitle(sel)}」的进度：请简短汇报，并用 mcp__cc-taskboard__ticket 更新状态和要点。` })
                  $.ui.toast(t('toast.sent', owner.label || owner.name))
                }} />
              ) : null}
              <Button key="verify" label={t('verify')} onPress={() => ask(`核对 ${sel.key}「${zhTitle(sel)}」在 repo 里的实际状态（提交、分支、PR），据此用 mcp__cc-taskboard__ticket 更新 col 和要点。`, t('toast.verify', sel.key))} />
            </Box>
          )}

          {sel.col === 'review' && !wk ? (
            <Box gap={1} flexWrap="wrap">
              <Text color={c.color} bold>{t('review.wait')}</Text>
              <Button key="accept" label={t('accept')} variant="primary" onPress={() => move($, sel.key, 'done', '你验收通过')} />
              <Button key="reject" label={t('reject')} onPress={() => move($, sel.key, 'doing', '你打回')} />
            </Box>
          ) : null}

          {wk ? null : sel.proposeCancel ? (
            <Box gap={1} flexWrap="wrap">
              <Text color={BAD} bold>{t('cancel.ask', clean(sel.proposeCancel.reason))}</Text>
              <Button key="confirm-cancel" label={t('cancel.ok')} variant="primary" onPress={() => ticketAct($, 'confirm', sel.key)} />
              <Button key="keep" label={t('cancel.keep')} onPress={() => ticketAct($, 'keep', sel.key)} />
            </Box>
          ) : sel.col === 'canceled' ? (
            <Box gap={1}><Button key="restore" label={t('restore')} onPress={() => ticketAct($, 'restore', sel.key)} /></Box>
          ) : (
            <Box flexDirection="column">
              <Box gap={1}><Button key="cancel" label={t('cancel')} onPress={() => ticketAct($, 'cancel', sel.key)} /></Box>
              {els.Input ? <els.Input key="cancel-reason" placeholder={t('cancel.ph')} onSubmit={(text: string) => ticketAct($, 'cancel', sel.key, text)} /> : null}
            </Box>
          )}

          <Box flexDirection="column">
            <Text color={MUTE} bold>{t('desc')}</Text>
            {descOf(sel, lang) ? <els.Markdown text={clean(descOf(sel, lang))} /> : <Text color={MUTE}>{t('desc.none')}</Text>}
            {wk || !els.Input ? null : (
              <els.Input key="desc" placeholder={t('desc.ph')} onSubmit={(text: string) => emit($, { k: 'meta', key: sel.key, meta: { desc: text, desc_en: '' } })} />
            )}
          </Box>

          <Box flexDirection="column">
            <Text color={MUTE} bold>{t('comments')}{sel.comments.length ? ` ${sel.comments.length}` : ''}</Text>
            {wk || !els.Input ? null : (
              <els.Input key="comment" placeholder={t('comment.ph')} onSubmit={(text: string) => void sendComment($, sel.key, text)} />
            )}
            {sel.comments.slice(-8).reverse().map((cm, i) => (
              <Text key={`cm${i}`}>
                <Text bold color={cm.by === 'me' ? P?.color ?? OK : MUTE}>{cm.by === 'me' ? t('you') : 'Claude'}</Text>
                <Text color={MUTE}> {hhmm(cm.t)} </Text>{clean(cm.text)}
              </Text>
            ))}
          </Box>

          {sel.notes.length ? (
            <Box flexDirection="column">
              <Text color={MUTE} bold>{t('notes')}</Text>
              {sel.notes.map((n, i) => <Text key={`n${i}`}>- {clean(n)}</Text>)}
            </Box>
          ) : null}
          <Box flexDirection="column">
            <Text color={MUTE} bold>{t('activity')}</Text>
            {sel.log.slice().reverse().map((l, i) => (
              <Text key={`l${i}`}><Text color={MUTE}>{hhmm(l.t)} </Text>{clean(l.text)}<Text color={MUTE}> · {sessName(l.sid)}</Text></Text>
            ))}
          </Box>
          {wk ? <Text color={MUTE}>{t('ro.hint')}</Text> : null}
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Box gap={1} flexWrap="wrap">
            <Button key="back" label={t('back')} onPress={() => setView({ sel: null })} />
            <Text color={MUTE}>{P ? pn(P.id) : sel.project} / </Text>
            <Text color={P?.color ?? MUTE} bold>{sel.key}</Text>
            {lozenge(cn(sel.col), c.color)}
            {sel.priority ? lozenge(sel.priority, PRIORITY_COLOR[sel.priority]) : null}
          </Box>
          <Text>{code ? <Text bold color={P?.color}>{code} </Text> : null}<Text bold>{rest}</Text></Text>
          {wide ? <Box gap={2}>{main}{side}</Box> : <Box flexDirection="column" gap={1}>{side}{main}</Box>}
        </Box>
      )
    }

    // ----- board / feed: the focus list (WB-29, mockup v2 option A), native elements only -----
    const wide = width >= 80
    const off = v.off ?? []
    const more = v.more ?? []
    const doneOpen = Boolean(v.doneOpen)
    // Canceled folds like done; a search opens it, so archived hits show.
    const canceledOpen = Boolean(v.canceledOpen) || Boolean(q)
    const openOf = (c: Col) => (c === 'todo' ? Boolean(v.todoOpen) : c === 'done' ? doneOpen : canceledOpen)
    const showProj = wide && v.proj === 'ALL'

    // Header
    const boardTitle = t('board.title', proj ? pn(proj.id) : t('all.projects'))
    const title = bigTitle
      ? <els.Markdown key="board-title" text={`## ${boardTitle} · W${isoWeek(now)}`} />
      : <Text wrap="truncate-end"><Text bold color={surf.text}>{boardTitle}</Text><Text color={surf.mute}> W{isoWeek(now)}</Text></Text>
    const nav = [
      wk < maxBack ? <Button key="wk-prev" plain label={t('wk.prev', isoWeek(b.weekStart - 86_400_000))} onPress={() => setView({ week: wk + 1, sel: null })} /> : null,
      wk > 0 ? <Button key="wk-next" plain label={t('wk.next', isoWeek(b.weekStart + 8 * 86_400_000))} onPress={() => setView({ week: wk - 1, sel: null })} /> : null,
      wk > 1 ? <Button key="wk-now" plain label={t('wk.now')} onPress={() => setView({ week: 0, sel: null })} /> : null,
    ]
    const liveN = b.tickets.filter(x => (v.proj === 'ALL' || x.project === v.proj) && isLive(x)).length
    const tabs = [{ id: 'ALL', label: t('all') }, ...PROJECTS.map(p => ({ id: p.id, label: pn(p.id) }))].map(({ id, label }) => {
      const wait = id === 'ALL' ? 0 : count('decide', b.tickets.filter(x => x.project === id))
      return (
        <Box key={`pj-${id}`} gap={1}>
          {v.proj === id ? <Text bold underline color={surf.text}>{label}</Text> : <Button key={`p-${id}`} plain label={label} onPress={() => setView({ proj: id })} />}
          {wait ? <Text color={BAD}>{wait}</Text> : null}
        </Box>
      )
    })
    const seg = (id: 'board' | 'feed') => {
      const label = t(id === 'board' ? 'tab.board' : 'hdr.feed')
      return v.tab === id ? <Text key={`tab-${id}`} bold color={surf.text}>{label}</Text> : <Button key={`tab-${id}`} plain label={label} onPress={() => setView({ tab: id })} />
    }
    const header = (
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={1}>
          <Box flexShrink={1}>{title}</Box>
          <Box gap={2} flexShrink={0}>
            <Button key="lang" plain label={t('lang.btn')} onPress={() => setLang($, lang === 'zh' ? 'en' : 'zh')} />
          </Box>
        </Box>
        <Box justifyContent="space-between" gap={1} flexWrap="wrap">
          <Text color={surf.mute}>
            {md(b.weekStart)} ~ {md(b.weekStart + 6.5 * 86_400_000)} · {t('h.new')} {b.createdThisWeek} · {t('h.done')} {count('done', projScope)} · {t('l.live')} <Text color={surf.live}>{liveN}</Text>{wk ? ` · ${t('week.ro')}` : ''}
          </Text>
          <Box gap={2}>{nav}</Box>
        </Box>
        <Box gap={2} flexWrap="wrap" marginTop={1}>{tabs}</Box>
        <Box justifyContent="space-between" gap={1} flexWrap="wrap">
          <Box gap={2} flexWrap="wrap">
            {/* Filters stay Buttons (pressing again turns them off): bright when on, dim when off. */}
            <Button key="qf-me" plain dimColor={!v.me} label={t('qf.me')} onPress={() => setView({ me: !v.me })} />
            <Button key="qf-live" plain dimColor={!v.live} label={t('qf.live')} onPress={() => setView({ live: !v.live })} />
            {els.Input ? (
              <Box width={wide ? 30 : Math.max(12, width - 36)}>
                <els.Input key="search" placeholder={t('hdr.search')} value={v.q ?? ''} onInput={(text: string) => setView({ q: text })} onSubmit={(text: string) => setView({ q: text })} />
              </Box>
            ) : null}
          </Box>
          <Box gap={2}>{seg('board')}{seg('feed')}</Box>
        </Box>
      </Box>
    )

    // Status ribbon and legend: every status in scope, sized by count; a legend press hides / shows one.
    const ORDER: Col[] = ['decide', 'doing', 'review', 'follow', 'todo', 'done', 'canceled']
    const present = ORDER.filter(c => count(c) > 0)
    const shown = present.filter(c => !off.includes(c))
    const total = shown.reduce((n, c) => n + count(c), 0)
    const ribbon = (() => {
      if (!total) return null
      if (els.Svg) {
        let x = 0
        const rects = shown.map(c => {
          const w = ((1000 - 2 * (shown.length - 1)) * count(c)) / total
          const r = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="6" fill="${colOf(c).color}"/>`
          x += w + 2
          return r
        }).join('')
        const source = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="6" viewBox="0 0 1000 6" preserveAspectRatio="none"><clipPath id="rb"><rect width="1000" height="6" rx="3"/></clipPath><g clip-path="url(#rb)">${rects}</g></svg>`
        return <els.Svg key="ribbon" source={source} alt={shown.map(c => `${cn(c)} ${count(c)}`).join(' · ')} height={6} />
      }
      // Terminal: one line of runs, width - 4 cells; every status at least one, the largest takes the rounding.
      const n = Math.max(shown.length, width - 4)
      const lens = shown.map(c => Math.max(1, Math.floor((n * count(c)) / total)))
      const big = lens.indexOf(Math.max(...lens))
      lens[big] = (lens[big] ?? 1) + n - lens.reduce((a, l) => a + l, 0)
      return <Text key="ribbon">{shown.map((c, i) => <Text key={`rb-${c}`} color={colOf(c).color}>{'▇'.repeat(Math.max(1, lens[i] ?? 1))}</Text>)}</Text>
    })()
    const legend = present.length ? (
      <Box gap={2} flexWrap="wrap">
        {present.map(c => {
          const hidden = off.includes(c)
          return (
            <Box key={`lg-${c}`} gap={1}>
              <Text color={colOf(c).color} dimColor={hidden}>●</Text>
              <Button key={`legend-${c}`} plain dimColor={hidden} label={`${cn(c)} ${count(c)}`} onPress={() => setView({ off: hidden ? off.filter(x => x !== c) : [...off, c] })} />
            </Box>
          )
        })}
      </Box>
    ) : null

    // The preview of one ticket, inline under its row at every width (WB-32: an absolute popup got clipped by a short list). Past weeks are read-only.
    const preview = (tk: Ticket, c: { fg?: string; mute: string }) => {
      const desc = descOf(tk, lang) ? plain(descOf(tk, lang)) : tk.notes.map(n => `- ${plain(n).join(' ')}`)
      const toCol = async (to: string) => {
        if (to === tk.col) return
        const col = to as Col
        await personMove($, tk.key, col, '你手动移动')
        // The ticket goes where it now belongs: that section shown, a folded one opened.
        await update($, view, cur => ({
          ...cur, peek: null, off: (cur.off ?? []).filter(x => x !== col),
          ...(col === 'todo' ? { todoOpen: true } : col === 'done' ? { doneOpen: true } : col === 'canceled' ? { canceledOpen: true } : {}),
        }))
      }
      const toPri = (p: string) => { if (p !== (tk.priority ?? '')) void emit($, { k: 'meta', key: tk.key, meta: { priority: p as Priority } }) } // '' clears it
      return [
        <Box key="pv-line" gap={1} flexWrap="wrap">
          {wk ? <Text color={colOf(tk.col).color}>● {cn(tk.col)}</Text> : els.Select ? (
            <Box gap={1}>
              <els.Select key="peek-status" value={tk.col} options={COLS.map(x => ({ value: x.id, label: cn(x.id) }))} onSelect={toCol} />
              <els.Select key="peek-priority" value={tk.priority ?? ''} options={[{ value: '', label: t('none') }, ...PRIORITIES.map(p => ({ value: p, label: p }))]} onSelect={toPri} />
            </Box>
          ) : null}
          <Button key="peek-open" label={t('peek.open')} variant="primary" onPress={() => setView({ sel: tk.key, peek: null })} />
          {tk.sids.some(x => x !== sid) ? <Button key="peek-jump" label={t('jump.go')} onPress={() => jumpTo($, linkedOf(tk))} /> : null}
          {wk ? null : <Button key="peek-spawn" label={t('spawn')} onPress={() => newSessionFor($, tk)} />}
          {wk ? null : actsOf(tk).map(a => <Button key={`peek-${a.id}`} label={a.label} onPress={() => ticketAct($, a.id, tk.key)} />)}
        </Box>,
        // Surfaces without Select (mobile): the detail page's button rows.
        !wk && !els.Select ? (
          <Box key="pv-moves" flexDirection="column">
            <Box gap={1} flexWrap="wrap">
              <Text color={c.mute}>{t('move.to')}</Text>
              {COLS.filter(x => x.id !== tk.col).map(x => <Button key={`peek-mv-${x.id}`} label={cn(x.id)} onPress={() => toCol(x.id)} />)}
            </Box>
            <Box gap={1}>
              <Text color={c.mute}>{t('priority')}</Text>
              {PRIORITIES.map(p => <Button key={`peek-pri-${p}`} label={p} variant={tk.priority === p ? 'primary' : 'secondary'} onPress={() => toPri(p)} />)}
            </Box>
          </Box>
        ) : null,
        <Box key="pv-desc" flexDirection="column">
          <Text color={c.mute} bold>{t('desc')}</Text>
          {desc.length ? desc.slice(0, 3).map((l, i) => <Text key={`pd${i}`} color={c.fg}>{l}</Text>) : <Text color={c.mute}>{t('desc.none')}</Text>}
        </Box>,
        <Box key="pv-comments" flexDirection="column">
          <Text color={c.mute} bold>{t('comments')} {tk.comments.length}</Text>
          {tk.comments.slice(-2).map((cm, i) => (
            <Text key={`pc${i}`} color={c.fg}><Text color={c.mute}>{cm.by === 'me' ? t('you') : 'Claude'} · {md(cm.t)} {hhmm(cm.t)} </Text>{clean(cm.text)}</Text>
          ))}
          {wk || !els.Input ? null : <els.Input key="peek-comment" placeholder={t('peek.cmt.ph')} submitLabel={t('peek.send')} onSubmit={(text: string) => void sendComment($, tk.key, text)} />}
        </Box>,
        <Text key="pv-foot" color={c.mute}>
          {t('peek.created', md(tk.created))} · {t('peek.updated', ago(lang, tk.log.at(-1)?.t ?? tk.created, now))} · {t('peek.fold')}
        </Text>,
      ]
    }

    // One ticket, one line: the title is a plain Button, clipped to what the right-side items leave.
    const row = (tk: Ticket) => {
      const closed = tk.col === 'done' || tk.col === 'canceled'
      const pc = projOf(tk.project)?.color ?? MUTE
      const { code, rest } = splitCode(titleOf(tk, lang))
      const due = dueText(tk)
      const age = closed ? 0 : days(tk.since, now)
      const right = [
        tk.priority === 'P0' || tk.priority === 'P1' ? { text: ` ${tk.priority} `, color: PRIORITY_COLOR[tk.priority], pill: true } : null,
        due,
        tk.proposeCancel ? { text: t('d.propose'), color: BAD } : null,
        isLive(tk) ? { text: t('l.live'), color: surf.live } : null,
        wide && tk.comments.length ? { text: `${tk.comments.length} ✎`, color: surf.mute } : null,
        { text: tk.key, color: wide ? surf.mute : pc },
        age > 0 ? { text: `${age}${t('l.days')}`, color: age > 7 ? WARN : surf.mute } : null,
      ].filter((x): x is { text: string; color: string; pill?: boolean } => x !== null)
      // ponytail: cells are terminal cells; the desktop font runs narrower, so 4 spare cells keep the row on one line there too
      const room = width - 2 - (showProj ? 5 : 0) - right.reduce((n, r) => n + cells(r.text) + 1, 0) - 4
      const open = v.peek === tk.key
      const line = (
        <Box key={`row-${tk.key}`} gap={1} backgroundColor={open ? surf.tint : undefined} hover={{ backgroundColor: surf.tint }}>
          {showProj ? <Box width={4} flexShrink={0}><Text bold color={pc} wrap="truncate-end">{tk.project}</Text></Box> : null}
          <Box flexGrow={1} flexShrink={1}>
            <Button key={`open-${tk.key}`} plain dimColor={closed} label={clip(code ? `${code} ${rest}` : rest, Math.max(6, room))}
              onPress={() => setView({ peek: open ? null : tk.key })} />
          </Box>
          {right.map((r, i) => <Text key={`r${i}`} color={r.color} inverse={r.pill} bold={r.pill}>{r.text}</Text>)}
        </Box>
      )
      if (!open) return [line]
      return [
        line,
        <Box key={`pv-${tk.key}`} flexDirection="column" backgroundColor={surf.tint} paddingX={1}>
          <Text bold>{code ? `${code} ` : ''}{rest}</Text>
          {preview(tk, { mute: surf.mute })}
        </Box>,
      ]
    }

    // A status section: colored dot, bold name, muted count; narrow decide shows its first 5 behind a more / less Button.
    const section = (c: Col, cap = 0) => {
      const items = scope.filter(x => x.col === c)
      if (off.includes(c) || !items.length) return null
      const capped = cap > 0 && items.length > cap
      const expanded = more.includes(c)
      return (
        <Box key={`sec-${c}`} flexDirection="column">
          <Box gap={1}>
            <Text color={colOf(c).color}>●</Text>
            <Text bold color={surf.text}>{cn(c)}</Text>
            <Text color={surf.mute}>{items.length}</Text>
            {capped ? <Button key={`more-${c}`} plain dimColor label={expanded ? t('lane.collapse') : t('more.n', items.length - cap)}
              onPress={() => setView({ more: expanded ? more.filter(x => x !== c) : [...more, c] })} /> : null}
          </Box>
          {(capped && !expanded ? items.slice(0, cap) : items).flatMap(row)}
        </Box>
      )
    }
    const FOLDS: Col[] = ['todo', 'done', 'canceled']
    const foldRow = (
      <Box key="folds" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Box gap={2} flexWrap="wrap">
          {FOLDS.map(c => count(c) ? (
            <Box key={`fd-${c}`} gap={1}>
              <Text color={colOf(c).color}>●</Text>
              <Button key={`fold-${c}`} plain dimColor label={`${cn(c)} ${count(c)} ${openOf(c) ? '⌄' : '›'}`}
                onPress={() => setView(c === 'todo' ? { todoOpen: !v.todoOpen } : c === 'done' ? { doneOpen: !doneOpen } : { canceledOpen: !v.canceledOpen })} />
            </Box>
          ) : null)}
        </Box>
        {els.Link ? <els.Link key="web-link" href={WEB_LINK} label={t('w.link')} /> : null}
      </Box>
    )
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        {header}
        {v.tab === 'board' && (ribbon || legend) ? <Box flexDirection="column">{ribbon}{legend}</Box> : null}
        {v.tab === 'feed' ? (
          <Box flexDirection="column">
            {b.feed.filter(f => v.proj === 'ALL' || f.key.startsWith(`${v.proj}-`)).slice(0, Math.max(5, (e.viewport?.rows ?? 30) - 12)).map((f, i) => (
              <Text key={`f${i}`}>
                <Text color={MUTE}>{hhmm(f.t)} </Text>{lozenge(t(`kind.${f.icon}` as K), f.icon === 'move' ? WARN : f.icon === 'new' ? OK : f.icon === 'comment' ? '#5aa9b8' : MUTE)} <Text bold>{f.key}</Text> {clean(f.text)}<Text color={MUTE}> · {sessName(f.sid)}</Text>
              </Text>
            ))}
            {b.feed.length === 0 ? <Text color={MUTE}>{t('feed.empty')}</Text> : null}
          </Box>
        ) : !PROJECTS.length ? (
          <Text color={MUTE}>{t('empty.noboards')}</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {scope.length ? (['decide', 'doing', 'review', 'follow'] as Col[]).map(c => section(c, !wide && c === 'decide' ? 5 : 0))
              : <Text color={MUTE}>{t(filtered ? 'empty.filter' : wk ? 'empty.past' : 'empty.week')}</Text>}
            {foldRow}
            {FOLDS.filter(openOf).map(c => section(c))}
          </Box>
        )}
      </Box>
    )
  })
}
