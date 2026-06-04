import { describe, expect, it } from "vitest";
import { keyHints, resolveAction } from "./controls";

describe("keyboard control mapping", () => {
  describe("QWERTY wire cluster (WASD)", () => {
    it("maps W/S to wire feed +/-", () => {
      expect(resolveAction("qwerty", "w")).toEqual({ type: "device", device: "wire", control: "feed", sign: 1 });
      expect(resolveAction("qwerty", "s")).toEqual({ type: "device", device: "wire", control: "feed", sign: -1 });
    });
    it("maps A/D to wire torque -/+", () => {
      expect(resolveAction("qwerty", "a")).toEqual({ type: "device", device: "wire", control: "torque", sign: -1 });
      expect(resolveAction("qwerty", "d")).toEqual({ type: "device", device: "wire", control: "torque", sign: 1 });
    });
    it("is case-insensitive", () => {
      expect(resolveAction("qwerty", "W")).toEqual({ type: "device", device: "wire", control: "feed", sign: 1 });
    });
    it("does NOT bind z or q on QWERTY", () => {
      expect(resolveAction("qwerty", "z")).toBeNull();
      expect(resolveAction("qwerty", "q")).toBeNull();
    });
  });

  describe("AZERTY wire cluster (ZQSD)", () => {
    it("maps Z/S to wire feed +/- (W→Z swap)", () => {
      expect(resolveAction("azerty", "z")).toEqual({ type: "device", device: "wire", control: "feed", sign: 1 });
      expect(resolveAction("azerty", "s")).toEqual({ type: "device", device: "wire", control: "feed", sign: -1 });
    });
    it("maps Q/D to wire torque -/+ (A→Q swap)", () => {
      expect(resolveAction("azerty", "q")).toEqual({ type: "device", device: "wire", control: "torque", sign: -1 });
      expect(resolveAction("azerty", "d")).toEqual({ type: "device", device: "wire", control: "torque", sign: 1 });
    });
    it("does NOT bind w or a on AZERTY", () => {
      expect(resolveAction("azerty", "w")).toBeNull();
      expect(resolveAction("azerty", "a")).toBeNull();
    });
  });

  describe("sheath arrow cluster (layout-independent)", () => {
    for (const layout of ["qwerty", "azerty"] as const) {
      it(`maps arrows to sheath feed/torque on ${layout}`, () => {
        expect(resolveAction(layout, "ArrowUp")).toEqual({ type: "device", device: "sheath", control: "feed", sign: 1 });
        expect(resolveAction(layout, "ArrowDown")).toEqual({ type: "device", device: "sheath", control: "feed", sign: -1 });
        expect(resolveAction(layout, "ArrowLeft")).toEqual({ type: "device", device: "sheath", control: "torque", sign: -1 });
        expect(resolveAction(layout, "ArrowRight")).toEqual({ type: "device", device: "sheath", control: "torque", sign: 1 });
      });
    }
  });

  describe("global commands (layout-stable)", () => {
    for (const layout of ["qwerty", "azerty"] as const) {
      it(`F/C/R map to view/inject/reset on ${layout}`, () => {
        expect(resolveAction(layout, "f")).toEqual({ type: "view" });
        expect(resolveAction(layout, "c")).toEqual({ type: "inject" });
        expect(resolveAction(layout, "r")).toEqual({ type: "reset" });
      });
    }
  });

  it("returns null for unbound keys", () => {
    expect(resolveAction("qwerty", "x")).toBeNull();
    expect(resolveAction("qwerty", " ")).toBeNull();
    expect(resolveAction("qwerty", "Enter")).toBeNull();
  });

  describe("display hints", () => {
    it("shows WASD on QWERTY and ZQSD on AZERTY for the wire", () => {
      expect(keyHints("qwerty").wire).toEqual({ advance: "W", retract: "S", torqueMinus: "A", torquePlus: "D" });
      expect(keyHints("azerty").wire).toEqual({ advance: "Z", retract: "S", torqueMinus: "Q", torquePlus: "D" });
    });
    it("shows arrow glyphs for the sheath on both layouts", () => {
      expect(keyHints("qwerty").sheath).toEqual({ advance: "↑", retract: "↓", torqueMinus: "←", torquePlus: "→" });
      expect(keyHints("azerty").sheath).toEqual(keyHints("qwerty").sheath);
    });
    it("shows F/C/R globals identically on both layouts", () => {
      const q = keyHints("qwerty");
      const a = keyHints("azerty");
      expect([q.view, q.inject, q.reset]).toEqual(["F", "C", "R"]);
      expect([a.view, a.inject, a.reset]).toEqual(["F", "C", "R"]);
    });
  });
});
