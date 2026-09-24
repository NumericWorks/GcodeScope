// GcodeScope — Three.js toolpath viewer
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const COLORS = {
  bg: 0x16181b,
  grid: 0x2c3036, gridMain: 0x3a3f46,
  rapid: 0xff4d4f,
  travel: 0x5c6470,
  cnc: 0x4fc3f7,
  current: 0xff7a1a, cncCurrent: 0xffffff,
  tool: 0xff7a1a,
  lowZ: new THREE.Color(0x3d6f8e), highZ: new THREE.Color(0xd8e4ec),
};

// CNC move colors, indexed by the parser's K_* segment kind. Follows the convention CAM
// simulators share: red dashed rapids, blue feed, warm colors for moves into the material,
// green lead-in, magenta lead-out, grey feed retract.
export const KIND_COLORS = [
  0x4fc3f7, // K_CUT      feed / cutting (G1 G2 G3)
  0xff9f1a, // K_PLUNGE   vertical feed into material
  0xffd23f, // K_RAMP     ramp / helical entry
  0x9aa5b1, // K_RETRACT  feed move out of the material
  0x3ddc84, // K_LEADIN   lead-in (G41/G42 approach or CAM entry arc)
  0xe056fd, // K_LEADOUT  lead-out (G40 departure or CAM exit arc)
];
export const RAPID_COLOR = COLORS.rapid;

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(COLORS.bg);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this.paths = new THREE.Group();
    this.scene.add(this.paths);

    const toolGeo = new THREE.ConeGeometry(1, 3, 16);
    toolGeo.rotateX(-Math.PI / 2); // tip points to -Z
    toolGeo.translate(0, 0, 1.5);
    this.tool = new THREE.Mesh(toolGeo, new THREE.MeshBasicMaterial({ color: COLORS.tool }));
    this.tool.visible = false;
    this.scene.add(this.tool);

    this.showRapids = true;
    this.onlyCurrent = false;
    this.data = null;
    this.step = 0;

    this._needsRender = true;
    this._resize = () => this.resize();
    new ResizeObserver(this._resize).observe(container);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this._needsRender) {
        this._needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  requestRender() { this._needsRender = true; }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  clear() {
    for (const g of [this.paths, this.helpers]) {
      for (const o of [...g.children]) {
        g.remove(o);
        o.traverse?.((c) => { c.geometry?.dispose(); c.material?.dispose?.(); });
      }
    }
  }

  load(d) {
    this.clear();
    this.data = d;
    const b = d.bounds;
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ, 1);

    // --- cut / extrusion geometry
    const cutGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(d.cutPos, 3);
    cutGeo.setAttribute('position', posAttr);
    let cutMat;
    if (d.mode === 'print') {
      const nSeg = d.cutZ.length;
      const col = new Float32Array(nSeg * 6);
      const zr = Math.max(b.maxZ - b.minZ, 1e-6), c = new THREE.Color();
      for (let i = 0; i < nSeg; i++) {
        const t = (d.cutZ[i] - b.minZ) / zr;
        c.copy(COLORS.lowZ).lerp(COLORS.highZ, t);
        // subtle stripe per layer-ish so layers read on a phone screen
        col[i * 6] = col[i * 6 + 3] = c.r;
        col[i * 6 + 1] = col[i * 6 + 4] = c.g;
        col[i * 6 + 2] = col[i * 6 + 5] = c.b;
      }
      cutGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      cutMat = new THREE.LineBasicMaterial({ vertexColors: true });
    } else {
      const nSeg = d.cutKind.length;
      const col = new Float32Array(nSeg * 6);
      const pal = KIND_COLORS.map((h) => new THREE.Color(h));
      for (let i = 0; i < nSeg; i++) {
        const c = pal[d.cutKind[i]] || pal[0];
        col[i * 6] = col[i * 6 + 3] = c.r;
        col[i * 6 + 1] = col[i * 6 + 4] = c.g;
        col[i * 6 + 2] = col[i * 6 + 5] = c.b;
      }
      cutGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      cutMat = new THREE.LineBasicMaterial({ vertexColors: true });
    }
    this.cutLines = new THREE.LineSegments(cutGeo, cutMat);
    this.cutLines.frustumCulled = false;
    this.paths.add(this.cutLines);

    // current layer highlight (shares the position buffer)
    const curGeo = new THREE.BufferGeometry();
    curGeo.setAttribute('position', posAttr);
    this.curLines = new THREE.LineSegments(curGeo, new THREE.LineBasicMaterial({ color: d.mode === 'print' ? COLORS.current : COLORS.cncCurrent }));
    this.curLines.frustumCulled = false;
    this.curLines.renderOrder = 2;
    this.paths.add(this.curLines);

    // --- rapids / travel
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.BufferAttribute(d.rapidPos, 3));
    this.rapidLines = new THREE.LineSegments(rGeo, d.mode === 'print'
      ? new THREE.LineBasicMaterial({ color: COLORS.travel, transparent: true, opacity: 0.35 })
      : new THREE.LineDashedMaterial({ color: COLORS.rapid, transparent: true, opacity: 0.75, dashSize: size / 120, gapSize: size / 160 }));
    if (d.mode !== 'print') this.rapidLines.computeLineDistances();
    this.rapidLines.frustumCulled = false;
    this.paths.add(this.rapidLines);

    // --- helpers: grid on the lowest plane + axes at origin (work zero)
    const gsize = Math.pow(10, Math.ceil(Math.log10(size * 1.4)));
    const div = 20;
    const grid = new THREE.GridHelper(gsize, div, COLORS.gridMain, COLORS.grid);
    grid.rotation.x = Math.PI / 2;
    const cell = gsize / div;
    grid.position.set(
      Math.round(((b.minX + b.maxX) / 2) / cell) * cell,
      Math.round(((b.minY + b.maxY) / 2) / cell) * cell,
      d.mode === 'print' ? Math.min(0, b.minZ) : b.minZ);
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    this.helpers.add(grid);
    const axes = new THREE.AxesHelper(size * 0.15);
    axes.renderOrder = 3;
    this.helpers.add(axes);

    const ts = size * 0.03;
    this.tool.scale.set(ts, ts, ts);
    this.tool.visible = d.mode === 'cnc';

    this.setStep(d.stepCut.length - 1);
    this.fit('iso');
  }

  setStep(i) {
    const d = this.data;
    if (!d) return;
    const n = d.stepCut.length;
    i = Math.max(0, Math.min(n - 1, i | 0));
    this.step = i;
    const cutEnd = d.stepCut[i];
    const prevCut = i > 0 ? d.stepCut[i - 1] : 0;
    const rapidEnd = d.stepRapid[i];
    const prevRapid = i > 0 ? d.stepRapid[i - 1] : 0;

    const layerMode = d.mode === 'print';
    const start = this.onlyCurrent && layerMode ? prevCut : 0;
    this.cutLines.geometry.setDrawRange(start * 2, (cutEnd - start) * 2);
    this.rapidLines.visible = this.showRapids;
    const rStart = this.onlyCurrent && layerMode ? prevRapid : 0;
    this.rapidLines.geometry.setDrawRange(rStart * 2, (rapidEnd - rStart) * 2);

    // highlight: current layer (print) or last move (cnc)
    const atEnd = i === n - 1;
    if (layerMode) {
      this.curLines.visible = !atEnd || this.onlyCurrent;
      this.curLines.geometry.setDrawRange(prevCut * 2, (cutEnd - prevCut) * 2);
    } else {
      this.curLines.visible = !atEnd;
      this.curLines.geometry.setDrawRange(prevCut * 2, (cutEnd - prevCut) * 2);
    }
    if (this.tool.visible !== (d.mode === 'cnc')) this.tool.visible = d.mode === 'cnc';
    this.tool.position.set(d.stepPos[i * 3], d.stepPos[i * 3 + 1], d.stepPos[i * 3 + 2]);
    this.requestRender();
  }

  setShowRapids(v) { this.showRapids = v; this.setStep(this.step); }
  setOnlyCurrent(v) { this.onlyCurrent = v; this.setStep(this.step); }

  fit(view = 'iso') {
    const d = this.data;
    if (!d) return;
    const b = d.bounds;
    const c = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    const r = Math.max(Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) / 2, 1);
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = r / Math.sin(Math.min(vHalf, hHalf)) * 1.05;
    const dir = view === 'top' ? new THREE.Vector3(0, -0.0001, 1)
      : view === 'front' ? new THREE.Vector3(0, -1, 0.0001)
      : new THREE.Vector3(0.6, -1, 0.75);
    dir.normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.01);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
    this.requestRender();
  }
}
