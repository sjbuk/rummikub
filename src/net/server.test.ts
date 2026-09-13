import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerApiError, api, functionsBase } from './server';

function mockFetchOnce(status: number, body: unknown) {
  const stub = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('functionsBase', () => {
  it('defaults to the deployed project', () => {
    expect(functionsBase()).toContain('supabase.co/functions/v1');
  });
});

describe('api client', () => {
  it('POSTs JSON and returns the parsed state', async () => {
    const stub = mockFetchOnce(200, { code: 'ABCDE', yourSeat: 0 });
    const state = await api.joinRoom({ code: 'ABCDE', name: 'G' });
    expect(state.code).toBe('ABCDE');
    expect(stub).toHaveBeenCalledOnce();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/rooms-join')).toBe(true);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'ABCDE', name: 'G' });
  });
  it('GETs the public lobby list', async () => {
    const stub = mockFetchOnce(200, { rooms: [] });
    await api.listRooms();
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/rooms-list')).toBe(true);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });
  it('maps function errors to ServerApiError with status and name', async () => {
    mockFetchOnce(409, { error: 'room_full', message: 'That room is full.' });
    const err = await api.joinRoom({ code: 'ABCDE', name: 'G' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServerApiError);
    expect(err.status).toBe(409);
    expect(err.error).toBe('room_full');
  });
  it('maps network failures to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const err = await api.listRooms().catch((e) => e);
    expect(err).toBeInstanceOf(ServerApiError);
    expect(err.status).toBe(0);
    expect(err.error).toBe('network');
  });
});
