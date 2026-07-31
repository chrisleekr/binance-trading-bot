import {
  updateSnapshot,
  type SocketEntry,
  type SocketFrame,
} from '@/features/profile/socket/registry';

/**
 * Parse one raw WebSocket message and fan it out to the entry's subscribers.
 * Malformed (non-string or non-JSON) frames are dropped — the server contract
 * is JSON-only. `resync-required` frames notify the resync handlers; all other
 * frames notify the frame handlers unless the entry is paused (tab hidden).
 */
export const dispatchFrame = (entry: SocketEntry, data: unknown, clock: () => number): void => {
  if (typeof data !== 'string') return;
  let frame: SocketFrame;
  try {
    frame = JSON.parse(data) as SocketFrame;
  } catch {
    return;
  }
  const seq = typeof frame.seq === 'number' ? frame.seq : entry.snapshot.lastSeq;
  updateSnapshot(entry, { lastMessageAt: clock(), lastSeq: seq });
  if (frame.topic === 'resync-required') {
    // Snapshot the set so a handler that re-subscribes mid-iteration
    // doesn't observe its own callback in the same dispatch.
    for (const handler of [...entry.resyncHandlers]) handler();
  }
  if (!entry.paused) {
    const snap = entry.snapshot;
    for (const handler of [...entry.frameHandlers]) handler(frame, snap);
  }
};
