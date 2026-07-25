import { normalize } from './schema.js';
import { toGeoJSON } from './geo.js';
import { Viewer3D, structureStats } from './viewer3d.js';
import { MapView } from './mapview.js';
import { Editor } from './editor.js';
import { formatLength } from './units.js';

const el = (id) => document.getElementById(id);
const AUTOSAVE_KEY = 'dev3d:autosave';

const state = {
  raw: null,       // source-of-truth development JSON (file units, edited in place)
  dev: null,       // normalized (meters)
  geojson: null,
  displayUnits: 'ft',
  selectedId: null,
};

const infoPanel = el('info-panel');

const viewer = new Viewer3D(el('view3d'), {
  onSelect: (structure) => {
    state.selectedId = structure?.id ?? null;
    viewer.setSelected(state.selectedId);
    renderInfoPanel();
    if (structure && !el('editor').classList.contains('hidden')) {
      editor.selectStructureById(structure.id);
    }
  },
});
const mapView = new MapView(el('viewmap'));

const editor = new Editor(el('editor-content'), {
  onChange: () => scheduleRebuild(),
  onSelectStructure: (id) => {
    state.selectedId = id;
    viewer.setSelected(id);
    renderInfoPanel();
  },
  onReset: () => {
    if (!confirm('Discard all local changes and reload the bundled example?')) return;
    localStorage.removeItem(AUTOSAVE_KEY);
    loadExample();
  },
});

// --- rendering ---------------------------------------------------------------

function materialChip(dev, id) {
  const m = id ? dev.materials[id] : null;
  if (!m) return '<span class="muted">—</span>';
  const swatch = m.texture
    ? `<img class="chip-thumb" src="${m.texture.dataUrl}" alt="">`
    : `<span class="chip-swatch" style="background:${m.color}"></span>`;
  return `${swatch}${m.name}`;
}

function renderInfoPanel() {
  const dev = state.dev;
  const structure = dev?.structures.find((s) => s.id === state.selectedId);
  if (!structure) {
    infoPanel.classList.add('hidden');
    return;
  }
  const s = structureStats(structure, state.displayUnits);
  const u = state.displayUnits;

  const componentRows = structure.components.map((c) => {
    const dims = [c.widthM, c.heightM].every((v) => v === null)
      ? ''
      : ` · ${c.widthM !== null ? formatLength(c.widthM, u) : '?'} × ${c.heightM !== null ? formatLength(c.heightM, u) : '?'}`;
    const mat = c.material ? ` · ${dev.materials[c.material]?.name ?? c.material}` : '';
    const notes = c.notes ? `<div class="muted comp-notes">${c.notes}</div>` : '';
    return `<li><strong>${c.count}×</strong> ${c.name}${dims}${mat}${notes}</li>`;
  }).join('');

  const photos = structure.photos.map((p) =>
    `<img class="info-photo" src="${p}" onclick="window.open(this.src,'_blank')" alt="photo">`).join('');

  infoPanel.innerHTML = `
    <h3>${structure.name}</h3>
    <dl>
      <dt>Type</dt><dd>${structure.type}</dd>
      <dt>Height</dt><dd>${s.height}</dd>
      <dt>Floors</dt><dd>${s.floors}</dd>
      <dt>Envelope</dt><dd>${s.envelope}</dd>
      <dt>Footprint</dt><dd>${s.footprintArea}</dd>
      <dt>Gross floor area</dt><dd>${s.grossFloorArea}</dd>
      <dt>Facade</dt><dd class="chip">${materialChip(dev, structure.materials.facade)}</dd>
      <dt>Roof</dt><dd class="chip">${materialChip(dev, structure.materials.roof)}</dd>
    </dl>
    ${componentRows ? `<h4>Components</h4><ul class="comp-list">${componentRows}</ul>` : ''}
    ${photos ? `<h4>Photos</h4><div class="info-photos">${photos}</div>` : ''}`;
  infoPanel.classList.remove('hidden');
}

