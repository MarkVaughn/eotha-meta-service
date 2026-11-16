// The home harbor (and so the spawn point) every player without one is given: the same location
// development login uses unless it is asked for another. `h3Index` is a resolution 8 cell.
export const DEFAULT_HARBOR = Object.freeze({
  latitude: 37.7749,
  longitude: -122.4194,
  h3Index: '8828308281fffff'
});
