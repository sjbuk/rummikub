/**
 * Shared press-drag-drop controller for the staging grid and the main board.
 *
 * One code path for mouse, touch, and pen: a press that moves past a small
 * slop threshold becomes a drag (floating clone + drop highlight, committed
 * on release); a press released in place is a tap. The drag payload is
 * resolved at press time so mid-drag re-renders cannot change what moves,
 * and no state is mutated until the drop commits.
 */

export type DragArea = 'board' | 'rack';

/** What is being moved: the origin grid plus the exact cells travelling. */
export interface DragPayload {
  area: DragArea;
  cells: number[];
}

/** Where the pointer released: the destination grid plus its slot index. */
export interface DragDest {
  area: DragArea;
  index: number;
}

/**
 * Window/distance in which a second tap counts as a double-tap. Sized to
 * cover the set-grab gesture (450ms in app.ts) and Safari's own window.
 */
export const DOUBLE_TAP_GUARD_MS = 500;
export const DOUBLE_TAP_GUARD_PX = 40;

/**
 * Blocks iPad double-tap-to-zoom on the two-tap set grab.
 *
 * Safari's smart zoom is the default action of the second tap's `touchend`,
 * so that — not `dblclick`, which fires after the zoom decision — is the
 * event to cancel. Only tile taps are cancelled: they travel the Pointer
 * Events path, which cancellation leaves intact, while empty cells and
 * buttons rely on compat click and are never touched.
 */
export function installDoubleTapZoomGuard(target: Pick<HTMLElement, 'addEventListener'>): void {
  let last: { time: number; x: number; y: number } | null = null;
  target.addEventListener('touchend', (e) => {
    const ev = e as TouchEvent;
    const touch = ev.changedTouches && ev.changedTouches[0];
    if (!touch) return;
    const now = Date.now();
    if (
      last &&
      now - last.time < DOUBLE_TAP_GUARD_MS &&
      Math.hypot(touch.clientX - last.x, touch.clientY - last.y) < DOUBLE_TAP_GUARD_PX
    ) {
      const t = ev.target as Element | null;
      if (typeof t?.closest === 'function' && t.closest('.tile')) {
        ev.preventDefault();
      }
    }
    last = { time: now, x: touch.clientX, y: touch.clientY };
  }, { passive: false });
}

export interface TileDragHooks {
  /** Scope in which `.drop-target` highlights are cleared. */
  root: HTMLElement;
  boardGrid: HTMLElement;
  rackGrid: HTMLElement;
  /** Press released in place (selection / double-tap-grab lives here). */
  onTap: (payload: DragPayload) => void;
  /** Drag released over a grid cell. */
  onDrop: (payload: DragPayload, dest: DragDest) => void;
}

/** Pointer travel before a press becomes a drag — plain taps still tap. */
export const DRAG_SLOP_PX = 10;

interface ActiveDrag {
  pointerId: number;
  payload: DragPayload;
  origin: HTMLElement;
  hooks: TileDragHooks;
  startX: number;
  startY: number;
  dragging: boolean;
  clone: HTMLElement | null;
  destEl: HTMLElement | null;
  dest: DragDest | null;
}

let active: ActiveDrag | null = null;

function clearHighlight(hooks: TileDragHooks) {
  hooks.root.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
}

function endVisuals(drag: ActiveDrag) {
  drag.clone?.remove();
  drag.clone = null;
  drag.origin.classList.remove('dragging');
  drag.destEl = null;
  drag.dest = null;
  clearHighlight(drag.hooks);
}

function destFromPoint(hooks: TileDragHooks, x: number, y: number): { dest: DragDest; el: HTMLElement } | null {
  const under = document.elementFromPoint(x, y) as HTMLElement | null;
  const rackCell = under?.closest?.('.rack-grid .cell') as HTMLElement | null;
  if (rackCell && hooks.rackGrid.contains(rackCell)) {
    return { dest: { area: 'rack', index: [...hooks.rackGrid.children].indexOf(rackCell) }, el: rackCell };
  }
  const boardCell = under?.closest?.('.board-grid .cell') as HTMLElement | null;
  if (boardCell && hooks.boardGrid.contains(boardCell)) {
    return { dest: { area: 'board', index: [...hooks.boardGrid.children].indexOf(boardCell) }, el: boardCell };
  }
  return null;
}

function positionClone(drag: ActiveDrag, x: number, y: number) {
  const clone = drag.clone;
  if (!clone) return;
  const size = drag.origin.getBoundingClientRect();
  // Float the clone above the pointer so the target cell stays visible.
  clone.style.transform = `translate(${x - size.width / 2}px, ${y - size.height - 14}px)`;
}

function onMove(e: PointerEvent) {
  const drag = active;
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.dragging) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_SLOP_PX) return;
    drag.dragging = true;
    const rect = drag.origin.getBoundingClientRect();
    const clone = drag.origin.cloneNode(true) as HTMLElement;
    clone.classList.add('drag-clone');
    clone.classList.remove('selected', 'just-drew', 'dragging');
    if (drag.payload.cells.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'drag-count';
      badge.textContent = `×${drag.payload.cells.length}`;
      clone.append(badge);
    }
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    document.body.append(clone);
    drag.clone = clone;
    drag.origin.classList.add('dragging');
  }
  positionClone(drag, e.clientX, e.clientY);
  clearHighlight(drag.hooks);
  const hit = destFromPoint(drag.hooks, e.clientX, e.clientY);
  if (hit) {
    drag.dest = hit.dest;
    drag.destEl = hit.el;
    hit.el.classList.add('drop-target');
  } else {
    drag.dest = null;
    drag.destEl = null;
  }
  e.preventDefault();
}

function detach() {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
}

function onUp(e: PointerEvent) {
  const drag = active;
  if (!drag || e.pointerId !== drag.pointerId) return;
  active = null;
  detach();
  if (!drag.dragging) {
    drag.hooks.onTap(drag.payload);
    return;
  }
  const dest = drag.dest;
  endVisuals(drag);
  // Released anywhere else: the tile snaps back, nothing changes.
  if (dest) drag.hooks.onDrop(drag.payload, dest);
}

function onCancel(e: PointerEvent) {
  const drag = active;
  if (!drag || e.pointerId !== drag.pointerId) return;
  active = null;
  detach();
  if (drag.dragging) endVisuals(drag);
}

/**
 * Make a tile element draggable via Pointer Events. The payload is fixed at
 * press time; taps route to `onTap`, drops to `onDrop`. Tiles carry no click
 * handlers of their own, so no trailing-click suppression is needed.
 */
export function attachTileDrag(el: HTMLElement, payload: DragPayload, hooks: TileDragHooks) {
  el.onpointerdown = (e) => {
    if (active) return; // one drag at a time; a second finger's press is ignored
    active = {
      pointerId: e.pointerId,
      payload: { area: payload.area, cells: [...payload.cells] },
      origin: el,
      hooks,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      clone: null,
      destEl: null,
      dest: null,
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };
}
