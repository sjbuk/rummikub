import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDoubleTapZoomGuard } from './drag';

function stubTarget() {
  const calls: { type: string; listener: EventListener; options: unknown }[] = [];
  return {
    calls,
    target: {
      addEventListener: (type: string, listener: EventListener, options: unknown) => {
        calls.push({ type, listener, options });
      },
    },
  };
}

/** Fake second-tap touchend on a tile (or elsewhere when `onTile` is false). */
function touchEnd(listener: EventListener, x: number, onTile: boolean): { preventDefault: () => void; calls: number } {
  const spy = vi.fn();
  listener({
    target: { closest: (sel: string) => (onTile && sel === '.tile' ? {} : null) },
    changedTouches: [{ clientX: x, clientY: 100 }],
    preventDefault: spy,
  } as unknown as Event);
  return { preventDefault: spy, calls: spy.mock.calls.length };
}

describe('installDoubleTapZoomGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a non-passive touchend listener (passive would ignore preventDefault)', () => {
    const { calls, target } = stubTarget();
    installDoubleTapZoomGuard(target);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('touchend');
    expect(calls[0].options).toMatchObject({ passive: false });
  });

  it('cancels a rapid second tap on a tile, so Safari cannot smart-zoom', () => {
    const { calls, target } = stubTarget();
    installDoubleTapZoomGuard(target);
    const onTouchEnd = calls[0].listener;
    expect(touchEnd(onTouchEnd, 50, true).calls).toBe(0);
    vi.setSystemTime(1_000_200);
    expect(touchEnd(onTouchEnd, 55, true).calls).toBe(1);
  });

  it('leaves slow taps, distant taps, and non-tile taps alone', () => {
    const { calls, target } = stubTarget();
    installDoubleTapZoomGuard(target);
    const onTouchEnd = calls[0].listener;

    // Slow second tap on a tile: untouched (empty-cell clicks must survive).
    touchEnd(onTouchEnd, 50, true);
    vi.setSystemTime(1_001_000);
    expect(touchEnd(onTouchEnd, 50, true).calls).toBe(0);

    // Rapid but distant tap: untouched.
    vi.setSystemTime(1_001_100);
    expect(touchEnd(onTouchEnd, 500, true).calls).toBe(0);

    // Rapid nearby tap off any tile (empty cell / button): untouched.
    vi.setSystemTime(1_001_200);
    expect(touchEnd(onTouchEnd, 505, false).calls).toBe(0);
  });
});
