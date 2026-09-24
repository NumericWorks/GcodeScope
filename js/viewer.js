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
  0xd4e157, // K_SPOT     spot / center drill
  0xff6e40, // K_DRILL    drilling, peck (G83) and chip-break (G73)
  0xf48fb1, // K_TAP      tapping (G84 / G74)
  0x26c6da, // K_BORE     boring / reaming (G85–G89, G76)
  0x7986ff, // K_BOREMILL helical bore milling
  0xb388ff, // K_THREADMILL thread milling
];
const HOLE_KIND = { spot: 6, drill: 7, peck: 7, chipbreak: 7, tap: 8, bore: 9, boremill: 10, threadmill: 11 };
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
    this.showHoles = true;
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

    // --- holes: see-through bodies with rims, peck rings and thread helices
    this.buildHoles(d, size);

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

  buildHoles(d, size) {
    this.holeMesh = this.holeLines = null;
    const holes = d.holes || [];
    if (!holes.length) return;
    const tri = [], triCol = [], lin = [], linCol = [];
    this.holeTriEnd = new Uint32Array(holes.length);
    this.holeLineEnd = new Uint32Array(holes.length);
    this.holeStep = new Uint32Array(holes.length);
    const fallbackR = Math.min(5, Math.max(0.5, size * 0.01));
    const N = 20, c = new THREE.Color();
    const ring = (x, y, z, r, rgb) => {
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
        lin.push(x + r * Math.cos(a0), y + r * Math.sin(a0), z, x + r * Math.cos(a1), y + r * Math.sin(a1), z);
        linCol.push(...rgb, ...rgb);
      }
    };
    // surface of revolution between (z0, r0) and (z1, r1)
    const band = (x, y, z0, r0, z1, r1, rgb) => {
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        tri.push(x + r0 * c0, y + r0 * s0, z0, x + r0 * c1, y + r0 * s1, z0, x + r1 * c1, y + r1 * s1, z1,
          x + r0 * c0, y + r0 * s0, z0, x + r1 * c1, y + r1 * s1, z1, x + r1 * c0, y + r1 * s0, z1);
        for (let v = 0; v < 6; v++) triCol.push(...rgb);
      }
    };
    const helix = (x, y, zb, zt, r, pitch, lh, rgb) => {
      const turns = (zt - zb) / pitch;
      if (!(turns > 0) || turns > 400) return;
      const n = Math.ceil(turns * 16), sgn = lh ? -1 : 1;
      let px = x + r, py = y, pz = zb;
      for (let k = 1; k <= n; k++) {
        const t = k / n, a = sgn * t * turns * Math.PI * 2;
        const nx = x + r * Math.cos(a), ny = y + r * Math.sin(a), nz = zb + t * (zt - zb);
        lin.push(px, py, pz, nx, ny, nz); linCol.push(...rgb, ...rgb);
        px = nx; py = ny; pz = nz;
      }
    };
    holes.forEach((h, i) => {
      c.setHex(KIND_COLORS[HOLE_KIND[h.type]] ?? KIND_COLORS[7]);
      const rgb = [c.r, c.g, c.b];
      const r = h.d > 0 ? h.d / 2 : fallbackR;
      const top = Math.max(h.top, h.bottom), bot = h.bottom;
      if (h.type === 'spot') {
        // 90° countersink cone: radius grows 1:1 with height, up to the tool radius
        const hgt = Math.min(top - bot, r);
        band(h.x, h.y, bot, 0, bot + hgt, hgt, rgb);
        ring(h.x, h.y, bot + hgt, hgt, rgb);
      } else if (h.type === 'drill' || h.type === 'peck' || h.type === 'chipbreak') {
        // 118° drill point
        const tip = Math.min(r / Math.tan(59 * Math.PI / 180), top - bot);
        band(h.x, h.y, bot, 0, bot + tip, r, rgb);
        band(h.x, h.y, bot + tip, r, top, r, rgb);
        ring(h.x, h.y, top, r, rgb); ring(h.x, h.y, bot + tip, r, rgb);
        for (const pz of h.pecks) { ring(h.x, h.y, pz, r * 1.12, rgb); }
      } else {
        band(h.x, h.y, bot, r, top, r, rgb);
        band(h.x, h.y, bot, 0, bot, r, rgb); // flat bottom
        ring(h.x, h.y, top, r, rgb); ring(h.x, h.y, bot, r, rgb);
        if ((h.type === 'tap' || h.type === 'threadmill') && h.pitch > 0) helix(h.x, h.y, bot, top, r * 1.01, h.pitch, h.lh, rgb);
      }
      this.holeTriEnd[i] = tri.length / 3;
      this.holeLineEnd[i] = lin.length / 3;
      this.holeStep[i] = h.step;
    });
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3));
    mg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(triCol), 3));
    this.holeMesh = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
    }));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lin), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(linCol), 3));
    this.holeLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    for (const o of [this.holeMesh, this.holeLines]) { o.frustumCulled = false; o.renderOrder = 1; this.paths.add(o); }
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
    if (this.holeMesh) {
      // holes finished up to this step
      let lo = 0, hi = this.holeStep.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.holeStep[mid] <= i) lo = mid + 1; else hi = mid; }
      this.holeMesh.visible = this.holeLines.visible = this.showHoles && lo > 0;
      this.holeMesh.geometry.setDrawRange(0, lo ? this.holeTriEnd[lo - 1] : 0);
      this.holeLines.geometry.setDrawRange(0, lo ? this.holeLineEnd[lo - 1] : 0);
    }
    if (this.tool.visible !== (d.mode === 'cnc')) this.tool.visible = d.mode === 'cnc';
    this.tool.position.set(d.stepPos[i * 3], d.stepPos[i * 3 + 1], d.stepPos[i * 3 + 2]);
    this.requestRender();
  }

  setShowRapids(v) { this.showRapids = v; this.setStep(this.step); }
  setShowHoles(v) { this.showHoles = v; this.setStep(this.step); }
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
