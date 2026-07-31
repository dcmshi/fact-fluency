import { vi } from 'vitest';

/**
 * A stand-in for the browser WebSocket, for the two live-game pages.
 *
 * Both pages are pure renderers of server pushes, so a socket the test can push
 * frames into is enough to drive them through every phase. Only the surface those
 * pages touch is implemented: the four handler properties, `send`, `close`,
 * `readyState`, and the OPEN constant they compare against.
 */
export class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.OPEN;
  sent: unknown[] = [];
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  /** Push a server frame at the page. */
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Everything this socket sent with the given `type`. */
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === type,
    );
  }
}

/** Install FakeSocket as the global WebSocket; returns the live instance list. */
export function stubWebSocket(): { latest: () => FakeSocket } {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  return {
    latest: () => {
      const socket = FakeSocket.instances.at(-1);
      if (!socket) throw new Error('no WebSocket was opened');
      return socket;
    },
  };
}
