import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  OneFactor,
  ShaderMaterial
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

/**
 * Fullscreen tone-map: optical depth tau -> grayscale fluoroscopy image + grain + vignette.
 *
 * Two acquisition modes (uMode):
 *  - 0 LIVE: native fluoroscopy. The accumulated optical depth (bone + vessel walls + contrast +
 *    instruments) plus a soft-tissue body bias is mapped through Beer–Lambert to grey.
 *  - 1 DSA (digital subtraction angiography): a mask render (bone + walls, no contrast, no
 *    instruments) is subtracted from the live render, so only contrast and the moving instruments
 *    survive — the classic flat-grey field with black vessels that real selective work runs on.
 *
 * `uBrightness`/`uContrast` are the operator windowing controls (level/width), applied to the
 * displayed intensity about mid-grey. Vignette = collimator falloff; hash grain = photon noise.
 */
export function makeTonemapMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDepth: { value: null },
      tBase: { value: null },
      uMode: { value: 0 },
      uGain: { value: 0.7 },
      uBrightness: { value: 0 },
      uContrast: { value: 1 },
      uNoise: { value: 0.04 },
      uTime: { value: 0 }
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
      uniform sampler2D tBase;
      uniform float uMode;
      uniform float uGain;
      uniform float uBrightness;
      uniform float uContrast;
      uniform float uNoise;
      uniform float uTime;
      varying vec2 vUv;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        float tauLive = max(0.0, texture2D(tDepth, vUv).r);
        float img;
        if (uMode > 0.5) {
          // DSA: remove the static mask (bone + walls), keep contrast + instruments
          float tauBase = max(0.0, texture2D(tBase, vUv).r);
          float tau = max(0.0, tauLive - tauBase);
          img = exp(-tau * uGain) * 0.95 + 0.05;   // flat light-grey field
        } else {
          // LIVE: soft-tissue body bias so the field reads mid-grey (bone is a real mesh now)
          float bodyR = length((vUv - vec2(0.5, 0.46)) * vec2(1.7, 1.0));
          float body = smoothstep(0.98, 0.30, bodyR) * 0.34;
          img = exp(-(tauLive + body) * uGain);     // 1 = lucent, ->0 = dense (dark)
        }

        // operator windowing: contrast about mid-grey, then brightness shift
        img = (img - 0.5) * uContrast + 0.5 + uBrightness;
        float grey = clamp(img, 0.0, 1.0) * 0.95;

        // vignette (collimator falloff)
        float r = length(vUv - 0.5) * 2.0;
        grey *= mix(1.0, 0.46, smoothstep(0.6, 1.3, r));

        // photon / film grain
        float n = (hash(vUv * 800.0 + uTime) - 0.5) * uNoise;
        grey = clamp(grey + n + 0.01, 0.0, 1.0);

        gl_FragColor = vec4(vec3(grey), 1.0);
      }
    `
  });
}
