// In-app editor: structures, materials (with photo upload), and site
// settings. Mutates the RAW development object (file units) directly and
// notifies the app via onChange, which re-normalizes and re-renders.

import { MATERIAL_CATEGORIES } from './schema.js';

const STRUCTURE_TYPES = [
  'residential', 'office', 'retail', 'mixed-use', 'civic',
  'industrial', 'parking', 'hotel', 'default',
];

// --- tiny DOM helpers -------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

/**
 * Read an image file as a data URL, downscaled so the longest edge is at
 * most maxDim px (keeps embedded photos from bloating the JSON).
 */
async function readImageScaled(file, maxDim = 1024) {
  const url = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('could not read file'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('not a valid image'));
    i.src = url;
  });
  if (Math.max(img.width, img.height) <= maxDim && file.size < 400_000) return url;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function uniqueId(base, taken) {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// ----------------------------------------------------------------------------

export class Editor {
  constructor(root, { onChange, onSelectStructure, onReset }) {
    this.root = root;
    this.onChange = onChange;
    this.onSelectStructure = onSelectStructure;
    this.onReset = onReset;
    this.raw = null;
    this.tab = 'structures';
    this.selectedStructure = null; // index into raw.structures
    this.selectedMaterial = null;  // index into raw.materials
  }

  refresh(raw) {
    this.raw = raw;
    if (this.selectedStructure >= (raw.structures?.length ?? 0)) this.selectedStructure = null;
    if (this.selectedMaterial >= (raw.materials?.length ?? 0)) this.selectedMaterial = null;
    this.render();
  }

  /** Sync selection from a 3D-view click. */
  selectStructureById(id) {
    const idx = (this.raw?.structures ?? []).findIndex((s) => s.id === id);
    if (idx >= 0) {
      this.selectedStructure = idx;
      this.tab = 'structures';
      this.render();
    }
  }

  _changed() {
    this.onChange?.();
  }

  render() {
    const { root } = this;
    root.innerHTML = '';
    if (!this.raw) return;

    root.append(h('div', { class: 'ed-tabs' },
      ...[['structures', 'Structures'], ['materials', 'Materials'], ['site', 'Site']].map(([id, label]) =>
        h('button', {
          class: `ed-tab ${this.tab === id ? 'active' : ''}`,
          onclick: () => { this.tab = id; this.render(); },
        }, label)),
    ));

    const body = h('div', { class: 'ed-body' });
    root.append(body);
    if (this.tab === 'structures') this._renderStructures(body);
    else if (this.tab === 'materials') this._renderMaterials(body);
    else this._renderSite(body);
  }

  // --- field builders --------------------------------------------------------

  _numField(label, obj, key, { step = 'any', placeholder = '', after = null } = {}) {
    return h('label', { class: 'ed-field' }, label,
      h('input', {
        type: 'number', step, placeholder,
        value: obj[key] ?? '',
        onchange: (e) => {
          const v = e.target.value;
          if (v === '') delete obj[key];
          else obj[key] = Number(v);
          after?.();
          this._changed();
        },
      }));
  }

  _textField(label, obj, key, { after = null } = {}) {
    return h('label', { class: 'ed-field' }, label,
      h('input', {
        type: 'text',
        value: obj[key] ?? '',
        onchange: (e) => { obj[key] = e.target.value; after?.(); this._changed(); },
      }));
  }

  _selectField(label, obj, key, options, { allowNone = false, after = null } = {}) {
    const sel = h('select', {
      onchange: (e) => {
        if (e.target.value === '') delete obj[key];
        else obj[key] = e.target.value;
        after?.();
        this._changed();
      },
    },
    allowNone ? h('option', { value: '' }, '— none —') : null,
    ...options.map(([v, text]) =>
      h('option', { value: v, ...(obj[key] === v ? { selected: '' } : {}) }, text)));
    return h('label', { class: 'ed-field' }, label, sel);
  }

  _colorField(label, obj, key, fallback) {
    return h('label', { class: 'ed-field' }, label,
      h('input', {
        type: 'color',
        value: obj[key] ?? fallback,
        onchange: (e) => { obj[key] = e.target.value; this._changed(); },
      }));
  }

  _photoGallery(list, { onAdd, onRemove, addLabel = '+ Add photos' }) {
    const gallery = h('div', { class: 'ed-gallery' },
      ...list.map((url, i) =>
        h('div', { class: 'ed-thumb' },
          h('img', { src: url, onclick: () => window.open(url, '_blank') }),
          h('button', { class: 'ed-thumb-x', title: 'Remove photo', onclick: () => onRemove(i) }, '×'))),
      h('label', { class: 'ed-add-photo' }, addLabel,
        h('input', {
          type: 'file', accept: 'image/*', multiple: '',
          onchange: async (e) => {
            for (const file of e.target.files) {
              try { onAdd(await readImageScaled(file)); }
              catch (err) { alert(`Skipped ${file.name}: ${err.message}`); }
            }
            this.render();
            this._changed();
          },
        })));
    return gallery;
  }

  _materialOptions() {
    return (this.raw.materials ?? []).map((m) => [m.id, m.name ?? m.id]);
  }

  // --- structures tab ---------------------------------------------------------

  _renderStructures(body) {
    const raw = this.raw;
    raw.structures ??= [];
    const units = raw.units;

    body.append(h('div', { class: 'ed-list' },
      ...raw.structures.map((s, i) =>
        h('button', {
          class: `ed-item ${this.selectedStructure === i ? 'active' : ''}`,
          onclick: () => {
            this.selectedStructure = i;
            this.render();
            this.onSelectStructure?.(s.id ?? null);
          },
        }, s.name ?? s.id ?? `Structure ${i + 1}`)),
      h('button', {
        class: 'ed-item ed-add',
        onclick: () => {
          const taken = new Set(raw.structures.map((s) => s.id));
          const id = uniqueId('structure', taken);
          raw.structures.push({
            id,
            name: 'New structure',
            type: 'default',
            rect: { center: [0, 0], width: units === 'ft' ? 100 : 30, depth: units === 'ft' ? 60 : 18, rotation: 0 },
            floors: 2,
          });
          this.selectedStructure = raw.structures.length - 1;
          this.render();
          this._changed();
        },
      }, '+ Add structure')));

    if (this.selectedStructure === null) {
      body.append(h('p', { class: 'ed-hint' }, 'Select a structure to edit it, or click one in the 3D view.'));
      return;
    }

    const s = raw.structures[this.selectedStructure];
    const form = h('div', { class: 'ed-form' });
    body.append(form);

    form.append(
      h('h3', {}, 'Identity'),
      this._textField('Name', s, 'name', { after: () => this.render() }),
      this._selectField('Type', s, 'type', STRUCTURE_TYPES.map((t) => [t, t])),
      this._colorField('Color (no-material fallback)', s, 'color', '#a9b2bc'),
      h('h3', {}, `Dimensions (${units})`),
      this._numField('Height to roof', s, 'height', { placeholder: 'or use floors' }),
      this._numField('Floors', s, 'floors'),
      this._numField(`Floor-to-floor height (${units})`, s, 'floorHeight',
        { placeholder: units === 'ft' ? 'default 10.5' : 'default 3.2' }),
    );

    form.append(h('h3', {}, `Footprint (${units})`));
    if (s.rect) {
      s.rect.center ??= [0, 0];
      const c = s.rect.center;
      const coord = (label, idx) => h('label', { class: 'ed-field' }, label,
        h('input', {
          type: 'number', step: 'any', value: c[idx],
          onchange: (e) => { c[idx] = Number(e.target.value) || 0; this._changed(); },
        }));
      form.append(
        coord('Center X (east)', 0), coord('Center Y (north)', 1),
        this._numField('Width', s.rect, 'width'),
        this._numField('Depth', s.rect, 'depth'),
        this._numField('Rotation (° CCW)', s.rect, 'rotation'),
      );
    } else {
      const ta = h('textarea', {
        rows: 6, spellcheck: 'false',
        onchange: (e) => {
          const pts = e.target.value.split('\n').map((line) => line.split(',').map(Number))
            .filter((p) => p.length === 2 && p.every(Number.isFinite));
          if (pts.length >= 3) { s.footprint = pts; this._changed(); }
          else alert('Footprint needs at least 3 lines of "x, y".');
        },
      });
      ta.value = (s.footprint ?? []).map(([x, y]) => `${x}, ${y}`).join('\n');
      form.append(h('label', { class: 'ed-field ed-field-wide' }, 'Polygon — one "x, y" per line', ta));
    }

    form.append(
      h('h3', {}, 'Materials'),
      (this.raw.materials ?? []).length
        ? h('div', {},
            this._matSlot(s, 'facade'),
            this._matSlot(s, 'roof'))
        : h('p', { class: 'ed-hint' }, 'No materials defined yet — add them in the Materials tab.'),
    );

    form.append(h('h3', {}, 'Photos'));
    s.photos ??= [];
    form.append(this._photoGallery(s.photos, {
      onAdd: (url) => s.photos.push(url),
      onRemove: (i) => { s.photos.splice(i, 1); this.render(); this._changed(); },
    }));

    form.append(h('h3', {}, 'Components / bill of materials'));
    s.components ??= [];
    const compBox = h('div', { class: 'ed-components' });
    s.components.forEach((comp, i) => {
      compBox.append(h('div', { class: 'ed-component' },
        this._textField('Name', comp, 'name'),
        this._selectField('Material', comp, 'material', this._materialOptions(), { allowNone: true }),
        h('div', { class: 'ed-row' },
          this._numField(`W (${units})`, comp, 'width'),
          this._numField(`H (${units})`, comp, 'height'),
          this._numField('Count', comp, 'count', { step: '1' })),
        this._textField('Notes', comp, 'notes'),
        h('button', {
          class: 'ed-danger ed-small',
          onclick: () => { s.components.splice(i, 1); this.render(); this._changed(); },
        }, 'Remove component')));
    });
    compBox.append(h('button', {
      class: 'ed-secondary',
      onclick: () => {
        s.components.push({ name: 'New component', count: 1 });
        this.render();
        this._changed();
      },
    }, '+ Add component'));
    form.append(compBox);

    form.append(h('button', {
      class: 'ed-danger',
      onclick: () => {
        if (!confirm(`Delete "${s.name ?? s.id}"?`)) return;
        raw.structures.splice(this.selectedStructure, 1);
        this.selectedStructure = null;
        this.render();
        this._changed();
      },
    }, 'Delete structure'));
  }

  _matSlot(s, slot) {
    s.materials ??= {};
    return this._selectField(slot === 'facade' ? 'Facade material' : 'Roof material',
      s.materials, slot, this._materialOptions(), { allowNone: true });
  }

  // --- materials tab -----------------------------------------------------------

  _renderMaterials(body) {
    const raw = this.raw;
    raw.materials ??= [];
    const units = raw.units;

    body.append(h('div', { class: 'ed-list' },
      ...raw.materials.map((m, i) =>
        h('button', {
          class: `ed-item ${this.selectedMaterial === i ? 'active' : ''}`,
          onclick: () => { this.selectedMaterial = i; this.render(); },
        },
        h('span', { class: 'ed-swatch', style: `background:${m.color ?? '#9aa2ab'}` }),
        m.name ?? m.id)),
      h('button', {
        class: 'ed-item ed-add',
        onclick: () => {
          const name = prompt('Material name (e.g. "Modular red brick"):');
          if (!name) return;
          const taken = new Set(raw.materials.map((m) => m.id));
          raw.materials.push({ id: uniqueId(slugify(name), taken), name, category: 'other', color: '#9aa2ab' });
          this.selectedMaterial = raw.materials.length - 1;
          this.render();
          this._changed();
        },
      }, '+ Add material')));

    if (this.selectedMaterial === null) {
      body.append(h('p', { class: 'ed-hint' },
        'Materials carry the real detail: category, unit dimensions, supplier, notes, reference photos, ',
        'and a texture photo with its real-world coverage so it tiles at true scale on the model.'));
      return;
    }

    const m = raw.materials[this.selectedMaterial];
    const form = h('div', { class: 'ed-form' });
    body.append(form);

    form.append(
      h('p', { class: 'ed-hint' }, `id: ${m.id}`),
      this._textField('Name', m, 'name', { after: () => this.render() }),
      this._selectField('Category', m, 'category', MATERIAL_CATEGORIES.map((c) => [c, c])),
      this._colorField('Color (used when no texture photo)', m, 'color', '#9aa2ab'),
      this._textField('Supplier / product', m, 'supplier'),
      this._textField('Notes', m, 'notes'),
    );

    form.append(
      h('h3', {}, `Unit dimensions (${units}) — one brick, panel, board…`),
      h('div', { class: 'ed-row' },
        this._numField('Unit length', (m.unit ??= {}), 'length'),
        this._numField('Unit height', m.unit, 'height')),
    );

    form.append(h('h3', {}, 'Texture photo (tiles on the 3D model)'));
    if (m.texture?.dataUrl) {
      form.append(
        h('div', { class: 'ed-thumb ed-thumb-lg' },
          h('img', { src: m.texture.dataUrl, onclick: () => window.open(m.texture.dataUrl, '_blank') })),
        h('p', { class: 'ed-hint' }, 'Real-world area this photo covers — it repeats at this exact size on the model:'),
        h('div', { class: 'ed-row' },
          this._numField(`Coverage width (${units})`, m.texture, 'coverageWidth'),
          this._numField(`Coverage height (${units})`, m.texture, 'coverageHeight')),
        h('button', {
          class: 'ed-danger ed-small',
          onclick: () => { delete m.texture; this.render(); this._changed(); },
        }, 'Remove texture'),
      );
    } else {
      form.append(h('label', { class: 'ed-add-photo' }, '+ Upload texture photo',
        h('input', {
          type: 'file', accept: 'image/*',
          onchange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
              const dataUrl = await readImageScaled(file, 1024);
              m.texture = {
                dataUrl,
                coverageWidth: units === 'ft' ? 4 : 1.2,
                coverageHeight: units === 'ft' ? 4 : 1.2,
              };
              this.render();
              this._changed();
            } catch (err) { alert(err.message); }
          },
        })));
    }

    form.append(h('h3', {}, 'Reference photos'));
    m.photos ??= [];
    form.append(this._photoGallery(m.photos, {
      onAdd: (url) => m.photos.push(url),
      onRemove: (i) => { m.photos.splice(i, 1); this.render(); this._changed(); },
    }));

    form.append(h('button', {
      class: 'ed-danger',
      onclick: () => {
        const refs = (raw.structures ?? []).filter((s) =>
          s.materials?.facade === m.id || s.materials?.roof === m.id ||
          (s.components ?? []).some((c) => c.material === m.id));
        const msg = refs.length
          ? `"${m.name}" is used by ${refs.length} structure(s); those references will be cleared. Delete?`
          : `Delete "${m.name}"?`;
        if (!confirm(msg)) return;
        for (const s of raw.structures ?? []) {
          if (s.materials?.facade === m.id) delete s.materials.facade;
          if (s.materials?.roof === m.id) delete s.materials.roof;
          for (const c of s.components ?? []) if (c.material === m.id) delete c.material;
        }
        raw.materials.splice(this.selectedMaterial, 1);
        this.selectedMaterial = null;
        this.render();
        this._changed();
      },
    }, 'Delete material'));
  }

  // --- site tab -----------------------------------------------------------------

  _renderSite(body) {
    const raw = this.raw;
    const form = h('div', { class: 'ed-form' });
    body.append(form);
    form.append(
      this._textField('Development name', raw, 'name'),
      h('p', { class: 'ed-hint' }, `Units: ${raw.units} (set in the file; all dimensions use these)`),
      h('h3', {}, 'Map anchor (georeference)'),
      this._numField('Latitude', (raw.anchor ??= {}), 'lat', { step: '0.000001' }),
      this._numField('Longitude', raw.anchor, 'lon', { step: '0.000001' }),
      this._numField('Bearing (° clockwise from north)', raw.anchor, 'bearing'),
      h('h3', {}, 'Data'),
      h('button', { class: 'ed-secondary', onclick: () => this.onReset?.() },
        'Discard changes & reload example'),
    );
  }
}
