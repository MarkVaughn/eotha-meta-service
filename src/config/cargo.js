// Cargo lease rules. The hold itself, its lots and their prices are the engine's: it signs every
// change (`src/lib/cargo.js`), and this service only stores the newest hold the fencing rule admits.

// Most lots a signed hold may carry (the engine's CARGO_MAX_LOTS), which keeps a lease token small
// enough for the WebSocket query string.
export const CARGO_MAX_LOTS = 32;
