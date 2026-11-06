import { describe, expect, it } from 'vitest';
import { rankEndpointsForUser } from '../src/llm.js';

describe('per-user sticky load balancing', () => {
  const eps = [
    { id: 1, weight: 1 },
    { id: 2, weight: 1 },
    { id: 3, weight: 1 },
  ];

  it('is deterministic for a user and returns all endpoints as failover order', () => {
    const a = rankEndpointsForUser(eps, 'rs-user-7').map((e) => e.id);
    const b = rankEndpointsForUser([...eps].reverse(), 'rs-user-7').map((e) => e.id);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3]);
  });

  it('spreads users roughly evenly and respects weights', () => {
    const count = (list: typeof eps) => {
      const c: Record<number, number> = {};
      for (let u = 0; u < 3000; u++) {
        const id = rankEndpointsForUser(list, `rs-user-${u}`)[0].id;
        c[id] = (c[id] ?? 0) + 1;
      }
      return c;
    };
    const even = count(eps);
    for (const id of [1, 2, 3]) expect(even[id]).toBeGreaterThan(800);
    const weighted = count([{ id: 1, weight: 3 }, { id: 2, weight: 1 }]);
    expect(weighted[1] / 3000).toBeGreaterThan(0.68);
    expect(weighted[1] / 3000).toBeLessThan(0.82);
  });

  it('only moves users of a removed endpoint (cache-friendly)', () => {
    let moved = 0;
    for (let u = 0; u < 1000; u++) {
      const before = rankEndpointsForUser(eps, `rs-user-${u}`)[0].id;
      const after = rankEndpointsForUser(eps.filter((e) => e.id !== 3), `rs-user-${u}`)[0].id;
      if (before !== 3 && before !== after) moved++;
    }
    expect(moved).toBe(0);
  });
});
