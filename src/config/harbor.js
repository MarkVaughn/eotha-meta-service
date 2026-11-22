// The H3 resolution of every home harbor cell (and so of the `home_h3` token claim).
export const HARBOR_H3_RESOLUTION = 8;

// The home harbor (and so the spawn point) every player without one is given when the sign-in
// carries no usable location: the same location development login uses unless it is asked for
// another. `h3Index` is a resolution 8 cell.
export const DEFAULT_HARBOR = Object.freeze({
  latitude: 37.7749,
  longitude: -122.4194,
  h3Index: '8828308281fffff'
});
