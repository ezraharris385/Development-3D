// Unit handling. Everything inside the engine is SI meters; input files may
// be authored in feet or meters, and the UI can display either.

export const METERS_PER_FOOT = 0.3048;

export function toMeters(value, units) {
  return units === 'ft' ? value * METERS_PER_FOOT : value;
}

export function fromMeters(valueM, units) {
  return units === 'ft' ? valueM / METERS_PER_FOOT : valueM;
}

/** Format a length in meters for display in the requested units. */
export function formatLength(valueM, units, decimals = 1) {
  const v = fromMeters(valueM, units);
  return `${v.toFixed(decimals)} ${units === 'ft' ? 'ft' : 'm'}`;
}

/** Format an area in square meters for display in the requested units. */
export function formatArea(valueM2, units, decimals = 0) {
  if (units === 'ft') {
    const sqft = valueM2 / (METERS_PER_FOOT * METERS_PER_FOOT);
    if (sqft >= 43560) return `${(sqft / 43560).toFixed(2)} ac (${Math.round(sqft).toLocaleString()} sq ft)`;
    return `${sqft.toFixed(decimals)} sq ft`;
  }
  if (valueM2 >= 10000) return `${(valueM2 / 10000).toFixed(2)} ha (${Math.round(valueM2).toLocaleString()} m²)`;
  return `${valueM2.toFixed(decimals)} m²`;
}
