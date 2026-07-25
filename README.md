# Development 3D

A system for rendering the physical portions of a large development **at true 1:1 scale**
from actual dimensions, and placing the resulting model on a real map.

You describe the development — buildings, roads, paths, green space, water,
parking — in a JSON file using real-world measurements (feet or meters). The
app then gives you:

- **3D Model view** — an interactive, life-size-accurate 3D scene where
  1 scene unit = 1 real meter. A 66 ft building is exactly 20.12 m tall in the
  scene. Includes a 10 m ground grid, a 1.75 m human figure and a 4.5 m car
  for scale reference, click-to-inspect dimensions on every structure, and a
  point-to-point measuring tool.
- **On the Map view** — the same model georeferenced onto OpenStreetMap via
  its anchor coordinates, with buildings rendered as 3D extrusions at their
  real heights and every footprint at true geographic size. Hover or click a
  building for its name and dimensions.
- **Material-level detail** — a materials library where every material carries
  its category, unit dimensions (one brick, one panel…), supplier, notes,
  reference photos, and a texture photo with its real-world coverage. Texture
  photos tile onto facades and roofs at their exact physical size: a photo of
  4 ft of brick repeats every 4 ft on the model.
- **Built-in editor with photo upload** — add and edit structures, dimensions,
  materials, and per-building component lists (windows, doors — with sizes and
  counts) directly in the app. Upload photos for materials and buildings;
  images are downscaled and embedded in the JSON so the file stays portable.
  Work autosaves to the browser and round-trips through **Save JSON**.
- **GeoJSON export** — one click produces a standard GeoJSON file you can drop
  into Google Earth, QGIS, ArcGIS, Mapbox, geojson.io, or any other mapping tool.

## Running it

It's a static site — no build step. Serve the folder over HTTP and open it:

```bash
cd Development-3D
python3 -m http.server 8000
# then open http://localhost:8000
```

(Any static server works. Opening `index.html` directly via `file://` won't
load the bundled example because browsers block local `fetch`; the **Load
JSON** button still works.)

Three.js and MapLibre GL are vendored in `vendor/`, so the app is fully
self-contained — only the map basemap streams from OpenStreetMap and needs an
internet connection. The 3D model view works entirely offline.

## Defining a development

The bundled example is in [`data/example-development.json`](data/example-development.json).
Load your own file with the **Load JSON** button.

### Coordinate system

All positions are on a flat local site grid, in the file's `units`:

- `+x` is site-east, `+y` is site-north, `[0, 0]` is the anchor point.
- `anchor.bearing` rotates the whole grid: it's the compass bearing (degrees
  clockwise from true north) that the local `+y` axis points. Use it to align
  the site with a street grid that isn't north-south.

### Schema

