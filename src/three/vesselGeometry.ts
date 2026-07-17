import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Vector3 } from "three";
import type { CenterlinePoint } from "../sim/types";

function tangentAt(points: readonly CenterlinePoint[], index: number): Vector3 {
  if (index === 0) return points[1].pos.clone().sub(points[0].pos).normalize();
  if (index === points.length - 1) return points[index].pos.clone().sub(points[index - 1].pos).normalize();
  return points[index + 1].pos.clone().sub(points[index - 1].pos).normalize();
}

function initialNormal(tangent: Vector3): Vector3 {
  const helper = Math.abs(tangent.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  return helper.sub(tangent.clone().multiplyScalar(helper.dot(tangent))).normalize();
}

/** Loft a variable-radius vessel so imported stenoses and dilation survive rendering. */
export function makeVesselGeometry(points: readonly CenterlinePoint[], radialSegments = 14): BufferGeometry {
  if (points.length < 2) throw new Error("makeVesselGeometry needs at least two centerline points");
  if (!Number.isInteger(radialSegments) || radialSegments < 3 || radialSegments > 64) {
    throw new Error("makeVesselGeometry radialSegments must be an integer from 3 to 64");
  }
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let normal = initialNormal(tangentAt(points, 0));
  const totalLength = points.at(-1)?.s || 1;

  for (let ring = 0; ring < points.length; ring++) {
    const point = points[ring];
    const tangent = tangentAt(points, ring);
    if (ring > 0) {
      // Parallel transport the prior ring normal into the new tangent plane to avoid frame flips.
      normal = normal.sub(tangent.clone().multiplyScalar(normal.dot(tangent)));
      if (normal.lengthSq() < 1e-10) normal = initialNormal(tangent);
      else normal.normalize();
    }
    const binormal = new Vector3().crossVectors(tangent, normal).normalize();
    for (let segment = 0; segment < radialSegments; segment++) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      const radial = normal
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(binormal, Math.sin(angle))
        .normalize();
      const vertex = point.pos.clone().addScaledVector(radial, point.radius);
      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(radial.x, radial.y, radial.z);
      uvs.push(segment / radialSegments, point.s / totalLength);
    }
  }

  for (let ring = 0; ring < points.length - 1; ring++) {
    for (let segment = 0; segment < radialSegments; segment++) {
      const nextSegment = (segment + 1) % radialSegments;
      const a = ring * radialSegments + segment;
      const b = (ring + 1) * radialSegments + segment;
      const c = (ring + 1) * radialSegments + nextSegment;
      const d = ring * radialSegments + nextSegment;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

