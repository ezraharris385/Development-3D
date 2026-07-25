// True-to-scale 3D viewer. Scene units are meters: 1 Three.js unit = 1 real
// meter, so a 66 ft building is exactly 20.12 units tall. Local site coords
// (x east, y north) map to Three.js as (x, height, -y).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { devBounds, polygonCentroid, polygonArea } from './schema.js';
import { bufferPolyline } from './geo.js';
import { formatLength, formatArea } from './units.js';

const SURFACE_COLORS = {
  ground: 0x39413a,
  road: 0x4a4d52,
  path: 0x8c8578,
  greenspace: 0x4d7a4f,
  water: 0x3d6b8e,
  parking: 0x5b5e63,
};

// Flat layers get tiny height offsets to avoid z-fighting.
const LAYER_Z = { greenspace: 0.02, water: 0.015, parking: 0.03, road: 0.05, path: 0.06 };

function shapeFromPoints(points) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  return shape;
}

/** Rotate an XY-plane geometry onto the ground: (x, y, z) -> (x, z, -y). */
function toGround(geometry) {
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 28px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  const h = 44;
  canvas.width = w * 2;
  canvas.height = h * 2;
  ctx.scale(2, 2);
  ctx.font = font;
  ctx.fillStyle = 'rgba(15, 18, 22, 0.75)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 8);
  ctx.fill();
  ctx.fillStyle = '#f2f5f7';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, h / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  const worldH = 6; // meters tall at scale; sprites keep screen-facing
  sprite.scale.set((w / h) * worldH, worldH, 1);
  return sprite;
}

/** Simple human figure, 1.75 m tall, for life-size reference. */
function makeHuman() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xd9822b });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.85, 4, 12), mat);
  body.position.y = 0.78;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), mat);
  head.position.y = 1.62;
  g.add(body, head);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

/** Reference car, 4.5 m x 1.8 m x 1.45 m. */
function makeCar() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xb0483a });
  const lower = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.65, 1.8), mat);
  lower.position.y = 0.55;
  const upper = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.6, 1.6), mat);
  upper.position.set(-0.2, 1.15, 0);
  g.add(lower, upper);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

