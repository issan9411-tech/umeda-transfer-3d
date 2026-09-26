import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Graph } from '../core/graph';
import { sampleKeyframes } from '../core/keyframes';
import type { Keyframe, RouteSummary } from '../core/planner';
import type { NetNode, Platform } from '../core/types';
import { heatColor, KIND_COLORS, readPalette, type ScenePalette } from './palette';

export interface ViewEvents {
  /** x, y are relative to the view container. */
  onPickPlatform?: (platformId: string, x: number, y: number) => void;
  onHoverPlatform?: (platformId: string | null, x: number, y: number) => void;
  onEmptyClick?: () => void;
}

type CameraPreset = 'overview' | 'north' | 'section' | 'top';

const tmpColor = new THREE.Color();

export class UmedaView {
  readonly g: Graph;
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private palette: ScenePalette;
  private events: ViewEvents;

  private exaggeration = 4;
  private hiddenLevels = new Set<string>();
  private showLabels = true;
  private heat: Float32Array | null = null;

  private staticGroup = new THREE.Group();
  private networkGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private labelGroup = new THREE.Group();
  private crowdMesh: THREE.InstancedMesh | null = null;
  private walker: THREE.Group;
  private platformMeshes: THREE.Mesh[] = [];
  private edgeLines: THREE.LineSegments | null = null;
  private routes: RouteSummary[] = [];
  private selected = 0;
  private walkerTrack: Keyframe[] = [];
  private follow = false;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hovered: THREE.Mesh | null = null;
  private highlightNodes: THREE.Group = new THREE.Group();
  private pulse = 0;
  private center = new THREE.Vector3();
  /** Node indices of the selected route (their labels are always shown). */
  private routeNodes = new Set<number>();
  private radius = 600;

  constructor(container: HTMLElement, g: Graph, events: ViewEvents = {}) {
    this.container = container;
    this.g = g;
    this.events = events;
    this.palette = readPalette();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'scene-canvas';
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'scene-labels';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 4000;
    this.controls.screenSpacePanning = false;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-400, 900, 300);
    this.scene.add(sun);

    this.scene.add(this.staticGroup, this.networkGroup, this.routeGroup, this.labelGroup, this.highlightNodes);
    this.walker = this.makeWalker();
    this.walker.visible = false;
    this.scene.add(this.walker);

