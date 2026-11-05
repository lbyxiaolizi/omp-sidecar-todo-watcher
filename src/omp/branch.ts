import type { TodoPhaseDraft } from '../todos.ts'
import type { SidecarTodoWatcher } from '../watcher/watcher.ts'
import type { OmpExtensionAPI } from './api.ts'
import * as v from 'valibot'
import { todoPhasesSchema } from '../todos.ts'

const stateEntryType = 'omp-sidecar-todo-watcher.state'

const phasesEntrySchema = v.union([
  v.pipe(
    v.object({
      type: v.literal('custom'),
      customType: v.picklist([stateEntryType, 'user_todo_edit']),
      data: v.object({ phases: todoPhasesSchema }),
    }),
    v.transform(entry => entry.data.phases),
  ),
  v.pipe(
    v.object({
      type: v.literal('message'),
      message: v.object({
        role: v.literal('toolResult'),
        toolName: v.literal('todo'),
        isError: v.optional(v.literal(false)),
        details: v.object({ phases: todoPhasesSchema }),
      }),
    }),
    v.transform(entry => entry.message.details.phases),
  ),
])

export function appendStateEntry(pi: OmpExtensionAPI, watcher: SidecarTodoWatcher): void {
  // omp keeps this object on the branch; snapshot the todo list and aggregate counters without cloning the
  // growing perCallLog into every saved entry (which would retain O(N^2) call records across N saves).
  const { perCallLog: _omitted, ...telemetrySummary } = watcher.telemetry
  pi.appendEntry(stateEntryType, {
    phases: structuredClone(watcher.phases),
    telemetry: { ...telemetrySummary, lastCall: watcher.telemetry.perCallLog.at(-1) },
  })
}

/** The newest todo phases on a session branch: this plugin's state, user todo edits, or omp's own `todo` tool */
export function findLatestTodoPhases(branch: readonly unknown[]): TodoPhaseDraft[] {
  for (const entry of branch.toReversed()) {
    const result = v.safeParse(phasesEntrySchema, entry)
    if (result.success) return result.output
  }
  return []
}