export class Viewer3D {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.dev = null;
    this.pickables = [];
    this.measurePoints = [];
    this.measureMode = false;
    this.selectedId = null;
    this._textureCache = new Map(); // dataUrl -> THREE.Texture

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1319);
    this.scene.fog = new THREE.Fog(0x0e1319, 900, 2600);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x2a2f2a, 0.9);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);

    this.measureLabel = document.createElement('div');
    this.measureLabel.className = 'measure-label hidden';
    container.appendChild(this.measureLabel);

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this._downAt = [e.clientX, e.clientY];
    });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (!this._downAt) return;
      const moved = Math.hypot(e.clientX - this._downAt[0], e.clientY - this._downAt[1]);
      this._downAt = null;
      if (moved < 5) this._handleClick(e);
    });

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._updateMeasureLabel();
    });
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setMeasureMode(on) {
    this.measureMode = on;
    if (!on) this.clearMeasurement();
    this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
  }

  clearMeasurement() {
    this.measurePoints = [];
    this.measureGroup.clear();
    this.measureLabel.classList.add('hidden');
  }

  /**
   * Get a repeating texture for a material photo, tiled at true scale:
   * the photo covers coverageWM x coverageHM real meters, so repeat is
   * 1/coverage per meter of surface (UVs are generated in meters).
   */
  _materialTexture(tex) {
    let texture = this._textureCache.get(tex.dataUrl);
    if (!texture) {
      texture = new THREE.TextureLoader().load(tex.dataUrl);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      this._textureCache.set(tex.dataUrl, texture);
    }
    const t = texture.clone();
    t.needsUpdate = true;
    t.repeat.set(1 / tex.coverageWM, 1 / tex.coverageHM);
    return t;
  }

  /** Build the THREE material for one surface of a structure. */
  _surfaceMaterial(dev, materialId, fallbackColor) {
    const def = materialId ? dev.materials[materialId] : null;
    const params = { roughness: 0.85, metalness: 0.05 };
    if (def?.texture) {
      params.map = this._materialTexture(def.texture);
      params.color = 0xffffff;
    } else {
      params.color = new THREE.Color(def?.color ?? fallbackColor);
    }
    if (def?.category === 'glass') {
      params.roughness = 0.25;
      params.metalness = 0.4;
    } else if (def?.category === 'metal') {
      params.roughness = 0.45;
      params.metalness = 0.6;
    }
    return new THREE.MeshStandardMaterial(params);
  }

  setDevelopment(dev, displayUnits, { preserveCamera = false } = {}) {
    this.dev = dev;
    this.displayUnits = displayUnits;
    this.pickables = [];
    this.clearMeasurement();
    this.modelGroup.clear();

    const [minX, minY, maxX, maxY] = devBounds(dev);
    const spanX = Math.max(maxX - minX, 50);
    const spanY = Math.max(maxY - minY, 50);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const radius = Math.max(spanX, spanY);

    // Ground + 10 m grid (each cell is exactly 10 real meters).
    const pad = radius * 1.5 + 100;
    const ground = new THREE.Mesh(
      toGround(new THREE.PlaneGeometry(spanX + pad * 2, spanY + pad * 2).translate(cx, cy, 0)),
      new THREE.MeshStandardMaterial({ color: SURFACE_COLORS.ground, roughness: 1 }),
    );
    ground.receiveShadow = true;
    this.modelGroup.add(ground);

    const gridSize = Math.ceil((radius + 100) / 100) * 200;
    const grid = new THREE.GridHelper(gridSize, gridSize / 10, 0x4a5560, 0x2a3138);
    grid.position.set(cx, 0.01, -cy);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.modelGroup.add(grid);

    // Flat area layers.
    const addFlat = (points, kind) => {
      const geo = toGround(new THREE.ShapeGeometry(shapeFromPoints(points)));
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: SURFACE_COLORS[kind], roughness: 1, side: THREE.DoubleSide,
      }));
      mesh.position.y = LAYER_Z[kind];
      mesh.receiveShadow = true;
      this.modelGroup.add(mesh);
    };
    dev.greenspace.forEach((g) => addFlat(g.polygon, 'greenspace'));
    dev.water.forEach((w) => addFlat(w.polygon, 'water'));
    dev.parking.forEach((p) => addFlat(p.polygon, 'parking'));
    dev.roads.forEach((r) => addFlat(bufferPolyline(r.path, r.widthM), 'road'));
    dev.paths.forEach((p) => addFlat(bufferPolyline(p.path, p.widthM), 'path'));

    // Site boundary outline.
    if (dev.site) {
      const pts = dev.site.boundary.map(([x, y]) => new THREE.Vector3(x, 0.1, -y));
      pts.push(pts[0].clone());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xe8c468 }),
      );
      this.modelGroup.add(line);
    }

    // Structures: extruded exactly to their real height. ExtrudeGeometry
    // puts the caps in material group 0 (roof after rotation) and the side
    // walls in group 1 (facade); UVs are in shape/depth units = meters, so
    // material photos tile at their true physical coverage.
    for (const s of dev.structures) {
      const geo = toGround(new THREE.ExtrudeGeometry(shapeFromPoints(s.footprint), {
        depth: s.heightM, bevelEnabled: false,
      }));
      const roofFallback = new THREE.Color(s.color).multiplyScalar(0.55).getStyle();
      const roofMat = this._surfaceMaterial(dev, s.materials.roof, roofFallback);
      const wallMat = this._surfaceMaterial(dev, s.materials.facade, s.color);
      const mesh = new THREE.Mesh(geo, [roofMat, wallMat]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.structure = s;
      this.modelGroup.add(mesh);
      this.pickables.push(mesh);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 30),
        new THREE.LineBasicMaterial({ color: 0x11151a, transparent: true, opacity: 0.4 }),
      );
      this.modelGroup.add(edges);

      const [lx, ly] = polygonCentroid(s.footprint);
      const label = makeTextSprite(s.name);
      label.position.set(lx, s.heightM + 6, -ly);
      this.modelGroup.add(label);
    }

    // Life-size scale references near the site's south-west corner.
    const human = makeHuman();
    human.position.set(minX - 8, 0, -(minY - 8));
    const car = makeCar();
    car.position.set(minX - 16, 0, -(minY - 8));
    this.modelGroup.add(human, car);

    // Sun + camera framing.
    this.sun.position.set(cx + radius, radius * 1.2 + 80, -cy + radius * 0.6);
    this.sun.target.position.set(cx, 0, -cy);
    this.scene.add(this.sun.target);
    const d = radius * 0.9 + 60;
    Object.assign(this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, far: radius * 4 + 500 });
    this.sun.shadow.camera.updateProjectionMatrix();

    if (!preserveCamera) {
      this.controls.target.set(cx, 0, -cy);
      this.camera.position.set(cx + radius * 0.75, radius * 0.65 + 40, -cy + radius * 0.9);
      this.camera.lookAt(cx, 0, -cy);
    }
    this.setSelected(this.selectedId);
  }

  /** Highlight the structure with the given id (null clears). */
  setSelected(id) {
    this.selectedId = id;
    for (const mesh of this.pickables) {
      const on = mesh.userData.structure.id === id;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => m.emissive?.setHex(on ? 0x2a4a6a : 0x000000));
    }
  }

  _pointerRay(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  _handleClick(event) {
    this._pointerRay(event);

    if (this.measureMode) {
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) this._addMeasurePoint(hit);
      return;
    }

    const hits = this.raycaster.intersectObjects(this.pickables, false);
    this.onSelect?.(hits.length ? hits[0].object.userData.structure : null);
  }

  _addMeasurePoint(point) {
    if (this.measurePoints.length >= 2) this.clearMeasurement();
    this.measurePoints.push(point.clone());
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xe8c468 }),
    );
    marker.position.copy(point);
    this.measureGroup.add(marker);

    if (this.measurePoints.length === 2) {
      const [a, b] = this.measurePoints;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0xe8c468 }),
      );
      this.measureGroup.add(line);
      this.measureDistanceM = a.distanceTo(b);
      this.measureLabel.classList.remove('hidden');
    }
  }

  _updateMeasureLabel() {
    if (this.measurePoints.length !== 2) return;
    const mid = this.measurePoints[0].clone().add(this.measurePoints[1]).multiplyScalar(0.5);
    mid.y += 1.5;
    const projected = mid.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.measureLabel.style.left = `${((projected.x + 1) / 2) * rect.width}px`;
    this.measureLabel.style.top = `${((1 - projected.y) / 2) * rect.height}px`;
    this.measureLabel.textContent = formatLength(this.measureDistanceM, this.displayUnits);
  }
}

/** Human-readable structure stats for the info panel. */
export function structureStats(s, units) {
  const area = polygonArea(s.footprint);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of s.footprint) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    height: formatLength(s.heightM, units),
    footprintArea: formatArea(area, units),
    grossFloorArea: formatArea(area * s.floors, units),
    envelope: `${formatLength(maxX - minX, units)} × ${formatLength(maxY - minY, units)}`,
    floors: s.floors,
  };
}
