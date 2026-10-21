// DI token for the Geocoder port — bound in NodesModule to Google when a key
// is configured, otherwise to NullGeocoder.
export const GEOCODER = Symbol('GEOCODER');
