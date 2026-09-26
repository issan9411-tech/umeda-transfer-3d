import { densityBand } from '../core/congestion';
import { buildCostModel, PROFILES, type CostOptions, type Objective, type ProfileId } from '../core/cost';
import type { Graph } from '../core/graph';
import { transferMatrix, type TransferMatrix } from '../core/matrix';
import { endpointSources, endpointTargets, planRoute, type Boarding, type Endpoint, type RoutePlan } from '../core/planner';
import type { DataSet } from '../data/dataset';
import { UmedaView, type WalkView } from '../render/view';
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
  /** Camera used when playback starts ('off' keeps the overview). */
  walkView: WalkView | 'off';
  labels: boolean;
  exag: number;
  crowd: boolean;
  heat: boolean;
  live: boolean;
  matrixMode: 'typicalS' | 'bestS';
}

const STORE_KEY = 'umeda-transfer-3d:v1';
const PERSIST: (keyof State)[] = ['from', 'to', 'profile', 'objective', 'boarding', 'day', 'speed', 'hour', 'congestion', 'rain', 'rate', 'walkView', 'labels', 'exag', 'matrixMode'];
const RATES = [1, 2, 4, 10, 30];

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
    this.view.setTimeOfDay(this.state.hour);
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
      rate: 4,
      walkView: 'chase',
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
    // Anything restored from storage may be stale or hand-edited: validate every field.
    const d = this.defaults();
    const oneOf = <T extends string>(v: unknown, xs: readonly T[], def: T): T =>
      typeof v === 'string' && (xs as readonly string[]).includes(v) ? (v as T) : def;
    const num = (v: unknown, lo: number, hi: number, def: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
    const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
    s.profile = oneOf(s.profile, Object.keys(PROFILES) as ProfileId[], d.profile);
    s.objective = oneOf(s.objective, ['time', 'distance', 'comfort'] as const, d.objective);
    s.boarding = oneOf(s.boarding, ['best', 'middle'] as const, d.boarding);
    s.day = oneOf(s.day, ['weekday', 'holiday'] as const, d.day);
    s.matrixMode = oneOf(s.matrixMode, ['typicalS', 'bestS'] as const, d.matrixMode);
    s.speed = num(s.speed, 0.7, 2.0, PROFILES[s.profile].speed);
    s.hour = num(s.hour, 5, 24, d.hour);
    s.exag = num(s.exag, 1, 8, d.exag);
    s.rate = RATES.includes(s.rate) ? s.rate : d.rate;
    s.walkView = oneOf(s.walkView, ['chase', 'first', 'orbit', 'off'] as const, d.walkView);
    s.congestion = bool(s.congestion, d.congestion);
    s.rain = bool(s.rain, d.rain);
    s.labels = bool(s.labels, d.labels);
    if (typeof s.from !== 'string' || typeof s.to !== 'string' || !this.parseEndpoint(s.from) || !this.parseEndpoint(s.to)) {
      s.from = d.from;
      s.to = d.to;
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
      liveDensity: s.live && s.crowd && this.crowd ? this.crowd.density : null,
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
      if (el.checked && !this.state.crowd) {
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
        const v = Number(el.value);
        const T = this.current()?.timeS ?? 0;
        this.t = v >= T - 0.1 ? T : v;
        this.view.setWalkerTime(this.t);
        this.updateClock();
      },
      'input',
    );
    onChange('rate', (el) => {
      this.state.rate = Number(el.value);
      this.saveState();
    });
    onChange('walkView', (el) => {
      this.state.walkView = el.value as State['walkView'];
      this.saveState();
      if (this.view.walking) {
        if (this.state.walkView === 'off') this.exitWalk();
        else this.view.enterWalk(this.state.walkView);
      } else if (this.playing && this.state.walkView !== 'off') {
        this.enterWalk();
      }
    });
    $('whExit').addEventListener('click', () => this.exitWalk());
    document.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement;
      const interactive =
        ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY', 'A'].includes(el.tagName) || el.isContentEditable || el.getAttribute('role') === 'button';
      if (e.code === 'Space' && !interactive) {
        e.preventDefault();
        this.setPlaying(!this.playing);
      }
      if (e.key === 'Escape') {
        this.hideTip();
        if (this.view.walking) this.exitWalk();
      }
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
    ($('walkView') as HTMLSelectElement).value = s.walkView;
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
    if (patch.from !== undefined || patch.to !== undefined) {
      this.state.selected = 0;
      this.userPicked = false;
    }
    this.applyStateToControls();
    this.saveState();
    this.matrixDirty = true;
    const planChanged = Object.keys(patch).some((k) => k !== 'selected');
    if (planChanged) this.replan(patch.from !== undefined || patch.to !== undefined);
    if (this.tab === 'matrix') this.renderMatrix();
    if (patch.hour !== undefined || patch.day !== undefined) this.updateHeat();
    if (patch.hour !== undefined) this.view.setTimeOfDay(this.state.hour);
  }

  // ---------------------------------------------------------------- planning

  private replan(refocus: boolean): void {
    const from = this.parseEndpoint(this.state.from);
    const to = this.parseEndpoint(this.state.to);
    if (!from || !to) return;
    const srcs = new Set(endpointSources(this.g, from, 'best'));
    if (endpointTargets(this.g, to).some((t) => srcs.has(t))) {
      this.plan = null;
      this.setPlaying(false);
      this.t = 0;
      const msg = '出発と到着に同じホームが含まれています。別のホームか駅を選んでください。';
      this.setResultsHtml(`<div class="empty">${msg}</div>`);
      this.lastAnnounce = msg;
      $('resultsStatus').textContent = msg;
      this.setStepsHtml('');
      this.view.setRoutes([]);
      this.syncWalkUi();
      this.updateFloorsForRoute();
      this.updateClock();
      return;
    }
    // Keep a route the user explicitly picked (by identity, not index) across recomputation;
    // otherwise always show the new recommendation.
    const prev = refocus || !this.userPicked ? null : this.current();
    const prevKey = prev ? prev.path.nodes.join(',') : null;
    this.plan = planRoute(this.g, { from, to, options: this.costOptions(), boarding: this.state.boarding, alternatives: 3 });
    const routes = this.plan.routes;
    let sel = prevKey ? routes.findIndex((r) => r.path.nodes.join(',') === prevKey) : 0;
    if (sel < 0) {
      sel = 0;
      this.userPicked = false;
      this.t = 0;
    }
    this.state.selected = Math.max(0, Math.min(sel, routes.length - 1));
    this.view.setRoutes(routes, this.state.selected);
    if (!this.view.walking) this.syncWalkUi();
    if (!this.current()) this.setPlaying(false);
    if (refocus) {
      this.t = 0;
      this.view.focusRoute();
    }
    this.t = Math.min(this.t, this.current()?.timeS ?? 0);
    this.announce(refocus);
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
    this.userPicked = i !== 0;
    this.view.selectRoute(i);
    this.t = 0;
    this.view.setWalkerTime(0);
    // A different route ends the current walk; keep walking the new one if playback is running.
    if (this.playing) this.enterWalk();
    this.syncWalkUi();
    this.renderResults();
    this.renderSteps();
    this.updateFloorsForRoute();
    this.updateClock();
  }

  // ---------------------------------------------------------------- rendering: route panel

  private lastResultsHtml = '';
  /** True once the viewer picked an alternative card; only then is it kept across replans. */
  private userPicked = false;
  private lastStepsHtml = '';
  private lastAnnounce = '';

  /** Replaces the route cards unless nothing changed, keeping keyboard focus on the same card. */
  private setResultsHtml(html: string): void {
    if (html === this.lastResultsHtml) return;
    this.lastResultsHtml = html;
    const el = $('results');
    const focused = (document.activeElement as HTMLElement | null)?.closest('#results [data-route]')?.getAttribute('data-route') ?? null;
    el.innerHTML = html;
    el.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((b) =>
      b.addEventListener('click', () => this.selectRoute(Number(b.dataset.route))),
    );
    el.querySelector<HTMLButtonElement>('[data-walk]')?.addEventListener('click', () => this.startWalk());
    if (focused !== null) el.querySelector<HTMLButtonElement>(`[data-route="${focused}"]`)?.focus({ preventScroll: true });
  }

  private setStepsHtml(html: string): void {
    if (html === this.lastStepsHtml) return;
    this.lastStepsHtml = html;
    const el = $('steps');
    const focused = (document.activeElement as HTMLElement | null)?.closest('#steps .step-btn')?.getAttribute('data-i') ?? null;
    el.innerHTML = html;
    el.querySelectorAll<HTMLButtonElement>('.step-btn').forEach((btn) =>
      btn.addEventListener('click', () => this.jumpToStep(Number(btn.dataset.i), Number(btn.dataset.t))),
    );
    if (focused !== null) el.querySelector<HTMLButtonElement>(`.step-btn[data-i="${focused}"]`)?.focus({ preventScroll: true });
  }

  private jumpToStep(i: number, t: number): void {
    const r = this.current();
    const ins = r?.instructions[i];
    if (!r || !ins) return;
    this.t = t;
    this.view.setWalkerTime(this.t);
    this.updateClock(i);
    const [a, b] = ins.steps;
    const nodes: number[] = [];
    for (let k = Math.max(0, a); k <= Math.min(b, r.path.steps.length - 1); k++) nodes.push(r.path.steps[k].from, r.path.steps[k].to);
    if (nodes.length === 0) nodes.push(ins.kind === 'arrive' ? r.path.nodes[r.path.nodes.length - 1] : r.path.nodes[0]);
    this.view.focusNodes(nodes);
  }

  /** One-line summary for screen readers, only when the recommendation actually changes. */
  private announce(force: boolean): void {
    const r = this.plan?.routes[0];
    const s = r ? Math.round(r.timeS) : 0;
    const msg = r ? `推奨ルート ${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒 ${r.tag}` : 'この条件で通れるルートが見つかりません';
    if (!force && msg === this.lastAnnounce) return;
    this.lastAnnounce = msg;
    $('resultsStatus').textContent = msg;
  }

  private renderResults(): void {
    const plan = this.plan;
    if (!plan || plan.routes.length === 0) {
      this.setResultsHtml(`<div class="empty">この条件で通れるルートが見つかりません。「段差なし」の場合はエレベーターの無い区間があるかもしれません。条件を変えて試してください。</div>`);
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

    const walkCta = `<button type="button" class="walk-cta" data-walk="1"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>このルートを3Dで歩く</button>`;
    this.setResultsHtml(
      `<div class="route-head"><span>${escapeHtml(fromSt?.nameJa ?? '')} <span class="lvl">${r0.boardingNode.level}</span> → ${escapeHtml(toSt?.nameJa ?? '')} <span class="lvl">${r0.alightNode.level}</span></span><span>${escapeHtml(r0.levels.map(lvlName).join('→'))}</span></div>${cards}${walkCta}${boardHint}`,
    );
  }

  private renderSteps(): void {
    const r = this.current();
    if (!r) {
      this.setStepsHtml('');
      return;
    }
    let acc = 0;
    const html = r.instructions
      .map((ins, i) => {
        const start = acc;
        acc += ins.timeS;
        const time = ins.kind === 'start' ? '0:00' : ins.kind === 'arrive' ? mmss(acc) : `+${jpDuration(ins.timeS)}`;
        return `<li class="step" data-i="${i}" style="--k:${KIND_CSS[ins.kind]}"><button type="button" class="step-btn" data-i="${i}" data-t="${start}">
          <span class="step-icon">${ICONS[ins.kind]}</span>
          <span class="step-body"><span class="step-text"><span class="lvl">${ins.level}</span>${escapeHtml(ins.text)}</span>
          ${ins.detail ? `<span class="step-detail"><br>${escapeHtml(ins.detail)}</span>` : ''}</span>
          <span class="step-time">${time}</span>
        </button></li>`;
      })
      .join('');
    this.setStepsHtml(html);
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
      // Warm up ≈10 simulated minutes (longer than typical trips) so the network starts near steady state.
      for (let i = 0; i < 300; i++) this.crowd.step(2);
    }
    if (!on) {
      this.view.setCrowd(null);
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
    if (on && r && this.t >= r.timeS - 0.1) this.t = 0;
    this.playing = on && !!r;
    // Playing a route walks it in 3D unless the viewer chose to stay in the overview.
    if (this.playing && this.state.walkView !== 'off' && !this.view.walking) this.enterWalk();
    $('playIcon').setAttribute('d', this.playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M7 5v14l12-7z');
    $('play').setAttribute('aria-label', this.playing ? '一時停止' : '再生');
  }

  /** Starts the walk-through from the beginning of the selected route. */
  private startWalk(): void {
    if (!this.current()) return;
    if (this.state.walkView === 'off') {
      this.state.walkView = 'chase';
      ($('walkView') as HTMLSelectElement).value = 'chase';
      this.saveState();
    }
    this.hideTip();
    this.t = 0;
    this.view.setWalkerTime(0);
    this.setPlaying(true);
    this.updateClock();
  }

  private enterWalk(): void {
    if (!this.current() || this.state.walkView === 'off') return;
    const wasWalking = !!this.view.walking;
    this.view.enterWalk(this.state.walkView);
    this.syncWalkUi();
    // On phones the 3D view sits above the panel: bring it into view when the walk starts.
    if (!wasWalking && matchMedia('(max-width: 760px)').matches) {
      $('stage').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  }

  private exitWalk(): void {
    this.view.exitWalk();
    this.syncWalkUi();
  }

  /** Shows the walk HUD / hides overview controls to match the view's walk state. */
  private syncWalkUi(): void {
    const walking = !!this.view.walking;
    $('walkHud').hidden = !walking;
    $('stage').classList.toggle('is-walking', walking);
    ($('exag') as HTMLInputElement).disabled = walking;
    if (!walking) document.querySelectorAll('.floor').forEach((b) => b.classList.remove('is-current'));
    this.updateClock();
  }

  /** Walk HUD: current and next instruction, level and what remains. */
  private updateWalkHud(idx: number): void {
    const r = this.current();
    if (!r || !this.view.walking) return;
    const ins = r.instructions[idx];
    const next = r.instructions.slice(idx + 1).find((x) => x.kind !== 'walk' || x.distM > 25);
    const arrived = this.t >= r.timeS - 0.1;
    $('whIcon').innerHTML = ICONS[arrived ? 'arrive' : ins.kind];
    ($('whIcon') as HTMLElement).style.setProperty('--k', KIND_CSS[arrived ? 'arrive' : ins.kind]);
    $('whNow').textContent = arrived ? `到着：${r.instructions[r.instructions.length - 1].text}` : ins.text;
    $('whNext').textContent = arrived ? 'もう一度歩くには ▶ を押してください' : next ? `次：${next.text}` : '';
    const lvl = this.g.net.levels.find((l) => l.id === ins.level);
    $('whLevel').innerHTML = `<b>${escapeHtml(ins.level)}</b><span>${escapeHtml(lvl?.nameJa ?? '')}</span>`;
    // Remaining distance: later instructions plus the unfinished part of the current one.
    let acc = 0;
    for (let i = 0; i < idx; i++) acc += r.instructions[i].timeS;
    const frac = ins.timeS > 0 ? Math.min(1, Math.max(0, (this.t - acc) / ins.timeS)) : 1;
    const remainM = r.instructions.slice(idx + 1).reduce((s, x) => s + x.distM, 0) + ins.distM * (1 - frac);
    $('whRemain').textContent = arrived ? `所要 ${jpDuration(r.timeS)}・${meters(r.distM)}` : `残り 約${meters(remainM)}・${jpDuration(r.timeS - this.t)}`;
    document.querySelectorAll<HTMLButtonElement>('.floor').forEach((b) => b.classList.toggle('is-current', b.dataset.level === ins.level));
  }

  /** Updates the clock, scrubber and current-step highlight; `forceIdx` pins the highlighted step. */
  private updateClock(forceIdx?: number): void {
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
    if (this.t >= total - 0.1) idx = r.instructions.length - 1;
    if (forceIdx !== undefined) idx = forceIdx;
    const ins = r.instructions[idx];
    $('scrubNow').textContent = ins ? `${ins.level}｜${ins.text}` : '';
    document.querySelectorAll('.step').forEach((li, i) => li.classList.toggle('is-now', i === idx));
    this.updateWalkHud(idx);
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
        this.view.setCrowd(this.crowd, simDt);
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
