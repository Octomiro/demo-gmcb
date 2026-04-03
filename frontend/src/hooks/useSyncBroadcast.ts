/**
 * BroadcastChannel-based cross-tab sync.
 * When any tab mutates data it calls `notify(channel)`.
 * All other tabs on the same origin receive it and call their reload.
 */

const CHANNELS = {
  shifts: "gmcb_shifts_changed",
  oneOff: "gmcb_one_off_changed",
} as const;

function makeChannel(name: string, onMessage: () => void): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(name);
  ch.onmessage = onMessage;
  return ch;
}

export function useShiftsBroadcast(onRemoteChange: () => void) {
  const ch = makeChannel(CHANNELS.shifts, onRemoteChange);
  return {
    notify: () => ch?.postMessage({ t: 1 }),
    close: () => ch?.close(),
  };
}

export function useOneOffBroadcast(onRemoteChange: () => void) {
  const ch = makeChannel(CHANNELS.oneOff, onRemoteChange);
  return {
    notify: () => ch?.postMessage({ t: 1 }),
    close: () => ch?.close(),
  };
}
