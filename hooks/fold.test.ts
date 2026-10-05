import { expect, test } from 'claude-code/testing'

import { boardForWeek, dayLabel, fold, ownerOf, resolveTheme, sessionTitle, splitCode, weeksBack } from './register.tsx'
import { archivedCanceled, keepTo, planInit, restoreTo, scanRow, setProjects, staleTitles } from './core.ts'

const NOW = new Date(2026, 9, 3, 15).getTime() // Sat 2026-10-03, week starts Mon 09-28
const H = 3_600_000

test('fold: create, move, commit, title, archive', async () => {
  const b = fold(
    [
      { t: NOW - 2 * H, sid: 's1', k: 'create', key: 'SVC-1', project: 'SVC', title: 'T-42', col: 'doing' },
      { t: NOW - H, sid: 's1', k: 'commit', key: 'SVC-1', text: 'abc1234 msg' },
      { t: NOW - H / 2, sid: 's2', k: 'move', key: 'SVC-1', col: 'follow', text: 'PR #112' },
      { t: NOW - H / 3, sid: 's2', k: 'title', key: 'SVC-1', title: 'T-42 登录页面' },
      // done last week → archived off the board
      { t: NOW - 10 * 24 * H, sid: 's1', k: 'create', key: 'ME-1', project: 'ME', title: 'old', col: 'done' },
    ] as any,
    [{ sid: 's1', cwd: '/x', name: 'x', project: 'SVC', seen: NOW - 10 * 60_000, state: 'run' }],
    NOW,
  )
  expect(b.tickets.map(t => t.key)).toEqual(['SVC-1'])
  const t = b.tickets[0]
  expect(t.col).toBe('follow')
  expect(t.title).toBe('T-42 登录页面')
  expect(t.commits).toBe(1)
  expect(t.sids).toEqual(['s1', 's2'])
  expect(b.commitsThisWeek).toBe(1)
  expect(b.createdThisWeek).toBe(1)
  expect(b.sessions[0].state).toBe('idle') // not seen for 10 min
  expect(b.feed[0].key).toBe('SVC-1')
})

test('boardForWeek replays a past week, read as of its end', async () => {
  const DAY = 24 * H
  const evs = [
    { t: NOW - 9 * DAY, sid: 's1', k: 'create', key: 'SVC-1', project: 'SVC', title: 'A', col: 'doing' }, // W39 Thu
    { t: NOW - 8 * DAY, sid: 's1', k: 'move', key: 'SVC-1', col: 'done' }, // W39 Fri: done last week
    { t: NOW - 7 * DAY, sid: 's1', k: 'create', key: 'SVC-2', project: 'SVC', title: 'B', col: 'doing' }, // W39 Sat
    { t: NOW - DAY, sid: 's1', k: 'move', key: 'SVC-2', col: 'follow' }, // this week
  ] as any
  expect(weeksBack(evs, NOW)).toBe(1)
  // This week: SVC-1 archived (done last week), SVC-2 in follow.
  expect(boardForWeek(evs, NOW, 0).board.tickets.map(t => `${t.key}:${t.col}`)).toEqual(['SVC-2:follow'])
  // Last week as it ended: SVC-1 done that week, SVC-2 still doing.
  const last = boardForWeek(evs, NOW, 1)
  expect(last.board.tickets.map(t => `${t.key}:${t.col}`)).toEqual(['SVC-1:done', 'SVC-2:doing'])
  expect(last.board.createdThisWeek).toBe(2)
  expect(last.board.feed.every(f => f.t < NOW - 6 * DAY)).toBe(true)
})

test('session titles follow 【days - status】KEY topic', async () => {
  const d = (m: number, day: number) => new Date(2026, m - 1, day, 15).getTime()
  expect(dayLabel([d(10, 3)])).toBe('Oct 3')
  expect(dayLabel([d(10, 1), d(10, 3), d(10, 1)])).toBe('Oct 1, 3')
  expect(dayLabel([d(9, 30), d(10, 1)])).toBe('Sep 30, Oct 1')
  expect(dayLabel([d(9, 28), d(9, 29), d(10, 1), d(10, 3)])).toBe('Sep 28-Oct 3')
  expect(sessionTitle('APP-3', '[UI] 登录页改版', 'doing', [d(10, 3)])).toBe('【Oct 3 - in progress】APP-3 登录页改版')
  expect(sessionTitle('SVC-1', '[T-42] 登录页面', 'done', [d(9, 30), d(10, 1)])).toBe('【Sep 30, Oct 1 - done】SVC-1 登录页面')
  expect(sessionTitle('SVC-2', 'x'.repeat(80), 'review', [d(10, 3)]).length).toBeLessThanOrEqual(60)
})

