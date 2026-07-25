import { normalize } from './schema.js';
import { toGeoJSON } from './geo.js';
import { Viewer3D, structureStats } from './viewer3d.js';
import { MapView } from './mapview.js';
import { formatLength } from './units.js';

const el = (id) => document.getElementById(id);

const state = {
  dev: null,
  geojson: null,
  displayUnits: 'ft',
  activeTab: 'view3d',
};

const infoPanel = el('info-panel');
const viewer = new Viewer3D(el('view3d'), {
  onSelect: (structure) => renderInfoPanel(structure),
});
const mapView = new MapView(el('viewmap'));

function renderInfoPanel(structure) {
  if (!structure) {
    infoPanel.classList.add('hidden');
    return;
  }
  const s = structureStats(structure, state.displayUnits);
  infoPanel.innerHTML = `
    <h3>${structure.name}</h3>
    <dl>
      <dt>Type</dt><dd>${structure.type}</dd>
      <dt>Height</dt><dd>${s.height}</dd>
      <dt>Floors</dt><dd>${s.floors}</dd>
      <dt>Envelope</dt><dd>${s.envelope}</dd>
      <dt>Footprint</dt><dd>${s.footprintArea}</dd>
      <dt>Gross floor area</dt><dd>${s.grossFloorArea}</dd>
    </dl>`;
  infoPanel.classList.remove('hidden');
}

function loadDevelopment(raw) {
  const { dev, warnings } = normalize(raw);
  state.dev = dev;
  state.displayUnits = dev.sourceUnits;
  state.geojson = toGeoJSON(dev);

  el('dev-name').textContent = dev.name;
  el('unit-toggle').textContent = state.displayUnits === 'ft' ? 'Units: ft' : 'Units: m';
  el('btn-geojson').disabled = !state.geojson;

  const warnBox = el('warnings');
  warnBox.innerHTML = warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  warnBox.classList.toggle('hidden', warnings.length === 0);

  renderInfoPanel(null);
  viewer.setDevelopment(dev, state.displayUnits);
  if (state.geojson) mapView.setData(state.geojson, dev.anchor);

  const mapNotice = el('map-notice');
  mapNotice.classList.toggle('hidden', !!state.geojson);
}

// --- Tabs ---
for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    state.activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    el('view3d').classList.toggle('hidden', state.activeTab !== 'view3d');
    el('viewmap-wrap').classList.toggle('hidden', state.activeTab !== 'viewmap');
    if (state.activeTab === 'viewmap') mapView.resize();
    else viewer.resize();
  });
}

// --- Toolbar ---
el('unit-toggle').addEventListener('click', () => {
  state.displayUnits = state.displayUnits === 'ft' ? 'm' : 'ft';
  el('unit-toggle').textContent = state.displayUnits === 'ft' ? 'Units: ft' : 'Units: m';
  viewer.displayUnits = state.displayUnits;
  renderInfoPanel(null);
});

el('btn-measure').addEventListener('click', () => {
  const on = el('btn-measure').classList.toggle('active');
  viewer.setMeasureMode(on);
});

el('btn-geojson').addEventListener('click', () => {
  if (!state.geojson) return;
  const blob = new Blob([JSON.stringify(state.geojson, null, 2)], { type: 'application/geo+json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.dev.name.replace(/\s+/g, '-').toLowerCase()}.geojson`;
  a.click();
  URL.revokeObjectURL(a.href);
});

el('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    loadDevelopment(JSON.parse(await file.text()));
  } catch (err) {
    alert(`Could not load development file: ${err.message}`);
  }
  e.target.value = '';
});

// --- Boot with the bundled example ---
fetch('./data/example-development.json')
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then(loadDevelopment)
  .catch((err) => {
    el('warnings').innerHTML =
      `<div>⚠ Could not load the example (${err.message}). ` +
      'Serve this folder over HTTP (e.g. <code>python3 -m http.server</code>) ' +
      'or load a development JSON with the button above.</div>';
    el('warnings').classList.remove('hidden');
  });

export { formatLength }; // re-export for console experimentation
