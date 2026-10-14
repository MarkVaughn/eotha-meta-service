// Shapes of the engine's identifiers. Only the syntax is checked here: which systems and stations
// exist is the engine's to say, and it vouches for them with signatures.
export const H3_PATTERN = '^[0-9a-f]{15}$';
export const STATION_PATTERN = '^[A-Za-z0-9_-]{1,64}$';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
