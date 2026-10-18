// Cargo lease rules. The hold itself, its lots and their prices are the engine's: it signs every
// change (`src/lib/cargo.js`), and this service only stores the newest hold the fencing rule admits.

// Most lots a signed hold may carry (the engine's CARGO_MAX_LOTS), which keeps a lease token small
// enough for the WebSocket query string.
export const CARGO_MAX_LOTS = 32;

// Leases older than this are pruned when a new one is issued (the newest is always kept). A record
// from a pruned lease can no longer be applied or credited.
export const CARGO_LEASE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
