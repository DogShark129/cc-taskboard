import type { ClientModule } from 'claude-code'

import type { BoardProps, CardProps, DragState } from '../types'

// Geometry so a pointer cell maps back to a card: header rows (name row + 1 empty), then cards one after another, 1 empty row between them.
// A card's height follows its title: 1..3 title rows + 1 meta row on a square tint block, no border. cardRows / cardHeight are the one source:
// the draw, the grid, the pointer math, the Client's height and the tests all derive from them.
export const HEAD_H = 2
export const CARD_H = 4 // the maximum card height (3 title rows)
// The preview popup (Jira's issue view): absolutely positioned over the columns, centered. Shared by the pointer math, the draw and the tests.
// Rows inside it, border = row 0: 1 header, 2 gap, 3-4 title, 5 action button, body below, footer on row h-2.
export const PEEK_H = 16
export const PEEK_MAX_H = 26
export const PEEK_MAX_W = 96
export const PEEK_WIDE = 80 // at this width and up: left column + right column; below: stacked
export const PEEK_SIDE = 34 // the right column, border included
// Terminal cells of a string: Han and full-width forms take two.
export const cells = (str: string) => [...str].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
// Cut a string to n cells, an ellipsis marking the cut.
export const clip = (str: string, n: number) => {
  if (cells(str) <= n) return str
  let out = ''
  for (const c of str) { if (cells(out + c) > n - 1) break; out += c }
  return n > 0 ? `${out}…` : ''
}
// What a card draws in its title area: bracket code, a space, the rest.
type Titled = { code?: string; rest?: string }
const titleText = (c: Titled) => `${c.code ? `${c.code} ` : ''}${c.rest ?? ''}`
// Title rows a card of this width needs, 1..3 (inner width = card - stripe 1 - padding 2). Longer titles are clipped, never taller.
export const cardRows = (c: Titled, cardWidth: number) => Math.min(3, Math.max(1, Math.ceil(cells(titleText(c)) / Math.max(1, cardWidth - 3))))
export const cardHeight = (c: Titled, cardWidth: number) => 1 + cardRows(c, cardWidth)
// rows = the board's own height; the popup grows with it up to PEEK_MAX_H. margin = cells kept free beside it (4 on the wide board, 2 on the grid).
// The stacked layout (below PEEK_WIDE) holds both columns in one, so it starts at the maximum height.
export const peekRect = (region: number, rows = 0, margin = 4) => {
  const w = Math.min(PEEK_MAX_W, region - margin)
  return { w, h: Math.min(PEEK_MAX_H, Math.max(w >= PEEK_WIDE ? PEEK_H : PEEK_MAX_H, rows)), top: 1, left: Math.floor((region - w) / 2) }
}
// Every hit area, popup-relative (dx, dy): content starts at dx 2 (border + padding).
export const peekGeo = (region: number, rows: number, open: string, margin = 4) => {
  const r = peekRect(region, rows, margin)
  const wide = r.w >= PEEK_WIDE
  const leftW = wide ? r.w - 4 - PEEK_SIDE - 2 : r.w - 4
  return { ...r, wide, leftW, closeX: r.w - 4, titleY: [3, 4], btn: { y: 5, x0: 2, x1: 2 + cells(`[ ${open} ]`) } }
}

