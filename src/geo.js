// Georeferencing: converts the local site grid (meters, +x east / +y north
// before bearing) into WGS84 lat/lon around the anchor, and builds GeoJSON
// so the model drops onto any map or GIS tool at true scale.

import { polygonCentroid } from './schema.js';

/**
 * Meters per degree at a given latitude (series expansion of the WGS84
 * ellipsoid — accurate to well under 1 m/deg at site scales).
 */
export function metersPerDegree(latDeg) {
  const phi = (latDeg * Math.PI) / 180;
  const lat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const lon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return { lat, lon };
}

/**
 * Build a projector for an anchor {lat, lon, bearing}.
 * bearing = degrees the local +y axis is rotated clockwise from true north.
 * Returns fn([xM, yM]) -> [lon, lat] (GeoJSON ordering).
 */
export function makeProjector(anchor) {
  const { lat: mLat, lon: mLon } = metersPerDegree(anchor.lat);
  const theta = (anchor.bearing * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return ([x, y]) => {
    const east = x * cos + y * sin;
    const north = -x * sin + y * cos;
    return [anchor.lon + east / mLon, anchor.lat + north / mLat];
  };
}

/**
 * Buffer an open polyline into a polygon of the given total width, using
 * averaged (miter-limited) join normals. Input/output in local meters.
 */
export function bufferPolyline(path, widthM) {
  const half = widthM / 2;
  const n = path.length;
  const normals = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = path[i + 1][0] - path[i][0];
    const dy = path[i + 1][1] - path[i][1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]); // left-hand normal
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    let nx, ny;
    if (i === 0) [nx, ny] = normals[0];
    else if (i === n - 1) [nx, ny] = normals[n - 2];
    else {
      nx = normals[i - 1][0] + normals[i][0];
      ny = normals[i - 1][1] + normals[i][1];
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      // Miter scale so the joined edge keeps constant width, limited to 4x.
      const dot = nx * normals[i][0] + ny * normals[i][1];
      const scale = Math.min(1 / Math.max(dot, 0.25), 4);
      nx *= scale; ny *= scale;
    }
    left.push([path[i][0] + nx * half, path[i][1] + ny * half]);
    right.push([path[i][0] - nx * half, path[i][1] - ny * half]);
  }
  return [...left, ...right.reverse()];
}

function ringToGeo(points, project) {
  const ring = points.map(project);
  ring.push(ring[0]); // close
  return ring;
}

/**
 * Convert a normalized development to a GeoJSON FeatureCollection.
 * Every feature carries a "kind" plus enough properties to style it
 * (height_m for extrusion, color, name).
 */
export function toGeoJSON(dev) {
  if (!dev.anchor) return null;
  const project = makeProjector(dev.anchor);
  const features = [];

  if (dev.site) {
    features.push({
      type: 'Feature',
      properties: { kind: 'site-boundary', name: dev.name },
      geometry: { type: 'Polygon', coordinates: [ringToGeo(dev.site.boundary, project)] },
    });
  }

  for (const kind of ['greenspace', 'water', 'parking']) {
    for (const area of dev[kind]) {
      features.push({
        type: 'Feature',
        properties: { kind, name: area.name },
        geometry: { type: 'Polygon', coordinates: [ringToGeo(area.polygon, project)] },
      });
    }
  }

  for (const kind of ['roads', 'paths']) {
    for (const way of dev[kind]) {
      features.push({
        type: 'Feature',
        properties: { kind: kind === 'roads' ? 'road' : 'path', name: way.name, width_m: way.widthM },
        geometry: {
          type: 'Polygon',
          coordinates: [ringToGeo(bufferPolyline(way.path, way.widthM), project)],
        },
      });
    }
  }

  for (const s of dev.structures) {
    features.push({
      type: 'Feature',
      properties: {
        kind: 'structure',
        id: s.id,
        name: s.name,
        structureType: s.type,
        height_m: s.heightM,
        floors: s.floors,
        color: s.color,
      },
      geometry: { type: 'Polygon', coordinates: [ringToGeo(s.footprint, project)] },
    });
    const [cx, cy] = polygonCentroid(s.footprint);
    features.push({
      type: 'Feature',
      properties: { kind: 'structure-label', name: s.name },
      geometry: { type: 'Point', coordinates: project([cx, cy]) },
    });
  }

  return { type: 'FeatureCollection', features };
}