test('spawned sessions whose title lags their ticket are listed for renaming', async () => {
  const day = new Date(2026, 9, 3, 15).getTime()
  const tk = (key: string, col: string) => ({ key, title: '[X] 主题', col, aliases: key === 'WB-1' ? ['ME-1'] : undefined }) as any
  const s = (sid: string, ticket: string, app?: string) => ({ sid, ticket, app, days: [day] }) as any
  const b = { tickets: [tk('WB-1', 'review'), tk('WB-2', 'doing')], sessions: [s('a', 'ME-1', 'local_a'), s('b', 'WB-2', 'local_b'), s('c', 'WB-1', 'local_c'), s('d', 'WB-1'), s('e', 'WB-1', 'local_e')] } as any
  const titles = { a: '【Oct 3 - in progress】WB-1 主题', b: '【Oct 3 - in progress】WB-2 主题', c: 'whatever' }
  // a: spawned, title says in progress but WB-1 (old key ME-1) is in review; b: already right; c: not spawned; d: no app id; e: no title found
  expect(staleTitles(b, ['a', 'b', 'd', 'e'], titles)).toEqual([{ sid: 'a', app: 'local_a', key: 'WB-1', title: '【Oct 3 - review】WB-1 主题' }])
  // f's current ticket is WB-2 (it created that one for another session), but its title names WB-1: it stays on WB-1
  const f = { ...b, sessions: [s('f', 'WB-2', 'local_f')] }
  expect(staleTitles(f, ['f'], { f: '【Oct 3 - in progress】WB-1 主题' }).map(x => x.title)).toEqual(['【Oct 3 - review】WB-1 主题'])
})

test('rekey moves a ticket to another board; old keys and late events still land on it', async () => {
  const H2 = 3_600_000
  const b = fold(
    [
      { t: NOW - 5 * H2, sid: 's1', k: 'create', key: 'ME-11', project: 'ME', title: 'i18n', col: 'doing' },
      { t: NOW - 4 * H2, sid: 's1', k: 'comment', key: 'ME-11', by: 'me', text: 'hi' },
      { t: NOW - 3 * H2, sid: 'migrate', k: 'rekey', key: 'ME-11', text: 'WB-10', project: 'WB' },
      { t: NOW - 2 * H2, sid: 's2', k: 'move', key: 'ME-11', col: 'review' }, // a session still on the old key
    ] as any,
    [{ sid: 's2', cwd: '/x', name: 'x', project: 'ME', seen: NOW, state: 'run', ticket: 'ME-11' }],
    NOW,
  )
  expect(b.tickets.map(t => `${t.key}:${t.project}:${t.col}`)).toEqual(['WB-10:WB:review'])
  expect(b.tickets[0].aliases).toEqual(['ME-11'])
  expect(b.tickets[0].comments.length).toBe(1)
  expect(b.sessions[0].ticket).toBe('WB-10')
  expect(b.feed.every(f => f.key === 'WB-10')).toBe(true)
})

test('past weeks show the new key and board after a later rekey', async () => {
  const DAY = 24 * H
  const evs = [
    { t: NOW - 9 * DAY, sid: 's1', k: 'create', key: 'ME-4', project: 'ME', title: 'old board', col: 'doing' },
    { t: NOW - 8 * DAY, sid: 's1', k: 'move', key: 'ME-4', col: 'done' },
    { t: NOW - H, sid: 'migrate', k: 'rekey', key: 'ME-4', text: 'WB-3', project: 'WB' },
  ] as any
  const last = boardForWeek(evs, NOW, 1).board
  expect(last.tickets.map(t => `${t.key}:${t.project}`)).toEqual(['WB-3:WB'])
  expect(last.feed.some(f => f.text.includes('WB-3') && f.text.includes('ME-4'))).toBe(false) // the move itself is this week's news
})

test('clean() drops emoji but keeps text symbols like ↔ → ✓', async () => {
  expect(splitCode('ticket↔session ✅ ⏳ 📄 ⚠️ → ok ✓').rest).toBe('ticket↔session → ok ✓')
})

