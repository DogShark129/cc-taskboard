export type Col = 'decide' | 'todo' | 'doing' | 'follow' | 'review' | 'done' | 'canceled'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'
export type Comment = { t: number; sid: string; by: 'claude' | 'me'; text: string }

export type Ticket = {
  key: string
  project: string
  // Chinese; title_en / desc_en hold the English (WB-18). Either may be missing until Claude fills it.
  title: string
  title_en?: string
  col: Col
  src: 'claude' | 'me'
  created: number
  since: number
  commits: number
  pr?: string
  notes: string[]
  // Old keys from a Jira-style move to another board (ME-11 → WB-10); events under them still land here.
  aliases?: string[]
  desc?: string
  desc_en?: string
  priority?: Priority
  comments: Comment[]
  branch?: string
  worktree?: string
  labels?: string[]
  // YYYY-MM-DD; '' = cleared
  due?: string
  // Relations, by canonical key: tickets this one waits on, and its parent ('' = none). The reverse sides are derived.
  blockedBy?: string[]
  parent?: string
  // WB-28: Claude asked to cancel it (it waits in decide; from = the column it came from), until the person confirms or keeps it.
  proposeCancel?: { reason: string; from?: Col }
  // Derived by fold from the log: the column it was in before its last cancel, where 恢复 sends it.
  canceledFrom?: Col
  sids: string[]
  log: { t: number; sid: string; text: string }[]
}

export type Sess = {
  sid: string
  cwd: string
  name: string
  project: string | null
  seen: number
  state: 'run' | 'idle' | 'wait'
  ticket?: string
  // From `claude agents --json`: the session's real title, and whether its process is still around.
  label?: string
  isGone?: boolean
  // Days (local midnight ms) this session took a prompt: the dates its title lists.
  days?: number[]
  // Newest comment by the person this session has already handled (woken for, or chose not to own).
  wokeUntil?: number
  // Newest web-board move this session has already looked at for 待开工 → 进行中 (WB-20).
  webUntil?: number
  // The desktop app's id for this session (CLAUDE_CODE_HOST_SESSION_ID): what set_session_title takes, and its local_<id>.json holds the title (WB-24).
  app?: string
}

export type Lang = 'zh' | 'en'
export type FeedItem = { t: number; sid: string; key: string; icon: 'new' | 'move' | 'commit' | 'pr' | 'comment'; text: string }

export type Board = {
  tickets: Ticket[]
  sessions: Sess[]
  feed: FeedItem[]
  weekStart: number
  commitsThisWeek: number
  createdThisWeek: number
}

// What the board's Client module draws: plain data, colors precomputed by the hooks module.
export type CardProps = {
  key: string; code: string; rest: string; color: string; src: 'claude' | 'me'
  live: boolean; done: boolean; age: number | null; ageColor: string; pr: string
  priority: string; priorityColor: string; comments: number
  labels: string; due: string; dueColor: string; blocked: string
  // Claude proposed to cancel it: the meta row carries 确认取消 / 保留 (WB-28).
  propose?: boolean
}
// The Jira-style preview popup: everything it shows, localized and cleaned by the hooks module.
export type PeekProps = {
  key: string; project: string; color: string; code: string; rest: string
  status: string; statusColor: string
  // Details panel rows, empty ones already left out; `lozenge` draws the value as a pill.
  rows: { label: string; value: string; color: string; lozenge?: boolean }[]
  detailsTitle: string; descTitle: string; desc: string[]; descNone: string
  commentsTitle: string; commentList: { head: string; text: string }[]
  footer: string; open: string; hint: string
  // The comment box under the comments: its placeholder and what Enter does.
  commentPh: string; send: string
  // Buttons after the open button on the same row (WB-28): cancel, or confirm / keep a proposal, or restore.
  acts: { id: 'cancel' | 'confirm' | 'keep' | 'restore'; label: string }[]
  bg: string; fg: string; border: string; mute: string
}
export type BoardProps = {
  colW: number
  // Grid mode (the narrow pane): the region width. Unset = the wide board, colW per column.
  grid?: number
  peek?: PeekProps
  labels: { dropTo: string; comments: string; days: string; blocked: string; live: string; cancelOk: string; keep: string }
  // The canceled column when the board has none: drawn as a drop bar only while a card is dragged (WB-28).
  dropCancel?: { name: string; color: string }
  // Surface colors for the user's theme (the Client cannot read the view).
  surf: { tint: string; text: string; sub: string; mute: string; accent: string; live: string }
  // count = every ticket of the column; cards = the ones drawn (none while done / canceled is folded); toggle = their expand / collapse word.
  cols: { id: Col; name: string; color: string; count: number; toggle?: string; cards: CardProps[] }[]
}
// The pane header drawn by its own Client (WB-23): every string localized, every color resolved by the hooks module.
export type HeaderProps = {
  width: number
  title: string; week: string; meta: string
  nav: { id: 'prev' | 'next' | 'now'; label: string }[]
  tabs: { id: string; label: string; decide: number; active: boolean }[]
  filters: { id: 'me' | 'live'; label: string; on: boolean }[]
  segs: { id: 'board' | 'feed'; label: string; active: boolean }[]
  search: { q: string; placeholder: string }
  live: string
  // Right-side text actions of row 1; web is drawn as a Link to href.
  web: { label: string; href: string }; theme: string; lang: string
  surf: { text: string; sub: string; mute: string; accent: string; live: string; decide: string }
}
export type HeaderState = { editing: boolean; q: string }
export type DragState = { drag: string | null; from: number; over: number; pd?: boolean }

// auto = follow the Claude app; Resolved is what auto turns into.
export type Resolved = 'light' | 'dark'
export type Theme = 'auto' | Resolved
export type View = { proj: string; tab: 'board' | 'feed'; sel: string | null; week?: number; collapsed?: string[]; lang?: Lang; theme?: Theme; themeResolved?: Resolved; peek?: string | null; q?: string; me?: boolean; live?: boolean; doneOpen?: boolean; canceledOpen?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cc-taskboard': { board: Board; view: View }
  }
}