```jsonc
{
  "name": "Lakeshore Commons",
  "units": "ft",                      // "ft" or "m" — applies to every number below
  "anchor": {                          // georeference; omit for 3D-only models
    "lat": 43.0668, "lon": -89.4001,
    "bearing": 12                      // degrees clockwise from north
  },
  "site": { "boundary": [[x, y], ...] },   // optional property line

  "materials": [
    {
      "id": "brick-red-modular",
      "name": "Modular red brick",
      "category": "brick",               // brick | stone | concrete | siding | glass
                                         // | metal | wood | stucco | membrane
                                         // | shingle | asphalt | other
      "color": "#8f4438",                // used when there is no texture photo
      "unit": { "length": 0.667, "height": 0.188 },  // one unit's real size
      "texture": {
        "dataUrl": "data:image/jpeg;base64,...",     // photo of the material
        "coverageWidth": 4, "coverageHeight": 4      // real area the photo shows —
                                                     // it tiles at exactly this size
      },
      "photos": ["data:image/jpeg;base64,..."],      // extra reference photos
      "supplier": "Example Brick Co. — Heritage Red",
      "notes": "Modular 8 x 2-1/4 x 3-5/8 in, 3/8 in joints"
    }
  ],

  "structures": [
    {
      "id": "bldg-a",
      "name": "Building A",
      "type": "residential",           // residential | office | retail | mixed-use
                                       // | civic | industrial | parking | hotel
      "footprint": [[x, y], ...],      // polygon in plan, OR the rect shorthand:
      // "rect": { "center": [x, y], "width": 260, "depth": 110, "rotation": 15 },
      "height": 66,                    // to the roof; or derive it from floors:
      "floors": 6,
      "floorHeight": 10.5,             // optional, defaults ≈ 10.5 ft / 3.2 m
      "color": "#a7bed3",              // optional, defaults by type
      "materials": {                   // references into the materials library
        "facade": "brick-red-modular",
        "roof": "epdm-membrane"
      },
      "photos": ["data:image/jpeg;base64,..."],   // site / reference photos
      "components": [                  // bill-of-materials detail
        { "name": "Window type W1", "material": "curtain-wall-glass",
          "width": 5, "height": 6, "count": 96, "notes": "..." }
      ]
    }
  ],

  "roads":  [ { "name": "Main St", "path": [[x, y], ...], "width": 36 } ],
  "paths":  [ { "path": [[x, y], ...], "width": 10 } ],
  "greenspace": [ { "name": "Park", "polygon": [[x, y], ...] } ],
  "water":      [ { "polygon": [[x, y], ...] } ],
  "parking":    [ { "polygon": [[x, y], ...] } ]
}
```

Notes:

- Give a structure either `height` or `floors` (or both). With only `floors`,
  height = `floors × floorHeight`.
- Roads and paths are centerlines with a real `width`; the system buffers them
  into correctly sized surfaces for both the 3D scene and the map.
- Everything is converted to SI meters internally, so mixing display units is
  lossless.

## Using the editor

Click **✏️ Editor** in the toolbar. Changes render live in both views and
autosave to the browser (use **Save JSON** for a portable file — uploaded
photos are embedded in it).

- **Structures tab** — add/select a building; edit its name, type, floors,
  height, footprint (rectangle fields or polygon coordinates); assign facade
  and roof materials; upload building photos; and maintain a component list
  (windows, doors, panels — each with material, width × height, count, notes).
- **Materials tab** — the material library. Each material has a category,
  color, unit dimensions (the real size of one brick/panel/board), supplier,
  notes, and reference photos. Upload a **texture photo** and enter the real
  area it covers — the model tiles it at exactly that physical size, so
  material scale reads correctly against the buildings.
- **Site tab** — development name and the map anchor (lat/lon/bearing).

Uploaded images are downscaled to ≤1024 px before embedding. If a project
accumulates more photos than browser storage allows, autosave pauses with a
warning — **Save JSON** still captures everything.

## How the map placement works

`src/geo.js` builds a local tangent-plane projection at the anchor: local
meters are rotated by the bearing into east/north offsets, then converted to
degrees using the WGS84 meters-per-degree series at the anchor latitude. At
development scales (a few km) this is accurate to centimeters. The output is
plain GeoJSON, which is what both the built-in map view and the export use —
so what you see on the map is exactly what any external GIS tool will show.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | App shell, tabs, toolbar |
| `src/schema.js` | Development file validation, defaults, unit conversion to meters |
| `src/units.js` | ft/m conversion and display formatting |
| `src/geo.js` | Anchor projection, road buffering, GeoJSON generation |
| `src/viewer3d.js` | Three.js true-scale scene: extrusions, real-scale material textures, labels, scale figures, measuring |
| `src/mapview.js` | MapLibre GL map with OSM basemap, 3D building extrusions, popups |
| `src/editor.js` | In-app editor: structures, materials library, photo uploads, components |
| `src/main.js` | Wiring: tabs, editor, autosave, unit toggle, file load, JSON/GeoJSON download |
| `data/example-development.json` | Sample mixed-use development (~24 acres) with a 5-material library |
| `vendor/` | Vendored Three.js 0.160 and MapLibre GL 4.7.1 (no CDN needed) |