function rebuild({ preserveCamera = true } = {}) {
  let result;
  try {
    result = normalize(state.raw);
  } catch (err) {
    showWarnings([`Invalid development: ${err.message}`]);
    return;
  }
  state.dev = result.dev;
  state.geojson = toGeoJSON(result.dev);

  el('dev-name').textContent = result.dev.name;
  el('btn-geojson').disabled = !state.geojson;
  showWarnings(result.warnings);

  viewer.setDevelopment(result.dev, state.displayUnits, { preserveCamera });
  if (state.geojson) mapView.setData(state.geojson, result.dev.anchor);
  el('map-notice').classList.toggle('hidden', !!state.geojson);
  renderInfoPanel();
  autosave();
}

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(), 250);
}

function showWarnings(warnings) {
  const warnBox = el('warnings');
  warnBox.innerHTML = warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  warnBox.classList.toggle('hidden', warnings.length === 0);
}

let autosaveFailed = false;
function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state.raw));
    autosaveFailed = false;
  } catch {
    if (!autosaveFailed) {
      autosaveFailed = true;
      showWarnings(['Autosave is off: the development (with embedded photos) exceeds browser storage. Use "Save JSON" to keep your work.']);
    }
  }
}

function loadDevelopment(raw, { preserveCamera = false } = {}) {
  state.raw = raw;
  state.displayUnits = raw.units === 'm' ? 'm' : 'ft';
  state.selectedId = null;
  el('unit-toggle').textContent = `Units: ${state.displayUnits}`;
  editor.refresh(raw);
  rebuild({ preserveCamera });
}

// --- tabs ----------------------------------------------------------------------

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    el('view3d').classList.toggle('hidden', tab !== 'view3d');
    el('viewmap-wrap').classList.toggle('hidden', tab !== 'viewmap');
    if (tab === 'viewmap') mapView.resize();
    else viewer.resize();
  });
}

// --- toolbar ----------------------------------------------------------------------

el('unit-toggle').addEventListener('click', () => {
  state.displayUnits = state.displayUnits === 'ft' ? 'm' : 'ft';
  el('unit-toggle').textContent = `Units: ${state.displayUnits}`;
  viewer.displayUnits = state.displayUnits;
  renderInfoPanel();
});

el('btn-measure').addEventListener('click', () => {
  const on = el('btn-measure').classList.toggle('active');
  viewer.setMeasureMode(on);
});

el('btn-editor').addEventListener('click', () => {
  const editorBox = el('editor');
  const showing = editorBox.classList.toggle('hidden');
  el('btn-editor').classList.toggle('active', !showing);
  viewer.resize();
});

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

el('btn-save').addEventListener('click', () => {
  if (!state.raw) return;
  const base = (state.raw.name ?? 'development').replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  download(`${base}.json`, JSON.stringify(state.raw, null, 2), 'application/json');
});

el('btn-geojson').addEventListener('click', () => {
  if (!state.geojson) return;
  const base = (state.raw.name ?? 'development').replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  download(`${base}.geojson`, JSON.stringify(state.geojson, null, 2), 'application/geo+json');
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

// --- boot ------------------------------------------------------------------------

function loadExample() {
  return fetch('./data/example-development.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((raw) => loadDevelopment(raw))
    .catch((err) => {
      showWarnings([
        `Could not load the example (${err.message}). Serve this folder over HTTP ` +
        '(e.g. python3 -m http.server) or load a development JSON with the button above.',
      ]);
    });
}

const saved = localStorage.getItem(AUTOSAVE_KEY);
if (saved) {
  try {
    loadDevelopment(JSON.parse(saved));
    showWarnings(['Restored your autosaved work. To start over, open the Editor → Site tab → "Discard changes & reload example".']);
  } catch {
    loadExample();
  }
} else {
  loadExample();
}

// Expose for debugging / console experimentation.
window.devApp = { state, viewer, mapView, editor, formatLength };
