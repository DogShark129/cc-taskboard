import type { ClientModule } from 'claude-code'

// WB-36: one pane row as a Client surface module, so a click anywhere on it (not only on the title) opens its preview.
// register.tsx's row() hands it plain data; a click posts the key back, and its ui.message hook folds the preview open or shut.
type Seg = { text: string; color: string; pill?: boolean }
type Props = { id: string; keyColor: string; title: string; dim: boolean; bg: string | null; hoverBg: string; right: Seg[] }

const Row: ClientModule<Props> = (p, surface) => {
  const { Box, Text } = surface.elements
  const toggle = () => surface.post({ toggle: p.id })
  surface.onPointer(e => { if (e.type === 'down' && e.button === 'left') toggle() })
  surface.onKey(e => { if (e.key === 'return' || e.key === ' ') toggle() })
  return (
    <Box key={`row-${p.id}`} gap={1} width="100%" backgroundColor={p.bg ?? undefined} hover={{ backgroundColor: p.hoverBg }}>
      {/* the key leads the row in the project color (WB-33); it names the project too */}
      <Box flexShrink={0}><Text bold color={p.keyColor}>{p.id}</Text></Box>
      <Box flexGrow={1} flexShrink={1}><Text dimColor={p.dim} wrap="truncate-end">{p.title}</Text></Box>
      {p.right.map((r, i) => <Text key={`r${i}`} color={r.color} inverse={r.pill} bold={r.pill}>{r.text}</Text>)}
    </Box>
  )
}
export default Row
