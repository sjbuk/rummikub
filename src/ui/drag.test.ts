import { describe, expect, it, vi } from 'vitest';
import { suppressDoubleTapZoom } from './drag';

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

describe('suppressDoubleTapZoom', () => {
  it('cancels dblclick so iPad Safari cannot smart-zoom a two-tap set grab', () => {
    const { calls, target } = stubTarget();
    suppressDoubleTapZoom(target);

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('dblclick');
    // Must be non-passive, otherwise preventDefault() is ignored.
    expect(calls[0].options).toMatchObject({ passive: false });

    const event = { preventDefault: vi.fn() } as unknown as Event;
    calls[0].listener(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});
