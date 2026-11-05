import { expect, it } from 'vitest'
import { appendStateEntry, findLatestTodoPhases } from '../../src/omp/branch.ts'
import { PeerSyncBroker } from '../../src/peer-sync/broker.ts'
import { recordSidecarCall } from '../../src/watcher/telemetry.ts'
import { SidecarTodoWatcher } from '../../src/watcher/watcher.ts'
import { zeroUsage } from '../fake-sidecar.ts'

it("finds the newest todo phases on a branch, including omp's own todo tool results", () => {
  const phases = findLatestTodoPhases([
    {
      type: 'custom',
      customType: 'omp-sidecar-todo-watcher.state',
      data: { phases: [{ name: 'Old', tasks: [{ id: '#1', content: 'Old task', status: 'pending' }] }] },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolName: 'todo',
        details: { phases: [{ name: 'Restored', tasks: [{ content: 'Restored branch task', status: 'pending' }] }] },
      },
    },
    {
      type: 'message',
      message: { role: 'toolResult', toolName: 'todo', isError: true, details: { phases: [] } },
    },
  ])

  expect(phases).toEqual([{ name: 'Restored', tasks: [{ content: 'Restored branch task', status: 'pending' }] }])
})

it('snapshots branch state without duplicating the growing perCallLog array into every entry', () => {
  const broker = new PeerSyncBroker(':memory:', '/repo')
  const watcher = new SidecarTodoWatcher('peer-a', broker)
  const entries: unknown[] = []
  const pi = {
    appendEntry: (_type: string, data: unknown) => {
      entries.push(data)
    },
  } as never

  for (let i = 0; i < 5; i++) {
    recordSidecarCall(watcher.telemetry, {
      kind: 'delta',
      mode: 'detached-smol',
      modelId: 'test/m',
      usage: zeroUsage,
      durationMs: 10,
    })
    appendStateEntry(pi, watcher)
  }
  broker.close()

  const last = entries.at(-1) as {
    telemetry: { calls: number; perCallLog?: unknown; lastCall?: { callIndex: number } }
  }
  expect(last.telemetry.calls).toBe(5)
  expect(last.telemetry.perCallLog).toBeUndefined()
  expect(last.telemetry.lastCall?.callIndex).toBe(5)
})
