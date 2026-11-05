import type { PeerSnapshot, PeerSyncBroker } from '../peer-sync/broker.ts'
import type { TodoItem, TodoPhase } from '../todos.ts'
import type { SidecarTodoWatcher } from '../watcher/watcher.ts'
import type { OmpExtensionContext, OmpTheme } from './api.ts'
import type { HudViewMode } from './runner.ts'
import { allTasks } from '../todos.ts'

const plainTheme: OmpTheme = { fg: (_color, text) => text, strikethrough: text => text }

const compactTaskLimit = 5
const expandedTaskLimit = 8
const progressBarWidth = 6

export interface HudRenderOptions {
  view?: HudViewMode
  checking?: boolean
}

export function refreshUi(
  ctx: OmpExtensionContext,
  {
    broker,
    watcher,
    view = 'compact',
    checking = false,
  }: { broker: PeerSyncBroker; watcher: SidecarTodoWatcher; view?: HudViewMode; checking?: boolean },
): void {
  if (!ctx.hasUI) return
  const peers = broker.listOtherPeers(watcher.peerId)
  const lines = renderHudLines(watcher, peers, ctx.ui.theme, { view, checking })
  ctx.ui.setWidget('sidecar-todo-watcher', lines.length > 0 ? lines : undefined, { placement: 'aboveEditor' })
  ctx.ui.setStatus('sidecar-todo', renderStatusText(watcher, peers.length, checking))
}

/**
 * Renders a multi-line TUI widget showing managed Todos (with progress bar, smart active windowing,
 * checkboxes & theme colors) + Peer Team activity and latest `<peer-sync>` event.
 */
export function renderHudLines(
  watcher: SidecarTodoWatcher,
  peers: readonly PeerSnapshot[],
  theme: OmpTheme = plainTheme,
  options: HudRenderOptions = {},
): string[] {
  const { view = 'compact', checking = false } = options
  const tasks = allTasks(watcher.phases)
  const lines: string[] = []

  if (tasks.length > 0) {
    const done = tasks.filter(task => task.status === 'completed').length
    const active = watcher.activeTask
    const bar = renderProgressBar(done, tasks.length, theme)
    const phaseBadge = renderActivePhaseBadge(watcher.phases, theme)
    const pauseBadge = watcher.paused ? theme.fg('warning', ' [PAUSED]') : ''
    const checkingBadge = checking ? theme.fg('accent', ' · ⟳ auditing…') : ''
    const telemetryBadge = renderTelemetryBadge(watcher, theme)

    lines.push(
      `${theme.fg('accent', '[Sidecar Todo]')} ${bar} ${phaseBadge}${done}/${tasks.length} done${pauseBadge}${
        active ? ` · Active (${active.id}): ${active.content}` : ` · ${theme.fg('success', 'All complete ✓')}`
      }${checkingBadge}${telemetryBadge}`,
    )

    if (view !== 'minimal') {
      const limit = view === 'expanded' ? expandedTaskLimit : compactTaskLimit
      const taggedTasks = tagTasksWithPhase(watcher.phases)
      const { visible, hiddenAbove, hiddenBelow } = selectVisibleWindow(taggedTasks, limit)
      if (hiddenAbove > 0) {
        lines.push(`  ${theme.fg('dim', `↑ +${hiddenAbove} completed todo(s) above`)}`)
      }
      for (const item of visible) {
        lines.push(`  ${renderTask(item.task, theme, item.phaseName)}`)
      }
      if (hiddenBelow > 0) {
        lines.push(`  ${theme.fg('dim', `… +${hiddenBelow} more todo(s)`)}`)
      }
    }

    if (view === 'expanded' && watcher.archivedBatches.length > 0) {
      lines.push(`  ${theme.fg('dim', `Archived lists in session: ${watcher.archivedBatches.length}`)}`)
    }
  } else if (checking) {
    lines.push(`${theme.fg('accent', '[Sidecar Todo]')} ${theme.fg('dim', '⟳ extracting initial todo plan…')}`)
  }

  if (peers.length > 0) {
    if (view === 'expanded') {
      lines.push(`${theme.fg('accent', '[Peers]')} ${peers.length} active teammate(s):`)
      for (const peer of peers) {
        lines.push(`  ${renderPeerBadge(peer, theme)}`)
      }
    } else {
      const peerSummary = peers.map(peer => renderPeerBadge(peer, theme)).join(' | ')
      lines.push(`${theme.fg('accent', '[Peers]')} ${peerSummary}`)
    }
  }

  if (watcher.lastPeerSync && view !== 'minimal' && (tasks.length > 0 || peers.length > 0)) {
    const sync = watcher.lastPeerSync
    const summary = sync.summary.length > 90 ? `${sync.summary.slice(0, 87)}…` : sync.summary
    lines.push(`  ${theme.fg('dim', `↳ Peer sync (@${sync.fromPeerId}): ${summary}`)}`)
  }

  return lines
}

