// Pure board logic shared by the mod (register.tsx) and the web server (web/server.ts): no claude-code runtime imports.
// explicit .d.ts so Deno can resolve it (type-only import)
import type { Board, Col, FeedItem, Lang, Priority, Resolved, Sess, Ticket } from '../types/index.d.ts'

export const LIVE_MS = 3 * 60_000
// The data dir, under HOME (CC_TASKBOARD_DATA overrides it). The legacy one is used only while the new one does not exist.
export const DATA_DIR = '.claude/cc-taskboard'
export const LEGACY_DATA_DIR = '.claude/weekly-board'

// Boards come from <data>/projects.json (written by the ticket tool's init action), not from code.
// match is a case-insensitive regex source tested against a session's cwd; the first board that matches owns it.
export type ProjectConf = { id?: string; name: string; name_en?: string; color?: string; icon?: string; root?: string; match: string }
export type Project = Required<Omit<ProjectConf, 'name_en' | 'match'>> & { name_en?: string; match: RegExp }
export const PROJECTS_FILE = 'projects.json'
export const PROJECT_ID = /^[A-Z][A-Z0-9]{0,9}$/
const PALETTE_CYCLE = ['#8394e6', '#c98bb9', '#a58fd6', '#4fae9f', '#cfa255', '#6f9fdc']
// Filled in place, so every module holding the array sees a reload.
export const PROJECTS: Project[] = []
// Validates and loads a projects.json body; returns the errors and leaves PROJECTS untouched when there are any.
// WB-34: a board without an id gets a default prefix: the initials of its English name (one word: its first three letters),
// else of its name, else of its repo folder (cc-taskboard → CT), else B1, B2…; a clash gets a number on the end.
export function defaultPrefix(p: { name?: string; name_en?: string; root?: string }, taken: Set<string>) {
  const words = (s?: string) => (s ?? '').split(/[^A-Za-z0-9]+/).filter(w => /^[A-Za-z]/.test(w))
  const from = [p.name_en, p.name, (p.root ?? '').split('/').filter(Boolean).at(-1)].map(words).find(w => w.length)
  if (!from) { for (let n = 1; ; n++) if (!taken.has(`B${n}`)) return `B${n}` }
  const base = (from.length === 1 ? from[0].slice(0, 3) : from.map(w => w[0]).join('')).toUpperCase().slice(0, 8)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`
}
// True when a projects.json body has boards without an id: the loader writes the filled-in defaults back, so they stay put.
export const missingIds = (raw: unknown) => Array.isArray(raw) && raw.some(p => p && typeof p === 'object' && !(p as ProjectConf).id)
export function setProjects(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw as ProjectConf[] : []
  const err: string[] = Array.isArray(raw) ? [] : ['projects 要是数组']
  const next: Project[] = []
  const taken = new Set(list.map(p => p?.id).filter(Boolean) as string[])
  list.forEach((conf, i) => {
    const p = conf && !conf.id && conf.name ? { ...conf, id: defaultPrefix(conf, taken) } : conf
    if (p?.id) taken.add(p.id)
    if (!p || !PROJECT_ID.test(p.id ?? '')) return err.push(`第 ${i + 1} 个 board 的 id 要是大写字母开头的前缀，如 APP`)
    if (next.some(x => x.id === p.id)) return err.push(`board id ${p.id} 重复`)
    if (!p.name) return err.push(`${p.id} 缺 name`)
    let match: RegExp
    try { match = new RegExp(p.match, 'i') } catch { return err.push(`${p.id} 的 match 不是合法正则`) }
    next.push({ id: p.id as string, name: p.name, name_en: p.name_en, color: p.color ?? PALETTE_CYCLE[i % PALETTE_CYCLE.length], icon: p.icon ?? 'layers', root: p.root ?? '', match })
  })
  if (!err.length) PROJECTS.splice(0, PROJECTS.length, ...next)
  return err
}
export const projectsJson = () => PROJECTS.map(p => ({ id: p.id, name: p.name, ...(p.name_en ? { name_en: p.name_en } : {}), color: p.color, icon: p.icon, root: p.root, match: p.match.source }))
export const projectFor = (cwd: string) => PROJECTS.find(p => p.match.test(cwd))?.id ?? null
export const COLS: { id: Col; name: string; color: string; icon: string; rule: string }[] = [
  { id: 'decide', name: '等我拍板', color: '#d9777a', icon: 'hourglass', rule: 'Claude 提问' },
  { id: 'todo', name: '待开工', color: '#8c94a3', icon: 'inbox', rule: '新建' },
  { id: 'doing', name: '进行中', color: '#6f9fdc', icon: 'activity', rule: '开始改代码' },
  { id: 'follow', name: '待跟进', color: '#cfa255', icon: 'eye', rule: '开 PR' },
  { id: 'review', name: '待审核', color: '#5aa9b8', icon: 'check', rule: 'Claude 做完' },
  { id: 'done', name: '已完成', color: '#62b38a', icon: 'check', rule: 'PR 合并' },
  // Only drawn when it holds a ticket: most weeks nothing is dropped, and a 7th column costs every card width.
  { id: 'canceled', name: '已取消', color: '#a08a8a', icon: 'x', rule: '不做了' },
]
export const COL_IDS = COLS.map(c => c.id)
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3']
export const PRIORITY_COLOR: Record<string, string> = { P0: '#d9777a', P1: '#cfa255', P2: '#8b93a3', P3: '#8b93a3' }
// Every UI string the pane draws, in both languages; {0} {1} are filled by t(). Tool text and the prompts sent to Claude stay Chinese on purpose.
export const ZH = {
  'col.decide': '等我拍板', 'col.todo': '待开工', 'col.doing': '进行中', 'col.follow': '待跟进', 'col.review': '待审核', 'col.done': '已完成', 'col.canceled': '已取消',
  'fold.rekey': '从 {0} 移到 {1}', 'fold.prefix': '编号从 {0} 改为 {1}',
  'kind.new': '新建', 'kind.move': '状态', 'kind.commit': '提交', 'kind.pr': 'PR', 'kind.comment': '评论',
  'l.days': '天', 'l.commits': '提交', 'l.comments': '评论', 'l.dropTo': '放到', 'l.blocked': '卡于', 'l.due': '截止',
  'due.left': '还剩 {0} 天', 'due.late': '逾期 {0} 天', 'due.today': '今天到期', 'due.bad': '日期要写成 YYYY-MM-DD',
  'd.labels': '标签', 'd.due': '截止', 'labels.ph': '标签，逗号分隔，回车保存', 'due.ph': 'YYYY-MM-DD，回车保存；空着回车清除',
  'rel.blockedBy': '被卡于', 'rel.blocks': '卡着', 'rel.parent': '父任务', 'rel.children': '子任务 {0}/{1}', 'rel.archived': '已归档', 'relations': '关系',
  'pane.title': '任务看板', 'cmd.opened': '已打开任务看板。',
  'lang.btn': 'EN', 'theme.auto': '跟随 Claude', 'theme.light': '浅色', 'theme.dark': '深色',
  'peek.open': '打开详情', 'peek.close': '关闭', 'peek.hint': '点空白处关闭', 'peek.latest': '最近：', 'peek.cmt.ph': '写评论，回车发送；在做这张票的会话会自动收到', 'peek.cmt.label': '评论 {0}：', 'peek.send': '发送',
  'peek.sess': '关联会话', 'peek.blocked': '阻塞于', 'peek.created': '创建 {0}', 'peek.updated': '更新 {0}',
  'ago.now': '刚刚', 'ago.min': '{0} 分钟前', 'ago.hour': '{0} 小时前', 'ago.day': '{0} 天前',
  'all.projects': '全部项目', 'all': '全部', 'week.ro': '历史周只读', 'wk.prev': '上一周 W{0}', 'wk.next': '下一周 W{0}', 'wk.now': '回到本周',
  'stats': '新建 {0} · 完成 {1} · 提交 {2}', 'to.decide': '{0} 待拍板', 'waiting.you': '等你回复',
  'tab.board': '看板', 'tab.feed': '实时动态',
  'feed.empty': '还没有动态。在任意会话里开始做一件事，Claude 会自动建工单。',
  'lane.count': '{0} 张', 'lane.expand': '展开', 'lane.collapse': '收起', 'lane.empty': '本周暂无',
  'empty.week': '本项目本周没有工单。', 'empty.past': '本项目这一周没有工单。',
  'empty.noboards': '还没有 board。在任意会话里对 Claude 说「初始化看板」，它会用 ticket 工具的 action:init 向导按最近的会话建好 board 和工单。',
  'back': '返回', 'src.me': '你加的', 'src.claude': 'Claude 自动建', 'priority': '优先级',
  'crumb': '项目', 'board.title': '{0} 看板', 'left': '剩 {0} 天', 'qf.me': '只看等我的', 'qf.live': '正在做的', 'search.ph': '搜索编号或标题', 'empty.filter': '没有符合筛选的工单。',
  'status': '状态', 'none': '无', 'details': '详情', 'd.src': '来源', 'd.stay': '停留', 'd.commits': '提交', 'd.branch': '分支',
  'review.wait': '待你验收', 'accept': '验收通过', 'reject': '打回',
  'cancel': '取消工单', 'cancel.ph': '取消理由（选填），回车即取消工单', 'cancel.ask': 'Claude 建议取消：{0}', 'cancel.ok': '确认取消', 'cancel.keep': '保留', 'restore': '恢复', 'd.propose': '建议取消',
  'fold.cancel': '你取消了「{0}」', 'fold.cancel.why': '你取消了「{0}」：{1}',
  'desc': '描述', 'desc.none': '还没有描述', 'desc.ph': '写或改描述，回车保存',
  'sessions': '关联会话', 'ss.gone': '已结束', 'ss.run': '忙', 'ss.idle': '空闲', 'this.session': ' · 本会话', 'jump': '切过去', 'sessions.none': '还没有会话做过这张票',
  'hand': '交给 Claude：', 'spawn': '开新会话', 'go.here': '在本会话继续', 'ask.owner': '问 {0} 进度', 'verify': '核对实际状态',
  'comments': '评论', 'you': '你', 'comment.ph': '写评论，回车提交；在做这张票的会话下一轮会看到',
  'notes': '要点', 'activity': '活动', 'ro.hint': '历史周只读，回到本周才能移动。', 'move.to': '移到：',
  'toast.moved': '{0} 移到 {1} · {2}', 'toast.other': '另一个会话', 'toast.jump': '已切到 {0}', 'jump.go': '跳到会话', 'jump.none': '没有可以打开的会话（可能都已归档）', 'jump.fail': '没能打开那个会话',
  'toast.spawn': '已切到 {0} 的新会话界面，按发送开工', 'spawn.fail': '没能打开新会话界面', 'toast.go': '已让本会话继续 {0}', 'toast.sent': '已发给 {0}', 'toast.verify': '已让本会话核对 {0}',
  'fold.create': '新建「{0}」→ {1}', 'fold.move': '→ {0}', 'fold.reason': '（{0}）', 'fold.comment.me': '你 评论：{0}', 'fold.comment.claude': 'Claude 评论：{0}',
  // web app only
  'w.new': '新建工单', 'w.title': '标题', 'w.project': '项目', 'w.create': '创建', 'w.cancel': '取消', 'w.desc.opt': '描述（可选）', 'w.title.ph': '一句话说清要做什么',
  'b.title': '看板设置', 'b.prefix': '编号前缀', 'b.name': '名称', 'b.name_en': '英文名', 'b.saved': '已保存，{0} 张票改了编号',
  'b.hint': '改了前缀，这个看板的票会一起改编号，数字不变（WB-12 → KB-12），旧编号仍然搜得到、认得出；也可以改回以前的前缀。',
  'w.save': '保存', 'w.edit': '编辑', 'w.add': '发表评论', 'w.offline': '连接断开，正在重连…',
  'w.link': '网页版', 'cmd.web': '网页版看板：{0}',
  'hdr.search': '搜索…', 'hdr.feed': '动态',
  'l.live': '在做', 'live.on': '在做：', 'd.worktree': '工作树', 'toast.woke': '{0}：收到评论，开始处理', 'fold.commit': '提交 {0}',
  'w.wk': 'W{0}', 'w.sprint': '本周', 'w.activity.none': '暂无活动', 'w.close': '关闭', 'w.lanes': '全部 · 泳道', 'w.sess': '{0} 个会话在做', 'w.err': '操作失败：{0}',
  // the pane's focus list (WB-29)
  'h.new': '新建', 'h.done': '完成', 'more.n': '还有 {0} 张 ›', 'peek.fold': '再点一次标题收起',
}
export const I18N: Record<Lang, typeof ZH> = {
  zh: ZH,
  en: {
    'col.decide': 'Decision', 'col.todo': 'To do', 'col.doing': 'In progress', 'col.follow': 'Waiting', 'col.review': 'In review', 'col.done': 'Done', 'col.canceled': 'Canceled',
    'fold.rekey': 'Moved from {0} to {1}', 'fold.prefix': 'Key changed from {0} to {1}',
    'kind.new': 'New', 'kind.move': 'Status', 'kind.commit': 'Commit', 'kind.pr': 'PR', 'kind.comment': 'Comment',
    'l.days': 'd', 'l.commits': 'commits', 'l.comments': 'comments', 'l.dropTo': 'Drop to', 'l.blocked': 'blocked by', 'l.due': 'due',
    'due.left': '{0}d left', 'due.late': '{0}d overdue', 'due.today': 'due today', 'due.bad': 'Date must be YYYY-MM-DD',
    'd.labels': 'Labels', 'd.due': 'Due', 'labels.ph': 'Labels, comma-separated, Enter to save', 'due.ph': 'YYYY-MM-DD, Enter to save; empty clears',
    'rel.blockedBy': 'Blocked by', 'rel.blocks': 'Blocks', 'rel.parent': 'Parent', 'rel.children': 'Subtasks {0}/{1}', 'rel.archived': 'archived', 'relations': 'Relations',
    'pane.title': 'Task board', 'cmd.opened': 'Task board opened.',
    'lang.btn': '中文', 'theme.auto': 'Follow Claude', 'theme.light': 'Light', 'theme.dark': 'Dark',
    'peek.open': 'Open details', 'peek.close': 'Close', 'peek.hint': 'Click outside to close', 'peek.latest': 'Latest: ', 'peek.cmt.ph': 'Add a comment — Enter to send; the session working this ticket picks it up', 'peek.cmt.label': 'Comment {0}: ', 'peek.send': 'Send',
    'peek.sess': 'Session', 'peek.blocked': 'Blocked by', 'peek.created': 'Created {0}', 'peek.updated': 'Updated {0}',
    'ago.now': 'just now', 'ago.min': '{0} min ago', 'ago.hour': '{0} h ago', 'ago.day': '{0} d ago',
    'all.projects': 'All projects', 'all': 'All', 'week.ro': 'Past week, read-only', 'wk.prev': 'Previous week W{0}', 'wk.next': 'Next week W{0}', 'wk.now': 'This week',
    'stats': 'New {0} · Done {1} · Commits {2}', 'to.decide': '{0} to decide', 'waiting.you': 'waiting for you',
    'tab.board': 'Board', 'tab.feed': 'Live feed',
    'feed.empty': 'No activity yet. Start working on something in any session and Claude will create a ticket.',
    'lane.count': '{0} tickets', 'lane.expand': 'Expand', 'lane.collapse': 'Collapse', 'lane.empty': 'None this week',
    'empty.week': 'No tickets in this project this week.', 'empty.past': 'No tickets in this project that week.',
    'empty.noboards': 'No boards yet. Ask Claude in any session to "set up the task board": the ticket tool\'s action:init wizard builds boards and tickets from your recent sessions.',
    'back': 'Back', 'src.me': 'Added by you', 'src.claude': 'Created by Claude', 'priority': 'Priority',
    'crumb': 'Projects', 'board.title': '{0} board', 'left': '{0} d left', 'qf.me': 'Waiting on me', 'qf.live': 'Live only', 'search.ph': 'Search key or title', 'empty.filter': 'No tickets match the filter.',
    'status': 'Status', 'none': 'None', 'details': 'Details', 'd.src': 'Source', 'd.stay': 'Stayed', 'd.commits': 'Commits', 'd.branch': 'Branch',
    'review.wait': 'Awaiting your review', 'accept': 'Accept', 'reject': 'Send back',
    'cancel': 'Cancel ticket', 'cancel.ph': 'Reason (optional), Enter cancels the ticket', 'cancel.ask': 'Claude proposes to cancel: {0}', 'cancel.ok': 'Cancel it', 'cancel.keep': 'Keep', 'restore': 'Restore', 'd.propose': 'Cancel?',
    'fold.cancel': 'You canceled "{0}"', 'fold.cancel.why': 'You canceled "{0}": {1}',
    'desc': 'Description', 'desc.none': 'No description yet', 'desc.ph': 'Write or edit the description, Enter to save',
    'sessions': 'Linked sessions', 'ss.gone': 'Ended', 'ss.run': 'Busy', 'ss.idle': 'Idle', 'this.session': ' · this session', 'jump': 'Switch to it', 'sessions.none': 'No session has worked on this ticket yet',
    'hand': 'Hand to Claude:', 'spawn': 'New session', 'go.here': 'Continue in this session', 'ask.owner': 'Ask {0} for progress', 'verify': 'Verify actual state',
    'comments': 'Comments', 'you': 'You', 'comment.ph': 'Write a comment, Enter to submit; the session on this ticket sees it next turn',
    'notes': 'Key points', 'activity': 'Activity', 'ro.hint': 'Past week is read-only; go back to this week to move tickets.', 'move.to': 'Move to:',
    'toast.moved': '{0} moved to {1} · {2}', 'toast.other': 'another session', 'toast.jump': 'Switched to {0}', 'jump.go': 'Go to session', 'jump.none': 'No session to open (all archived?)', 'jump.fail': 'Could not open that session',
    'toast.spawn': 'Opened a new session screen for {0}; press send to start', 'spawn.fail': 'Could not open a new session screen', 'toast.go': 'Asked this session to continue {0}', 'toast.sent': 'Sent to {0}', 'toast.verify': 'Asked this session to verify {0}',
    'fold.create': 'Created "{0}" → {1}', 'fold.move': '→ {0}', 'fold.reason': ' ({0})', 'fold.comment.me': 'You commented: {0}', 'fold.comment.claude': 'Claude commented: {0}',
    // web app only
    'w.new': 'New ticket', 'w.title': 'Title', 'w.project': 'Project', 'w.create': 'Create', 'w.cancel': 'Cancel', 'w.desc.opt': 'Description (optional)', 'w.title.ph': 'What needs doing, in one line',
    'b.title': 'Board settings', 'b.prefix': 'Key prefix', 'b.name': 'Name', 'b.name_en': 'English name', 'b.saved': 'Saved; {0} tickets got new keys',
    'b.hint': 'A new prefix rekeys that board\'s tickets, numbers kept (WB-12 → KB-12); the old keys still find them; an earlier prefix can be used again.',
    'w.save': 'Save', 'w.edit': 'Edit', 'w.add': 'Comment', 'w.offline': 'Disconnected, reconnecting...',
    'w.link': 'Web', 'cmd.web': 'Web board: {0}',
    'hdr.search': 'Search…', 'hdr.feed': 'Feed',
    'l.live': 'live', 'live.on': 'Working: ', 'd.worktree': 'Worktree', 'toast.woke': '{0}: got a comment, working on it', 'fold.commit': 'Commit {0}',
    'w.wk': 'W{0}', 'w.sprint': 'This week', 'w.activity.none': 'No activity', 'w.close': 'Close', 'w.lanes': 'All · lanes', 'w.sess': '{0} sessions working', 'w.err': 'Failed: {0}',
    'h.new': 'new', 'h.done': 'done', 'more.n': '{0} more ›', 'peek.fold': 'click the title again to fold',
  },
}
// Move reasons are stored as Chinese in the event log; known ones are translated when folding for en, the rest pass through.
export const REASON_EN: Record<string, string> = {
  '你拖拽移动': 'dragged by you', '你手动移动': 'moved by you', 'Claude 更新': 'updated by Claude', '认领': 'claimed', '开始改代码': 'started editing',
  'Claude 提问': 'Claude asked', '已回复': 'answered', 'PR 合并，待你验收': 'PR merged, awaiting your review', '你验收通过': 'accepted by you',
  '你打回': 'sent back by you', '你验收': 'accepted by you', '你在对话中验收': 'accepted by you in chat', '不做了': 'dropped', '初始化导入': 'imported at setup', 'PR 合并': 'PR merged',
  'Claude 建议取消': 'Claude proposes to cancel', '你保留': 'kept by you', '你恢复': 'restored by you',
}
// Imported Obsidian moves read 「W39 存档」.
const reasonOf = (l: Lang, text: string) => (l === 'en' ? REASON_EN[text] ?? text.replace(/^(W\d+) 存档$/, '$1 archived') : text)
export type K = keyof typeof ZH
// Tickets are bilingual: title / desc hold Chinese, title_en / desc_en English; a missing side falls back to the other.
export const titleOf = (tk: Pick<Ticket, 'key' | 'title' | 'title_en'>, l: Lang) => (l === 'en' ? tk.title_en || tk.title : tk.title || tk.title_en) || tk.key
export const descOf = (tk: Pick<Ticket, 'desc' | 'desc_en'>, l: Lang) => (l === 'en' ? tk.desc_en || tk.desc : tk.desc || tk.desc_en) || ''
// Which English / Chinese fields a ticket still lacks, for the tool's reply and the next-prompt nudge.
export const missingLang = (tk: Pick<Ticket, 'title' | 'title_en' | 'desc' | 'desc_en'>) =>
  [!tk.title_en && 'title_en', !tk.title && 'title', tk.desc && !tk.desc_en && 'desc_en', tk.desc_en && !tk.desc && 'desc'].filter(Boolean) as string[]
export function tl(l: Lang, key: K, ...args: (string | number)[]) {
  return I18N[l][key].replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)]))
}

// "2 小时前" style age of a timestamp, through the dictionary.
export function ago(l: Lang, t: number, now: number) {
  const m = Math.max(0, Math.floor((now - t) / 60_000))
  return m < 1 ? tl(l, 'ago.now') : m < 60 ? tl(l, 'ago.min', m) : m < 1440 ? tl(l, 'ago.hour', Math.floor(m / 60)) : tl(l, 'ago.day', Math.floor(m / 1440))
}

// The Claude app's own theme setting (config.json userThemeMode) wins; system / missing follows the OS.
export const resolveTheme = (userThemeMode: string | undefined, systemDark: boolean): Resolved =>
  userThemeMode === 'light' || userThemeMode === 'dark' ? userThemeMode : systemDark ? 'dark' : 'light'

export const MUTE = '#8b93a3'
// Mid-tone, desaturated colors: the pane can't tell the app's theme, so pick ones calm on dark and readable on light.
export const OK = '#62b38a'
export const WARN = '#cfa255'
export const BAD = '#d9777a'
// Closed = done or canceled: no longer blocks anything, no due-date alarm.
export const isOpen = (t?: Ticket) => !!t && t.col !== 'done' && t.col !== 'canceled'
// Blockers still open; ones archived off the board (closed in an earlier week) don't count.
export const openBlockers = (tk: Ticket, list: Ticket[]) => (tk.blockedBy ?? []).filter(k => isOpen(list.find(t => t.key === k)))
export const DUE = /^\d{4}-\d{2}-\d{2}$/
// Days from today to the due date (negative = overdue), or null when there is none or the ticket is closed.
export const dueIn = (tk: Ticket, now: number) =>
  tk.due && isOpen(tk) ? Math.round((new Date(`${tk.due}T00:00`).getTime() - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000) : null
export const dueColor = (n: number) => (n < 0 ? BAD : n <= 2 ? WARN : MUTE)
export const parseLabels = (xs: string[]) => [...new Set(xs.map(x => x.trim().replace(/^#/, '')).filter(Boolean))]
// Flat style: text, color and thin rules only; imported Obsidian notes carry emoji, so strip them at display.
export const clean = (s: string) => s.replace(/\p{Extended_Pictographic}\uFE0F|\p{Emoji_Presentation}|[\uFE0F\u20E3]/gu, '').replace(/\s{2,}/g, ' ').trim()
// Terminal cells of a string: Han and full-width forms take two.
export const cells = (str: string) => [...str].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
// Cut a string to n cells, an ellipsis marking the cut.
export const clip = (str: string, n: number) => {
  if (cells(str) <= n) return str
  let out = ''
  for (const c of str) { if (cells(out + c) > n - 1) break; out += c }
  return n > 0 ? `${out}…` : ''
}
export const splitCode = (title: string) => {
  const m = clean(title).match(/^\[([^\]]+)\]\s*(.*)$/)
  return m ? { code: `[${m[1]}]`, rest: m[2] || m[1] } : { code: '', rest: clean(title) }
}

export type Ev = {
  t: number
  sid: string
  k: 'create' | 'move' | 'note' | 'commit' | 'pr' | 'title' | 'meta' | 'comment' | 'rekey'
  key: string
  project?: string
  title?: string
  title_en?: string
  col?: Col
  src?: 'claude' | 'me'
  text?: string
  by?: 'claude' | 'me'
  meta?: { desc?: string; desc_en?: string; priority?: Priority; branch?: string; worktree?: string; labels?: string[]; due?: string; blockedBy?: string[]; parent?: string; proposeCancel?: Ticket['proposeCancel'] }
}

// WB-28: only the person cancels. Their cancel is a move by 'me' whose text is the reason (may be empty);
// 保留 sends a ticket Claude proposed to cancel back where it was, 恢复 brings a canceled one back (both: else todo).
export const cancelEv = (key: string, reason = ''): Omit<Ev, 't' | 'sid'> => ({ k: 'move', key, col: 'canceled', by: 'me', text: reason.trim() })
export const keepTo = (tk: Ticket): Col => tk.proposeCancel?.from ?? 'todo'
export const restoreTo = (tk: Ticket): Col => tk.canceledFrom ?? 'todo'

export const colOf = (id: string) => COLS.find(c => c.id === id) ?? COLS[1]
export const projOf = (id: string | null) => PROJECTS.find(p => p.id === id)
// A board's display name is user data from projects.json (name / name_en), not a dictionary entry; unknown ids show as-is.
export const projName = (l: Lang, id: string) => { const p = projOf(id); return !p ? id : l === 'en' ? p.name_en ?? p.name : p.name }
export const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5)
export const days = (t: number, now: number) => Math.floor((now - t) / 86_400_000)

export function weekStartOf(now: number) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
export function isoWeek(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const w1 = new Date(d.getFullYear(), 0, 4)
  return 1 + Math.round(((d.getTime() - w1.getTime()) / 86_400_000 - 3 + ((w1.getDay() + 6) % 7)) / 7)
}

// Folds every session's event log into the board. Pure, so the self-check below can run it.
// Who answers the person's comment on a ticket: a live session working it now, else the most recently
// seen live session that worked it. Every session computes the same answer, so exactly one wakes up.
// ponytail: sessions poll 5 s apart; two snapshots disagreeing can wake twice, rare enough to accept
export function ownerOf(tk: Ticket, sessions: Sess[], now: number): string | undefined {
  const live = sessions.filter(s => !s.isGone && now - s.seen < LIVE_MS).sort((a, b) => b.seen - a.seen)
  return (live.find(s => s.ticket === tk.key) ?? live.find(s => tk.sids.includes(s.sid)))?.sid
}

export const SYSTEM_SIDS = ['import', 'migrate', 'web']

// Old key → the key it became, in time order. A key that becomes a ticket's key again (a prefix renamed back, WB-34)
// stops being an alias, so WB-12 → KB-12 → WB-12 resolves to WB-12 instead of looping.
export function aliasResolver(evs: Ev[]) {
  const alias = new Map<string, string>()
  for (const x of [...evs].sort((a, b) => a.t - b.t)) if (x.k === 'rekey' && x.text) { alias.set(x.key, x.text); alias.delete(x.text) }
  const resolve = (k: string) => { for (let i = 0; alias.has(k) && i < 10; i++) k = alias.get(k) as string; return k }
  return { alias, resolve }
}

export function fold(evs: Ev[], sessions: Sess[], now: number, l: Lang = 'zh'): Board {
  const weekStart = weekStartOf(now)
  const map = new Map<string, Ticket>()
  const feed: FeedItem[] = []
  let commitsThisWeek = 0
  let createdThisWeek = 0
  const sorted = [...evs].sort((a, b) => a.t - b.t)
  const { alias, resolve } = aliasResolver(sorted)
  for (const raw of sorted) {
    const ev = alias.size ? { ...raw, key: resolve(raw.key) } : raw
    // ponytail: 'ME' is the board that the oldest imported events (written before tickets carried a project) belong to
    if (ev.k === 'create') {
      map.set(ev.key, {
        key: ev.key, project: ev.project ?? 'ME', title: ev.title ?? '', ...(ev.title_en ? { title_en: ev.title_en } : {}), col: ev.col ?? 'doing',
        src: ev.src ?? 'claude', created: ev.t, since: ev.t, commits: 0,
        notes: ev.text ? [ev.text] : [], sids: [], log: [], comments: [],
      })
      if (ev.t >= weekStart) createdThisWeek++
    }
    const tk = map.get(ev.key)
    if (!tk) continue
    // import / migrate / web write events but are not sessions: keep them out of 关联 session
    if (!SYSTEM_SIDS.includes(ev.sid) && !tk.sids.includes(ev.sid)) tk.sids.push(ev.sid)
    let line = ''
    let icon = '' as FeedItem['icon']
    if (ev.k === 'create') { line = tl(l, 'fold.create', titleOf(tk, l), tl(l, `col.${tk.col}` as K)); icon = 'new' }
    if (ev.k === 'move' && ev.col && ev.col !== tk.col) {
      // Where 恢复 goes: the column before the cancel, or before Claude's proposal when the person confirmed one.
      if (ev.col === 'canceled') tk.canceledFrom = tk.proposeCancel ? tk.proposeCancel.from : tk.col
      // Any move settles a proposal: confirmed, kept, or dragged elsewhere.
      delete tk.proposeCancel
      tk.col = ev.col
      tk.since = ev.t
      line = ev.col === 'canceled' && ev.by === 'me'
        ? tl(l, ev.text ? 'fold.cancel.why' : 'fold.cancel', titleOf(tk, l), ev.text ?? '')
        : tl(l, 'fold.move', tl(l, `col.${ev.col}` as K)) + (ev.text ? tl(l, 'fold.reason', reasonOf(l, ev.text)) : '')
      icon = 'move'
    }
    if (ev.k === 'title') { if (ev.title) tk.title = ev.title; if (ev.title_en) tk.title_en = ev.title_en }
    if (ev.k === 'rekey') {
      if (raw.key !== tk.key && !tk.aliases?.includes(raw.key)) tk.aliases = [...(tk.aliases ?? []), raw.key]
      const from = tk.project
      tk.project = ev.project ?? tk.project
      line = ev.by === 'me' ? tl(l, 'fold.prefix', raw.key, ev.text ?? tk.key) : tl(l, 'fold.rekey', `${projName(l, from)} ${raw.key}`, `${projName(l, tk.project)} ${tk.key}`)
      icon = 'move'
    }
    if (ev.k === 'meta' && ev.meta) Object.assign(tk, ev.meta)
    if (ev.k === 'comment' && ev.text) {
      tk.comments.push({ t: ev.t, sid: ev.sid, by: ev.by ?? 'claude', text: ev.text })
      if (tk.comments.length > 30) tk.comments.shift()
      line = tl(l, ev.by === 'me' ? 'fold.comment.me' : 'fold.comment.claude', ev.text.slice(0, 40))
      icon = 'comment'
    }
    if (ev.k === 'note' && ev.text) { tk.notes.push(ev.text); if (tk.notes.length > 8) tk.notes.shift() }
    if (ev.k === 'commit') {
      tk.commits++
      if (ev.t >= weekStart) commitsThisWeek++
      line = tl(l, 'fold.commit', ev.text ?? '')
      icon = 'commit'
    }
    if (ev.k === 'pr') { tk.pr = ev.text; line = `PR ${ev.text ?? ''}`; icon = 'pr' }
    if (line) {
      tk.log.push({ t: ev.t, sid: ev.sid, text: line })
      if (tk.log.length > 12) tk.log.shift()
      if (!(ev.k === 'rekey' && ev.by === 'me')) feed.push({ t: ev.t, sid: ev.sid, key: tk.key, icon, text: line }) // a prefix rename would flood the feed
    }
  }
  // Relations written before a rekey point at the old key.
  if (alias.size) for (const t of map.values()) {
    if (t.blockedBy) t.blockedBy = t.blockedBy.map(resolve)
    if (t.parent) t.parent = resolve(t.parent)
  }
  // Done and canceled tickets from earlier weeks are archived out of the board.
  const tickets = [...map.values()].filter(t => isOpen(t) || t.since >= weekStart)
  return {
    tickets,
    sessions: sessions.map(s => ({ ...s, ticket: s.ticket && resolve(s.ticket), state: now - s.seen > LIVE_MS ? 'idle' : s.state })),
    feed: feed.slice(-40).reverse(),
    weekStart,
    commitsThisWeek,
    createdThisWeek,
  }
}

// WB-34: a board's new prefix rekeys every ticket it ever had, numbers kept (WB-12 → KB-12); by 'me' marks it a rename, not a move.
// The old keys stay aliases until a ticket takes them again: renaming back to an old prefix is fine (aliasResolver).
// Refused only while a ticket outside this board still carries the prefix.
export function prefixRekeys(evs: Ev[], from: string, to: string): Omit<Ev, 't' | 'sid'>[] | string {
  const { resolve } = aliasResolver(evs)
  const current = [...new Set(evs.filter(x => x.k === 'create').map(x => resolve(x.key)))]
  if (current.some(k => k.startsWith(`${to}-`))) return `还有票的编号是 ${to} 开头，换一个前缀`
  const keys = current.filter(k => k.startsWith(`${from}-`))
  return keys.map(key => ({ k: 'rekey', key, text: `${to}-${key.slice(from.length + 1)}`, project: to, by: 'me' }))
}

// Canceled tickets archived off the board in earlier weeks: a search reaches them (WB-28).
export const archivedCanceled = (evs: Ev[], b: Board, l: Lang = 'zh') =>
  fold(evs, [], 0, l).tickets.filter(t => t.col === 'canceled' && !b.tickets.some(x => x.key === t.key))

// The board as it stood at the end of the week `offset` weeks back (0 = now): past weeks replay the logs up to that week's end.
export function boardForWeek(evs: Ev[], now: number, offset: number, l: Lang = 'zh'): { board: Board; asOf: number } {
  if (offset <= 0) return { board: fold(evs, [], now, l), asOf: now }
  const d = new Date(weekStartOf(now))
  d.setDate(d.getDate() - 7 * (offset - 1))
  const end = d.getTime()
  // A move to another board rewrites history too (Jira-style): replay rekeys whenever they happened.
  const b = fold(evs.filter(e => e.t < end || e.k === 'rekey'), [], end - 1, l)
  return { board: { ...b, feed: b.feed.filter(f => f.t >= b.weekStart && f.t < end) }, asOf: end - 1 }
}

// How many weeks back the oldest event sits; the week nav stops there.
export function weeksBack(evs: Ev[], now: number) {
  if (!evs.length) return 0
  const first = evs.reduce((m, e) => Math.min(m, e.t), now)
  return Math.round((weekStartOf(now) - weekStartOf(first)) / (7 * 86_400_000))
}

// Session titles follow the author's convention: 【Oct 1 - done】主题, several days as 【Sep 30, Oct 1 - …】.
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const STATUS_WORD: Record<Col, string> = { decide: 'decision', todo: 'todo', doing: 'in progress', follow: 'waiting', review: 'review', done: 'done', canceled: 'canceled' }
export function dayLabel(days: number[]) {
  const ds = [...new Set(days.map(t => new Date(t).setHours(0, 0, 0, 0)))].sort((a, b) => a - b).map(t => new Date(t))
  if (!ds.length) return ''
  const one = (d: Date, prev?: Date) => (prev && prev.getMonth() === d.getMonth() ? `${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getDate()}`)
  if (ds.length > 3) return `${one(ds[0])}-${one(ds[ds.length - 1], ds[0])}`
  return ds.map((d, i) => one(d, ds[i - 1])).join(', ')
}
export function sessionTitle(key: string, title: string, col: Col, days: number[]) {
  const head = `【${dayLabel(days)} - ${STATUS_WORD[col]}】${key} `
  const topic = splitCode(title).rest
  return head + (head.length + topic.length > 58 ? `${topic.slice(0, Math.max(8, 57 - head.length))}…` : topic)
}

// The KEY a spawned session's title already names (spawn_task gave it): it keeps that one, though its current
// ticket may be one it only created for another session.
export const titleKey = (title?: string) => title?.match(/】([A-Z][A-Z0-9]*-\d+) /)?.[1]
// WB-24: board-spawned sessions whose title (titles: sid -> as the desktop app holds it) no longer matches their ticket.
export function staleTitles(b: Board, spawned: string[], titles: Record<string, string>) {
  return b.sessions.flatMap(s => {
    const k = titleKey(titles[s.sid]) ?? s.ticket
    const tk = k && s.app && spawned.includes(s.sid) && titles[s.sid] !== undefined ? b.tickets.find(t => t.key === k || t.aliases?.includes(k)) : undefined
    if (!tk) return []
    const title = sessionTitle(tk.key, titleOf(tk, 'zh'), tk.col, s.days ?? [])
    return titles[s.sid] === title ? [] : [{ sid: s.sid, app: s.app!, key: tk.key, title }]
  })
}

// The desktop app's own links, one copy for the pane (open …) and the web app (the browser opens them). WB-36.
// WB-21: a new session in the ticket's project root with the claim line typed in; that first prompt marks it spawned.
// WB-41: the steps the claim answer opens with (title, sidebar group) are named here too: a note at its end got skipped.
export const claimLine = (key: string) => `认领 ${key}：先调用 mcp__cc-taskboard__ticket action:update key:${key} work:true，做完它返回的开头几步（改会话标题、归侧边栏分组），再看 ticket 描述和评论开工`
export function newSessionUrl(key: string, folder?: string) {
  return `claude://code/new?q=${encodeURIComponent(`${claimLine(key)}。`)}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`
}
// WB-41: the desktop session whose sidebar group a new session of tk joins: tk's own newest other session, else its board's.
export function groupPeer(sessions: Sess[], tk: Ticket, sid: string) {
  const s = sessions.filter(x => x.sid !== sid && x.app && !x.isGone).sort((x, y) => y.seen - x.seen)
  return (s.find(x => tk.sids.includes(x.sid)) ?? s.find(x => x.project === tk.project))?.app
}
// WB-30: an existing session, by its desktop id (list_sessions' `link`).
export const sessionUrl = (app: string) => `claude://claude.ai/epitaxy/${app}`
export const APP_ID = /^local_[A-Za-z0-9-]{1,64}$/
// The desktop app's session files, <dir>/<org>/<user>/local_*.json (macOS layout); io is the caller's fs.
export const appSessionsDir = (home: string) => `${home}/Library/Application Support/Claude/claude-code-sessions`
export type AppIo = { ls: (dir: string) => Promise<string[]>; read: (path: string) => Promise<string> }
async function appUserDirs(io: AppIo, dir: string) {
  const ls = (p: string) => io.ls(p).catch(() => [] as string[])
  const out: string[] = []
  for (const org of await ls(dir)) for (const user of await ls(`${dir}/${org}`)) out.push(`${dir}/${org}/${user}`)
  return out
}
// A session's title as the desktop app holds it (undefined: not found, or archived).
export async function appTitle(io: AppIo, dir: string, app: string) {
  for (const d of await appUserDirs(io, dir)) {
    const j = await io.read(`${d}/${app}.json`).then(JSON.parse).catch(() => null)
    if (j) return !j.isArchived && typeof j.title === 'string' ? j.title as string : undefined
  }
}
// The desktop id of a CLI session, not archived: `known` (Sess.app) when it still exists, else the file whose cliSessionId it is.
export async function appIdOf(io: AppIo, dir: string, cli: string, known?: string) {
  if (known && APP_ID.test(known)) return (await appTitle(io, dir, known)) === undefined ? undefined : known
  for (const d of await appUserDirs(io, dir)) {
    for (const f of await io.ls(d).catch(() => [] as string[])) {
      const id = f.replace(/\.json$/, '')
      if (!APP_ID.test(id)) continue
      const j = await io.read(`${d}/${f}`).then(JSON.parse).catch(() => null)
      if (j?.cliSessionId === cli) return j.isArchived ? undefined : id
    }
  }
}