    this.computeBounds();
    this.rebuildAll();
    this.setCamera('overview', false);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    this.renderer.domElement.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.renderer.domElement.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.renderer.domElement.addEventListener('click', (ev) => this.onClick(ev));
  }

  // ---------------------------------------------------------------- layout helpers

  private Y(y: number): number {
    return y * this.exaggeration;
  }

  private v(n: { x: number; y: number; z: number }): THREE.Vector3 {
    return new THREE.Vector3(n.x, this.Y(n.y), n.z);
  }

  private levelVisible(level: string): boolean {
    return !this.hiddenLevels.has(level);
  }

  private computeBounds(): void {
    const box = new THREE.Box3();
    for (const n of this.g.nodes) box.expandByPoint(new THREE.Vector3(n.x, 0, n.z));
    box.getCenter(this.center);
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.x, size.z) * 0.6 + 50;
  }

  // ---------------------------------------------------------------- construction

  private rebuildAll(): void {
    this.buildStatic();
    this.buildNetwork();
    this.buildLabels();
    this.buildRoutes();
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
        if (o instanceof CSS2DObject) o.element.remove();
      });
    }
  }

  private buildStatic(): void {
    this.clearGroup(this.staticGroup);
    this.platformMeshes = [];
    const p = this.palette;
    this.scene.background = p.bg;
    this.renderer.setClearColor(p.bg);

    // Ground plane with a subtle 50 m grid.
    const size = this.radius * 3.2;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshLambertMaterial({ color: p.ground, transparent: true, opacity: this.levelVisible('1F') ? 0.55 : 0.18, depthWrite: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(this.center.x, -0.2, this.center.z);
    ground.renderOrder = -2;
    this.staticGroup.add(ground);
    const grid = new THREE.GridHelper(size, Math.round(size / 50), p.grid, p.grid);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    grid.position.set(this.center.x, -0.1, this.center.z);
    this.staticGroup.add(grid);

    // Roads as flat ribbons.
    for (const road of this.g.net.roads) {
      const pts = road.points;
      const verts: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, z1] = pts[i];
        const [x2, z2] = pts[i + 1];
        const dx = x2 - x1;
        const dz = z2 - z1;
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * (road.width / 2);
        const nz = (dx / len) * (road.width / 2);
        verts.push(x1 + nx, 0, z1 + nz, x1 - nx, 0, z1 - nz, x2 + nx, 0, z2 + nz);
        verts.push(x2 + nx, 0, z2 + nz, x1 - nx, 0, z1 - nz, x2 - nx, 0, z2 - nz);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: p.road, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
      mesh.position.y = 0.05;
      mesh.renderOrder = -1;
      this.staticGroup.add(mesh);
    }

    // Building / station footprints: low translucent plinths (context only, not exaggerated),
    // underground malls as flat plates at their level, the JR roof as a thin canopy.
    for (const f of this.g.net.footprints) {
      const shape = new THREE.Shape(f.poly.map(([x, z]) => new THREE.Vector2(x, -z)));
      const flat = f.kind === 'building' || f.kind === 'station';
      const base = flat ? 0 : this.Y(f.y0);
      const depth = flat ? (f.kind === 'station' ? 3 : 1.6) : Math.max(0.4, f.kind === 'deck' ? 0.6 : 0.8);
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const station = this.g.net.stations.find((s) => s.id === f.id.split(':')[0]);
      const color = f.kind === 'station' && station ? new THREE.Color(station.color) : p.building;
      const opacity = f.kind === 'deck' ? 0.06 : f.kind === 'mall' ? 0.1 : f.kind === 'station' ? 0.16 : p.dark ? 0.22 : 0.3;
      const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = f.kind === 'deck' ? this.Y(f.y0) : base;
      mesh.renderOrder = 1;
      this.staticGroup.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo, 30),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: f.kind === 'deck' ? 0.25 : 0.5 }),
      );
      edges.position.y = mesh.position.y;
      this.staticGroup.add(edges);
    }

    // Level slabs: a translucent floor under each non-ground level's nodes.
    for (const level of this.g.net.levels) {
      if (level.y === 0 || !this.levelVisible(level.id)) continue;
      const ns = this.g.nodes.filter((n) => n.level === level.id);
      if (ns.length === 0) continue;
      const hull = convexHull(ns.map((n) => [n.x, n.z] as [number, number]));
      const padded = inflate(hull, 14);
      const shape = new THREE.Shape(padded.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: p.slab, transparent: true, opacity: level.y < 0 ? 0.1 : 0.08, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = this.Y(level.y) - 0.3;
      mesh.renderOrder = 0;
      this.staticGroup.add(mesh);
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(padded.map(([x, z]) => new THREE.Vector3(x, 0, z))),
        new THREE.LineBasicMaterial({ color: p.slab, transparent: true, opacity: 0.45 }),
      );
      outline.position.y = mesh.position.y;
      this.staticGroup.add(outline);
    }

    // Platforms (and a short run of track beyond each end).
    for (const pl of this.g.net.platforms) {
      if (!this.levelVisible(pl.level)) continue;
      const line = this.g.net.lines.find((l) => l.id === pl.lineIds[0]);
      const color = new THREE.Color(line?.color ?? '#888');
      const [ax, az] = pl.a;
      const [bx, bz] = pl.b;
      const len = Math.hypot(bx - ax, bz - az);
      const geo = new THREE.BoxGeometry(len, 1.2, pl.width);
      const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.15 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((ax + bx) / 2, this.Y(pl.y) - 0.6, (az + bz) / 2);
      mesh.rotation.y = -Math.atan2(bz - az, bx - ax);
      mesh.userData = { platformId: pl.id, baseEmissive: 0.15 };
      this.staticGroup.add(mesh);
      this.platformMeshes.push(mesh);

      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      const ext = 140;
      const trackPts = [
        new THREE.Vector3(ax - dx * ext, this.Y(pl.y) - 1.2, az - dz * ext),
        new THREE.Vector3(bx + dx * ext, this.Y(pl.y) - 1.2, bz + dz * ext),
      ];
      for (const off of [-1, 1]) {
        const ox = -dz * off * (pl.width / 2 + 1.6);
        const oz = dx * off * (pl.width / 2 + 1.6);
        const track = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(trackPts.map((q) => q.clone().add(new THREE.Vector3(ox, 0, oz)))),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
        );
        this.staticGroup.add(track);
      }
    }
  }

  private buildNetwork(): void {
    this.clearGroup(this.networkGroup);
    const g = this.g;
    const pos: number[] = [];
    const col: number[] = [];
    const edgeOf: number[] = [];
    g.edges.forEach((e, i) => {
      const a = g.nodes[g.nodeIndex.get(e.a) as number];
      const b = g.nodes[g.nodeIndex.get(e.b) as number];
      if (!this.levelVisible(a.level) && !this.levelVisible(b.level)) return;
      pos.push(a.x, this.Y(a.y) + 0.4, a.z, b.x, this.Y(b.y) + 0.4, b.z);
      const c = this.heat ? heatColor(this.heat[i], tmpColor) : tmpColor.setHex(KIND_COLORS[e.kind]);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      edgeOf.push(i);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.routes.length ? 0.55 : 0.9 }));
    lines.userData.edgeOf = edgeOf;
    this.edgeLines = lines;
    this.networkGroup.add(lines);

    // Markers for gates and elevators.
    const markers: { n: NetNode; color: number; size: number }[] = [];
    for (const n of g.nodes) {
      if (!this.levelVisible(n.level)) continue;
      if (n.kind === 'gate' && n.paid) markers.push({ n, color: KIND_COLORS.gate, size: 2.2 });
    }
    const elevatorEnds = new Set<string>();
    for (const e of g.edges) if (e.kind === 'elevator') elevatorEnds.add(e.a), elevatorEnds.add(e.b);
    for (const id of elevatorEnds) {
      const n = g.nodes[g.nodeIndex.get(id) as number];
      if (this.levelVisible(n.level)) markers.push({ n, color: KIND_COLORS.elevator, size: 1.6 });
    }
    if (markers.length) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), markers.length);
      const m4 = new THREE.Matrix4();
      markers.forEach((mk, i) => {
        m4.makeScale(mk.size * 2, mk.size, mk.size * 2).setPosition(mk.n.x, this.Y(mk.n.y) + mk.size / 2, mk.n.z);
        inst.setMatrixAt(i, m4);
        inst.setColorAt(i, tmpColor.setHex(mk.color));
      });
      this.networkGroup.add(inst);
    }
  }

  private buildLabels(): void {
    this.clearGroup(this.labelGroup);
    if (!this.showLabels) return;
    for (const s of this.g.net.stations) {
      const lvl = this.g.net.levels.reduce((best, l) => (Math.abs(l.y - s.anchor[1]) < Math.abs(best.y - s.anchor[1]) ? l : best));
      if (!this.levelVisible(lvl.id)) continue;
      const el = document.createElement('div');
      el.className = 'lbl lbl-station';
      el.style.setProperty('--c', s.color);
      el.innerHTML = `<b>${s.badge}</b><span>${s.nameJa}</span>`;
      const obj = new CSS2DObject(el);
      obj.position.set(s.anchor[0], this.Y(s.anchor[1]) + 10, s.anchor[2]);
      this.labelGroup.add(obj);
    }
    this.g.nodes.forEach((n, i) => {
      if (!n.label || !this.levelVisible(n.level) || this.routeNodes.has(i)) return;
      const el = document.createElement('div');
      el.className = `lbl lbl-node lbl-${n.kind}`;
      el.textContent = n.name;
      const obj = new CSS2DObject(el);
      obj.position.set(n.x, this.Y(n.y) + 3, n.z);
      obj.userData.minor = true;
      this.labelGroup.add(obj);
    });
    // Elevation ruler west of the network: one tick and tag per level.
    const minX = Math.min(...this.g.nodes.map((n) => n.x)) - 50;
    const z0 = this.center.z;
    const ys = this.g.net.levels.filter((l) => this.g.nodes.some((n) => n.level === l.id));
    const top = Math.max(...ys.map((l) => l.y));
    const bottom = Math.min(...ys.map((l) => l.y));
    const rulerMat = new THREE.LineBasicMaterial({ color: this.palette.slab, transparent: true, opacity: 0.8 });
    const pts = [new THREE.Vector3(minX, this.Y(bottom), z0), new THREE.Vector3(minX, this.Y(top), z0)];
    for (const l of ys) pts.push(new THREE.Vector3(minX, this.Y(l.y), z0), new THREE.Vector3(minX + 14, this.Y(l.y), z0));
    this.labelGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), rulerMat));
    for (const l of ys) {
      const el = document.createElement('div');
      el.className = 'lbl lbl-level' + (this.levelVisible(l.id) ? '' : ' is-off');
      el.textContent = `${l.id}  ${l.y > 0 ? '+' : ''}${l.y}m`;
      el.title = l.nameJa;
      const obj = new CSS2DObject(el);
      obj.center.set(0, 0.5);
      obj.position.set(minX + 16, this.Y(l.y), z0);
      if (l.id === 'M2') obj.userData.minor = true;
      this.labelGroup.add(obj);
    }
  }

  private buildRoutes(): void {
    this.clearGroup(this.routeGroup);
    this.clearGroup(this.highlightNodes);
    if (this.edgeLines) (this.edgeLines.material as THREE.LineBasicMaterial).opacity = this.routes.length ? 0.5 : 0.9;
    const p = this.palette;
    this.routes.forEach((r, idx) => {
      const isSel = idx === this.selected;
      const pts = r.path.nodes.map((ni) => this.v(this.g.nodes[ni]).add(new THREE.Vector3(0, isSel ? 1.4 : 0.9, 0)));
      if (pts.length < 2) return;
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 0; i < pts.length - 1; i++) {
        if (pts[i].distanceTo(pts[i + 1]) < 0.01) continue;
        path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
      }
      if (path.curves.length === 0) return;
      const segs = Math.min(1200, Math.max(16, path.curves.length * 6));
      const geo = new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, segs, isSel ? 1.7 : 0.9, 8, false);
      const mat = isSel
        ? new THREE.MeshLambertMaterial({ color: p.accent, emissive: p.accent, emissiveIntensity: 0.55 })
        : new THREE.MeshLambertMaterial({ color: p.alt, transparent: true, opacity: 0.55, depthWrite: false });
      const tube = new THREE.Mesh(geo, mat);
      tube.renderOrder = isSel ? 5 : 4;
      this.routeGroup.add(tube);

      if (isSel) {
        // Gate names along the route stay visible at every zoom level.
        for (const ni of r.path.nodes) {
          const n = this.g.nodes[ni];
          if (n.kind !== 'gate' || !n.paid) continue;
          const el = document.createElement('div');
          el.className = 'lbl lbl-node lbl-gate lbl-route';
          el.textContent = n.name;
          const obj = new CSS2DObject(el);
          obj.position.copy(this.v(n)).add(new THREE.Vector3(0, 4, 0));
          this.routeGroup.add(obj);
        }
        // Start / end pins.
        const a = pts[0];
        const b = pts[pts.length - 1];
        this.routeGroup.add(this.makePin(a, 0x2c7be5, 'のる'));
        this.routeGroup.add(this.makePin(b, 0xd6453d, 'おりる'));
        // Highlight nodes where the route changes level.
        const ring = new THREE.TorusGeometry(3.2, 0.5, 8, 24);
        r.path.steps.forEach((st) => {
          const e = this.g.edges[st.edge];
          if (e.kind === 'stairs' || e.kind === 'escalator' || e.kind === 'elevator' || e.kind === 'gate') {
            const n = this.g.nodes[st.from];
            const m = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: KIND_COLORS[e.kind] }));
            m.rotation.x = Math.PI / 2;
            m.position.copy(this.v(n)).add(new THREE.Vector3(0, 1.2, 0));
            this.highlightNodes.add(m);
          }
        });
      }
    });
  }

  private makePin(at: THREE.Vector3, color: number, text: string): THREE.Group {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(4, 10, 20), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.3 }));
    cone.rotation.x = Math.PI;
    cone.position.set(0, 8, 0);
    g.add(cone);
    const el = document.createElement('div');
    el.className = 'lbl lbl-pin';
    el.style.setProperty('--c', `#${color.toString(16).padStart(6, '0')}`);
    el.textContent = text;
    const lbl = new CSS2DObject(el);
    lbl.position.set(0, 17, 0);
    g.add(lbl);
    g.position.copy(at);
    return g;
  }

  private makeWalker(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.6, 3.2, 6, 14), new THREE.MeshLambertMaterial({ color: 0x1b2a38, emissive: 0x1b2a38, emissiveIntensity: 0.2 }));
    body.position.y = 3.4;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), new THREE.MeshLambertMaterial({ color: 0xffc400, emissive: 0xffc400, emissiveIntensity: 0.5 }));
    head.position.y = 7.4;
    g.add(head);
    const halo = new THREE.Mesh(new THREE.RingGeometry(4, 5.2, 32), new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.6;
    halo.name = 'halo';
    g.add(halo);
    return g;
  }

  // ---------------------------------------------------------------- public API

  setRoutes(routes: RouteSummary[], selected = 0): void {
    this.routes = routes;
    this.selected = Math.min(selected, Math.max(0, routes.length - 1));
    this.routeNodes = new Set(routes[this.selected]?.path.nodes ?? []);
    this.buildLabels();
    this.buildRoutes();
    this.walkerTrack = routes[this.selected]?.keyframes ?? [];
    this.walker.visible = this.walkerTrack.length > 0;
    this.setWalkerTime(0);
  }

  selectRoute(i: number): void {
    this.setRoutes(this.routes, i);
  }

  /** Frames the camera on the selected route. */
  focusRoute(): void {
    const r = this.routes[this.selected];
    if (!r) return;
    const box = new THREE.Box3();
    for (const ni of r.path.nodes) box.expandByPoint(this.v(this.g.nodes[ni]));
    this.frameBox(box);
  }

  focusNodes(nodeIdx: number[]): void {
    if (nodeIdx.length === 0) return;
    const box = new THREE.Box3();
    for (const ni of nodeIdx) box.expandByPoint(this.v(this.g.nodes[ni]));
    this.frameBox(box, 90);
  }

  private frameBox(box: THREE.Box3, minSize = 160): void {
    const c = box.getCenter(new THREE.Vector3());
    const size = Math.max(minSize, box.getSize(new THREE.Vector3()).length());
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    this.animateCamera(c, c.clone().add(dir.multiplyScalar(size * 1.25)));
  }

  private camAnim: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;

  private animateCamera(target: THREE.Vector3, position: THREE.Vector3): void {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      return;
    }
    this.camAnim = { from: this.camera.position.clone(), to: position, tFrom: this.controls.target.clone(), tTo: target, t: 0 };
  }

  setCamera(preset: CameraPreset, animate = true): void {
    const c = this.center.clone();
    const r = this.radius;
    let pos: THREE.Vector3;
    switch (preset) {
      case 'north':
        pos = new THREE.Vector3(c.x, r * 0.55, c.z - r * 1.5);
        break;
      case 'section':
        pos = new THREE.Vector3(c.x, 30, c.z + r * 1.7);
        break;
      case 'top':
        pos = new THREE.Vector3(c.x, r * 2.2, c.z + 1);
        break;
      default:
        pos = new THREE.Vector3(c.x + r * 0.9, r * 0.95, c.z + r * 1.15);
    }
    if (animate) this.animateCamera(c, pos);
    else {
      this.controls.target.copy(c);
      this.camera.position.copy(pos);
      this.controls.update();
    }
  }

  setExaggeration(ex: number): void {
    this.exaggeration = ex;
    this.rebuildAll();
    this.setWalkerTime(this.walkerT);
  }

  setLevelVisible(level: string, visible: boolean): void {
    if (visible) this.hiddenLevels.delete(level);
    else this.hiddenLevels.add(level);
    this.buildStatic();
    this.buildNetwork();
    this.buildLabels();
  }

  isLevelVisible(level: string): boolean {
    return this.levelVisible(level);
  }

  setLabels(on: boolean): void {
    this.showLabels = on;
    this.buildLabels();
  }

  setHeat(density: Float32Array | null): void {
    this.heat = density;
    this.updateEdgeColors();
  }

  /** Recolours network edges in place (cheap enough to call every few frames). */
  updateEdgeColors(): void {
    const lines = this.edgeLines;
    if (!lines) return;
    const edgeOf = lines.userData.edgeOf as number[];
    const attr = lines.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let k = 0; k < edgeOf.length; k++) {
      const i = edgeOf[k];
      const c = this.heat ? heatColor(this.heat[i], tmpColor) : tmpColor.setHex(KIND_COLORS[this.g.edges[i].kind]);
      attr.setXYZ(2 * k, c.r, c.g, c.b);
      attr.setXYZ(2 * k + 1, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }

  setFollow(on: boolean): void {
    this.follow = on;
  }

  private walkerT = 0;

  setWalkerTime(t: number): void {
    this.walkerT = t;
    if (!this.walkerTrack.length) return;
    const p = sampleKeyframes(this.walkerTrack, t);
    this.walker.position.set(p.x, this.Y(p.y) + 0.8, p.z);
  }

  get walkerPosition(): THREE.Vector3 {
    return this.walker.position;
  }

  /** Updates the crowd instances from packed positions. */
  setCrowd(positions: Float32Array | null, colors: Uint32Array | null, count: number): void {
    if (!positions || !colors || count === 0) {
      if (this.crowdMesh) this.crowdMesh.count = 0;
      return;
    }
    if (!this.crowdMesh || this.crowdMesh.instanceMatrix.count < count) {
      if (this.crowdMesh) {
        this.scene.remove(this.crowdMesh);
        this.crowdMesh.geometry.dispose();
        (this.crowdMesh.material as THREE.Material).dispose();
      }
      const cap = Math.max(count, positions.length / 3);
      // Each agent stands for ~20 people, so draw it well above human scale to stay visible.
      this.crowdMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(2.2, 3.2, 3, 8), new THREE.MeshLambertMaterial(), cap);
      this.crowdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.crowdMesh.frustumCulled = false;
      this.scene.add(this.crowdMesh);
    }
    const m4 = new THREE.Matrix4();
    const mesh = this.crowdMesh;
    let w = 0;
    for (let i = 0; i < count; i++) {
      const y = positions[i * 3 + 1];
      const lvl = this.levelOfY(y);
      if (lvl && !this.levelVisible(lvl)) continue;
      m4.makeTranslation(positions[i * 3], this.Y(y) + 3.8, positions[i * 3 + 2]);
      mesh.setMatrixAt(w, m4);
      mesh.setColorAt(w, tmpColor.setHex(colors[i]));
      w++;
    }
    mesh.count = w;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private levelOfY(y: number): string | null {
    let best: string | null = null;
    let bd = Infinity;
    for (const l of this.g.net.levels) {
      const d = Math.abs(l.y - y);
      if (d < bd) {
        bd = d;
        best = l.id;
      }
    }
    return bd < 2.5 ? best : null;
  }

  refreshTheme(): void {
    this.palette = readPalette();
    this.rebuildAll();
  }

  // ---------------------------------------------------------------- interaction

  private pickPlatform(ev: MouseEvent): THREE.Mesh | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.platformMeshes, false)[0];
    return (hit?.object as THREE.Mesh) ?? null;
  }

  private local(ev: MouseEvent): [number, number] {
    const rect = this.container.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  private onPointerMove(ev: PointerEvent): void {
    if (ev.buttons) return;
    const m = this.pickPlatform(ev);
    const [x, y] = this.local(ev);
    if (m !== this.hovered) {
      if (this.hovered) (this.hovered.material as THREE.MeshLambertMaterial).emissiveIntensity = this.hovered.userData.baseEmissive;
      this.hovered = m;
      if (m) (m.material as THREE.MeshLambertMaterial).emissiveIntensity = 0.7;
      this.renderer.domElement.style.cursor = m ? 'pointer' : '';
    }
    this.events.onHoverPlatform?.(m ? (m.userData.platformId as string) : null, x, y);
  }

  private downAt: [number, number] = [0, 0];

  private onPointerDown(ev: PointerEvent): void {
    this.downAt = [ev.clientX, ev.clientY];
  }

  private onClick(ev: MouseEvent): void {
    // Ignore clicks that ended an orbit drag.
    if (Math.hypot(ev.clientX - this.downAt[0], ev.clientY - this.downAt[1]) > 5) return;
    const m = this.pickPlatform(ev);
    const [x, y] = this.local(ev);
    if (m) this.events.onPickPlatform?.(m.userData.platformId as string, x, y);
    else this.events.onEmptyClick?.();
  }

  // ---------------------------------------------------------------- loop

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Per-frame update; dt in real seconds. */
  frame(dt: number): void {
    if (this.camAnim) {
      const a = this.camAnim;
      a.t = Math.min(1, a.t + dt / 0.9);
      const e = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(a.from, a.to, e);
      this.controls.target.lerpVectors(a.tFrom, a.tTo, e);
      if (a.t >= 1) this.camAnim = null;
    } else if (this.follow && this.walker.visible) {
      const target = this.walker.position;
      const delta = target.clone().sub(this.controls.target).multiplyScalar(Math.min(1, dt * 3));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    // Minor labels only when the camera is close enough to read them.
    const camPos = this.camera.position;
    for (const obj of this.labelGroup.children) {
      if (!obj.userData.minor) continue;
      obj.visible = obj.position.distanceTo(camPos) < 520;
    }
    this.pulse += dt;
    const halo = this.walker.getObjectByName('halo');
    if (halo) {
      const s = 1 + 0.25 * Math.sin(this.pulse * 4);
      halo.scale.set(s, s, s);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  platformAt(id: string): Platform | undefined {
    return this.g.net.platforms.find((p) => p.id === id);
  }
}

// ---------------------------------------------------------------- geometry utils

/** Andrew's monotone chain convex hull. */
export function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Pushes each hull vertex outward from the centroid by d metres. */
export function inflate(poly: [number, number][], d: number): [number, number][] {
  if (poly.length === 0) return poly;
  if (poly.length < 3) {
    const [x, z] = poly[0];
    return [
      [x - d, z - d],
      [x + d, z - d],
      [x + d, z + d],
      [x - d, z + d],
    ];
  }
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, z]) => {
    const dx = x - cx;
    const dz = z - cz;
    const len = Math.hypot(dx, dz) || 1;
    return [x + (dx / len) * d, z + (dz / len) * d] as [number, number];
  });
}
