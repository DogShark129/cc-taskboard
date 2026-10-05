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

// auto = follow the Claude app; Resolved is what auto turns into.
export type Resolved = 'light' | 'dark'
export type Theme = 'auto' | Resolved
// off: statuses the legend hid; more: sections expanded past their narrow cap; todoOpen / doneOpen / canceledOpen: the folds under the list.
export type View = { proj: string; tab: 'board' | 'feed'; sel: string | null; week?: number; lang?: Lang; themeResolved?: Resolved; peek?: string | null; q?: string; me?: boolean; live?: boolean; off?: Col[]; more?: Col[]; todoOpen?: boolean; doneOpen?: boolean; canceledOpen?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cc-taskboard': { board: Board; view: View }
  }
}
