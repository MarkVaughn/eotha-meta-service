// How long a docked receipt, signed by the engine, is honoured after its `issuedAtMs`. A receipt is
// reusable inside this window (it is not single-use), so this is the real bound on how long after
// undocking an upgrade can still be redeemed.
export const DOCKED_RECEIPT_TTL_MS = 30_000;

// Engine and meta-service clocks may disagree by this much before a receipt from the "future" is
// refused. Deliberately tighter than the mission claims' 60 s, which would double the window.
export const DOCKED_RECEIPT_MAX_SKEW_MS = 5_000;
