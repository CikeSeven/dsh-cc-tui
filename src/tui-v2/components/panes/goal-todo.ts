/** WP-08e1 goal/todo line component. */
import type { Component } from '../../renderer/component.js'
import { cellsToString, lineStyle, styledCells, truncateCells } from '../../renderer/lines.js'
import type { TerminalProfile } from '../../terminal/profile.js'
import type { GoalTodoView, TodoStatus } from '../../model/surfaces.js'

export const GOAL_TODO_MAX_LINES = 10

const phaseLabel: Record<NonNullable<GoalTodoView['goal']>['phase'], string> = {
  active: '● active',
  paused: 'Ⅱ paused',
  blocked: '⛔ blocked',
  complete: '✓ complete',
}

function todoGlyph(status: TodoStatus): string {
  switch (status) {
    case 'in_progress': return '●'
    case 'completed': return '✓'
    default: return '○'
  }
}

/**
 * Construct a pure component. It only receives the immutable projection; the
 * coordinator owns channel subscriptions and live updates.
 */
export function createGoalTodoComponent(view: GoalTodoView, profile: TerminalProfile): Component {
  const renderLine = (text: string, width: number, foreground: string | null = null): string => {
    if (width <= 0) return ''
    return cellsToString(truncateCells(styledCells(text, lineStyle({ foreground }), profile), width))
  }
  return {
    render(width) {
      if (width <= 0) return []
      const lines: string[] = []
      if (view.goal !== null) {
        const goal = view.goal
        lines.push(renderLine(`🎯 ${goal.objective} · ${phaseLabel[goal.phase]} · ${goal.roundsStarted}/${goal.maxGoalRounds}`, width, goal.phase === 'blocked' ? 'red' : null))
        if (goal.phase === 'blocked' && goal.blockedReason !== undefined) {
          lines.push(renderLine(`│ ${goal.blockedReason.message}`, width, 'red'))
        }
      }
      for (const [index, todo] of view.todos.entries()) {
        if (lines.length >= GOAL_TODO_MAX_LINES) break
        const branch = index === view.todos.length - 1 && view.hiddenTodos === 0 ? '└─' : '├─'
        lines.push(renderLine(`${branch} ${todoGlyph(todo.status)} ${todo.content}`, width, todo.status === 'in_progress' ? 'yellow' : null))
      }
      if (view.hiddenTodos > 0 && lines.length < GOAL_TODO_MAX_LINES) {
        lines.push(renderLine(`└─ … ${view.hiddenTodos} more`, width, 'bright-black'))
      }
      return lines
    },
    invalidate() {},
  }
}
