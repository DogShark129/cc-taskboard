import type { ClientModule } from 'claude-code'

// WB-36: one pane row as a Client surface module, so a click anywhere on it (not only on the title) opens its preview.
// register.tsx's row() hands it plain data; a click posts the key back, and its ui.message hook folds the preview open or shut.
// WB-43: a status section's head is the same clickable line: `lead` in place of the key, and a click posts `post` ({ fold }).
type Seg = { text: string; color: string; pill?: boolean; bold?: boolean }
type Props = { id: string; keyColor: string; title: string; dim: boolean; bg: string | null; hoverBg: string; right: Seg[]; lead?: Seg[]; post?: Record<string, unknown> }

const Row: ClientModule<Props> = (p, surface) => {
  const { Box, Text } = surface.elements
  const toggle = () => surface.post(p.post ?? { toggle: p.id })
  surface.onPointer(e => { if (e.type === 'down' && e.button === 'left') toggle() })
  surface.onKey(e => { if (e.key === 'return' || e.key === ' ') toggle() })
  const seg = (r: Seg, k: string) => <Text key={k} color={r.color} inverse={r.pill} bold={r.pill || r.bold}>{r.text}</Text>
  return (
    <Box key={`${p.lead ? 'head' : 'row'}-${p.id}`} gap={1} width="100%" backgroundColor={p.bg ?? undefined} hover={{ backgroundColor: p.hoverBg }}>
      {/* the key leads the row in the project color (WB-33); it names the project too */}
      {p.lead ? p.lead.map((r, i) => seg(r, `l${i}`)) : <Box flexShrink={0}><Text bold color={p.keyColor}>{p.id}</Text></Box>}
      <Box flexGrow={1} flexShrink={1}><Text dimColor={p.dim} wrap="truncate-end">{p.title}</Text></Box>
      {p.right.map((r, i) => seg(r, `r${i}`))}
    </Box>
  )
}
export default Row
