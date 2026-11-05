import type { PeerSyncBroker } from '../peer-sync/broker.ts'
import type { SidecarTodoWatcher } from '../watcher/watcher.ts'
import type { OmpExtensionContext } from './api.ts'
import type { SidecarSettings } from './runner.ts'
import { renderHudLines } from './hud.ts'
import { isHudViewMode, isWatcherMode, resolveDetachedModel } from './runner.ts'

export const peerTodosDescription =
  'Manage Sidecar Watcher todos & peer sync: /peer-todos [status|stats|peers|view <compact|expanded|minimal>|model <spec>|mode <auto|detached|ephemeral>|add <task>|done <#id>|drop <#id>|reset|pause|resume|broadcast <msg>]'

export interface PeerTodosOutcome {
  message: string
  level: 'info' | 'warning'
  /** `todos` asks the caller to persist the list and refresh the HUD, `hud` only to refresh it */
  changed?: 'todos' | 'hud'
}

export function runPeerTodosCommand(
  rawArgs: string,
  session: { broker: PeerSyncBroker; watcher: SidecarTodoWatcher; settings: SidecarSettings },
  ctx: OmpExtensionContext,
): PeerTodosOutcome {
  const { broker, watcher, settings } = session
  const trimmed = rawArgs.trim()
  const spaceIndex = trimmed.indexOf(' ')
  const subcommand = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase()
  const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim()

  switch (subcommand) {
    case 'model': {
      if (rest) settings.modelSpec = rest
      const model = resolveDetachedModel(ctx, settings)
      const modelName = model === undefined ? undefined : `${model.provider}/${model.id}`
      if (!rest) {
        return {
          message: `Current Watcher model: ${modelName ?? (settings.mode === 'detached' ? 'none' : 'session model (ephemeral)')}`,
          level: 'info',
        }
      }
      return modelName === undefined
        ? { message: `Could not resolve "${rest}", will fallback to default chain`, level: 'warning' }
        : { message: `Watcher model set to ${modelName}`, level: 'info', changed: 'hud' }
    }
    case 'mode': {
      if (!isWatcherMode(rest)) {
        return { message: 'Usage: /peer-todos mode <auto|detached|ephemeral>', level: 'warning' }
      }
      settings.mode = rest
      return { message: `Watcher mode set to ${rest}`, level: 'info', changed: 'hud' }
    }
    case 'view':
    case 'expand':
    case 'collapse':
    case 'minimal': {
      const targetView =
        subcommand === 'expand'
          ? 'expanded'
          : subcommand === 'collapse'
            ? 'compact'
            : subcommand === 'minimal'
              ? 'minimal'
              : rest.toLowerCase()
      if (!isHudViewMode(targetView)) {
        return { message: 'Usage: /peer-todos view <compact|expanded|minimal>', level: 'warning' }
      }
      settings.view = targetView
      return { message: `Sidecar HUD view set to ${targetView}.`, level: 'info', changed: 'hud' }
    }
    case 'add': {
      const added = watcher.addManualTask(rest)
      return added
        ? { message: `Added ${added.id}: ${added.content}`, level: 'info', changed: 'todos' }
        : { message: 'Usage: /peer-todos add <task description>', level: 'warning' }
    }
    case 'done': {
      const completed = watcher.markTaskCompleted(rest)
      return completed
        ? { message: `Completed ${completed.id}: ${completed.content}`, level: 'info', changed: 'todos' }
        : { message: `No open todo matching "${rest}"`, level: 'warning' }
    }
    case 'drop': {
      const dropped = watcher.markTaskAbandoned(rest)
      return dropped
        ? { message: `Abandoned ${dropped.id}: ${dropped.content}`, level: 'info', changed: 'todos' }
        : { message: `No open todo matching "${rest}"`, level: 'warning' }
    }
    case 'reset': {
      watcher.resetTodos()
      return { message: 'Sidecar todos archived and reset.', level: 'info', changed: 'todos' }
    }
    case 'pause':
    case 'resume': {
      watcher.paused = subcommand === 'pause'
      return {
        message: `Sidecar Todo Watcher ${watcher.paused ? 'paused' : 'resumed'}.`,
        level: 'info',
        changed: 'hud',
      }
    }
    case 'broadcast': {
      if (!rest) return { message: 'Usage: /peer-todos broadcast <technical message>', level: 'warning' }
      const queued = broker.broadcastPeerNote(watcher.peerId, rest)
      return { message: `Broadcast queued for ${queued} active peer(s).`, level: 'info' }
    }
    case 'peers': {
      const peers = broker.listOtherPeers(watcher.peerId)
      if (peers.length === 0) return { message: `Peer @${watcher.peerId}: no other active peers.`, level: 'info' }
      const lines = [
        `Active peers (${peers.length}) alongside @${watcher.peerId}:`,
        ...peers.map(
          peer =>
            `  • @${peer.peerId}: ${peer.completedCount}/${peer.totalCount} done${peer.activeTask === null ? '' : ` — Active: ${peer.activeTask}`}`,
        ),
      ]
      if (watcher.lastPeerSync) {
        lines.push(`Last sync from @${watcher.lastPeerSync.fromPeerId}: ${watcher.lastPeerSync.summary}`)
      }
      return { message: lines.join('\n'), level: 'info' }
    }
    case 'stats': {
      const t = watcher.telemetry
      const model = resolveDetachedModel(ctx, settings)
      const resolvedName = model === undefined ? 'session model (ephemeral)' : `${model.provider}/${model.id}`
      const lines = [
        `Sidecar Watcher Telemetry (@${watcher.peerId}, mode=${settings.mode}, view=${settings.view ?? 'compact'}):`,
        `  Model: ${t.lastModelId ?? resolvedName}`,
        `  Calls: ${t.calls} · Total tokens: ${t.totalTokens} (in=${t.inputTokens}, cacheRead=${t.cacheReadTokens}, cacheWrite=${t.cacheWriteTokens}, out=${t.outputTokens})`,
        `  Cache hit rate: ${(t.cacheHitRate * 100).toFixed(1)}% overall · ${(t.warmCacheHitRate * 100).toFixed(1)}% warm`,
        `  Cost: $${t.totalCostUsd.toFixed(4)}${t.lastDurationMs === undefined ? '' : ` · Last latency: ${t.lastDurationMs}ms`}`,
      ]
      return { message: lines.join('\n'), level: 'info' }
    }
    default: {
      const lines = renderHudLines(watcher, broker.listOtherPeers(watcher.peerId), undefined, {
        view: settings.view ?? 'compact',
      })
      return { message: lines.length > 0 ? lines.join('\n') : 'No active todos or peers.', level: 'info' }
    }
  }
}
