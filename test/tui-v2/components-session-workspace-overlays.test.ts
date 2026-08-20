/** WP-08d1 session/workspace overlay contracts: bounded views and cell-safe text. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderDialogOverlayLines } from '../../src/tui-v2/components/overlays/render-dialog.js'
import { DEFAULT_COMPONENT_THEME } from '../../src/tui-v2/components/theme.js'
import {
  parseCatalogOverlayPayload,
  type SessionBrowserPayload,
  type WorkspaceDialogPayload,
} from '../../src/tui-v2/model/catalog-overlay-payloads.js'
import { measureLineWidth } from '../../src/tui-v2/renderer/lines.js'
import { unknownConservativeDefaults } from '../../src/tui-v2/terminal/profile.js'

const profile = unknownConservativeDefaults()
const theme = DEFAULT_COMPONENT_THEME
const hostile = '控制👩‍💻e\u0301\x1b]52;c;ZXZpbA==\x07\x1b]8;;https://evil.invalid\x07linked\x1b]8;;\x07\x1b[31m red\nnext'

function sessionPayload(): SessionBrowserPayload {
  return {
    kind: 'session-browser-dialog',
    key: 'sessions-safe',
    title: `Resume ${hostile}`,
    phase: 'ready',
    now: 2_000,
    filter: {
      query: `搜😀${hostile}`,
      cursor: 3,
      allProjects: true,
      branchOnly: false,
      showSubagents: true,
    },
    rows: [
      { kind: 'project', key: 'project:/tmp', cwd: `/tmp/${hostile}`, count: 1 },
      {
        kind: 'session',
        id: 'session-1',
        sessionKind: 'fork',
        title: `LIST_ROW_SENTINEL ${hostile}`,
        titleSource: 'renamed',
        cwd: `/work/${hostile}`,
        createdAt: 1_000,
        updatedAt: 1_500,
        depth: 1,
        bytes: 4_096,
        model: `model-${hostile}`,
        branch: `branch-${hostile}`,
        childCount: 2,
      },
    ],
    selectedId: 'session-1',
    hasMoreAbove: false,
    hasMoreBelow: true,
    sourceCount: 2,
    shownCount: 1,
    hiddenSubagents: 1,
    emptyCount: 1,
    current: { id: 'current', title: `Current ${hostile}` },
    mode: 'list',
    preview: {
      open: true,
      phase: 'ready',
      sessionId: 'session-1',
      title: `Preview ${hostile}`,
      cwd: `/preview/${hostile}`,
      entries: [
        { role: 'user', text: `PREVIEW_ENTRY_SENTINEL ${hostile}`, at: 1_100 },
        { role: 'assistant', text: `answer ${hostile}` },
        { role: 'tool', text: `tool/call ${hostile}` },
      ],
    },
    notice: { text: `notice ${hostile}`, tone: 'warning' },
    hint: `hint ${hostile}`,
  }
}

function workspacePayload(): WorkspaceDialogPayload {
  return {
    kind: 'workspace-dialog',
    key: 'workspace-safe',
    title: `Workspace ${hostile}`,
    phase: 'pending',
    view: 'choices',
    query: `查😀${hostile}`,
    cursor: 3,
    items: [
      {
        kind: 'choice',
        id: 'choice-1',
        label: `Provider ${hostile}`,
        description: `Description ${hostile}`,
        badge: `remote ${hostile}`,
        hasInput: true,
      },
    ],
    selectedId: 'choice-1',
    hasMoreAbove: true,
    hasMoreBelow: true,
    sourceCount: 9,
    filteredCount: 1,
    input: {
      choiceId: 'choice-1',
      value: `值😀${hostile}`,
      cursor: 3,
      placeholder: `placeholder ${hostile}`,
    },
    degraded: true,
    notice: { text: `local-only ${hostile}`, tone: 'warning' },
    error: `bounded error ${hostile}`,
    hint: `hint ${hostile}`,
  }
}

for (const width of [0, 1, 2, 20, 99, 100, 140]) {
  test(`session/workspace overlays are cell-safe at width ${width}`, () => {
    for (const payload of [sessionPayload(), workspacePayload()]) {
      const lines = renderDialogOverlayLines(payload, width, { profile, theme })
      if (width === 0) {
        assert.deepEqual(lines, [])
        continue
      }
      assert.ok(lines.length > 0, `${payload.kind} rendered`)
      for (const line of lines) {
        assert.ok(
          measureLineWidth(line, profile) <= width,
          `${payload.kind} exceeds ${width}: ${JSON.stringify(line)}`,
        )
        assert.ok(!line.includes('\x1b]'), 'untrusted OSC is not replayed')
        assert.ok(!line.includes('https://evil.invalid'), 'OSC URI is not replayed as text')
        assert.ok(!line.includes('ZXZpbA=='), 'OSC clipboard payload is not replayed as text')
      }
    }
  })
}

test('session preview switches from narrow replacement to 100-cell split', () => {
  const view = sessionPayload()
  const narrow = renderDialogOverlayLines(view, 99, { profile, theme }).join('\n')
  assert.match(narrow, /PREVIEW_ENTRY_SENTINEL/)
  assert.ok(!narrow.includes('LIST_ROW_SENTINEL'), 'narrow preview replaces the session list')

  const split = renderDialogOverlayLines(view, 100, { profile, theme }).join('\n')
  assert.match(split, /PREVIEW_ENTRY_SENTINEL/)
  assert.match(split, /LIST_ROW_SENTINEL/)
})

test('catalog payload parser rejects malformed and over-budget projections', () => {
  const session = sessionPayload()
  const workspace = workspacePayload()
  assert.equal(parseCatalogOverlayPayload(session)?.kind, 'session-browser-dialog')
  assert.equal(parseCatalogOverlayPayload(workspace)?.kind, 'workspace-dialog')

  assert.equal(parseCatalogOverlayPayload({
    ...session,
    filter: { ...session.filter, cursor: [...session.filter.query].length + 1 },
  }), null)
  assert.equal(parseCatalogOverlayPayload({
    ...session,
    preview: {
      ...session.preview,
      entries: Array.from({ length: 9 }, (_, index) => ({ role: 'tool', text: `tool-${index}` })),
    },
  }), null)
  assert.equal(parseCatalogOverlayPayload({ ...session, selectedId: 'outside-window' }), null)

  const nineItems = Array.from({ length: 9 }, (_, index) => ({
    kind: 'target' as const,
    id: `target-${index}`,
    label: `Target ${index}`,
  }))
  assert.equal(parseCatalogOverlayPayload({
    ...workspace,
    items: nineItems,
    sourceCount: 9,
    filteredCount: 9,
    selectedId: 'target-0',
  }), null)
  assert.equal(parseCatalogOverlayPayload({
    ...workspace,
    cursor: [...workspace.query].length + 1,
  }), null)
  assert.equal(parseCatalogOverlayPayload({ ...workspace, selectedId: 'outside-window' }), null)
  assert.equal(parseCatalogOverlayPayload({ kind: 'workspace-dialog' }), null)
})
