// Cargo lease rules. The hold itself, its lots and their prices are the engine's: it signs every
// change (`src/lib/cargo.js`), and this service only stores the newest hold the fencing rule admits.

// Most lots a signed hold may carry (the engine's CARGO_MAX_LOTS), which keeps a lease token small
// enough for the WebSocket query string.
export const CARGO_MAX_LOTS = 32;

// Credits per m3 of pure ore by resource type, as the engine prices it (eotha-rtse `cargo.rs` `base_price`); a
// resource it does not list sells at the default. Only the export toll reads it, to value ore at baseline market
// price; a sale itself is priced and signed by the engine.
export const ORE_BASE_PRICES = Object.freeze({ FERRITE: 10, TITANIUM: 25 });
export const DEFAULT_ORE_BASE_PRICE = 10;