export const md = (t: number) => {
  const d = new Date(t)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const parseLines = (text: string): Ev[] =>
  text.split('\n').flatMap(l => {
    try { return l.trim() ? [JSON.parse(l) as Ev] : [] } catch { return [] }
  })

// ---------- init wizard (ticket tool action:"init") ----------
// One row per desktop session file (claude-code-sessions/<org>/<user>/local_*.json); the app's own status summary says where it stands.
export type ScanRow = { sid: string; title: string; cwd: string; created: number; last: number; status?: string; detail?: string; needs?: string; branches: string[]; prs: string[] }
export function scanRow(text: string): ScanRow | null {
  let d: any
  try { d = JSON.parse(text) } catch { return null }
  if (!d?.cliSessionId) return null
  let s = d.postTurnSummary
  try { if (typeof s === 'string') s = JSON.parse(s) } catch { s = undefined }
  const prs = (d.prs ?? []) as { prNumber: number; state: string }[]
  return {
    sid: d.cliSessionId, title: d.title ?? '', cwd: d.cwd ?? '', created: d.createdAt ?? 0, last: d.lastActivityAt ?? d.createdAt ?? 0,
    status: s?.status_category, detail: s?.status_detail, needs: s?.needs_action || undefined,
    branches: ((d.writtenBranches ?? []) as string[]).map(b => b.split('\0').pop() ?? b),
    prs: prs.slice(0, 3).map(p => `#${p.prNumber} ${p.state}`).concat(prs.length > 3 ? [`+${prs.length - 3}`] : []),
  }
}
// Worktrees the app makes live under <repo>/.claude/worktrees/; they belong to the repo.
export const repoOf = (cwd: string) => cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')

// Session -> keys of the tickets it already shows up on (archived ones too), so a rerun skips what is already on the board.
function linkedKeys(evs: Ev[]) {
  const out = new Map<string, string[]>()
  for (const t of fold(evs, [], 0).tickets) for (const s of t.sids) out.set(s, [...(out.get(s) ?? []), t.key])
  return out
}

export function scanText(rows: ScanRow[], evs: Ev[]) {
  const linked = linkedKeys(evs)
  const repos = new Map<string, number>()
  for (const r of rows) repos.set(repoOf(r.cwd), (repos.get(repoOf(r.cwd)) ?? 0) + 1)
  return [
    `最近 ${rows.length} 个 session，按仓库/目录：${[...repos].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('；')}`,
    `现有 board：${PROJECTS.length ? PROJECTS.map(p => `${p.id}=${p.name}（match /${p.match.source}/）`).join('；') : '无（还没有 projects.json）'}`,
    ...rows.map(r => [
      r.sid, md(r.last), r.title, r.cwd, `归属 ${projectFor(r.cwd) ?? '无'}`,
      r.status && `状态 ${r.status}${r.detail ? `：${r.detail}` : ''}`, r.needs && `等用户：${r.needs}`,
      r.branches.length && `分支 ${r.branches.join(',')}`, r.prs.length && `PR ${r.prs.join(' ')}`,
      linked.has(r.sid) && `已在 ${linked.get(r.sid)?.join(',')}`,
    ].filter(Boolean).join(' | ')),
  ].join('\n')
}

export type InitPlan = {
  projects?: ProjectConf[]
  tickets?: { project: string; title: string; title_en: string; col: Col; sids: string[]; desc?: string; desc_en?: string; note?: string }[]
  links?: { key: string; sids: string[]; note?: string }[]
}
// The plan as events, with keys handed out the way create does (max + 1 over every log). Pure: preview and write share it.
// Sessions already on a ticket are skipped, so running it twice adds nothing.
export function planInit(plan: InitPlan, evs: Ev[], rows: ScanRow[], now: number) {
  const err: string[] = []
  const lines: string[] = []
  const out: Ev[] = []
  const ids = new Set((plan.projects ?? projectsJson()).map(p => p.id))
  const row = new Map(rows.map(r => [r.sid, r]))
  const linked = linkedKeys(evs)
  const every = fold(evs, [], 0).tickets
  const used = new Map<string, number>()
  for (const x of evs) for (const k of x.k === 'create' ? [x.key] : x.k === 'rekey' && x.text ? [x.text] : []) {
    const [p, n] = k.split('-')
    used.set(p, Math.max(used.get(p) ?? 0, Number(n) || 0))
  }
  const span = (sids: string[]) => {
    const rs = sids.map(s => row.get(s)).filter(Boolean) as ScanRow[]
    return { t0: rs.length ? Math.min(...rs.map(r => r.created || r.last)) : now, t1: rs.length ? Math.max(...rs.map(r => r.last)) : now }
  }
  for (const s of [...(plan.tickets ?? []).flatMap(t => t.sids ?? []), ...(plan.links ?? []).flatMap(l => l.sids ?? [])]) if (!row.has(s)) err.push(`没扫到 session ${s}`)
  for (const t of plan.tickets ?? []) {
    if (!ids.has(t.project)) { err.push(`「${t.title}」的 board ${t.project} 不存在`); continue }
    if (!t.title || !t.title_en || !COL_IDS.includes(t.col)) { err.push(`「${t.title}」要有 title、title_en，col 要合法`); continue }
    if (!t.sids?.length) { err.push(`「${t.title}」没有 session`); continue }
    const fresh = t.sids.filter(s => !linked.has(s))
    if (!fresh.length) { lines.push(`跳过「${t.title}」：session 已在 ${linked.get(t.sids[0])?.join(',')}`); continue }
    const n = (used.get(t.project) ?? 0) + 1
    used.set(t.project, n)
    const key = `${t.project}-${n}`
    const { t0, t1 } = span(fresh)
    out.push({ t: t0, sid: fresh[0], k: 'create', key, project: t.project, title: t.title, title_en: t.title_en, col: 'doing', src: 'claude', text: t.note })
    if (t.desc || t.desc_en) out.push({ t: t0, sid: fresh[0], k: 'meta', key, meta: { ...(t.desc ? { desc: t.desc } : {}), ...(t.desc_en ? { desc_en: t.desc_en } : {}) } })
    // meta {} carries only the sid: it links the extra session without adding a note
    for (const s of fresh.slice(1)) out.push({ t: t0, sid: s, k: 'meta', key, meta: {} })
    if (t.col !== 'doing') out.push({ t: Math.max(t1, t0 + 1), sid: fresh[0], k: 'move', key, col: t.col, text: '初始化导入' })
    for (const s of fresh) linked.set(s, [key])
    lines.push(`${key} [${colOf(t.col).name}] ${t.title}  ← ${fresh.map(s => row.get(s)?.title ?? s).join(' / ')}`)
  }
  for (const l of plan.links ?? []) {
    const tk = every.find(t => t.key === l.key || t.aliases?.includes(l.key))
    if (!tk) { err.push(`没有 ticket ${l.key}`); continue }
    const fresh = (l.sids ?? []).filter(s => !tk.sids.includes(s))
    if (!fresh.length) { lines.push(`跳过 ${tk.key}：session 已挂上`); continue }
    const { t1 } = span(fresh)
    fresh.forEach((s, i) => out.push(i === 0 && l.note ? { t: t1, sid: s, k: 'note', key: tk.key, text: l.note } : { t: t1, sid: s, k: 'meta', key: tk.key, meta: {} }))
    lines.push(`${tk.key} 挂上 ${fresh.map(s => row.get(s)?.title ?? s).join(' / ')}${l.note ? `；要点：${l.note}` : ''}`)
  }
  return { evs: out, lines, err }
}