export function renderStatusText(watcher: SidecarTodoWatcher, peerCount = 0, checking = false): string | undefined {
  const tasks = allTasks(watcher.phases)
  if (tasks.length === 0) return checking ? 'Todo ⟳' : undefined
  const done = tasks.filter(task => task.status === 'completed').length
  const active = watcher.activeTask
  const stateSuffix = watcher.paused ? ' (paused)' : active ? ` (${active.id})` : ' ✓'
  const peerSuffix = peerCount > 0 ? ` · ${peerCount}p` : ''
  const spinSuffix = checking ? ' ⟳' : ''
  return `Todo ${done}/${tasks.length}${stateSuffix}${peerSuffix}${spinSuffix}`
}

/**
 * Selects a window of up to `limit` tasks anchored around the first `in_progress` (or first incomplete) task
 * so long lists never hide the active task behind already-completed items.
 */
export function selectVisibleWindow<T extends { task: TodoItem }>(
  items: readonly T[],
  limit: number,
): { visible: T[]; hiddenAbove: number; hiddenBelow: number } {
  if (items.length <= limit) {
    return { visible: [...items], hiddenAbove: 0, hiddenBelow: 0 }
  }
  const focusIndex = items.findIndex(
    item => item.task.status === 'in_progress' || item.task.status === 'blocked' || item.task.status === 'pending',
  )
  // When all tasks are completed/abandoned, show the tail of the list
  const anchor = focusIndex === -1 ? items.length - limit : Math.max(0, focusIndex - 1)
  const start = Math.min(anchor, Math.max(0, items.length - limit))
  const end = Math.min(items.length, start + limit)
  return {
    visible: items.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: items.length - end,
  }
}

function renderProgressBar(done: number, total: number, theme: OmpTheme): string {
  const filled = total > 0 ? Math.round((done / total) * progressBarWidth) : 0
  const donePart = '█'.repeat(filled)
  const restPart = '░'.repeat(Math.max(0, progressBarWidth - filled))
  const bar = `${done === total ? theme.fg('success', donePart) : theme.fg('accent', donePart)}${theme.fg('dim', restPart)}`
  return `[${bar}]`
}

function renderActivePhaseBadge(phases: readonly TodoPhase[], theme: OmpTheme): string {
  if (phases.length <= 1) return ''
  const activeIndex = phases.findIndex(phase =>
    phase.tasks.some(task => task.status === 'in_progress' || task.status === 'pending' || task.status === 'blocked'),
  )
  const index = activeIndex === -1 ? phases.length - 1 : activeIndex
  const phase = phases[index]
  return `${theme.fg('muted', `[${index + 1}/${phases.length} ${phase.name}]`)} `
}

function renderTelemetryBadge(watcher: SidecarTodoWatcher, theme: OmpTheme): string {
  const { telemetry } = watcher
  if (telemetry.calls === 0) return ''
  const shortModel = shortenModelId(telemetry.lastModelId ?? telemetry.mode)
  const hitRate = telemetry.warmCacheHitRate > 0 ? telemetry.warmCacheHitRate : telemetry.cacheHitRate
  const latency = telemetry.lastDurationMs === undefined ? '' : `, ${(telemetry.lastDurationMs / 1000).toFixed(1)}s`
  return theme.fg(
    'dim',
    ` · Watcher(${shortModel}): ${telemetry.calls} calls, ${telemetry.totalTokens} tok, ${(hitRate * 100).toFixed(1)}% cache ($${telemetry.totalCostUsd.toFixed(4)}${latency})`,
  )
}

function shortenModelId(modelId: string): string {
  const parts = modelId.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : modelId
}

function tagTasksWithPhase(phases: readonly TodoPhase[]): Array<{ task: TodoItem; phaseName?: string }> {
  const multiPhase = phases.length > 1
  return phases.flatMap(phase => phase.tasks.map(task => ({ task, phaseName: multiPhase ? phase.name : undefined })))
}

function renderPeerBadge(peer: PeerSnapshot, theme: OmpTheme): string {
  const allDone = peer.totalCount > 0 && peer.completedCount === peer.totalCount
  const progress = `${peer.completedCount}/${peer.totalCount}`
  const detail = peer.activeTask === null ? (allDone ? ' ✓' : '') : `: ${peer.activeTask}`
  const text = `@${peer.peerId}(${progress}${detail})`
  if (allDone) return theme.fg('success', text)
  if (peer.activeTask !== null) return theme.fg('accent', text)
  return theme.fg('muted', text)
}

function renderTask(task: TodoItem, theme: OmpTheme, phaseName?: string): string {
  const phasePrefix = phaseName === undefined ? '' : `[${phaseName}] `
  switch (task.status) {
    case 'completed':
      return theme.fg('success', `[x] ${task.id} ${phasePrefix}${theme.strikethrough(task.content)}`)
    case 'in_progress':
      return theme.fg('accent', `[>] ${task.id} ${phasePrefix}${task.content}`)
    case 'abandoned':
      return theme.fg('dim', `[-] ${task.id} ${phasePrefix}${theme.strikethrough(task.content)}`)
    case 'blocked':
      return theme.fg('warning', `[!] ${task.id} ${phasePrefix}${task.content} (blocked)`)
    case 'pending':
      return theme.fg('muted', `[ ] ${task.id} ${phasePrefix}${task.content}`)
  }
}