test('canceled archives like done; relations follow a rekey', async () => {
  const DAY = 24 * H
  const b = fold(
    [
      { t: NOW - 9 * DAY, sid: 's1', k: 'create', key: 'WB-1', project: 'WB', title: 'old', col: 'canceled' }, // canceled last week
      { t: NOW - 2 * H, sid: 's1', k: 'create', key: 'WB-2', project: 'WB', title: 'now', col: 'canceled' },
      { t: NOW - 2 * H, sid: 's1', k: 'create', key: 'ME-5', project: 'ME', title: 'blocker', col: 'doing' },
      { t: NOW - H, sid: 's1', k: 'create', key: 'WB-3', project: 'WB', title: 'x', col: 'todo' },
      { t: NOW - H, sid: 's1', k: 'meta', key: 'WB-3', meta: { blockedBy: ['ME-5'], parent: 'ME-5', labels: ['hold'], due: '2026-10-05' } },
      { t: NOW - H / 2, sid: 'migrate', k: 'rekey', key: 'ME-5', text: 'WB-4', project: 'WB' },
    ] as any,
    [],
    NOW,
  )
  expect(b.tickets.map(t => `${t.key}:${t.col}`)).toEqual(['WB-2:canceled', 'WB-4:doing', 'WB-3:todo'])
  const t3 = b.tickets.find(t => t.key === 'WB-3')!
  expect(t3.blockedBy).toEqual(['WB-4'])
  expect(t3.parent).toBe('WB-4')
  expect(t3.labels).toEqual(['hold'])
})

test('ownerOf: the live session working the ticket, else the latest live one that worked it', async () => {
  const tk = { key: 'WB-13', sids: ['a', 'b', 'c'] } as any
  const S = (sid: string, seenAgo: number, ticket?: string, isGone = false) => ({ sid, seen: NOW - seenAgo, ticket, isGone, state: 'idle' })
  expect(ownerOf(tk, [S('a', 1000), S('b', 2000, 'WB-13'), S('c', 500)], NOW)).toBe('b') // working it now wins
  expect(ownerOf(tk, [S('a', 1000), S('b', 2000), S('c', 500)], NOW)).toBe('c') // else most recently seen
  expect(ownerOf(tk, [S('a', 10 * 60_000), S('c', 500, undefined, true)], NOW)).toBeUndefined() // stale / gone: nobody
  expect(ownerOf(tk, [S('x', 100, 'WB-13')], NOW)).toBe('x') // claimed but never touched before still counts
})

test('resolveTheme: the Claude app setting wins, system or missing follows the OS', async () => {
  expect(resolveTheme('light', true)).toBe('light')
  expect(resolveTheme('dark', false)).toBe('dark')
  expect(resolveTheme('system', true)).toBe('dark')
  expect(resolveTheme('system', false)).toBe('light')
  expect(resolveTheme(undefined, true)).toBe('dark')
  expect(resolveTheme(undefined, false)).toBe('light')
})

test('fold in en: bilingual title, commit line, imported move reasons', async () => {
  const b = fold(
    [
      { t: NOW - 2 * H, sid: 's1', k: 'create', key: 'SVC-1', project: 'SVC', title: '登录页面', title_en: 'login page', col: 'doing' },
      { t: NOW - H, sid: 's1', k: 'commit', key: 'SVC-1', text: 'abc1234 msg' },
      { t: NOW - H / 2, sid: 'import', k: 'move', key: 'SVC-1', col: 'done', text: 'W39 存档' },
      { t: NOW - H / 3, sid: 's2', k: 'title', key: 'SVC-1', title_en: 'login page v2' },
    ] as any,
    [],
    NOW,
    'en',
  )
  const t = b.tickets[0]
  expect([t.title, t.title_en]).toEqual(['登录页面', 'login page v2'])
  expect(t.log.map(l => l.text)).toEqual(['Created "login page" → In progress', 'Commit abc1234 msg', '→ Done (W39 archived)'])
})

