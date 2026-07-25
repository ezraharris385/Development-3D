// Development definition schema + normalization.
//
// A development file describes the physical elements of a site using REAL
// dimensions. Local coordinates are a flat site grid: +x is "site east",
// +y is "site north" (before the anchor bearing is applied), origin is the
// anchor point. Units for every coordinate/length in the file are given by
// the top-level "units" field ("ft" or "m").
//
// {
//   "name": "…",
//   "units": "ft" | "m",
//   "anchor": { "lat": 43.07, "lon": -89.40, "bearing": 0 },   // georeference
//   "site":   { "boundary": [[x,y], …] },                      // optional
//   "structures": [
//     { "id": "…", "name": "…", "type": "residential",
//       "footprint": [[x,y], …],                    // polygon, OR:
//       "rect": { "center": [x,y], "width": w, "depth": d, "rotation": deg },
//       "height": 66,            // to top, in file units (optional if floors)
//       "floors": 5,             // optional; height = floors * floorHeight
//       "floorHeight": 10.5,     // optional, default 10.5 ft / 3.2 m
//       "color": "#8da9c4" }
//   ],
//   "roads":      [ { "name": "…", "path": [[x,y], …], "width": 24 } ],
//   "paths":      [ { "path": [[x,y], …], "width": 8 } ],       // sidewalks etc.
//   "greenspace": [ { "name": "…", "polygon": [[x,y], …] } ],
//   "water":      [ { "polygon": [[x,y], …] } ],
//   "parking":    [ { "name": "…", "polygon": [[x,y], …] } ]
// }
//
// normalize() converts everything to meters and fills defaults; the rest of
// the app only ever sees normalized data.

import { toMeters, METERS_PER_FOOT } from './units.js';

export const TYPE_COLORS = {
  residential: '#a7bed3',
  office: '#7f9bb3',
  retail: '#c9a97e',
  'mixed-use': '#b39fc4',
  civic: '#9cc0a5',
  industrial: '#b0a99f',
  parking: '#8f8f96',
  hotel: '#c4a3a3',
  default: '#a9b2bc',
};

const DEFAULT_FLOOR_HEIGHT_M = 3.2; // ≈ 10.5 ft floor-to-floor

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function convertPoints(points, units) {
  return points.map(([x, y]) => [toMeters(x, units), toMeters(y, units)]);
}

/** Expand a rect shorthand into a footprint polygon (file units in/out). */
export function rectToPolygon({ center = [0, 0], width, depth, rotation = 0 }) {
  const [cx, cy] = center;
  const hw = width / 2;
  const hd = depth / 2;
  const r = (rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [
    [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd],
  ].map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

/** Shoelace area of a polygon in whatever units its points are in. */
export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

export function polygonCentroid(points) {
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  return [cx / points.length, cy / points.length];
}

/**
 * Validate + normalize a raw development definition.
 * Returns { dev, warnings } where dev has every length in meters.
 */
export function normalize(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') throw new Error('Development file must be a JSON object.');

  const units = raw.units === 'ft' ? 'ft' : raw.units === 'm' ? 'm' : null;
  if (!units) throw new Error(`"units" must be "ft" or "m" (got ${JSON.stringify(raw.units)}).`);

  const dev = {
    name: typeof raw.name === 'string' ? raw.name : 'Untitled development',
    sourceUnits: units,
    anchor: null,
    site: null,
    structures: [],
    roads: [],
    paths: [],
    greenspace: [],
    water: [],
    parking: [],
  };

  if (raw.anchor) {
    const { lat, lon, bearing = 0 } = raw.anchor;
    if (isNum(lat) && isNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      dev.anchor = { lat, lon, bearing: isNum(bearing) ? bearing : 0 };
    } else {
      warnings.push('anchor.lat/lon invalid — map placement disabled.');
    }
  } else {
    warnings.push('No "anchor" set — the model renders to scale but cannot be placed on a map.');
  }

  if (raw.site?.boundary?.length >= 3) {
    dev.site = { boundary: convertPoints(raw.site.boundary, units) };
  }

  const defFloorH = units === 'ft' ? DEFAULT_FLOOR_HEIGHT_M / METERS_PER_FOOT : DEFAULT_FLOOR_HEIGHT_M;

  (raw.structures ?? []).forEach((s, i) => {
    let footprint = s.footprint;
    if (!footprint && s.rect) footprint = rectToPolygon(s.rect);
    if (!footprint || footprint.length < 3) {
      warnings.push(`structures[${i}] has no usable footprint or rect — skipped.`);
      return;
    }
    const floorHeight = isNum(s.floorHeight) ? s.floorHeight : defFloorH;
    let height = s.height;
    if (!isNum(height)) {
      if (isNum(s.floors)) height = s.floors * floorHeight;
      else {
        warnings.push(`structures[${i}] "${s.name ?? s.id ?? i}" has no height or floors — defaulted to 1 floor.`);
        height = floorHeight;
      }
    }
    dev.structures.push({
      id: s.id ?? `structure-${i}`,
      name: s.name ?? s.id ?? `Structure ${i + 1}`,
      type: s.type ?? 'default',
      footprint: convertPoints(footprint, units),
      heightM: toMeters(height, units),
      floors: isNum(s.floors) ? s.floors : Math.max(1, Math.round(height / floorHeight)),
      color: s.color ?? TYPE_COLORS[s.type] ?? TYPE_COLORS.default,
    });
  });

  const readWays = (list, kind, defaultWidth) => (list ?? []).forEach((w, i) => {
    if (!w.path || w.path.length < 2) {
      warnings.push(`${kind}[${i}] needs a "path" with at least 2 points — skipped.`);
      return;
    }
    dev[kind].push({
      name: w.name ?? null,
      path: convertPoints(w.path, units),
      widthM: toMeters(isNum(w.width) ? w.width : defaultWidth, units),
    });
  });
  readWays(raw.roads, 'roads', units === 'ft' ? 24 : 7.3);
  readWays(raw.paths, 'paths', units === 'ft' ? 8 : 2.4);

  const readAreas = (list, kind) => (list ?? []).forEach((a, i) => {
    if (!a.polygon || a.polygon.length < 3) {
      warnings.push(`${kind}[${i}] needs a "polygon" with at least 3 points — skipped.`);
      return;
    }
    dev[kind].push({ name: a.name ?? null, polygon: convertPoints(a.polygon, units) });
  });
  readAreas(raw.greenspace, 'greenspace');
  readAreas(raw.water, 'water');
  readAreas(raw.parking, 'parking');

  return { dev, warnings };
}

/** Bounding box [minX, minY, maxX, maxY] in meters over every element. */
export function devBounds(dev) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (pts) => {
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  };
  if (dev.site) eat(dev.site.boundary);
  dev.structures.forEach((s) => eat(s.footprint));
  dev.roads.forEach((r) => eat(r.path));
  dev.paths.forEach((p) => eat(p.path));
  dev.greenspace.forEach((g) => eat(g.polygon));
  dev.water.forEach((w) => eat(w.polygon));
  dev.parking.forEach((p) => eat(p.polygon));
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}
