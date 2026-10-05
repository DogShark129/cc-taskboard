import type { ClientModule } from 'claude-code'

import type { HeaderProps, HeaderState } from '../types'
// Copied from board-client.tsx on purpose: on the desktop a surface module is shipped to the app on its own, so it must not
// import runtime values from another file (types are fine, they vanish at compile time).
const cells = (str: string) => [...str].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const clip = (str: string, n: number) => {
  if (cells(str) <= n) return str
  let out = ''
  for (const c of str) { if (cells(out + c) > n - 1) break; out += c }
  return n > 0 ? `${out}…` : ''
}

// The pane header (mockup C): one font size, so the hierarchy is weight and color only. Drawn here because a pane Button
// cannot be bold, underlined or colored; clicks are resolved against headerLayout and posted as { hdr: kind, id }.
const GAP = 2
const SEP = ' | '
// The end of a string that fits n cells (a long query shows what was typed last).
const tail = (str: string, n: number) => { let out = ''; for (const c of [...str].reverse()) { if (cells(c + out) > n) break; out = c + out } return out }

export type HeaderItem = { kind: string; id: string; text: string; x: number; y: number; w: number }
export type HeaderHit = { kind: string; id: string; x0: number; x1: number; y: number }
const CLICK = new Set(['nav', 'web', 'theme', 'lang', 'proj', 'filter', 'search', 'seg'])

// Every drawn piece and every hit area (x1 exclusive). Pure: the draw, the pointer math and the tests share it.
// editing: the search field has the keys (draws the local query plus a caret).
export const headerLayout = (p: HeaderProps, width: number, editing = false, q = p.search.q) => {
  const items: HeaderItem[] = []
  const put = (kind: string, id: string, text: string, x: number, y: number, w = cells(text)) => { items.push({ kind, id, text, x, y, w }); return x + w }
  const span = (list: { label: string }[]) => list.reduce((n, it, i) => n + (i ? GAP : 0) + cells(it.label), 0)
  const row = (list: { kind: string; id: string; label: string }[], x: number, y: number) => list.reduce((at, it) => put(it.kind, it.id, it.label, at, y) + GAP, x)
  // Row 0: title + week left, the text actions right; the week nav joins them when it fits beside the title, else it ends row 1.
  const acts = [{ kind: 'web', id: 'web', label: p.web.label }, { kind: 'theme', id: 'theme', label: p.theme }, { kind: 'lang', id: 'lang', label: p.lang }]
  const nav = p.nav.map(n => ({ kind: 'nav', ...n }))
  // No title (the desktop draws it bigger above, as a Markdown heading): the meta line takes row 0 beside the actions.
  const noTitle = !p.title && !p.week
  const head = noTitle ? 20 : cells(p.title) + cells(p.week)
  const navUp = !nav.length || head + GAP + span(nav) + GAP + span(acts) <= width
  const right = navUp ? [...nav, ...acts] : acts
  const rx = Math.max(0, width - span(right))
  const room = Math.max(0, rx - GAP)
  if (noTitle) put('meta', '', clip(p.meta, room), 0, 0)
  else {
    const titleW = Math.min(cells(p.title), Math.max(0, room - cells(p.week)))
    put('week', '', p.week, put('title', '', clip(p.title, titleW), 0, 0, titleW), 0)
  }
  row(right, rx, 0)
  // Row 1: the meta line (when the title holds row 0), truncated before the nav that moved down; or the nav alone.
  const nx = navUp ? width : Math.max(0, width - span(nav))
  if (!noTitle) put('meta', '', clip(p.meta, navUp ? width : Math.max(0, nx - GAP)), 0, 1)
  if (!navUp) row(nav, nx, 1)
  // Tabs, wrapping by whole tabs; a tab's decide count belongs to it (same hit area).
  let x = 0
  let y = noTitle && navUp ? 1 : 2
  for (const tb of p.tabs) {
    const w = cells(tb.label) + (tb.decide ? 1 + cells(String(tb.decide)) : 0)
    if (x > 0 && x + w > width) { x = 0; y++ }
    put('proj', tb.id, tb.label, x, y, w)
    x += w + GAP
  }
  // Tools: filters, the search field, the board / feed segments right-aligned (on their own row when they do not fit).
  y++
  x = row(p.filters.map(f => ({ kind: 'filter', ...f })), 0, y)
  const segW = span(p.segs) - (p.segs.length - 1) * (GAP - SEP.length)
  const segUp = x + cells(p.search.placeholder) + 1 + GAP + segW <= width
  const searchEnd = segUp ? width - segW - GAP : width
  const shown = editing ? `${tail(q, Math.max(0, searchEnd - x - 1))}|` : q ? tail(q, Math.max(0, searchEnd - x)) : clip(p.search.placeholder, Math.max(0, searchEnd - x))
  items.push({ kind: 'search', id: 'search', text: shown, x, y, w: Math.max(cells(shown), searchEnd - x) })
  const sy = segUp ? y : y + 1
  p.segs.reduce((at, s, i) => put('seg', s.id, s.label, i ? put('sep', '', SEP, at, sy) : at, sy), width - segW)
  y = sy
  if (p.live) put('live', '', clip(p.live, width), 0, ++y)
  const hits: HeaderHit[] = items.filter(it => CLICK.has(it.kind)).map(it => ({ kind: it.kind, id: it.id, x0: it.x, x1: it.x + it.w, y: it.y }))
  return { items, hits, height: y + 1 }
}

