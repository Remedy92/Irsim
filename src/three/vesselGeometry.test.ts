import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { makeVesselGeometry } from "./vesselGeometry";

describe("makeVesselGeometry", () => {
  it("preserves each centerline radius instead of replacing it with a branch mean", () => {
    const points = [
      { pos: new Vector3(0, 0, 0), radius: 0.25, s: 0 },
      { pos: new Vector3(0, 1, 0), radius: 0.8, s: 1 },
      { pos: new Vector3(0, 2, 0), radius: 0.4, s: 2 }
    ];
    const radialSegments = 8;
    const geometry = makeVesselGeometry(points, radialSegments);
    const positions = geometry.getAttribute("position");
    for (let ring = 0; ring < points.length; ring++) {
      for (let segment = 0; segment < radialSegments; segment++) {
        const vertex = new Vector3().fromBufferAttribute(positions, ring * radialSegments + segment);
        expect(vertex.distanceTo(points[ring].pos)).toBeCloseTo(points[ring].radius, 5);
      }
    }
    expect(geometry.index?.count).toBe((points.length - 1) * radialSegments * 6);
    geometry.dispose();
  });
});

