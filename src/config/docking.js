// How long a docked receipt, signed by the engine, is honoured after its `issuedAtMs`. A receipt is
// reusable inside this window (it is not single-use), so this is the real bound on how long after
// undocking an upgrade can still be redeemed.
export const DOCKED_RECEIPT_TTL_MS = 30_000;

// Engine and meta-service clocks may disagree by this much before a receipt from the "future" is
// refused. Deliberately tighter than the mission claims' 60 s, which would double the window.
export const DOCKED_RECEIPT_MAX_SKEW_MS = 5_000;

// How long after its `undockedAtMs` a signed undock receipt is still accepted. It matches the 15 minute window
// the FLAKY departure roll is bucketed on (src/lib/crew-docking.js), so a receipt relayed late never lands in a
// different roll than the one the cast-off belonged to.
export const UNDOCK_RECEIPT_TTL_MS = 900_000;

// How far past the meta-service clock an undock receipt's `undockedAtMs` may be before it is refused. Matches
// DOCKED_RECEIPT_MAX_SKEW_MS.
export const UNDOCK_RECEIPT_MAX_SKEW_MS = 5_000;
