import { arcIndex, type CostModel } from './cost';
import type { Graph } from './graph';
import type { Path } from './search';
import type { EdgeKind, NetNode } from './types';

export type InstructionKind = 'start' | 'walk' | 'stairs' | 'escalator' | 'elevator' | 'gate-in' | 'gate-out' | 'crossing' | 'arrive';

export interface Instruction {
  kind: InstructionKind;
  text: string;
  detail?: string;
  timeS: number;
  distM: number;
  /** Index range [from, to] into path.steps covered by this instruction (inclusive). */
  steps: [number, number];
  level: string;
  indoor: boolean;
}

const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

/** 8-way compass direction of travel from a to b (x = east, z = south). */
export function compass(a: { x: number; z: number }, b: { x: number; z: number }): string {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) < 1) return '';
  const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return DIRS[Math.round(((bearing + 360) % 360) / 45) % 8];
}

export function levelName(g: Graph, id: string): string {
  return g.net.levels.find((l) => l.id === id)?.nameJa ?? id;
}

type VerticalKind = 'stairs' | 'escalator' | 'elevator';
const VERTICAL: EdgeKind[] = ['stairs', 'escalator', 'elevator'];

export function buildInstructions(g: Graph, model: CostModel, path: Path): Instruction[] {
  const out: Instruction[] = [];
  const nodes = g.nodes;
  if (path.steps.length === 0) return out;
  const first = nodes[path.nodes[0]];
  const last = nodes[path.nodes[path.nodes.length - 1]];
  const platformName = (n: NetNode) => g.net.platforms.find((p) => p.id === n.platformId)?.nameJa;
  const stationName = (n: NetNode) => g.net.stations.find((s) => s.id === n.stationId)?.nameJa ?? '';

  out.push({
    kind: 'start',
    text: `${stationName(first)} ${platformName(first) ?? first.name}`.trim(),
    detail: first.kind === 'platform' ? `${first.name}で降車` : first.name,
    timeS: 0,
    distM: 0,
    steps: [0, -1],
    level: first.level,
    indoor: true,
  });

  let i = 0;
  const steps = path.steps;
  while (i < steps.length) {
    const st = steps[i];
    const e = g.edges[st.edge];
    const from = nodes[st.from];
    const k = arcIndex(st.edge, st.dir);

    if (e.kind === 'walk' || e.kind === 'platform') {
      // Merge consecutive level walking segments.
      let j = i;
      let t = 0;
      let d = 0;
      let indoor = true;
      const names: string[] = [];
      let platformM = 0;
      while (j < steps.length && (g.edges[steps[j].edge].kind === 'walk' || g.edges[steps[j].edge].kind === 'platform')) {
        const ej = g.edges[steps[j].edge];
        if (j > i) {
          // Split where the walk moves between a platform and a named corridor, so each part
          // keeps its own wording and compass heading.
          const prev = g.edges[steps[j - 1].edge];
          if ((prev.kind === 'platform') !== (ej.kind === 'platform') && (prev.name || ej.name)) break;
        }
        const kj = arcIndex(steps[j].edge, steps[j].dir);
        t += model.time[kj];
        d += model.dist[kj];
        indoor = indoor && ej.indoor;
        if (ej.kind === 'platform') platformM += model.dist[kj];
        if (ej.name && !names.includes(ej.name)) names.push(ej.name);
        j++;
      }
      const prevIns = out[out.length - 1];
      if (d < 3 && prevIns.kind !== 'start') {
        // Negligible hop (e.g. stair landing → gate at the same spot): fold into the previous step.
        prevIns.timeS += t;
        prevIns.distM += d;
        prevIns.steps = [prevIns.steps[0], j - 1];
        i = j;
        continue;
      }
      const to = nodes[steps[j - 1].to];
      const dir = compass(from, to);
      // "ホーム上を…" only when most of the walk really is on the platform.
      const onPlatform = platformM >= d * 0.6;
      const shown = d < 10 ? Math.max(1, Math.round(d)) : Math.round(d / 10) * 10;
      const via = names.length ? names.slice(0, 3).join(' → ') : '';
      const head = onPlatform ? 'ホーム上を' : via ? `${via}を` : '';
      out.push({
        kind: 'walk',
        text: `${head}${dir ? dir + 'へ' : ''}約${shown}m 歩く`,
        detail: `${to.name}${indoor ? '' : '（屋外）'}`,
        timeS: t,
        distM: d,
        steps: [i, j - 1],
        level: from.level,
        indoor,
      });
      i = j;
      continue;
    }

    if (VERTICAL.includes(e.kind)) {
      // Merge consecutive vertical moves of the same kind (e.g. two escalator flights).
      let j = i;
      let t = 0;
      let d = 0;
      // Only merge a monotonic move; every elevator ride is its own step (own wait).
      const sign0 = Math.sign(nodes[steps[i].to].y - nodes[steps[i].from].y);
      while (j < steps.length && g.edges[steps[j].edge].kind === e.kind) {
        const sj = Math.sign(nodes[steps[j].to].y - nodes[steps[j].from].y);
        if (j > i && (e.kind === 'elevator' || (sj !== 0 && sj !== sign0))) break;
        const kj = arcIndex(steps[j].edge, steps[j].dir);
        t += model.time[kj];
        d += model.dist[kj];
        j++;
      }
      const to = nodes[steps[j - 1].to];
      const up = to.y > from.y;
      const label = e.kind === 'stairs' ? '階段' : e.kind === 'escalator' ? 'エスカレーター' : 'エレベーター';
      const rise = Math.round(Math.abs(to.y - from.y));
      const verb = up ? '上る' : '下りる';
      out.push({
        kind: e.kind as VerticalKind,
        text:
          from.level === to.level
            ? `${label}で約${rise}m${verb}`
            : `${label}で${levelName(g, from.level)}から${levelName(g, to.level)}へ${verb}`,
        detail: `${e.name ? e.name + '・' : ''}高低差 約${rise}m`,
        timeS: t,
        distM: d,
        steps: [i, j - 1],
        level: to.level,
        indoor: e.indoor,
      });
      i = j;
      continue;
    }

    const to = nodes[st.to];
    if (e.kind === 'gate') {
      const exiting = from.paid === true && to.paid !== true;
      const gateNode = from.kind === 'gate' ? from : to;
      out.push({
        kind: exiting ? 'gate-out' : 'gate-in',
        text: `${e.name ?? gateNode.name}${exiting ? 'を出る' : 'から入る'}`,
        detail: `${stationName(gateNode)}・${levelName(g, gateNode.level)}`,
        timeS: model.time[k],
        distM: model.dist[k],
        steps: [i, i],
        level: gateNode.level,
        indoor: e.indoor,
      });
    } else {
      out.push({
        kind: 'crossing',
        text: `${e.name ?? '横断歩道'}を渡る`,
        detail: `信号待ち込み 約${Math.round(model.time[k])}秒`,
        timeS: model.time[k],
        distM: model.dist[k],
        steps: [i, i],
        level: to.level,
        indoor: e.indoor,
      });
    }
    i++;
  }

  out.push({
    kind: 'arrive',
    text: `${stationName(last)} ${platformName(last) ?? last.name}`.trim(),
    detail: last.kind === 'platform' ? `${last.name}に到着` : last.name,
    timeS: 0,
    distM: 0,
    steps: [steps.length, steps.length - 1],
    level: last.level,
    indoor: true,
  });
  return out;
}