// The board's columns, drawn where pointer events reach: press a card and drag it to another column
// to move it (posts { move, col }); press and release in place to preview it (posts { peek }).
// While a preview is open every click is resolved against its geometry: outside or x closes, title / open button opens the detail.
// The narrow board: fixed-size cards in a wrapping grid, one section per column. Pure, so the draw, the pointer math, the hooks module's height and the tests share it.
// Section = header row + card rows (1 row between them); 1 blank row between sections. Cards that fit a row: floor((regionW + 1) / (GRID_CARD_W + 1)), at least one;
// a lone card takes the whole region width.
export const GRID_CARD_W = 30
type Stub = { key: string } & Titled
// Cards of one column stacked from row y0: each with its own y / h, 1 empty row between; end = the first free row after the last.
const stack = <T extends Stub>(cards: T[], w: number, y0: number) => {
  let y = y0
  const out = cards.map(c => { const h = cardHeight(c, w); const r = { key: c.key, y, h }; y += h + 1; return r })
  return { cards: out, end: Math.max(y0, y - 1) }
}
export const gridLayout = (cols: { id: string; cards: Stub[] }[], regionW: number) => {
  const cw = Math.min(GRID_CARD_W, regionW)
  const per = Math.max(1, Math.floor((regionW + 1) / (cw + 1)))
  const w = per === 1 ? regionW : cw
  let y = 0
  const sections = cols.map(c => {
    const top = y
    let ry = top + 1
    const cards: { key: string; x: number; y: number; w: number; h: number }[] = []
    const rowH: number[] = []
    for (let i = 0; i < c.cards.length; i += per) {
      const row = c.cards.slice(i, i + per).map((k, j) => ({ key: k.key, x: j * (w + 1), y: ry, w, h: cardHeight(k, w) }))
      const h = Math.max(...row.map(k => k.h)) // a row is as tall as its tallest card; the others keep their own height, top-aligned
      cards.push(...row)
      rowH.push(h)
      ry += h + 1
    }
    const h = ry - top - (rowH.length ? 1 : 0)
    y += h + 1
    return { id: c.id, y: top, h, rowH, cards }
  })
  return { w, per, height: Math.max(1, y - 1), sections }
}
// The wide board's column: each card's y / h (rows from the board's top, below the header).
export const columnLayout = (cards: Stub[], colW: number) => stack(cards, colW, HEAD_H).cards
// The board's own height in rows: the stacked grid, or the tallest of the wide columns (room for at least one card).
export const boardHeight = (cols: { id: string; cards: Stub[] }[], colW: number, grid?: number) =>
  grid ? gridLayout(cols, grid).height : Math.max(...cols.map(c => stack(c.cards, colW, HEAD_H).end), HEAD_H + cardHeight({}, colW))

