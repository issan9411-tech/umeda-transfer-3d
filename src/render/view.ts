import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Graph } from '../core/graph';
import { sampleKeyframes } from '../core/keyframes';
import type { Keyframe, RouteSummary } from '../core/planner';
import type { EdgeKind, NetNode, Platform } from '../core/types';
import { heatColor, KIND_COLORS, readPalette, type ScenePalette } from './palette';
import { PeopleCrowd, createWalkerFigure, type PeopleOptions, type WalkerFigure } from './people';
import { buildStations, buildTrainModel } from './station';
import {
  angleDelta,
  buildGuideLine,
  buildWalkway,
  disposeWalkway,
  headingBetween,
  updateWalkway,
  verticalLaneOffsets,
  type WalkCut,
} from './walkway';

export interface ViewEvents {
  /** x, y are relative to the view container. */
  onPickPlatform?: (platformId: string, x: number, y: number) => void;
  onHoverPlatform?: (platformId: string | null, x: number, y: number) => void;
  onEmptyClick?: () => void;
}

type CameraPreset = 'overview' | 'north' | 'section' | 'top';

/** Walk-through camera: behind the walker, at eye level, or orbiting while following. */
export type WalkView = 'chase' | 'first' | 'orbit';

/** Vertical exaggeration used while walking: close to real scale so stairs look like stairs. */
const WALK_EX = 1.5;
/** Size of the walker's halo while walking (the overview marker is drawn oversized). */
const WALKER_SCALE = 0.3;
/**
 * Pedestrian figures while walking: a little above real size, between the real horizontal
 * scale and the 1.5× vertical exaggeration, so people, gates and steps read in proportion.
 */
const PEOPLE_SCALE = 1.25;
/** The walker figure in the overview: a "you are here" marker, larger than the crowd (×5). */
const WALKER_OVERVIEW_SCALE = 9;

/** Overview figures shrink as the camera closes in (each agent stands for ~20 people). */
const overviewZoom = (dist: number) => Math.min(1, Math.max(0.3, dist / 500));
/** Soles above Y(level) while walking (walkway floors are lifted 0.08 to avoid z-fighting). */
const FLOOR_LIFT = 0.09;
/** Stair flights in the walk scene rise ≈0.94 m per metre (1.5× exaggerated). */
const WALK_STAIR_SLOPE = 0.9;

