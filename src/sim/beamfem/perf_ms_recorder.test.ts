import { describe, it } from "vitest";
import {
  CoaxialAssembly,
  CosseratRod,
  GUIDEWIRE_DIRECT,
  SHEATH_DIRECT
} from "../cosserat";
import { buildNormalAnatomy } from "../anatomy";

/**
 * Phase F — PER-FRAME WALL-TIME RECORDER (reported, NOT asserted).
 *
 * Drives a representative shipped-resolution (h=0.5 / ~40-node) DIRECT coax frame N times and
 * console.logs the p50/p95 per-frame ms so a human can read the real budget headroom vs the
 * 16.7 ms (60 fps) frame budget.
 *
 * Deliberately NO ms assertion: wall-clock timing flakes on shared CI runners (other tenants,
 * thermal throttling, GC pauses). The HARD, CI-stable budget is the deterministic work-count gate
 * (tangentAssemblies===32, elementForceEvals<=20000) in integration_live.test.ts — this file is the
 * human-facing feel/budget number only.
 *
 * SHIPPED RESOLUTION NOTE: the committed shipped target is h=0.5 / ~40 nodes with the existing
 * numerical-Jacobian tangent. The analytic Crisfield/Battini consistent tangent + h=0.25 is the
 * DEFERRED perf upgrade (the cost lever is the tangent, not node count) and is NOT exercised here.
 */

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

describe("Phase F — direct coax per-frame ms recorder (reported, not asserted)", () => {
  it("records p50/p95 step ms for a shipped-resolution direct coax frame", () => {
    const anatomy = buildNormalAnatomy();
    const outer = new CosseratRod(anatomy, "rcfa", SHEATH_DIRECT, { deployed: 6.5, steer: 0, torque: 0 });
    const inner = new CosseratRod(anatomy, "rcfa", GUIDEWIRE_DIRECT, { deployed: 8, steer: 0.35, torque: 0 });
    const asm = new CoaxialAssembly(outer, inner);
    asm.setOuterInput(6.5, 0, 0);
    asm.setInnerInput(8, 0.35, 0);

    // Warm to a steady, representative navigating state (material fed, contacts persistent) so the
    // recorded frames reflect the in-procedure cost, not first-use setup noise.
    asm.setInnerInput(18, 0.35, 0);
    const warm = 120;
    for (let i = 0; i < warm; i++) asm.step(1 / 60);

    const N = 200;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      asm.step(1 / 60);
      samples.push(performance.now() - t0);
    }

    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const counters = asm.directPerfCounters();

    // eslint-disable-next-line no-console
    console.log(
      `[perf-ms] direct coax frame (h=0.5, ~40 nodes/instr): ` +
        `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms mean=${mean.toFixed(3)}ms ` +
        `(N=${N}, min=${samples[0].toFixed(3)} max=${samples[samples.length - 1].toFixed(3)}) ` +
        `| budget=16.7ms | last-frame tangentAssemblies=${counters.tangentAssemblies} ` +
        `elementForceEvals=${counters.elementForceEvals} ` +
        `| innerN=${inner.n} outerN=${outer.n}`
    );
    // INTENTIONALLY no ms expect(): reported number only (wall-clock flakes on CI).
  }, 60000);
});
