/**
 * @vitest-environment happy-dom
 *
 * Reproduction: switching worktrees leaves a Claude Code (DOM-renderer) terminal
 * rendered garbled until a manual zoom forces a refit + full refresh.
 *
 * User report (Orca 1.4.104, macOS): "Every time I switch between workspaces the
 * claude code terminal tab is all jumbled and broken, I have to zoom out and zoom
 * in to get it to render properly." Diagnostic shows many rapid
 * `sidebar_worktree_activate` breadcrumbs.
 *
 * Root cause hypothesis (pinned here):
 * On a worktree (surface) switch, the now-visible terminal resumes via
 * resumeTerminalVisibility() -> heavy path -> manager.resumeRendering() +
 * fitPanes(). For a DOM-renderer pane (GPU off / auto->DOM / context-loss
 * fallback):
 *   - resumePaneRendering() only repaints WebGL panes (attachWebgl ->
 *     refreshTerminalAfterWebglAttach). A DOM pane has no webglAddon, so
 *     reattachWebglIfNeeded() is a no-op: NO refresh.
 *   - fitPanes() -> fitAllPanes() -> safeFit() early-returns when the container
 *     dimensions are unchanged (proposeDimensions === current cols/rows), so it
 *     never calls fit() and never repaints.
 *   - resetAllTerminalWebglAtlases() is a no-op for DOM panes.
 * Net: the stale canvas (not painted while hidden) is shown without any
 * repaint. A manual zoom changes font metrics -> proposeDimensions differs ->
 * fit() runs -> refresh() -> correct render, which is why zoom "fixes" it.
 *
 * This test drives the REAL resumeTerminalVisibility() through the heavy path
 * with a DOM-renderer pane whose container size did not change while hidden, and
 * delegates fitAllPanes() to the REAL fitAllPanesInternal/safeFit so the
 * dimensions-match early-return is exercised authentically. It asserts the pane
 * is repainted on resume (refresh) — regression guard for the fix that adds
 * manager.refreshAllPanes() to the heavy resume path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeTerminalVisibility } from './terminal-visibility-resume'
import { fitAllPanesInternal } from '@/lib/pane-manager/pane-tree-ops'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'

// The container/PTY size is unchanged across the worktree switch, so xterm's
// fit addon proposes the same cols/rows the terminal already has.
const STEADY_COLS = 120
const STEADY_ROWS = 30

type FakeTerminal = {
  cols: number
  rows: number
  refresh: ReturnType<typeof vi.fn<(start: number, end: number) => void>>
  focus: ReturnType<typeof vi.fn<() => void>>
}

type FakePane = {
  id: number
  // DOM-renderer pane: GPU rendering off, no WebGL addon attached.
  gpuRenderingEnabled: boolean
  webglAddon: null
  webglAttachmentDeferred: boolean
  webglDisabledAfterContextLoss: boolean
  terminal: FakeTerminal
  container: { getBoundingClientRect: () => { width: number; height: number } }
  fitAddon: {
    proposeDimensions: () => { cols: number; rows: number }
    fit: ReturnType<typeof vi.fn>
  }
}

function makeDomRendererPane(id: number): FakePane {
  const terminal: FakeTerminal = {
    cols: STEADY_COLS,
    rows: STEADY_ROWS,
    refresh: vi.fn(),
    focus: vi.fn()
  }
  return {
    id,
    gpuRenderingEnabled: false,
    webglAddon: null,
    webglAttachmentDeferred: true, // suspended while the worktree was hidden
    webglDisabledAfterContextLoss: false,
    terminal,
    // A real, comfortably-sized pane (passes canMeasurePaneForFit).
    container: { getBoundingClientRect: () => ({ width: 800, height: 480 }) },
    fitAddon: {
      // Container did not change while hidden -> same dims the terminal has.
      proposeDimensions: () => ({ cols: STEADY_COLS, rows: STEADY_ROWS }),
      fit: vi.fn()
    }
  }
}

function makeManager(panes: FakePane[]) {
  const paneMap = new Map<number, FakePane>(panes.map((pane) => [pane.id, pane]))
  return {
    panes,
    getPanes: () => panes,
    getActivePane: () => panes[0] ?? null,
    // Delegate to the REAL fit so safeFit()'s dimensions-match early-return runs.
    fitAllPanes: () => fitAllPanesInternal(paneMap as never),
    refreshAllPanes: () => {
      for (const pane of panes) {
        pane.terminal.refresh(0, pane.terminal.rows - 1)
      }
    },
    // resumeRendering -> resumePaneRendering: only WebGL panes get a repaint.
    resumeRendering: () => {
      for (const pane of panes) {
        pane.webglAttachmentDeferred = false
        // reattachWebglIfNeeded: no-op for a DOM pane (gpuRenderingEnabled=false).
      }
    },
    suspendRendering: vi.fn(),
    resetWebglTextureAtlases: vi.fn() // no-op for DOM panes (no atlas)
  }
}

describe('worktree switch resume (DOM-renderer Claude Code terminal)', () => {
  const registered: { resetWebglTextureAtlases(): void }[] = []

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const manager of registered.splice(0)) {
      unregisterLivePaneManager(manager)
    }
  })

  it('repaints the terminal on worktree-switch resume even when dimensions are unchanged', () => {
    const pane = makeDomRendererPane(1)
    const manager = makeManager([pane])
    registerLivePaneManager(manager as never)
    registered.push(manager as never)

    // Heavy (surface) resume: the worktree just became active again after being
    // hidden by a sidebar_worktree_activate to another workspace. wasVisible is
    // false because the pane's surface was hidden; shouldUseLightTabResume is
    // false because the hidden reason was 'surface', not 'tab'.
    resumeTerminalVisibility({
      manager: manager as never,
      isActive: true,
      wasVisible: false,
      shouldUseLightTabResume: false,
      captureViewportPositions: () => new Map(),
      withSuppressedScrollTracking: (cb) => cb()
    })

    // The container size did not change, so the real safeFit() early-returned and
    // never called fit(). For a DOM pane nothing else repainted the canvas, so it
    // shows the stale (garbled) buffer until the user zooms.
    expect(pane.fitAddon.fit).not.toHaveBeenCalled()

    // The fix forces a repaint on resume regardless of whether the fit changed
    // dimensions (manager.refreshAllPanes() in the heavy path), so the worktree
    // switch renders correctly without the manual zoom the user reported.
    expect(pane.terminal.refresh).toHaveBeenCalled()
  })
})
