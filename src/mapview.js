// Map placement view. Uses MapLibre GL (global `maplibregl` from the script
// tag in index.html) with OpenStreetMap raster tiles as the basemap and the
// development's GeoJSON — every polygon at true geographic scale — layered
// on top. Structures render as 3D fill-extrusions at their real heights.

const KIND_FILL = {
  'site-boundary': null,
  greenspace: { color: '#3f7a45', opacity: 0.65 },
  water: { color: '#3d6b8e', opacity: 0.7 },
  parking: { color: '#6a6d73', opacity: 0.75 },
  road: { color: '#43464c', opacity: 0.9 },
  path: { color: '#8c8578', opacity: 0.9 },
};

export class MapView {
  constructor(container) {
    this.container = container;
    this.map = null;
    this.lastGeoJSON = null;
    this.popup = null;
    this._needsFit = false;
  }

  setData(geojson, anchor) {
    if (!geojson) return;
    this.lastGeoJSON = geojson;
    this.anchor = anchor;
    // A map created in a hidden (zero-size) container mis-tiles; defer
    // creation / camera fit until the tab is actually visible.
    const hidden = this.container.offsetWidth === 0;
    if (!this.map) {
      if (hidden) this._pendingCreate = true;
      else this._createMap(geojson, anchor);
    } else {
      this.map.getSource('development')?.setData(geojson);
      if (hidden) this._needsFit = true;
      else this.fitToData(geojson);
    }
  }

  /** Call whenever the map container is revealed or resized. */
  resize() {
    if (this._pendingCreate) {
      this._pendingCreate = false;
      this._createMap(this.lastGeoJSON, this.anchor);
      return;
    }
    if (!this.map) return;
    this.map.resize();
    if (this._needsFit && this.lastGeoJSON) {
      this._needsFit = false;
      this.fitToData(this.lastGeoJSON);
    }
  }

  fitToData(geojson) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const eat = (coords) => {
      if (typeof coords[0] === 'number') {
        minLon = Math.min(minLon, coords[0]); maxLon = Math.max(maxLon, coords[0]);
        minLat = Math.min(minLat, coords[1]); maxLat = Math.max(maxLat, coords[1]);
      } else coords.forEach(eat);
    };
    geojson.features.forEach((f) => eat(f.geometry.coordinates));
    if (!Number.isFinite(minLon)) return;
    this.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 80, pitch: 55, duration: 800 });
  }

  _createMap(geojson, anchor) {
    this.map = new maplibregl.Map({
      container: this.container,
      center: [anchor.lon, anchor.lat],
      zoom: 15,
      pitch: 55,
      antialias: true,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
            maxzoom: 19,
          },
        },
        layers: [{ id: 'basemap', type: 'raster', source: 'osm' }],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 160 }), 'bottom-left');

    // 'style.load' rather than 'load': it fires as soon as the style is
    // ready, so the development still renders even if basemap tiles stall.
    this.map.on('style.load', () => {
      this.map.addSource('development', { type: 'geojson', data: geojson });

      for (const [kind, style] of Object.entries(KIND_FILL)) {
        if (!style) continue;
        this.map.addLayer({
          id: `dev-${kind}`,
          type: 'fill',
          source: 'development',
          filter: ['==', ['get', 'kind'], kind],
          paint: { 'fill-color': style.color, 'fill-opacity': style.opacity },
        });
      }

      this.map.addLayer({
        id: 'dev-site-boundary',
        type: 'line',
        source: 'development',
        filter: ['==', ['get', 'kind'], 'site-boundary'],
        paint: { 'line-color': '#e8c468', 'line-width': 2.5, 'line-dasharray': [3, 2] },
      });

      this.map.addLayer({
        id: 'dev-structures',
        type: 'fill-extrusion',
        source: 'development',
        filter: ['==', ['get', 'kind'], 'structure'],
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'height_m'],
          'fill-extrusion-opacity': 0.9,
        },
      });

      // No symbol/label layer on purpose: symbol layers need remote glyph
      // fonts, and a failed glyph fetch aborts tile processing for every
      // layer in the source. Structure names show via hover/click popups.
      this.map.on('click', 'dev-structures', (e) => {
        const p = e.features[0].properties;
        const html = `<strong>${p.name}</strong><br>` +
          `${p.structureType} · ${p.floors} floors · ${Number(p.height_m).toFixed(1)} m ` +
          `(${(p.height_m / 0.3048).toFixed(0)} ft) tall`;
        this.popup?.remove();
        this.popup = new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat).setHTML(html).addTo(this.map);
      });
      this.map.on('mouseenter', 'dev-structures', () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', 'dev-structures', () => { this.map.getCanvas().style.cursor = ''; });

      this.fitToData(geojson);
    });
  }
}