/** Per-agent crowd state the view draws (CrowdSim satisfies it). */
export interface CrowdFrame {
  readonly positions: Float32Array;
  readonly headings: Float32Array;
  readonly speeds: Float32Array;
  readonly ids: Uint32Array;
  readonly climbs: Int8Array;
  readonly lateral: Float32Array;
  readonly edgeOf: Int32Array;
  /** Destination colours (0xrrggbb), used to colour-code the overview crowd. */
  readonly colors: Uint32Array;
  readonly count: number;
}

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
  private people: PeopleCrowd | null = null;
  private crowdFrame: CrowdFrame | null = null;
  private crowdOffsets = new Float32Array(0);
  private peopleOpts: PeopleOptions;
  /** Sideways shift of each drawn stair / escalator / elevator flight (x, z per edge). */
  private laneOffsets: Float32Array;
  /** Levels at both ends of each edge (crowd visibility without per-agent map lookups). */
  private edgeLevels: [string, string][];
  private walker: THREE.Group;
  private figure: WalkerFigure;
  /** Per keyframe segment of the walker's track: edge walked (−1 while waiting). */
  private walkerSegEdge = new Int32Array(0);
  private walkerYaw = 0;
  private walkerOff = new THREE.Vector3();
  private walkerLift = 0;
  private platformMeshes: THREE.Mesh[] = [];
  private edgeLines: THREE.LineSegments | null = null;
  private routes: RouteSummary[] = [];
  private selected = 0;
  private walkerTrack: Keyframe[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hovered: THREE.Mesh | null = null;
  private highlightNodes: THREE.Group = new THREE.Group();
  private pulse = 0;
  private center = new THREE.Vector3();
  /** Node indices of the selected route (their labels are always shown). */
  private routeNodes = new Set<number>();
  private radius = 600;

  // Walk-through state
  private walkView: WalkView | null = null;
  private walkGroup: THREE.Group | null = null;
  private trainGroup = new THREE.Group();
  private signGroup = new THREE.Group();
  private savedEx = 4;
  private heading = 0;
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private miniCam = new THREE.OrthographicCamera(-160, 160, 160, -160, 1, 6000);
  private miniMarker: THREE.Mesh;
  private miniFrame: HTMLDivElement;
  private walkCut: WalkCut = { eye: new THREE.Vector3(), target: new THREE.Vector3() };

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

    this.scene.add(this.staticGroup, this.networkGroup, this.routeGroup, this.labelGroup, this.highlightNodes, this.trainGroup, this.signGroup);

    // Minimap: top-down orthographic camera that also sees layer 1 (the heading marker).
    this.miniCam.up.set(0, 0, -1);
    this.miniCam.layers.enable(1);
    const marker = new THREE.Mesh(new THREE.ConeGeometry(9, 22, 3), new THREE.MeshBasicMaterial({ color: 0xffc400 }));
    marker.geometry.rotateX(Math.PI / 2);
    marker.layers.set(1);
    marker.visible = false;
    this.miniMarker = marker;
    this.scene.add(marker);
    this.miniFrame = document.createElement('div');
    this.miniFrame.className = 'minimap-frame';
    this.miniFrame.hidden = true;
    this.miniFrame.setAttribute('aria-hidden', 'true');
    container.appendChild(this.miniFrame);
    this.laneOffsets = verticalLaneOffsets(g);
    this.edgeLevels = g.edges.map((e) => [g.nodes[g.nodeIndex.get(e.a) as number].level, g.nodes[g.nodeIndex.get(e.b) as number].level]);
    this.figure = createWalkerFigure();
    this.walker = this.makeWalker();
    this.walker.visible = false;
    this.scene.add(this.walker);
    this.setWalkerScale();
    this.peopleOpts = {
      Y: (y) => this.Y(y),
      scale: 1,
      visible: (i) => this.crowdVisible(i),
      groundLift: (i) => this.crowdGroundLift(i),
    };

    this.computeBounds();
    this.rebuildAll();
    this.setCamera('overview', false);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    this.renderer.domElement.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.renderer.domElement.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    this.renderer.domElement.addEventListener('pointerleave', () => this.clearHover());
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
    if (this.walkView) this.buildWalkScene();
  }

  // ---------------------------------------------------------------- walk-through

  /** Floors, walls, stairs, gates (walkway.ts), trains at both ends and signboards. */
  private buildWalkScene(): void {
    if (this.walkGroup) {
      this.scene.remove(this.walkGroup);
      disposeWalkway(this.walkGroup);
    }
    const sel = this.routes[this.selected];
    const routeEdges = new Set(sel ? sel.path.steps.map((st) => this.g.edges[st.edge].id) : []);
    this.walkGroup = buildWalkway(this.g, {
      Y: (y) => this.Y(y),
      ex: this.exaggeration,
      dark: this.palette.dark,
      levelVisible: (l) => this.levelVisible(l),
      routeEdges,
    });
    // People and the walker stand on the same (route-centred) stair lanes walkway.ts draws.
    this.laneOffsets = verticalLaneOffsets(this.g, routeEdges);
    this.scene.add(this.walkGroup);

    this.clearGroup(this.trainGroup);
    this.clearGroup(this.signGroup);
    const r = this.routes[this.selected];
    // Station architecture and parked trains; the route-end trains below keep their tracks free.
    const ends = r ? [r.boardingNode, r.alightNode] : [];
    const occupied = ends.flatMap((n, i) => (n.platformId ? [{ platformId: n.platformId, side: (i === 0 ? 1 : -1) as 1 | -1 }] : []));
    this.walkGroup.add(
      buildStations(this.g.net, {
        Y: (y) => this.Y(y),
        ex: this.exaggeration,
        dark: this.palette.dark,
        levelVisible: (l) => this.levelVisible(l),
        walk: true,
        occupied,
        focus: occupied.map((x) => x.platformId),
        routeEdges,
      }),
    );
    if (!r) return;
    ends.forEach((n, i) => {
      const p = this.g.net.platforms.find((x) => x.id === n.platformId);
      if (!p || !this.levelVisible(p.level)) return;
      const line = this.g.net.lines.find((l) => l.id === p.lineIds[0]);
      if (!line) return;
      this.trainGroup.add(buildTrainModel(p, line, { Y: (y) => this.Y(y), ex: this.exaggeration, dark: this.palette.dark, side: i === 0 ? 1 : -1 }));
    });

    // Signboards where each instruction begins (station-sign style, see styles.css).
    r.instructions.forEach((ins, i) => {
      if (ins.kind === 'start') return;
      const stepIdx = Math.min(Math.max(0, ins.steps[0]), r.path.steps.length - 1);
      const nodeIdx = ins.kind === 'arrive' ? r.path.nodes[r.path.nodes.length - 1] : r.path.steps[stepIdx]?.from;
      if (nodeIdx === undefined) return;
      const n = this.g.nodes[nodeIdx];
      const el = document.createElement('div');
      el.className = `sign sign-${ins.kind}`;
      el.innerHTML = `<span class="sign-lvl"></span><span class="sign-text"></span>`;
      (el.firstChild as HTMLElement).textContent = ins.level;
      (el.lastChild as HTMLElement).textContent = ins.text;
      const obj = new CSS2DObject(el);
      obj.position.copy(this.v(n)).add(new THREE.Vector3(0, 3.4 * this.exaggeration + 1.5, 0));
      obj.userData.instruction = i;
      this.signGroup.add(obj);
    });
  }

  /** Enters (or switches) walk-through mode for the selected route. */
  enterWalk(view: WalkView): void {
    if (!this.routes[this.selected]) return;
    const first = this.walkView === null;
    this.walkView = view;
    if (first) {
      this.savedEx = this.exaggeration;
      this.exaggeration = WALK_EX;
      this.scene.fog = new THREE.Fog(this.palette.bg, 90, 520);
      this.rebuildAll();
      this.camAnim = null;
      this.camera.near = 0.3;
      this.camera.updateProjectionMatrix();
      this.setWalkerScale();
      this.setWalkerTime(this.walkerT);
      this.heading = this.lookaheadHeading() ?? this.heading;
      this.snapWalkCamera();
    }
    this.controls.enabled = view === 'orbit';
    if (view === 'orbit') {
      this.controls.target.copy(this.walker.position);
      this.controls.minDistance = 15;
      if (this.camera.position.distanceTo(this.walker.position) > 400) this.snapWalkCamera();
    }
    this.walker.visible = view !== 'first' && this.walkerTrack.length > 0;
    this.miniFrame.hidden = false;
    this.miniMarker.visible = true;
  }

  exitWalk(): void {
    if (!this.walkView) return;
    this.walkView = null;
    if (this.walkGroup) {
      this.scene.remove(this.walkGroup);
      disposeWalkway(this.walkGroup);
      this.walkGroup = null;
    }
    this.clearGroup(this.trainGroup);
    this.clearGroup(this.signGroup);
    this.exaggeration = this.savedEx;
    this.scene.fog = null;
    this.camera.near = 1;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = true;
    this.controls.minDistance = 40;
    this.setWalkerScale();
    this.walker.visible = this.walkerTrack.length > 0;
    this.miniFrame.hidden = true;
    this.miniMarker.visible = false;
    this.rebuildAll();
    this.setWalkerTime(this.walkerT);
    this.focusRoute();
  }

  get walking(): WalkView | null {
    return this.walkView;
  }

  /** Index of the instruction the walker is currently carrying out. */
  private currentInstruction(): number {
    const r = this.routes[this.selected];
    if (!r) return 0;
    let acc = 0;
    for (let i = 0; i < r.instructions.length; i++) {
      acc += r.instructions[i].timeS;
      if (this.walkerT < acc) return i;
    }
    return r.instructions.length - 1;
  }

  /** Direction of travel a few seconds ahead of the walker (null while moving vertically). */
  private lookaheadHeading(): number | null {
    const p0 = sampleKeyframes(this.walkerTrack, this.walkerT);
    for (const ahead of [2, 5, 10, 20]) {
      const h = headingBetween(p0, sampleKeyframes(this.walkerTrack, this.walkerT + ahead));
      if (h !== null) return h;
    }
    // At the destination: keep facing the way we arrived.
    const back = headingBetween(sampleKeyframes(this.walkerTrack, this.walkerT - 5), p0);
    return back;
  }

  private walkPose(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const w = this.walker.position;
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    if (this.walkView === 'first') {
      const eye = w.clone().add(new THREE.Vector3(0, 1.6 * PEOPLE_SCALE, 0));
      const ahead = sampleKeyframes(this.walkerTrack, this.walkerT + 4);
      const dy = this.Y(ahead.y) - (w.y - FLOOR_LIFT - this.walkerLift);
      return { pos: eye, target: eye.clone().add(fwd.multiplyScalar(14)).add(new THREE.Vector3(0, dy * 0.7 - 1.2, 0)) };
    }
    // Close behind and below the corridor ceiling (walls are 3.2 m × 1.5 high, with light strips
    // just under the top), so the ceiling never hides the walker; on the way down a flight the
    // camera stays above the steps behind.
    const pos = w.clone().sub(fwd.clone().multiplyScalar(8)).add(new THREE.Vector3(0, 3.4, 0));
    const behind = sampleKeyframes(this.walkerTrack, this.walkerT - 6);
    pos.y = Math.max(pos.y, this.Y(behind.y) + 2.6);
    return { pos, target: w.clone().add(fwd.multiplyScalar(7)).add(new THREE.Vector3(0, 1.0, 0)) };
  }

  private snapWalkCamera(): void {
    const { pos, target } = this.walkPose();
    this.camPos.copy(pos);
    this.camTarget.copy(target);
    this.camera.position.copy(pos);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
  }

  private updateWalkCamera(dt: number): void {
    const h = this.lookaheadHeading();
    if (h !== null) this.heading += angleDelta(this.heading, h) * Math.min(1, dt * 2.4);
    this.miniMarker.position.copy(this.walker.position).setY(this.walker.position.y + 40);
    this.miniMarker.rotation.set(0, this.heading, 0);
    if (this.walkView === 'orbit') {
      const delta = this.walker.position.clone().sub(this.controls.target).multiplyScalar(Math.min(1, dt * 3));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      return;
    }
    const { pos, target } = this.walkPose();
    const k = 1 - Math.exp(-dt * 5);
    this.camPos.lerp(pos, k);
    this.camTarget.lerp(target, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    this.controls.target.copy(this.camTarget);
  }

  private renderMinimap(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const size = Math.round(Math.min(190, w * 0.3, h * 0.32));
    const x = w - size - 14;
    const bottom = w < 760 ? 70 : 92;
    this.miniFrame.style.width = `${size}px`;
    this.miniFrame.style.height = `${size}px`;
    this.miniFrame.style.left = `${x}px`;
    this.miniFrame.style.top = `${h - bottom - size}px`;
    const p = this.walker.position;
    this.miniCam.position.set(p.x, p.y + 1500, p.z);
    this.miniCam.lookAt(p.x, p.y, p.z);
    this.miniCam.updateProjectionMatrix();
    const fog = this.scene.fog;
    this.scene.fog = null;
    // People are sub-pixel from up here: skip their ~20 draw calls in the minimap pass.
    const people = this.people?.object;
    if (people) people.visible = false;
    this.figure.object.visible = false;
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(x, bottom, size, size);
    this.renderer.setViewport(x, bottom, size, size);
    this.renderer.render(this.scene, this.miniCam);
    this.renderer.setScissorTest(false);
    if (people) people.visible = true;
    this.figure.object.visible = true;
    this.scene.fog = fog;
    this.renderer.setViewport(0, 0, w, h);
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
      // While walking, walkway.ts draws the platform slabs (with the stair wells cut out).
      mesh.visible = !this.walkView;
      mesh.rotation.y = -Math.atan2(bz - az, bx - ax);
      mesh.userData = { platformId: pl.id, baseEmissive: 0.15 };
      // While walking, station.ts draws the real platform slabs.
      mesh.visible = !this.walkView;
      this.staticGroup.add(mesh);
      this.platformMeshes.push(mesh);
    }

    // Tracks, trains, roofs and station boxes (overview detail level).
    if (!this.walkView) {
      this.staticGroup.add(
        buildStations(this.g.net, {
          Y: (y) => this.Y(y),
          ex: this.exaggeration,
          dark: p.dark,
          levelVisible: (l) => this.levelVisible(l),
          walk: false,
        }),
      );
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
    // Overview markers only: walking shows the real gate machines and lift shafts (walkway.ts),
    // and a 2 m block at eye height would swallow the camera.
    if (markers.length && !this.walkView) {
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
      // A station label follows its platforms' levels (the anchor may sit on another level).
      const platLevels = this.g.net.platforms.filter((p) => p.stationId === s.id).map((p) => p.level);
      const nearest = this.g.net.levels.reduce((best, l) => (Math.abs(l.y - s.anchor[1]) < Math.abs(best.y - s.anchor[1]) ? l : best));
      const visible = platLevels.length ? platLevels.some((l) => this.levelVisible(l)) : this.levelVisible(nearest.id);
      if (!visible) continue;
      const el = document.createElement('div');
      el.className = 'lbl lbl-station';
      el.style.setProperty('--c', s.color);
      el.innerHTML = `<b>${s.badge}</b><span>${s.nameJa}</span>`;
      const obj = new CSS2DObject(el);
      obj.position.set(s.anchor[0], this.Y(s.anchor[1]) + 10, s.anchor[2]);
      this.labelGroup.add(obj);
    }
    if (this.walkView) return; // signboards take over while walking
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
    if (this.walkView) {
      // Walking: a guide line painted on the floor instead of the overview tube and pins.
      const r = this.routes[this.selected];
      if (!r) return;
      const pts = r.path.nodes.map((ni) => this.v(this.g.nodes[ni]));
      const guide = buildGuideLine(pts, this.palette.accent);
      if (guide) this.routeGroup.add(guide);
      if (this.edgeLines) (this.edgeLines.material as THREE.LineBasicMaterial).opacity = 0.25;
      return;
    }
    if (this.edgeLines) (this.edgeLines.material as THREE.LineBasicMaterial).opacity = this.routes.length ? 0.5 : 0.9;
    const p = this.palette;
    this.routes.forEach((r, idx) => {
      const isSel = idx === this.selected;
      const pts = r.path.nodes.map((ni) => this.v(this.g.nodes[ni]).add(new THREE.Vector3(0, isSel ? 1.4 : 0.9, 0)));
      if (pts.length < 2) return;
      const q = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) if (pts[i].distanceTo(pts[i + 1]) >= 0.01) q.push(pts[i + 1]);
      const nSeg = q.length - 1;
      if (nSeg === 0) return;
      // An integer number of samples per segment, so every route vertex is sampled exactly.
      const k = Math.max(1, Math.min(6, Math.floor(1200 / nSeg)));
      const geo = new THREE.TubeGeometry(new PolylineCurve(q), nSeg * k, isSel ? 1.7 : 0.9, 8, false);
      const mat = isSel
        ? new THREE.MeshLambertMaterial({ color: p.accent, emissive: p.accent, emissiveIntensity: 0.55 })
        : new THREE.MeshLambertMaterial({ color: p.alt, transparent: true, opacity: 0.55, depthWrite: false });
      const tube = new THREE.Mesh(geo, mat);
      tube.renderOrder = isSel ? 5 : 4;
      this.routeGroup.add(tube);

      if (isSel) {
        // Gate and landmark names along the route stay visible at every zoom level.
        for (const ni of r.path.nodes) {
          const n = this.g.nodes[ni];
          if (!n.label && !(n.kind === 'gate' && n.paid)) continue;
          const el = document.createElement('div');
          el.className = `lbl lbl-node lbl-${n.kind} lbl-route`;
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
    g.add(this.figure.object);
    const halo = new THREE.Mesh(new THREE.RingGeometry(4, 5.2, 32), new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.6;
    halo.name = 'halo';
    g.add(halo);
    return g;
  }

  /** Figure at crowd scale while walking, a large marker (with its halo) in the overview. */
  private setWalkerScale(): void {
    const halo = this.walker.getObjectByName('halo') as THREE.Object3D;
    const walking = !!this.walkView;
    this.figure.object.scale.setScalar(walking ? PEOPLE_SCALE : WALKER_OVERVIEW_SCALE);
    halo.userData.base = walking ? WALKER_SCALE : 1.5;
    halo.position.y = walking ? 0.12 : 0.6;
  }

  /** Maps each keyframe segment of the walker's track to the edge it walks (−1 = waiting). */
  private buildWalkerSegments(r: RouteSummary | undefined): void {
    const kf = r?.keyframes ?? [];
    const steps = r?.path.steps ?? [];
    this.walkerSegEdge = new Int32Array(Math.max(0, kf.length - 1)).fill(-1);
    let s = 0;
    for (let i = 0; i + 1 < kf.length; i++) {
      const a = kf[i];
      const b = kf[i + 1];
      if (a.x === b.x && a.y === b.y && a.z === b.z) continue; // waiting at a / b
      if (s < steps.length) this.walkerSegEdge[i] = steps[s++].edge;
    }
  }

  /** Index of the keyframe segment containing t (clamped). */
  private walkerSegment(t: number): number {
    const kf = this.walkerTrack;
    let lo = 0;
    let hi = kf.length - 1;
    if (hi < 1) return 0;
    if (t <= kf[0].t) return 0;
    if (t >= kf[hi].t) return hi - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (kf[mid].t <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  private edgeKind(e: number): EdgeKind | null {
    return e >= 0 ? this.g.edges[e].kind : null;
  }

  /** Extra height of a stair tread / escalator step above the line between two landings. */
  private flightLift(kind: EdgeKind | null): number {
    if (!this.walkView) return 0;
    if (kind === 'stairs') return 0.09 * this.exaggeration;
    if (kind === 'escalator') return 0.35;
    return 0;
  }

  private crowdVisible(i: number): boolean {
    const f = this.crowdFrame;
    if (!f) return false;
    // Same rule as the network lines: hidden only when both ends of its edge are hidden.
    const ends = this.edgeLevels[f.edgeOf[i]];
    if (!ends || this.hiddenLevels.size === 0) return true;
    return this.levelVisible(ends[0]) || this.levelVisible(ends[1]);
  }

  private crowdGroundLift(i: number): number {
    const f = this.crowdFrame;
    return f ? this.flightLift(this.edgeKind(f.edgeOf[i])) : 0;
  }

  // ---------------------------------------------------------------- public API

  setRoutes(routes: RouteSummary[], selected = 0): void {
    const prevKey = this.routes[this.selected]?.path.nodes.join(',');
    this.routes = routes;
    this.selected = Math.min(selected, Math.max(0, routes.length - 1));
    this.routeNodes = new Set(routes[this.selected]?.path.nodes ?? []);
    this.buildLabels();
    this.buildRoutes();
    this.walkerTrack = routes[this.selected]?.keyframes ?? [];
    this.buildWalkerSegments(routes[this.selected]);
    this.walker.visible = this.walkerTrack.length > 0 && this.walkView !== 'first';
    this.setWalkerTime(0);
    if (this.walkView) {
      if (routes[this.selected]?.path.nodes.join(',') !== prevKey) this.exitWalk();
      else this.buildWalkScene();
    }
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
    if (this.walkView) {
      this.savedEx = ex;
      return;
    }
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
    if (this.walkView) this.buildWalkScene();
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

  private walkerT = 0;

  setWalkerTime(t: number): void {
    const dt = Math.abs(t - this.walkerT);
    this.walkerT = t;
    if (!this.walkerTrack.length) return;
    const p = sampleKeyframes(this.walkerTrack, t);
    // What the walker is doing on this stretch: walking, climbing, riding or waiting.
    const k = this.walkerSegment(t);
    const a = this.walkerTrack[k];
    const b = this.walkerTrack[Math.min(k + 1, this.walkerTrack.length - 1)];
    const edge = this.walkerSegEdge[k] ?? -1;
    const kind = this.edgeKind(edge);
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    const riding = kind === null || kind === 'escalator' || kind === 'elevator';
    const speed = riding || b.t <= a.t ? 0 : run / (b.t - a.t);
    if (run > 0.3) this.walkerYaw = Math.atan2(b.x - a.x, b.z - a.z);
    const climb = kind === 'stairs' ? (Math.sign(b.y - a.y) as -1 | 0 | 1) : 0;
    // Stand on the flight that is actually drawn (parallel flights are shifted sideways).
    const walking = !!this.walkView;
    const ox = walking && edge >= 0 ? this.laneOffsets[edge * 2] : 0;
    const oz = walking && edge >= 0 ? this.laneOffsets[edge * 2 + 1] : 0;
    const e = dt > 2 ? 1 : 1 - Math.exp(-dt / 0.6);
    this.walkerOff.x += (ox - this.walkerOff.x) * e;
    this.walkerOff.z += (oz - this.walkerOff.z) * e;
    this.walkerLift += (this.flightLift(kind) - this.walkerLift) * (dt > 2 ? 1 : 1 - Math.exp(-dt / 0.25));
    const base = walking ? FLOOR_LIFT + this.walkerLift : 0.8;
    this.walker.position.set(p.x + this.walkerOff.x, this.Y(p.y) + base, p.z + this.walkerOff.z);
    this.figure.update(Math.min(dt, 5), speed, this.walkerYaw, climb, walking ? WALK_STAIR_SLOPE : undefined);
  }

  get walkerPosition(): THREE.Vector3 {
    return this.walker.position;
  }

  /**
   * Draws the crowd as animated people; `dt` is the simulated time since the last call (so
   * strides match how far everyone moved). Pass null to hide it.
   */
  setCrowd(frame: CrowdFrame | null, dt = 0): void {
    if (!frame || frame.count === 0) {
      this.crowdFrame = null;
      this.people?.clear();
      return;
    }
    const cap = frame.positions.length / 3;
    if (!this.people || this.people.capacity < cap) {
      if (this.people) {
        this.scene.remove(this.people.object);
        this.people.dispose();
      }
      this.people = new PeopleCrowd(cap, { detail: 'low' });
      this.scene.add(this.people.object);
    }
    this.crowdFrame = frame;
    const n = frame.count;
    if (this.crowdOffsets.length < n * 2) this.crowdOffsets = new Float32Array(cap * 2);
    // Spread people across walkways (to the right of their direction of travel) and, while
    // walking, onto the stairs / escalators actually drawn beside the node line.
    const walking = !!this.walkView;
    const off = this.crowdOffsets;
    for (let i = 0; i < n; i++) {
      const h = frame.headings[i];
      const lat = frame.lateral[i];
      const e = frame.edgeOf[i];
      off[i * 2] = -Math.cos(h) * lat + (walking ? this.laneOffsets[e * 2] : 0);
      off[i * 2 + 1] = Math.sin(h) * lat + (walking ? this.laneOffsets[e * 2 + 1] : 0);
    }
    const o = this.peopleOpts;
    o.ids = frame.ids;
    o.climbs = frame.climbs;
    o.offsets = off;
    if (walking) {
      o.scale = PEOPLE_SCALE;
      o.lift = FLOOR_LIFT;
      o.camera = this.camera;
      o.maxDistance = 260;
      o.minDistance = this.walkView === 'first' ? 2 : 2.5;
      o.maxDrawn = 350;
      o.tints = undefined;
      o.detail = 'high';
      o.stairSlope = WALK_STAIR_SLOPE;
      o.shadows = true;
    } else {
      // Each agent stands for ~20 people, so draw it well above human scale to stay visible;
      // shrink as the camera closes in.
      o.scale = 5 * overviewZoom(this.camera.position.distanceTo(this.controls.target));
      o.lift = 0;
      o.camera = undefined;
      o.maxDistance = undefined;
      o.minDistance = undefined;
      o.maxDrawn = undefined;
      o.tints = frame.colors;
      o.tintAmount = 0.6;
      o.detail = 'low';
      o.stairSlope = undefined; // overview stairs are lines: a normal stair pose is enough
      o.shadows = false;
    }
    this.people.update(frame.positions, frame.headings, frame.speeds, n, dt, o);
  }

  refreshTheme(): void {
    this.palette = readPalette();
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(this.palette.bg);
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

  private clearHover(): void {
    if (this.hovered) {
      (this.hovered.material as THREE.MeshLambertMaterial).emissiveIntensity = this.hovered.userData.baseEmissive;
      this.hovered = null;
    }
    this.renderer.domElement.style.cursor = '';
    this.events.onHoverPlatform?.(null, 0, 0);
  }

  private onPointerMove(ev: PointerEvent): void {
    if (ev.buttons) {
      this.clearHover();
      return;
    }
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
    this.clearHover();
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
    } else if (this.walkView) {
      this.updateWalkCamera(dt);
    }
    if (this.walkGroup) {
      // Cut away whatever stands between the following camera and the walker.
      this.walkCut.eye.copy(this.camera.position);
      this.walkCut.target.copy(this.walker.position).y += 1.2;
      updateWalkway(this.walkGroup, dt, this.walkView === 'first' ? null : this.walkCut);
    }
    // Minor labels only when the camera is close enough to read them.
    const camPos = this.camera.position;
    for (const obj of this.labelGroup.children) {
      if (!obj.userData.minor) continue;
      obj.visible = obj.position.distanceTo(camPos) < (this.walkView ? 120 : 520);
    }
    if (this.walkView) {
      const cur = this.currentInstruction();
      for (const obj of this.signGroup.children) {
        const i = obj.userData.instruction as number;
        obj.visible = i >= cur && i <= cur + 2 && obj.position.distanceTo(camPos) < 260;
      }
    }
    this.pulse += dt;
    const halo = this.walker.getObjectByName('halo');
    if (!this.walkView) {
      const zoom = overviewZoom(this.camera.position.distanceTo(this.controls.target));
      this.figure.object.scale.setScalar(WALKER_OVERVIEW_SCALE * zoom);
      if (halo) halo.userData.base = 1.5 * zoom;
    }
    if (halo) {
      const s = (1 + 0.25 * Math.sin(this.pulse * 4)) * ((halo.userData.base as number | undefined) ?? 1);
      halo.scale.set(s, s, s);
    }
    if (!this.walkView || this.walkView === 'orbit') this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    if (this.walkView) this.renderMinimap();
  }

  platformAt(id: string): Platform | undefined {
    return this.g.net.platforms.find((p) => p.id === id);
  }
}

// ---------------------------------------------------------------- geometry utils

/**
 * Polyline parameterised uniformly per segment (not by arc length), so that TubeGeometry samples
 * land on the vertices instead of cutting corners.
 */
class PolylineCurve extends THREE.Curve<THREE.Vector3> {
  private pts: THREE.Vector3[];

  constructor(pts: THREE.Vector3[]) {
    super();
    this.pts = pts;
  }

  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const n = this.pts.length - 1;
    const f = Math.min(Math.max(t, 0), 1) * n;
    const i = Math.min(Math.floor(f), n - 1);
    return target.lerpVectors(this.pts[i], this.pts[i + 1], f - i);
  }

  override getPointAt(u: number, target?: THREE.Vector3): THREE.Vector3 {
    return this.getPoint(u, target);
  }

  override getTangentAt(u: number, target?: THREE.Vector3): THREE.Vector3 {
    return this.getTangent(u, target);
  }
}

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