const BoardClient: ClientModule<BoardProps, DragState> = (p, s) => {
  const { Box, Text, Input } = s.elements
  const st: DragState = s.state ?? { drag: null, from: -1, over: -1 }
  const slot = p.colW + 1
  const lay = p.grid ? gridLayout(p.cols, p.grid) : null // grid mode: sections stacked, drag targets are sections
  const margin = lay ? 2 : 4
  const colAt = (x: number) => Math.max(0, Math.min(p.cols.length - 1, Math.floor(x / slot)))
  // The column (wide) or section (grid, by the row only) a cell falls in.
  const unitAt = (x: number, y: number) => (lay ? Math.max(0, lay.sections.findLastIndex(s => s.y <= y)) : colAt(x))
  const cardAt = (x: number, y: number) => {
    if (lay) return lay.sections.flatMap(s => s.cards).find(c => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h)?.key ?? null
    return columnLayout(p.cols[colAt(x)]?.cards ?? [], p.colW).find(c => y >= c.y && y < c.y + c.h)?.key ?? null
  }
  // The done column's right-aligned expand / collapse text, on its header row.
  const toggleAt = (x: number, y: number) => {
    const ci = lay ? lay.sections.findIndex(s => s.y === y) : y === 0 ? colAt(x) : -1
    const tg = p.cols[ci]?.toggle
    return Boolean(tg) && x >= (lay ? p.grid! : ci * slot + p.colW) - cells(tg!)
  }

  const region = lay ? p.grid! : p.cols.length * p.colW + p.cols.length - 1
  const rows = boardHeight(p.cols, p.colW, p.grid)
  s.onPointer(ev => {
    if (p.peek) {
      if (ev.type === 'down' && ev.button === 'left') s.setState({ ...st, pd: true })
      else if (ev.type === 'up' && st.pd) {
        const g = peekGeo(region, rows, p.peek.open, margin)
        const dx = ev.x - g.left
        const dy = ev.y - g.top
        if (dx < 0 || dx >= g.w || dy < 0 || dy >= g.h || (dy === 1 && dx >= g.closeX)) s.post({ peek: null })
        else if ((dy >= g.titleY[0] && dy <= g.titleY[1] && dx >= 2 && dx < 2 + g.leftW) || (dy === g.btn.y && dx >= g.btn.x0 && dx < g.btn.x1)) s.post({ open: p.peek.key })
        s.setState({ drag: null, from: -1, over: -1 })
      }
      return
    }
    if (ev.type === 'down' && ev.button === 'left') {
      if (toggleAt(ev.x, ev.y)) { s.post({ toggleDone: true }); return }
      const key = cardAt(ev.x, ev.y)
      if (key) s.setState({ drag: key, from: unitAt(ev.x, ev.y), over: unitAt(ev.x, ev.y) })
    } else if (ev.type === 'move' && st.drag && ev.button) {
      if (unitAt(ev.x, ev.y) !== st.over) s.setState({ ...st, over: unitAt(ev.x, ev.y) })
    } else if (ev.type === 'up' && st.drag) {
      const to = unitAt(ev.x, ev.y)
      s.post(to === st.from ? { peek: st.drag } : { move: st.drag, col: p.cols[to].id })
      s.setState({ drag: null, from: -1, over: -1 })
    }
  })

  const k = p.peek
  const g = peekGeo(region, rows, k?.open ?? '', margin)
  // Lines the description may take: what is left of the body after the fixed left-column rows (title 2, button, two headings, the comment input) and the comments.
  const descMax = Math.max(1, Math.min(6, g.h - 5 - 6 - (k?.commentList.length ?? 0) * 2))
  const tx = { backgroundColor: k?.bg, color: k?.fg } // every popup Text sits on the popup's own background
  const { surf } = p
  // Column / section header: bold status-colored name + muted count, the done column's toggle on the right; highlighted while a card is dragged over it.
  const head = (c: BoardProps['cols'][number], ci: number) => (
    <Box flexGrow={1} justifyContent="space-between" gap={1}>
      <Box gap={1}>
        {st.drag !== null && ci === st.over && ci !== st.from
          ? <Text bold inverse color={c.color}>{` ${p.labels.dropTo} ${c.name} `}</Text>
          : <Text bold color={c.color}>{c.name}</Text>}
        <Text color={surf.mute}>{c.count}</Text>
      </Box>
      {c.toggle ? <Text color={surf.mute}>{c.toggle}</Text> : null}
    </Box>
  )
  // One ticket card (accent-stripe style, no border): a ▎ on every row in the status color (live color while a session works it; a full █ while dragged),
  // then 1-3 title rows + 1 meta row on the tint.
  // Height follows the title (cardHeight); w = fixed width in the grid, else the column's.
  const drawCard = (k: CardProps, stripe: string, w?: number) => {
    const isDragged = k.key === st.drag
    // Inner width: card minus stripe (1), padding (2); labels get what key and priority leave.
    const labels = clip(k.labels, (w ?? p.colW) - 3 - cells(k.key) - (k.priority ? cells(k.priority) + 3 : 0) - 1)
    const tx = { backgroundColor: surf.tint } // every card Text sits on the card's own tint
    const tr = cardRows(k, w ?? p.colW)
    return (
      <Box key={k.key} height={1 + tr} width={w} backgroundColor={surf.tint}>
        <Box width={1} flexShrink={0} flexDirection="column" backgroundColor={surf.tint}>
          {Array.from({ length: 1 + tr }, (_, i) => <Text key={`s${i}`} {...tx} color={isDragged ? k.color : k.live ? surf.live : stripe}>{isDragged ? '█' : '▎'}</Text>)}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} paddingX={1} overflow="hidden" backgroundColor={surf.tint}>
          <Box height={tr} overflow="hidden" backgroundColor={surf.tint}>
            <Text {...tx} color={k.done ? surf.mute : surf.text} dimColor={isDragged}>{k.code ? <Text {...tx} bold>{k.code}</Text> : null}{k.code ? ' ' : ''}{k.rest}</Text>
          </Box>
          <Box justifyContent="space-between" gap={1} height={1} overflow="hidden" backgroundColor={surf.tint}>
            <Box gap={1} flexShrink={0} backgroundColor={surf.tint}>
              <Text {...tx} color={k.done ? surf.mute : k.color} bold strikethrough={k.done}>{k.key}</Text>
              {k.priority ? <Text color={k.priorityColor} inverse bold>{` ${k.priority} `}</Text> : null}
              {labels ? <Text {...tx} color={surf.mute}>{labels}</Text> : null}
            </Box>
            {/* ponytail: the right side clips at the card edge first; labels were already cut to what the key and priority leave */}
            <Box gap={1} flexShrink={1} overflow="hidden" backgroundColor={surf.tint}>
              {k.blocked ? <Text {...tx} color="#d9777a">{p.labels.blocked} {k.blocked}</Text> : null}
              {k.due ? <Text {...tx} color={k.dueColor}>{k.due}</Text> : null}
              {k.live ? <Text {...tx} color={surf.live}>{p.labels.live}</Text> : null}
              {k.age ? <Text {...tx} color={k.ageColor}>{k.age}{p.labels.days}</Text> : null}
              {k.comments ? <Text {...tx} color={surf.mute}>{k.comments} {p.labels.comments}</Text> : null}
              {k.pr ? <Text {...tx} color={surf.mute}>PR {k.pr}</Text> : null}
            </Box>
          </Box>
        </Box>
      </Box>
    )
  }
  return (
    <Box gap={1} flexDirection={lay ? 'column' : 'row'}>
      {k ? (
        <Box position="absolute" top={g.top} left={g.left} width={g.w} height={g.h} flexDirection="column" borderStyle="round"
          borderColor={k.border} backgroundColor={k.bg} paddingX={1} overflow="hidden">
          <Box height={1} justifyContent="space-between" backgroundColor={k.bg}>
            <Box backgroundColor={k.bg}>
              <Text {...tx} color={k.mute}>{`${k.project} / `}</Text>
              <Text {...tx} color={k.color} bold>{k.key}</Text>
            </Box>
            <Text {...tx} color={k.mute}>×</Text>
          </Box>
          <Text {...tx}> </Text>
          <Box flexGrow={1} flexDirection={g.wide ? 'row' : 'column'} gap={2} overflow="hidden" backgroundColor={k.bg}>
            <Box flexGrow={1} width={g.leftW} flexDirection="column" overflow="hidden" backgroundColor={k.bg}>
              <Box height={2} overflow="hidden" backgroundColor={k.bg}>
                <Text {...tx} bold>{k.code ? <Text {...tx} bold color={k.color}>{k.code}</Text> : null}{k.code ? ' ' : ''}{k.rest}</Text>
              </Box>
              <Text {...tx} color={k.color} bold>{`[ ${k.open} ]`}</Text>
              <Text {...tx} color={k.mute} bold>{k.descTitle}</Text>
              {k.desc.length ? k.desc.slice(0, descMax).map((l, i) => <Text key={`d${i}`} {...tx} wrap="truncate-end">{l}</Text>) : <Text {...tx} color={k.mute}>{k.descNone}</Text>}
              <Text {...tx} color={k.mute} bold>{k.commentsTitle}</Text>
              {k.commentList.map((c, i) => (
                <Box key={`c${i}`} flexDirection="column" backgroundColor={k.bg}>
                  <Text {...tx} color={k.mute} wrap="truncate-end">{c.head}</Text>
                  <Text {...tx} wrap="truncate-end">{c.text}</Text>
                </Box>
              ))}
              {/* a click on its row is inside the popup: the pointer math above ignores it */}
              <Input key="peek-comment" placeholder={k.commentPh} submitLabel={k.send} onSubmit={(text: string) => s.post({ comment: k.key, text })} />
            </Box>
            <Box width={g.wide ? PEEK_SIDE : g.leftW} flexDirection="column" overflow="hidden" backgroundColor={k.bg}>
              <Box height={1} backgroundColor={k.bg}>
                <Text {...tx} color={k.statusColor} bold inverse>{` ${k.status} ▾ `}</Text>
              </Box>
              <Text {...tx}> </Text>
              <Box flexDirection="column" borderStyle="round" borderColor={k.border} paddingX={1} backgroundColor={k.bg}>
                <Text {...tx} color={k.mute} bold>{k.detailsTitle}</Text>
                {k.rows.map(r => (
                  <Box key={r.label} height={1} gap={1} backgroundColor={k.bg}>
                    <Box width={12} flexShrink={0} backgroundColor={k.bg}><Text {...tx} color={k.mute} wrap="truncate-end">{r.label}</Text></Box>
                    <Box flexGrow={1} backgroundColor={k.bg}>
                      <Text {...tx} color={r.color} bold={r.lozenge} inverse={r.lozenge} wrap="truncate-end">{r.lozenge ? ` ${r.value} ` : r.value}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
          <Box height={1} justifyContent="space-between" backgroundColor={k.bg}>
            <Text {...tx} color={k.mute}>{k.footer}</Text>
            <Text {...tx} color={k.mute}>{k.hint}</Text>
          </Box>
        </Box>
      ) : null}
      {lay ? p.cols.map((c, ci) => (
        <Box key={c.id} flexDirection="column">
          {head(c, ci)}
          {c.cards.length ? (
            <Box flexDirection="column" gap={1}>
              {Array.from({ length: Math.ceil(c.cards.length / lay.per) }, (_, r) => (
                <Box key={`r${r}`} gap={1} alignItems="flex-start" height={lay.sections[ci].rowH[r]}>{c.cards.slice(r * lay.per, (r + 1) * lay.per).map(k => drawCard(k, c.color, lay.w))}</Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )) : p.cols.map((c, ci) => (
        <Box key={c.id} flexDirection="column" width={p.colW}>
          <Box height={HEAD_H}>{head(c, ci)}</Box>
          <Box flexDirection="column" gap={1}>{c.cards.map(k => drawCard(k, c.color))}</Box>
        </Box>
      ))}
    </Box>
  )
}

export default BoardClient
