// Dev-login pilots have no database row, so their credit ledgers live in memory,
// shared across route modules (trade, missions, ...) that need to read/write credits.
const accounts = new Map();

export function mockAccount(playerId) {
  if (!accounts.has(playerId)) accounts.set(playerId, { credits: 0, trades: [] });
  return accounts.get(playerId);
}
