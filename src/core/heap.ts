/** Binary min-heap of (priority, value) pairs. Stale entries are left in place; callers skip them. */
export class MinHeap<T> {
  private prio: number[] = [];
  private vals: T[] = [];

  get size(): number {
    return this.prio.length;
  }

  push(priority: number, value: T): void {
    const p = this.prio;
    const v = this.vals;
    let i = p.length;
    p.push(priority);
    v.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (p[parent] <= priority) break;
      p[i] = p[parent];
      v[i] = v[parent];
      i = parent;
    }
    p[i] = priority;
    v[i] = value;
  }

  /** Removes and returns the smallest entry, or undefined when empty. */
  pop(): { priority: number; value: T } | undefined {
    const p = this.prio;
    const v = this.vals;
    const n = p.length;
    if (n === 0) return undefined;
    const top = { priority: p[0], value: v[0] };
    const lastP = p.pop() as number;
    const lastV = v.pop() as T;
    if (n > 1) {
      let i = 0;
      const len = n - 1;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && p[r] < p[l] ? r : l;
        if (p[c] >= lastP) break;
        p[i] = p[c];
        v[i] = v[c];
        i = c;
      }
      p[i] = lastP;
      v[i] = lastV;
    }
    return top;
  }
}