const HeaderClient: ClientModule<HeaderProps, HeaderState> = (p, s) => {
  const { Box, Text, Link } = s.elements
  const st: HeaderState = s.state ?? { editing: false, q: p.search.q }
  const lay = headerLayout(p, p.width, st.editing, st.editing ? st.q : p.search.q)
  const { surf } = p
  const send = (q: string) => { s.setState({ editing: true, q }); s.post({ hdr: 'q', text: q }) }
  s.onPointer(ev => {
    if (ev.type !== 'down' || ev.button !== 'left') return
    const h = lay.hits.find(h => h.y === ev.y && ev.x >= h.x0 && ev.x < h.x1)
    if (h?.kind === 'search') { s.setState({ editing: true, q: st.editing ? st.q : p.search.q }); return }
    if (st.editing) s.setState({ ...st, editing: false })
    // the web Link opens the page itself; the engine has no open-URL call for the hooks module to make
    if (!h || h.kind === 'web') return
    s.post(h.kind === h.id ? { hdr: h.kind } : { hdr: h.kind, id: h.id })
  })
  s.onKey(ev => {
    if (!st.editing) return
    if (ev.key === 'return') s.setState({ ...st, editing: false })
    else if (ev.key === 'backspace') send([...st.q].slice(0, -1).join(''))
    else if (!ev.ctrl && !ev.meta && (ev.key === 'space' || [...ev.key].length === 1)) send(st.q + (ev.key === 'space' ? ' ' : ev.key))
  })

  const tab = (it: HeaderItem) => {
    const tb = p.tabs.find(t => t.id === it.id)!
    return [
      tb.active ? <Text key={`t-${it.id}`} bold underline color={surf.accent}>{tb.label}</Text> : <Text key={`t-${it.id}`} color={surf.sub}>{tb.label}</Text>,
      tb.decide ? <Text key={`n-${it.id}`} color={surf.decide}>{` ${tb.decide}`}</Text> : null,
    ]
  }
  const piece = (it: HeaderItem) => {
    const k = `${it.kind}-${it.id}`
    switch (it.kind) {
      case 'title': return <Text key={k} bold color={surf.text}>{it.text}</Text>
      case 'week': case 'meta': case 'nav': case 'theme': case 'lang': case 'sep': return <Text key={`${k}-${it.x}`} color={surf.mute}>{it.text}</Text>
      case 'web': return <Link key="web-link" href={p.web.href} label={it.text} />
      case 'proj': return tab(it)
      case 'filter': { const on = p.filters.find(f => f.id === it.id)?.on; return <Text key={k} bold={on} color={on ? surf.accent : surf.sub}>{it.text}</Text> }
      case 'search': return <Text key={k} color={st.editing || p.search.q ? surf.text : surf.mute}>{it.text}</Text>
      case 'seg': { const on = p.segs.find(x => x.id === it.id)?.active; return <Text key={k} bold={on} color={on ? surf.text : surf.sub}>{it.text}</Text> }
      default: return <Text key={k} color={surf.live}>{it.text}</Text>
    }
  }
  // One row = its pieces in x order, the gaps between them filled with spaces.
  return (
    <Box flexDirection="column" width={p.width}>
      {Array.from({ length: lay.height }, (_, y) => {
        let at = 0
        return (
          <Box key={`r${y}`} height={1} width={p.width} overflow="hidden">
            {lay.items.filter(it => it.y === y).sort((a, b) => a.x - b.x).flatMap(it => {
              const pad = it.x - at
              at = it.x + (it.kind === 'search' ? cells(it.text) : it.w)
              return [pad > 0 ? <Text key={`g${it.x}`}>{' '.repeat(pad)}</Text> : null, piece(it)]
            })}
          </Box>
        )
      })}
    </Box>
  )
}

export default HeaderClient