test('init plan: keys follow the logs, status lands as a move, linked sessions are skipped, bad plans are refused', async () => {
  expect(setProjects([{ id: 'SVC', name: 'SVC 重写', match: 'web-app' }, { id: 'ME', name: '私人', match: 'private' }])).toEqual([])
  expect(setProjects([{ id: 'bad', name: 'x', match: '(' }]).length).toBe(1)
  const sess = (sid: string, title: string, last: number, summary?: object) =>
    scanRow(JSON.stringify({ cliSessionId: sid, title, cwd: '/Users/x/web-app', createdAt: last - H, lastActivityAt: last, postTurnSummary: summary && JSON.stringify(summary), prs: [{ prNumber: 9, state: 'MERGED' }] }))!
  const rows = [sess('a', 'fix A', NOW - 5 * H, { status_category: 'completed' }), sess('b', 'B part 1', NOW - 4 * H), sess('c', 'B part 2', NOW - 3 * H), sess('old', 'on SVC-3', NOW - 2 * H)]
  expect(rows[0].status).toBe('completed')
  expect(rows[0].prs).toEqual(['#9 MERGED'])
  expect(scanRow('not json')).toBeNull()
  const evs = [
    { t: NOW - 9 * H, sid: 'old', k: 'create', key: 'SVC-3', project: 'SVC', title: 'x', col: 'doing' },
    { t: NOW - 9 * H, sid: 'z', k: 'rekey', key: 'ME-1', project: 'SVC', text: 'SVC-7' },
  ] as any
  const plan = {
    tickets: [
      { project: 'SVC', title: '修 A', title_en: 'Fix A', col: 'done', sids: ['a'], desc: '已推', desc_en: 'pushed' },
      { project: 'SVC', title: 'B', title_en: 'B', col: 'doing', sids: ['b', 'c'] },
      { project: 'SVC', title: '已有', title_en: 'have', col: 'todo', sids: ['old'] },
    ],
    links: [{ key: 'SVC-3', sids: ['old', 'c'], note: '挂上' }],
  } as any
  const r = planInit(plan, evs, rows, NOW)
  expect(r.err).toEqual([])
  const b = fold([...evs, ...r.evs], [], NOW)
  const tk = (k: string) => b.tickets.find(t => t.key === k)!
  expect(tk('SVC-8').col).toBe('done') // after SVC-7 from the rekey
  expect(tk('SVC-8').title_en).toBe('Fix A')
  expect(tk('SVC-8').desc_en).toBe('pushed')
  expect(tk('SVC-9').sids).toEqual(['b', 'c'])
  expect(tk('SVC-9').col).toBe('doing')
  expect(tk('SVC-3').sids).toEqual(['old', 'c'])
  expect(tk('SVC-3').notes).toEqual(['挂上'])
  expect(r.lines.some(l => l.startsWith('跳过「已有」'))).toBe(true)
  // Rerun: nothing new.
  expect(planInit(plan, [...evs, ...r.evs], rows, NOW).evs).toEqual([])
  expect(planInit({ tickets: [{ project: 'NOPE', title: 'x', title_en: 'x', col: 'todo', sids: ['zz'] }] } as any, evs, rows, NOW).err.length).toBe(2)
})

// WB-28: a proposal lives until the next move; the person's cancel says who and why; 恢复 goes back to where it was.
test('fold: cancel proposal, the person cancel line, restore target, archived canceled', async () => {
  const evs: any[] = [
    { t: NOW - 5 * H, sid: 's1', k: 'create', key: 'SVC-1', project: 'SVC', title: 'A', col: 'follow' },
    { t: NOW - 4 * H, sid: 's1', k: 'move', key: 'SVC-1', col: 'decide', text: 'Claude 建议取消' },
    { t: NOW - 4 * H + 1, sid: 's1', k: 'meta', key: 'SVC-1', meta: { proposeCancel: { reason: '重复', from: 'follow' } } },
    { t: NOW - 10 * 24 * H, sid: 's1', k: 'create', key: 'ME-1', project: 'ME', title: 'old', col: 'doing' },
    { t: NOW - 10 * 24 * H + 1, sid: 's1', k: 'move', key: 'ME-1', col: 'canceled', by: 'me', text: '' },
  ]
  const one = (b: ReturnType<typeof fold>) => b.tickets.find(t => t.key === 'SVC-1')!
  let tk = one(fold(evs, [], NOW))
  expect([tk.col, tk.proposeCancel, keepTo(tk)]).toEqual(['decide', { reason: '重复', from: 'follow' }, 'follow'])
  evs.push({ t: NOW - 3 * H, sid: 'web', k: 'move', key: 'SVC-1', col: 'canceled', by: 'me', text: '重复' })
  const b = fold(evs, [], NOW)
  tk = one(b)
  // the proposal is settled; 恢复 skips 等我拍板 and goes back to the column Claude's proposal came from
  expect([tk.col, tk.proposeCancel, restoreTo(tk)]).toEqual(['canceled', undefined, 'follow'])
  expect(b.feed[0].text).toBe('你取消了「A」：重复')
  expect(fold(evs, [], NOW, 'en').feed[0].text).toBe('You canceled "A": 重复')
  // a plain cancel goes back to the column it left; none known = todo
  expect(restoreTo(one(fold([evs[0], { t: NOW - H, sid: 's1', k: 'move', key: 'SVC-1', col: 'canceled', by: 'me' }], [], NOW)))).toBe('follow')
  expect(keepTo({ ...tk, proposeCancel: { reason: 'x' } })).toBe('todo')
  // ME-1 was canceled 10 days ago: off the board, but in the search pool
  expect(b.tickets.map(t => t.key)).toEqual(['SVC-1'])
  expect(archivedCanceled(evs, b).map(t => t.key)).toEqual(['ME-1'])
})
