import { densityBand } from '../core/congestion';
import { buildCostModel, PROFILES, type CostOptions, type Objective, type ProfileId } from '../core/cost';
import type { Graph } from '../core/graph';
import { transferMatrix, type TransferMatrix } from '../core/matrix';
import { endpointSources, endpointTargets, planRoute, type Boarding, type Endpoint, type RoutePlan } from '../core/planner';
import type { DataSet } from '../data/dataset';
import { UmedaView } from '../render/view';
import { KIND_COLORS } from '../render/palette';
import { CrowdSim, type Endpoint as CrowdEndpoint } from '../sim/crowd';
import { escapeHtml, hourLabel, jpDuration, meters, minutes, mmss, readableOn } from './format';
import { ICONS, KIND_CSS } from './icons';
import { renderAbout } from './about';

interface State {
  from: string;
  to: string;
  profile: ProfileId;
  objective: Objective;
  boarding: Boarding;
  day: 'weekday' | 'holiday';
  speed: number;
  hour: number;
  congestion: boolean;
  rain: boolean;
  selected: number;
  rate: number;
  follow: boolean;
  labels: boolean;
  exag: number;
  crowd: boolean;
  heat: boolean;
  live: boolean;
  matrixMode: 'typicalS' | 'bestS';
}

const STORE_KEY = 'umeda-transfer-3d:v1';
const PERSIST: (keyof State)[] = ['from', 'to', 'profile', 'objective', 'boarding', 'day', 'speed', 'hour', 'congestion', 'rain', 'rate', 'labels', 'exag', 'matrixMode'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class App {
  private g: Graph;
  private data: DataSet;
  private view: UmedaView;
  private state: State;
  private plan: RoutePlan | null = null;
  private t = 0;
  private playing = false;
  private crowd: CrowdSim | null = null;
  private matrix: TransferMatrix | null = null;
  private matrixDirty = true;
  private liveTimer = 0;
  private heatTimer = 0;
  private tab: 'route' | 'matrix' | 'about' = 'route';

  constructor(g: Graph, data: DataSet) {
    this.g = g;
    this.data = data;
    this.state = this.loadState();
    this.view = new UmedaView($('scene'), g, {
      onPickPlatform: (id, x, y) => this.showPlatformPopover(id, x, y),
      onHoverPlatform: (id, x, y) => this.showPlatformTip(id, x, y),
      onEmptyClick: () => this.hideTip(),
    });
    this.buildControls();
    this.applyStateToControls();
    this.view.setExaggeration(this.state.exag);
    this.view.setLabels(this.state.labels);
    this.replan(true);
    this.renderStats();
    this.renderLegend();
    $('pane-about').innerHTML = renderAbout(g, data);
    this.watchTheme();
    this.loop();
  }

  // ---------------------------------------------------------------- state

  private defaults(): State {
    return {
      from: this.data.defaultRoute.from,
      to: this.data.defaultRoute.to,
      profile: 'standard',
      objective: 'time',
      boarding: 'best',
      day: 'weekday',
      speed: PROFILES.standard.speed,
      hour: 8.5,
      congestion: true,
      rain: false,
      selected: 0,
      rate: 10,
      follow: false,
      labels: true,
      exag: 4,
      crowd: false,
      heat: false,
      live: false,
      matrixMode: 'typicalS',
    };
  }

  private loadState(): State {
    const s = this.defaults();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<State>;
        for (const k of PERSIST) if (saved[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = saved[k];
      }
    } catch {
      /* storage unavailable: use defaults */
    }
    if (!this.parseEndpoint(s.from) || !this.parseEndpoint(s.to)) {
      s.from = this.data.defaultRoute.from;
      s.to = this.data.defaultRoute.to;
    }
    return s;
  }

  private saveState(): void {
    try {
      const out: Record<string, unknown> = {};
      for (const k of PERSIST) out[k] = this.state[k];
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {
      /* ignore */
    }
  }

  private costOptions(): CostOptions {
    const s = this.state;
    return {
      profile: s.profile,
      speed: s.speed,
      objective: s.objective,
      rain: s.rain,
      hour: s.hour,
      day: s.day,
      congestion: s.congestion,
      liveDensity: s.live && this.crowd ? this.crowd.density : null,
    };
  }

  private parseEndpoint(v: string): Endpoint | null {
    const [kind, id] = v.split(':');
    if (kind === 'station') return this.g.net.stations.some((s) => s.id === id) ? { stationId: id } : null;
    const p = this.g.net.platforms.find((x) => x.id === id);
    return p ? { stationId: p.stationId, platformId: p.id } : null;
  }

  // ---------------------------------------------------------------- controls

  private buildControls(): void {
    const net = this.g.net;
    const lineName = (id: string) => net.lines.find((l) => l.id === id)?.nameJa ?? id;
    const options = net.stations
      .map((st) => {
        const ps = net.platforms.filter((p) => p.stationId === st.id);
        const opts = [`<option value="station:${st.id}">${escapeHtml(st.nameJa)}（どのホームでも）</option>`];
        for (const p of ps) {
          const lines = p.lineIds.map(lineName).join('・');
          opts.push(`<option value="platform:${p.id}">${escapeHtml(`${st.nameJa} ${p.nameJa}｜${lines}`)}</option>`);
        }
        return `<optgroup label="${escapeHtml(`${st.badge} ${st.nameJa}`)}">${opts.join('')}</optgroup>`;
      })
      .join('');
    $('from').innerHTML = options;
    $('to').innerHTML = options;

    $('profiles').insertAdjacentHTML(
      'beforeend',
      Object.values(PROFILES)
        .map(
          (p) =>
            `<label class="chip" title="${escapeHtml(p.descJa)}"><input type="radio" name="profile" value="${p.id}" id="profile-${p.id}" /><span>${escapeHtml(p.nameJa)}</span></label>`,
        )
        .join(''),
    );

    const onChange = (id: string, fn: (el: HTMLInputElement & HTMLSelectElement) => void, ev = 'change') =>
      $(id).addEventListener(ev, (e) => fn(e.currentTarget as HTMLInputElement & HTMLSelectElement));

    onChange('from', (el) => this.set({ from: el.value }));
    onChange('to', (el) => this.set({ to: el.value }));
    $('swap').addEventListener('click', () => this.set({ from: this.state.to, to: this.state.from }));
    $('profiles').addEventListener('change', (e) => {
      const id = (e.target as HTMLInputElement).value as ProfileId;
      this.set({ profile: id, speed: PROFILES[id].speed });
    });
    onChange('objective', (el) => this.set({ objective: el.value as Objective }));
    onChange('boarding', (el) => this.set({ boarding: el.value as Boarding }));
    onChange('day', (el) => this.set({ day: el.value as State['day'] }));
    onChange('speed', (el) => this.set({ speed: Number(el.value) }), 'input');
    onChange('hour', (el) => this.set({ hour: Number(el.value) }), 'input');
    onChange('congestion', (el) => this.set({ congestion: el.checked }));
    onChange('rain', (el) => this.set({ rain: el.checked }));

    // Tabs
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) =>
      b.addEventListener('click', () => this.showTab(b.dataset.tab as App['tab'])),
    );
    document.querySelectorAll<HTMLInputElement>('input[name="mmode"]').forEach((r) =>
      r.addEventListener('change', () => {
        this.state.matrixMode = r.value as State['matrixMode'];
        this.saveState();
        this.renderMatrix();
      }),
    );

    // HUD
    document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('[data-cam]').forEach((x) => x.classList.toggle('is-active', x === b));
        this.view.setCamera(b.dataset.cam as 'overview');
      }),
    );
    onChange(
      'exag',
      (el) => {
        this.state.exag = Number(el.value);
        $('exagOut').textContent = `×${this.state.exag}`;
        this.view.setExaggeration(this.state.exag);
        this.saveState();
      },
      'input',
    );
    onChange('labels', (el) => {
      this.state.labels = el.checked;
      this.view.setLabels(el.checked);
      this.saveState();
    });
    onChange('crowd', (el) => this.toggleCrowd(el.checked));
    onChange('heat', (el) => {
      this.state.heat = el.checked;
      this.updateHeat();
      this.renderLegend();
    });
    onChange('live', (el) => {
      this.state.live = el.checked;
      if (el.checked && !this.crowd) {
        ($('crowd') as HTMLInputElement).checked = true;
        this.toggleCrowd(true);
      }
      this.replan(false);
    });

    // Floors (elevator-panel buttons, top floor first)
    const levels = [...net.levels].filter((l) => this.g.nodes.some((n) => n.level === l.id)).sort((a, b) => b.y - a.y);
    $('floorbar').innerHTML = levels
      .map((l) => `<button type="button" class="floor is-on" data-level="${l.id}" title="${escapeHtml(l.nameJa)}" aria-pressed="true">${l.id}</button>`)
      .join('');
    $('floorbar').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.floor');
      if (!b) return;
      const lvl = b.dataset.level as string;
      const on = !this.view.isLevelVisible(lvl);
      this.view.setLevelVisible(lvl, on);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });

    // Playback
    $('play').addEventListener('click', () => this.setPlaying(!this.playing));
    onChange(
      'scrub',
      (el) => {
        this.t = Number(el.value);
        this.view.setWalkerTime(this.t);
        this.updateClock();
      },
      'input',
    );
    onChange('rate', (el) => {
      this.state.rate = Number(el.value);
      this.saveState();
    });
    onChange('follow', (el) => {
      this.state.follow = el.checked;
      this.view.setFollow(el.checked);
    });
    document.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) {
        e.preventDefault();
        this.setPlaying(!this.playing);
      }
      if (e.key === 'Escape') this.hideTip();
    });
  }

  private applyStateToControls(): void {
    const s = this.state;
    ($('from') as HTMLSelectElement).value = s.from;
    ($('to') as HTMLSelectElement).value = s.to;
    const radio = document.getElementById(`profile-${s.profile}`) as HTMLInputElement | null;
    if (radio) radio.checked = true;
    ($('objective') as HTMLSelectElement).value = s.objective;
    ($('boarding') as HTMLSelectElement).value = s.boarding;
    ($('day') as HTMLSelectElement).value = s.day;
    ($('speed') as HTMLInputElement).value = String(s.speed);
    $('speedOut').textContent = `${s.speed.toFixed(2)} m/s`;
    ($('hour') as HTMLInputElement).value = String(s.hour);
    $('hourOut').textContent = hourLabel(s.hour);
    ($('congestion') as HTMLInputElement).checked = s.congestion;
    ($('rain') as HTMLInputElement).checked = s.rain;
    ($('rate') as HTMLSelectElement).value = String(s.rate);
    ($('labels') as HTMLInputElement).checked = s.labels;
    ($('exag') as HTMLInputElement).value = String(s.exag);
    $('exagOut').textContent = `×${s.exag}`;
    document.querySelectorAll<HTMLInputElement>('input[name="mmode"]').forEach((r) => (r.checked = r.value === s.matrixMode));
    const p = PROFILES[s.profile];
    const objLabel = { time: '時間優先', distance: '距離優先', comfort: '楽さ優先' }[s.objective];
    $('optSummary').textContent = [
      objLabel,
      s.day === 'weekday' ? '平日' : '土休日',
      hourLabel(s.hour),
      s.congestion ? '混雑考慮' : '',
      s.rain ? '雨' : '',
      `${p.nameJa} ${s.speed.toFixed(2)}m/s`,
    ]
      .filter(Boolean)
      .join('・');
  }

  private set(patch: Partial<State>): void {
    Object.assign(this.state, patch);
    if (patch.from !== undefined || patch.to !== undefined) this.state.selected = 0;
    this.applyStateToControls();
    this.saveState();
    this.matrixDirty = true;
    const planChanged = Object.keys(patch).some((k) => k !== 'selected');
    if (planChanged) this.replan(patch.from !== undefined || patch.to !== undefined);
    if (this.tab === 'matrix') this.renderMatrix();
  }

  // ---------------------------------------------------------------- planning

  private replan(refocus: boolean): void {
    const from = this.parseEndpoint(this.state.from);
    const to = this.parseEndpoint(this.state.to);
    if (!from || !to) return;
    const srcs = new Set(endpointSources(this.g, from, 'best'));
    if (endpointTargets(this.g, to).some((t) => srcs.has(t))) {
      this.plan = null;
      $('results').innerHTML = `<div class="empty">出発と到着に同じホームが含まれています。別のホームか駅を選んでください。</div>`;
      $('steps').innerHTML = '';
      this.view.setRoutes([]);
      this.updateFloorsForRoute();
      return;
    }
    const prevSel = this.state.selected;
    this.plan = planRoute(this.g, { from, to, options: this.costOptions(), boarding: this.state.boarding, alternatives: 3 });
    this.state.selected = Math.min(prevSel, Math.max(0, this.plan.routes.length - 1));
    this.view.setRoutes(this.plan.routes, this.state.selected);
    if (refocus) {
      this.t = 0;
      this.view.focusRoute();
    }
    this.t = Math.min(this.t, this.current()?.timeS ?? 0);
    this.view.setWalkerTime(this.t);
    this.renderResults();
    this.renderSteps();
    this.updateFloorsForRoute();
    this.updateClock();
  }

  private current() {
    return this.plan?.routes[this.state.selected] ?? null;
  }

  private selectRoute(i: number): void {
    this.state.selected = i;
    this.view.selectRoute(i);
    this.t = 0;
    this.view.setWalkerTime(0);
    this.renderResults();
    this.renderSteps();
    this.updateFloorsForRoute();
    this.updateClock();
  }

  // ---------------------------------------------------------------- rendering: route panel

  private renderResults(): void {
    const plan = this.plan;
    const el = $('results');
    if (!plan || plan.routes.length === 0) {
      el.innerHTML = `<div class="empty">この条件で通れるルートが見つかりません。「段差なし」の場合はエレベーターの無い区間があるかもしれません。条件を変えて試してください。</div>`;
      return;
    }
    const net = this.g.net;
    const st = (id?: string) => net.stations.find((s) => s.id === id);
    const r0 = this.current() ?? plan.routes[0];
    const fromSt = st(r0.boardingNode.stationId);
    const toSt = st(r0.alightNode.stationId);
    const lvlName = (id: string) => net.levels.find((l) => l.id === id)?.nameJa ?? id;
    const cards = plan.routes
      .map((r, i) => {
        const band = densityBand(r.maxDensity);
        const rank = i === 0 ? '推奨' : `代替${i}`;
        const meta = [
          `<span>${meters(r.distM)}</span>`,
          r.climbUpM > 0.5 ? `<span>↑${Math.round(r.climbUpM)}m</span>` : '',
          r.climbDownM > 0.5 ? `<span>↓${Math.round(r.climbDownM)}m</span>` : '',
          r.counts.stairs ? `<span style="color:#e36c2f">階段${r.counts.stairs}</span>` : '',
          r.counts.escalator ? `<span style="color:#13a3a8">ES${r.counts.escalator}</span>` : '',
          r.counts.elevator ? `<span style="color:#2fa84f">EV${r.counts.elevator}</span>` : '',
          r.counts.gate ? `<span>改札${r.counts.gate}</span>` : '',
          r.outdoorM > 5 ? `<span>屋外${Math.round(r.outdoorM)}m</span>` : '<span>全屋内</span>',
          this.state.congestion || this.state.live ? `<span class="pill lv${band.level}">${band.label}</span>` : '',
        ].join('');
        return `<button type="button" class="card${i === this.state.selected ? ' is-selected' : ''}" data-route="${i}" aria-pressed="${i === this.state.selected}">
          <span class="card-rank">${rank}</span>
          <span class="card-time">${Math.floor(Math.round(r.timeS) / 60)}<small>分</small>${String(Math.round(r.timeS) % 60).padStart(2, '0')}<small>秒</small></span>
          <span class="card-tag">${escapeHtml(r.tag)}</span>
          <span class="card-meta">${meta}</span>
        </button>`;
      })
      .join('');

    const boardHint =
      this.state.boarding === 'best' && r0.boardingNode.kind === 'platform'
        ? `<div class="hint"><span class="hint-icon">乗</span><div>おすすめ乗車位置：<b>${escapeHtml(r0.boardingNode.name)}</b><br><span style="color:var(--ink-3)">この位置で降りると乗換が最短になります</span></div></div>`
        : '';

    el.innerHTML = `<div class="route-head"><span>${escapeHtml(fromSt?.nameJa ?? '')} <span class="lvl">${r0.boardingNode.level}</span> → ${escapeHtml(toSt?.nameJa ?? '')} <span class="lvl">${r0.alightNode.level}</span></span><span>${escapeHtml(r0.levels.map(lvlName).join('→'))}</span></div>${cards}${boardHint}`;
    el.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((b) =>
      b.addEventListener('click', () => this.selectRoute(Number(b.dataset.route))),
    );
  }

  private renderSteps(): void {
    const r = this.current();
    const el = $('steps');
    if (!r) {
      el.innerHTML = '';
      return;
    }
    let acc = 0;
    el.innerHTML = r.instructions
      .map((ins, i) => {
        const start = acc;
        acc += ins.timeS;
        const time = ins.kind === 'start' ? '0:00' : ins.kind === 'arrive' ? mmss(acc) : `+${jpDuration(ins.timeS)}`;
        return `<li class="step" data-i="${i}" data-t="${start}" style="--k:${KIND_CSS[ins.kind]}">
          <span class="step-icon">${ICONS[ins.kind]}</span>
          <span class="step-body"><span class="step-text"><span class="lvl">${ins.level}</span>${escapeHtml(ins.text)}</span>
          ${ins.detail ? `<span class="step-detail"><br>${escapeHtml(ins.detail)}</span>` : ''}</span>
          <span class="step-time">${time}</span>
        </li>`;
      })
      .join('');
    el.querySelectorAll<HTMLLIElement>('.step').forEach((li) =>
      li.addEventListener('click', () => {
        const ins = r.instructions[Number(li.dataset.i)];
        this.t = Number(li.dataset.t);
        this.view.setWalkerTime(this.t);
        this.updateClock();
        const [a, b] = ins.steps;
        const nodes: number[] = [];
        for (let k = Math.max(0, a); k <= Math.min(b, r.path.steps.length - 1); k++) nodes.push(r.path.steps[k].from, r.path.steps[k].to);
        if (nodes.length === 0) nodes.push(ins.kind === 'arrive' ? r.path.nodes[r.path.nodes.length - 1] : r.path.nodes[0]);
        this.view.focusNodes(nodes);
      }),
    );
  }

  private updateFloorsForRoute(): void {
    const used = new Set(this.current()?.levels ?? []);
    document.querySelectorAll<HTMLButtonElement>('.floor').forEach((b) => b.classList.toggle('is-route', used.has(b.dataset.level as string)));
  }

  private renderStats(): void {
    const n = this.g.net;
    $('netStats').innerHTML = `${n.stations.length}駅 ${n.platforms.length}ホーム<br>ノード ${n.nodes.length} · リンク ${n.edges.length}`;
  }

  private renderLegend(): void {
    const items = this.state.heat
      ? `<span><i style="background:linear-gradient(90deg,#1fa85a,#eaa81a,#eb3d2e);width:60px"></i>混雑度（空 → 密）</span>`
      : [
          ['通路', KIND_COLORS.walk],
          ['階段', KIND_COLORS.stairs],
          ['エスカレーター', KIND_COLORS.escalator],
          ['エレベーター', KIND_COLORS.elevator],
          ['改札', KIND_COLORS.gate],
          ['横断歩道', KIND_COLORS.crossing],
        ]
          .map(([name, c]) => `<span><i style="background:#${(c as number).toString(16).padStart(6, '0')}"></i>${name}</span>`)
          .join('');
    $('legend').innerHTML = `${items}<span><i style="background:var(--accent);height:5px"></i>選択ルート</span>`;
  }

  // ---------------------------------------------------------------- matrix

  private showTab(tab: App['tab']): void {
    this.tab = tab;
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll<HTMLElement>('.tabpane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
    if (tab === 'matrix') this.renderMatrix();
  }

  private renderMatrix(): void {
    if (this.matrixDirty || !this.matrix) {
      const opts = { ...this.costOptions(), liveDensity: null };
      this.matrix = transferMatrix(this.g, opts);
      this.matrixDirty = false;
    }
    const m = this.matrix;
    const key = this.state.matrixMode;
    const st = (id: string) => this.g.net.stations.find((s) => s.id === id);
    const head = m.stations
      .map((id) => {
        const s = st(id);
        return `<th scope="col" title="${escapeHtml(s?.nameJa ?? id)}"><span class="mh" style="--c:${s?.color}">${escapeHtml(s?.short ?? id)}</span></th>`;
      })
      .join('');
    const rows = m.cells
      .map((row, i) => {
        const s = st(m.stations[i]);
        const cells = row
          .map((c, j) => {
            if (i === j) return `<td class="diag" aria-label="同じ駅"></td>`;
            const v = c[key];
            const bg = matrixColor(v);
            const title = `${st(c.from)?.nameJa} → ${st(c.to)?.nameJa}\n標準 ${jpDuration(c.typicalS)} / 最短 ${jpDuration(c.bestS)} / 最長 ${jpDuration(c.worstS)}\n歩行 約${Math.round(c.distM)}m`;
            return `<td><button type="button" data-from="${c.from}" data-to="${c.to}" style="background:${bg};color:${readableOn(bg)}" title="${escapeHtml(title)}">${minutes(v)}</button></td>`;
          })
          .join('');
        return `<tr><th scope="row" title="${escapeHtml(s?.nameJa ?? '')}"><span class="mh" style="--c:${s?.color}">${escapeHtml(s?.short ?? '')}</span></th>${cells}</tr>`;
      })
      .join('');
    $('matrixWrap').innerHTML = `<table class="matrix"><thead><tr><th scope="col" class="corner"><span>出発↓ 到着→</span></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    $('matrixWrap').querySelectorAll<HTMLButtonElement>('button[data-from]').forEach((b) =>
      b.addEventListener('click', () => {
        this.set({ from: `station:${b.dataset.from}`, to: `station:${b.dataset.to}` });
        this.showTab('route');
      }),
    );
    $('matrixLegend').innerHTML = `<span>単位：分</span><span>2</span><span class="ramp" style="background:linear-gradient(90deg,${[2, 5, 8, 11, 14].map((x) => matrixColor(x * 60)).join(',')})"></span><span>14+</span>`;
  }

  // ---------------------------------------------------------------- crowd simulation

  private toggleCrowd(on: boolean): void {
    this.state.crowd = on;
    if (on && !this.crowd) {
      const colors = new Map(this.g.net.stations.map((s) => [s.id, parseInt(s.color.replace('#', ''), 16)]));
      const endpoints: CrowdEndpoint[] = [];
      for (const s of this.g.net.stations) {
        const nodes = this.g.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === 'platform' && n.stationId === s.id);
        const w = (this.data.ridership[s.id] ?? 1) / Math.max(1, nodes.length);
        for (const { i } of nodes) endpoints.push({ node: i, weight: w, stationId: s.id });
      }
      const ents = this.g.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === 'entrance');
      for (const { i } of ents) endpoints.push({ node: i, weight: this.data.entranceWeight / Math.max(1, ents.length) });
      this.crowd = new CrowdSim(this.g, endpoints, colors);
      this.crowd.hour = this.state.hour;
      this.crowd.day = this.state.day;
      // Warm up so the network is populated immediately.
      for (let i = 0; i < 90; i++) this.crowd.step(2);
    }
    if (!on) {
      this.view.setCrowd(null, null, 0);
      if (this.state.live) {
        this.state.live = false;
        ($('live') as HTMLInputElement).checked = false;
        this.replan(false);
      }
      $('simStats').textContent = '';
    }
    this.updateHeat();
  }

  private updateHeat(): void {
    if (!this.state.heat) {
      this.view.setHeat(null);
      return;
    }
    if (this.crowd && this.state.crowd) this.view.setHeat(this.crowd.density);
    else {
      const m = buildCostModel(this.g, { ...this.costOptions(), congestion: true, liveDensity: null });
      this.view.setHeat(m.density);
    }
  }

  // ---------------------------------------------------------------- playback

  private setPlaying(on: boolean): void {
    const r = this.current();
    if (on && r && this.t >= r.timeS) this.t = 0;
    this.playing = on && !!r;
    $('playIcon').setAttribute('d', this.playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M7 5v14l12-7z');
    $('play').setAttribute('aria-label', this.playing ? '一時停止' : '再生');
  }

  private updateClock(): void {
    const r = this.current();
    const total = r?.timeS ?? 0;
    const scrub = $('scrub') as HTMLInputElement;
    scrub.max = String(Math.max(1, total));
    scrub.value = String(this.t);
    $('clock').textContent = `${mmss(this.t)} / ${mmss(total)}`;
    if (!r) {
      $('scrubNow').textContent = '';
      return;
    }
    let acc = 0;
    let idx = 0;
    for (let i = 0; i < r.instructions.length; i++) {
      if (this.t >= acc - 1e-6) idx = i;
      acc += r.instructions[i].timeS;
      if (this.t < acc) break;
    }
    if (this.t >= total - 1e-6) idx = r.instructions.length - 1;
    const ins = r.instructions[idx];
    $('scrubNow').textContent = ins ? `${ins.level}｜${ins.text}` : '';
    document.querySelectorAll('.step').forEach((li, i) => li.classList.toggle('is-now', i === idx));
  }

  private loop(): void {
    let last = performance.now();
    let clockTick = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const r = this.current();
      if (this.playing && r) {
        this.t = Math.min(r.timeS, this.t + dt * this.state.rate);
        this.view.setWalkerTime(this.t);
        clockTick += dt;
        if (clockTick > 0.1) {
          clockTick = 0;
          this.updateClock();
        }
        if (this.t >= r.timeS) {
          this.setPlaying(false);
          this.updateClock();
        }
      }
      if (this.crowd && this.state.crowd) {
        this.crowd.hour = this.state.hour;
        this.crowd.day = this.state.day;
        const simDt = dt * Math.max(4, this.state.rate);
        const n = Math.ceil(simDt / 1.5);
        for (let i = 0; i < n; i++) this.crowd.step(simDt / n);
        this.view.setCrowd(this.crowd.positions, this.crowd.colors, this.crowd.count);
        this.heatTimer += dt;
        if (this.heatTimer > 0.5) {
          this.heatTimer = 0;
          if (this.state.heat) this.view.updateEdgeColors();
          $('simStats').textContent = `歩行者 約${this.crowd.people.toLocaleString('ja-JP')}人 / ${hourLabel(this.state.hour)}`;
        }
        if (this.state.live) {
          this.liveTimer += dt;
          if (this.liveTimer > 4) {
            this.liveTimer = 0;
            this.replan(false);
          }
        }
      }
      this.view.frame(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- tooltips

  private platformInfo(id: string): string {
    const net = this.g.net;
    const p = net.platforms.find((x) => x.id === id);
    if (!p) return '';
    const s = net.stations.find((x) => x.id === p.stationId);
    const lines = p.lineIds.map((l) => net.lines.find((x) => x.id === l)?.nameJa ?? l).join('・');
    return `<b>${escapeHtml(s?.nameJa ?? '')} ${escapeHtml(p.nameJa)}</b><br>${escapeHtml(lines)}${p.directions ? `<br><span style="opacity:.75">${escapeHtml(p.directions)}</span>` : ''}`;
  }

  private tipPinned = false;

  private showPlatformTip(id: string | null, x: number, y: number): void {
    if (this.tipPinned) return;
    const tip = $('tip');
    if (!id) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = this.platformInfo(id);
    tip.style.pointerEvents = 'none';
    this.placeTip(tip, x, y);
  }

  private showPlatformPopover(id: string, x: number, y: number): void {
    const tip = $('tip');
    this.tipPinned = true;
    tip.innerHTML = `${this.platformInfo(id)}<div style="display:flex;gap:6px;margin-top:6px">
      <button type="button" data-set="from" style="flex:1;border:0;border-radius:6px;padding:4px 8px;background:var(--from);color:#fff;cursor:pointer">ここから乗換</button>
      <button type="button" data-set="to" style="flex:1;border:0;border-radius:6px;padding:4px 8px;background:var(--to);color:#fff;cursor:pointer">ここへ乗換</button></div>`;
    tip.style.pointerEvents = 'auto';
    this.placeTip(tip, x, y);
    tip.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) =>
      b.addEventListener('click', () => {
        this.set(b.dataset.set === 'from' ? { from: `platform:${id}` } : { to: `platform:${id}` });
        this.hideTip();
      }),
    );
  }

  private placeTip(tip: HTMLElement, x: number, y: number): void {
    tip.hidden = false;
    const stage = $('stage');
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.min(stage.clientWidth - w - 8, x + 14)}px`;
    tip.style.top = `${Math.max(8, Math.min(stage.clientHeight - h - 8, y + 14))}px`;
  }

  private hideTip(): void {
    this.tipPinned = false;
    $('tip').hidden = true;
  }

  private watchTheme(): void {
    const refresh = () => requestAnimationFrame(() => this.view.refreshTheme());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}

/** Sequential ramp for transfer minutes: pale green (quick) → amber → red (long). */
export function matrixColor(seconds: number): string {
  if (!Number.isFinite(seconds)) return '#cccccc';
  const stops: [number, [number, number, number]][] = [
    [120, [214, 240, 222]],
    [300, [255, 232, 150]],
    [480, [250, 180, 90]],
    [660, [232, 110, 70]],
    [840, [190, 50, 60]],
  ];
  const s = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], seconds));
  for (let i = 1; i < stops.length; i++) {
    if (s <= stops[i][0]) {
      const [s0, c0] = stops[i - 1];
      const [s1, c1] = stops[i];
      const f = (s - s0) / (s1 - s0);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
      return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return '#be323c';
}
