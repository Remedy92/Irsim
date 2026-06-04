import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  OneFactor,
  ShaderMaterial,
  Vector2
} from "three";

/**
 * Per-mesh "X-ray attenuation" material.
 *
 * Rendered with additive custom blending into a float/half-float buffer and
 * DoubleSide: front faces subtract their camera distance, back faces add it, so
 * the accumulated sum over every surface crossing equals (path thickness * sigma),
 * i.e. the optical depth tau through that material along the view ray. Optical
 * depths from different materials (vessel wall, contrast, metal wire) add up
 * naturally because each writes into the same buffer.
 */
export function makeAttenuationMaterial(sigma: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uSigma: { value: sigma } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendEquationAlpha: AddEquation,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
    vertexShader: /* glsl */ `
      varying float vDist;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;                 // positive distance in front of the camera
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uSigma;
      varying float vDist;
      void main() {
        float signed = gl_FrontFacing ? -vDist : vDist;
        gl_FragColor = vec4(uSigma * signed, 0.0, 0.0, 1.0);
      }
    `
  });
}

/** Fullscreen tone-map: optical depth tau -> grayscale fluoroscopy image + grain + vignette. */
export function makeTonemapMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDepth: { value: null },
      uGain: { value: 0.7 },
      uNoise: { value: 0.045 },
      uTime: { value: 0 },
      uResolution: { value: new Vector2(1, 1) }
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tDepth;
      uniform float uGain;
      uniform float uNoise;
      uniform float uTime;
      varying vec2 vUv;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        float tau = max(0.0, texture2D(tDepth, vUv).r);

        // baseline soft-tissue path so the field reads as mid-grey, not blown-out white
        float bodyR = length((vUv - vec2(0.5, 0.46)) * vec2(1.7, 1.0));
        float body = smoothstep(0.95, 0.35, bodyR) * 0.5;
        float img = exp(-(tau + body) * uGain);   // 1 = lucent, ->0 = dense (dark)

        float grey = 0.92 * img;

        // vignette (collimator-ish falloff)
        float r = length(vUv - 0.5) * 2.0;
        grey *= mix(1.0, 0.5, smoothstep(0.55, 1.25, r));

        // photon / film grain
        float n = (hash(vUv * 800.0 + uTime) - 0.5) * uNoise;
        grey = clamp(grey + n + 0.01, 0.0, 1.0);

        gl_FragColor = vec4(vec3(grey), 1.0);
      }
    `
  });
}
