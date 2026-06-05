import type { Anatomy } from "./types";
import { applyVariant, compileAnatomy, type AnatomyDoc, type VariantSpec } from "./anatomyDoc";

/**
 * The shipped "normal" arterial anatomy, authored as a declarative DOCUMENT and compiled into the
 * runtime `Anatomy` (centerline graph) by anatomyDoc.ts.
 *
 * IMPORTANT: this is a parametric, anatomically-plausible stand-in — NOT a real segmented dataset.
 * Diameters/lengths/takeoff angles follow published morphometry, but the geometry is hand-authored
 * so the rendering + physics + UX can be built and tuned against a realistic, MANY-vessel tree today.
 * The production path replaces this document with one emitted by the license-clean pipeline
 * (contrast CTA → TotalSegmentator → VMTK centerlines → JSON sidecar) or a license-clean synthetic
 * tree. Because the engine depends only on the `Anatomy` interface (and authoring depends only on the
 * `AnatomyDoc` schema), that swap is local. See docs/anatomy-realism-roadmap.md.
 *
 * Body frame, units in cm: +y cranial, +x patient-left, +z anterior.
 *
 * Coverage: aortoiliac (femoral access) + arch great vessels + renals + the visceral/mesenteric tree
 * (celiac → hepatic/splenic/GDA/left-gastric, SMA, IMA) + the pelvic path (internal iliac → uterine,
 * the UFE target). Every non-aortic branch welds its ostium onto the nearest parent sample so the
 * lumen graph connects it (the §7 "ostium weld"); the celiac/hepatic/SMA junctions are true carinae.
 */
export const NORMAL_DOC: AnatomyDoc = {
  id: "normal-v1",
  name: "Normal arterial anatomy (procedural v1)",
  branches: [
    // --- Aorta: femoral-access bifurcation (y=0) up through abdominal + thoracic to the arch.
    // Radii calibrated toward published means: abdominal aorta narrowed from v0 (infrarenal ~18 mm vs
    // v0's borderline-ectatic ~21 mm), ascending aorta/root widened (~28 mm). A MODERATE calibration —
    // the navigation solver's contained-curvature response is chaotic w.r.t. aorta radius, so the
    // narrowing stops short of the physiological mean to keep femoral→aorta navigation stable until the
    // planned dynamic-beam solver lands. Control-point POSITIONS are unchanged from v0, so every welded
    // ostium and the femoral access points are preserved. (docs/anatomy-realism-roadmap.md §4.)
    {
      id: "aorta",
      name: "Aorta",
      attenuation: 1.0,
      controls: [
        { p: [0.0, 0.0, 0.0], r: 0.85 }, // aortic bifurcation (~L4, ~17 mm)
        { p: [0.1, 4.0, 0.4], r: 0.89 },
        { p: [0.0, 9.0, 0.8], r: 0.92 }, // infrarenal (~18 mm)
        { p: [-0.2, 13.5, 0.6], r: 0.96 }, // renal level
        { p: [0.0, 19.0, 0.2], r: 1.02 }, // diaphragm
        { p: [0.3, 26.0, -0.4], r: 1.1 }, // descending thoracic (~22 mm)
        { p: [0.6, 31.5, -1.2], r: 1.22 }, // distal arch
        { p: [-0.4, 34.2, -0.2], r: 1.28 }, // arch apex
        { p: [-1.4, 32.5, 1.6], r: 1.42 } // ascending aorta / root (~28 mm)
      ]
    },

    // --- Iliac arteries down to the femoral access points (common iliac + external iliac + CFA,
    // simplified into one branch). Welded onto the aortic bifurcation node.
    {
      id: "iliac_r",
      name: "Right common iliac",
      attenuation: 0.85,
      parent: "aorta",
      ostiumNear: [0.0, 0.0, 0.0],
      ostiumR: 0.55,
      controls: [
        { p: [-2.2, -3.2, 0.2], r: 0.52 },
        { p: [-3.4, -7.0, 0.0], r: 0.5 },
        { p: [-3.8, -11.5, -0.2], r: 0.48 } // R common femoral (access)
      ]
    },
    {
      id: "iliac_l",
      name: "Left common iliac",
      attenuation: 0.85,
      parent: "aorta",
      ostiumNear: [0.0, 0.0, 0.0],
      ostiumR: 0.55,
      controls: [
        { p: [2.2, -3.2, 0.2], r: 0.52 },
        { p: [3.4, -7.0, 0.0], r: 0.5 },
        { p: [3.8, -11.5, -0.2], r: 0.48 } // L common femoral (access)
      ]
    },

    // --- Pelvic path: internal iliac (hypogastric) → uterine artery (the UFE target). The internal
    // iliac branches off the common iliac at the pelvic brim and runs posteromedially/caudally; the
    // uterine arises from its anterior division and curls toward the midline uterus (the Waltman-loop
    // selective skill). (docs/anatomy-realism-roadmap.md §3b.)
    {
      id: "iliac_internal_r",
      name: "Right internal iliac",
      attenuation: 0.6,
      samples: 28,
      parent: "iliac_r",
      ostiumNear: [-3.4, -7.0, 0.0],
      ostiumR: 0.32,
      controls: [
        { p: [-3.0, -9.0, -1.2], r: 0.3 },
        { p: [-2.6, -10.8, -1.8], r: 0.28 } // anterior division
      ]
    },
    {
      id: "uterine_r",
      name: "Right uterine artery",
      attenuation: 0.5,
      samples: 24,
      parent: "iliac_internal_r",
      ostiumNear: [-2.6, -10.8, -1.8],
      ostiumR: 0.17,
      controls: [
        { p: [-2.0, -11.4, -1.2], r: 0.16 },
        { p: [-1.0, -11.9, -0.6], r: 0.15 },
        { p: [-0.5, -12.2, -0.2], r: 0.14 } // toward the midline uterus
      ]
    },
    {
      id: "iliac_internal_l",
      name: "Left internal iliac",
      attenuation: 0.6,
      samples: 28,
      parent: "iliac_l",
      ostiumNear: [3.4, -7.0, 0.0],
      ostiumR: 0.32,
      controls: [
        { p: [3.0, -9.0, -1.2], r: 0.3 },
        { p: [2.6, -10.8, -1.8], r: 0.28 }
      ]
    },
    {
      id: "uterine_l",
      name: "Left uterine artery",
      attenuation: 0.5,
      samples: 24,
      parent: "iliac_internal_l",
      ostiumNear: [2.6, -10.8, -1.8],
      ostiumR: 0.17,
      controls: [
        { p: [2.0, -11.4, -1.2], r: 0.16 },
        { p: [1.0, -11.9, -0.6], r: 0.15 },
        { p: [0.5, -12.2, -0.2], r: 0.14 }
      ]
    },

    // --- Renal arteries. Calibrated to a realistic posterolateral + CAUDAL takeoff (population-mean
    // coronal angle ~54°; kidneys are retroperitoneal/posterior) and the real left/right ASYMMETRY:
    // the right renal is longer and runs more caudally (it crosses behind the IVC to a lower-sitting
    // right kidney). Ostium kept on the aorta renal-level node, so the renal targets are unchanged.
    {
      id: "renal_l",
      name: "Left renal artery",
      attenuation: 0.7,
      parent: "aorta",
      ostiumNear: [-0.2, 13.5, 0.6],
      ostiumR: 0.3,
      controls: [
        { p: [2.2, 13.0, 0.0], r: 0.27 },
        { p: [4.0, 12.3, -0.6], r: 0.25 } // L renal hilum (~3.4 cm, shorter)
      ]
    },
    {
      id: "renal_r",
      name: "Right renal artery",
      attenuation: 0.7,
      parent: "aorta",
      ostiumNear: [-0.2, 13.5, 0.6],
      ostiumR: 0.3,
      controls: [
        { p: [-2.4, 12.8, 0.0], r: 0.27 },
        { p: [-4.6, 12.0, -0.5], r: 0.25 },
        { p: [-6.2, 11.4, -0.9], r: 0.24 } // R renal hilum (~4.6 cm, longer + more caudal)
      ]
    },

    // --- Arch great vessels. Now welded onto the arch (v0 left them dangling), so a wire can only
    // engage them through their true ostia, gated by the lumen's branch-transition + hysteresis.
    {
      id: "innominate",
      name: "Brachiocephalic trunk",
      attenuation: 0.75,
      parent: "aorta",
      ostiumNear: [0.6, 31.5, -1.2],
      ostiumR: 0.45,
      controls: [
        { p: [-1.0, 34.5, -1.0], r: 0.4 },
        { p: [-2.2, 37.0, -0.8], r: 0.36 }
      ]
    },
    {
      id: "carotid_l",
      name: "Left common carotid",
      attenuation: 0.7,
      parent: "aorta",
      ostiumNear: [0.1, 33.2, -0.9],
      ostiumR: 0.34,
      controls: [
        { p: [0.6, 37.0, -0.6], r: 0.31 },
        { p: [1.0, 40.5, -0.4], r: 0.29 }
      ]
    },
    {
      id: "subclavian_l",
      name: "Left subclavian",
      attenuation: 0.72,
      parent: "aorta",
      ostiumNear: [-0.3, 33.6, -1.1],
      ostiumR: 0.38,
      controls: [
        { p: [2.6, 35.6, -1.6], r: 0.34 },
        { p: [5.4, 36.2, -2.0], r: 0.31 }
      ]
    },

    // --- Visceral / mesenteric tree (off the abdominal aorta): the highest-yield IR cannulation
    // territory. Celiac trifurcation + hepatic/SMA junctions are true carina nodes.
    {
      id: "celiac",
      name: "Celiac trunk",
      attenuation: 0.7,
      samples: 28,
      parent: "aorta",
      ostiumNear: [-0.05, 18.4, 0.3],
      ostiumR: 0.4,
      controls: [
        { p: [0.0, 18.5, 1.2], r: 0.38 },
        { p: [0.0, 18.5, 2.2], r: 0.36 } // trifurcation node
      ]
    },
    {
      id: "hepatic_common",
      name: "Common hepatic artery",
      attenuation: 0.62,
      samples: 24,
      parent: "celiac",
      ostiumNear: [0.0, 18.5, 2.2],
      ostiumR: 0.28,
      controls: [
        { p: [-1.4, 18.7, 3.0], r: 0.27 },
        { p: [-2.6, 18.9, 3.5], r: 0.26 } // hepatic bifurcation (PHA + GDA)
      ]
    },
    {
      id: "hepatic_proper",
      name: "Proper hepatic artery",
      attenuation: 0.58,
      samples: 22,
      parent: "hepatic_common",
      ostiumNear: [-2.6, 18.9, 3.5],
      ostiumR: 0.25,
      controls: [
        { p: [-3.4, 19.8, 3.9], r: 0.24 },
        { p: [-4.0, 20.6, 4.1], r: 0.22 } // R/L hepatic bifurcation
      ]
    },
    {
      id: "hepatic_r",
      name: "Right hepatic artery",
      attenuation: 0.5,
      samples: 22,
      parent: "hepatic_proper",
      ostiumNear: [-4.0, 20.6, 4.1],
      ostiumR: 0.16,
      controls: [
        { p: [-5.2, 21.3, 3.9], r: 0.15 },
        { p: [-6.0, 22.3, 3.7], r: 0.14 }
      ]
    },
    {
      id: "hepatic_l",
      name: "Left hepatic artery",
      attenuation: 0.5,
      samples: 22,
      parent: "hepatic_proper",
      ostiumNear: [-4.0, 20.6, 4.1],
      ostiumR: 0.14,
      controls: [
        { p: [-3.4, 21.5, 4.3], r: 0.13 },
        { p: [-2.8, 22.7, 4.4], r: 0.12 }
      ]
    },
    {
      id: "gda",
      name: "Gastroduodenal artery",
      attenuation: 0.55,
      samples: 22,
      parent: "hepatic_common",
      ostiumNear: [-2.6, 18.9, 3.5],
      ostiumR: 0.2,
      controls: [
        { p: [-2.4, 17.4, 3.6], r: 0.19 },
        { p: [-2.2, 15.9, 3.5], r: 0.18 }
      ]
    },
    {
      id: "splenic",
      name: "Splenic artery",
      attenuation: 0.65,
      samples: 40,
      parent: "celiac",
      ostiumNear: [0.0, 18.5, 2.2],
      ostiumR: 0.3,
      controls: [
        { p: [1.6, 18.9, 2.5], r: 0.3 },
        { p: [3.0, 18.3, 1.8], r: 0.29 },
        { p: [4.4, 18.9, 2.3], r: 0.28 },
        { p: [5.8, 18.4, 1.5], r: 0.27 },
        { p: [7.0, 19.0, 1.9], r: 0.26 } // splenic hilum (tortuous course)
      ]
    },
    {
      id: "gastric_l",
      name: "Left gastric artery",
      attenuation: 0.5,
      samples: 22,
      parent: "celiac",
      ostiumNear: [0.0, 18.5, 2.2],
      ostiumR: 0.2,
      controls: [
        { p: [0.6, 19.6, 2.3], r: 0.18 },
        { p: [1.0, 20.9, 2.1], r: 0.16 }
      ]
    },
    {
      id: "sma",
      name: "Superior mesenteric artery",
      attenuation: 0.7,
      samples: 40,
      parent: "aorta",
      ostiumNear: [-0.12, 16.4, 0.42],
      ostiumR: 0.29,
      controls: [
        { p: [-0.1, 16.1, 1.6], r: 0.28 },
        { p: [-0.05, 14.8, 2.2], r: 0.27 },
        { p: [0.0, 12.5, 2.6], r: 0.25 },
        { p: [0.1, 10.2, 2.7], r: 0.23 }
      ]
    },
    {
      id: "ileocolic",
      name: "Ileocolic artery",
      attenuation: 0.5,
      samples: 22,
      parent: "sma",
      ostiumNear: [0.0, 12.5, 2.6],
      ostiumR: 0.17,
      controls: [
        { p: [-1.3, 11.6, 2.4], r: 0.16 },
        { p: [-2.5, 10.9, 2.0], r: 0.14 }
      ]
    },
    {
      id: "colic_m",
      name: "Middle colic artery",
      attenuation: 0.48,
      samples: 22,
      parent: "sma",
      ostiumNear: [-0.05, 14.8, 2.2],
      ostiumR: 0.15,
      controls: [
        { p: [-0.2, 15.0, 3.3], r: 0.14 },
        { p: [-0.3, 14.9, 4.3], r: 0.12 }
      ]
    },
    {
      id: "ima",
      name: "Inferior mesenteric artery",
      attenuation: 0.62,
      samples: 28,
      parent: "aorta",
      ostiumNear: [-0.08, 10.8, 0.72],
      ostiumR: 0.2,
      controls: [
        { p: [0.5, 9.8, 1.4], r: 0.19 },
        { p: [0.95, 8.6, 1.6], r: 0.18 }
      ]
    },
    {
      id: "colic_l",
      name: "Left colic artery",
      attenuation: 0.48,
      samples: 22,
      parent: "ima",
      ostiumNear: [0.5, 9.8, 1.4],
      ostiumR: 0.14,
      controls: [
        { p: [1.6, 10.6, 1.5], r: 0.13 },
        { p: [2.4, 11.4, 1.4], r: 0.12 }
      ]
    },
    {
      id: "rectal_sup",
      name: "Superior rectal artery",
      attenuation: 0.48,
      samples: 22,
      parent: "ima",
      ostiumNear: [0.95, 8.6, 1.6],
      ostiumR: 0.14,
      controls: [
        { p: [1.0, 6.6, 1.3], r: 0.13 },
        { p: [1.0, 4.8, 1.0], r: 0.12 }
      ]
    }
  ],

  access: [
    { id: "rcfa", name: "Right common femoral artery", onBranch: "iliac_r", at: "end", dir: [0.32, 1, 0.04] },
    // Mirror of the right access across the sagittal plane.
    { id: "lcfa", name: "Left common femoral artery", onBranch: "iliac_l", at: "end", dir: [-0.32, 1, 0.04] }
  ],

  targets: [
    { id: "t_renal_l", name: "Left renal ostium", via: "renal_l", ostiumOf: "renal_l", acceptance: 0.6 },
    { id: "t_renal_r", name: "Right renal ostium", via: "renal_r", ostiumOf: "renal_r", acceptance: 0.6 },
    { id: "t_carotid_l", name: "Left common carotid ostium", via: "carotid_l", ostiumOf: "carotid_l", acceptance: 0.6 },
    { id: "t_innominate", name: "Brachiocephalic ostium", via: "innominate", ostiumOf: "innominate", acceptance: 0.7 },
    // Visceral selective cannulation targets.
    { id: "t_celiac", name: "Celiac trunk ostium", via: "celiac", ostiumOf: "celiac", acceptance: 0.6 },
    { id: "t_sma", name: "Superior mesenteric ostium", via: "sma", ostiumOf: "sma", acceptance: 0.6 },
    { id: "t_ima", name: "Inferior mesenteric ostium", via: "ima", ostiumOf: "ima", acceptance: 0.55 },
    { id: "t_hepatic", name: "Common hepatic artery", via: "hepatic_common", ostiumOf: "hepatic_common", acceptance: 0.5 },
    { id: "t_splenic", name: "Splenic artery", via: "splenic", ostiumOf: "splenic", acceptance: 0.5 },
    { id: "t_hepatic_r", name: "Right hepatic (selective)", via: "hepatic_r", ostiumOf: "hepatic_r", acceptance: 0.45 },
    // Pelvic targets (UFE).
    { id: "t_uterine_r", name: "Right uterine artery", via: "uterine_r", ostiumOf: "uterine_r", acceptance: 0.4 },
    { id: "t_uterine_l", name: "Left uterine artery", via: "uterine_l", ostiumOf: "uterine_l", acceptance: 0.4 },
    { id: "t_iia_r", name: "Right internal iliac ostium", via: "iliac_internal_r", ostiumOf: "iliac_internal_r", acceptance: 0.5 },
    { id: "t_iia_l", name: "Left internal iliac ostium", via: "iliac_internal_l", ostiumOf: "iliac_internal_l", acceptance: 0.5 }
  ],

  provenance: {
    source: "Procedural (IRsim parametric generator) — declarative AnatomyDoc compiled by anatomyDoc.ts",
    license: "CC0 / generated",
    note:
      "Anatomically-plausible placeholder: aortoiliac + arch great vessels + recalibrated renals + " +
      "visceral/mesenteric tree (celiac→hepatic/splenic/GDA/left-gastric, SMA, IMA) + pelvic path " +
      "(internal iliac→uterine). Diameters/lengths follow published morphometry but this is NOT a " +
      "segmented case. Replace with VMTK-derived centerlines from a license-clean CTA (or a license-" +
      "clean synthetic tree) before any clinical-credibility claim. See docs/anatomy-realism-roadmap.md."
  }
};

/**
 * Anatomical variants, expressed as operations on NORMAL_DOC. These are the cannulation challenges
 * that define real IR practice (docs/anatomy-realism-roadmap.md §5). Each stays fully graph-connected
 * because the reparent op re-welds the moved branch onto its new origin.
 */
export const ANATOMY_VARIANTS: VariantSpec[] = [
  {
    id: "bovine-arch",
    name: "Bovine arch (common origin of LCC)",
    note:
      "The commonest aortic-arch variant (~13-27%): the left common carotid shares its origin with the " +
      "brachiocephalic trunk instead of arising separately from the arch. Makes left-carotid selection a " +
      "distinct catheter skill.",
    ops: [
      {
        op: "reparent",
        branch: "carotid_l",
        parent: "innominate",
        ostiumNear: [-1.0, 34.5, -1.0],
        ostiumR: 0.34,
        controls: [
          { p: [-0.2, 36.5, -0.7], r: 0.32 },
          { p: [0.6, 38.8, -0.5], r: 0.3 },
          { p: [1.0, 40.5, -0.4], r: 0.29 }
        ]
      }
    ]
  },
  {
    id: "replaced-rha-sma",
    name: "Replaced right hepatic from SMA (Michels III)",
    note:
      "~11-15%: the right hepatic artery arises from the proximal SMA instead of the proper hepatic. " +
      "Selective right-hepatic cannulation (e.g. for TACE/Y90 navigation) must then be approached via the " +
      "SMA — a flagship variant skill. The proper hepatic supplies only the left lobe here.",
    ops: [
      {
        op: "reparent",
        branch: "hepatic_r",
        parent: "sma",
        ostiumNear: [-0.1, 16.1, 1.6],
        ostiumR: 0.16,
        controls: [
          { p: [-2.5, 18.0, 3.0], r: 0.15 },
          { p: [-4.5, 20.2, 3.6], r: 0.14 },
          { p: [-6.0, 22.3, 3.7], r: 0.14 } // ends in the right-lobe territory
        ]
      }
    ]
  }
];

/** Build the shipped "normal" anatomy (no variant). Stable public API consumed across the app. */
export function buildNormalAnatomy(): Anatomy {
  return compileAnatomy(NORMAL_DOC);
}

/**
 * Build the anatomy, optionally with a named variant from ANATOMY_VARIANTS applied. `undefined`
 * returns the normal anatomy. Throws on an unknown variant id.
 */
export function buildAnatomy(variantId?: string): Anatomy {
  if (!variantId) return compileAnatomy(NORMAL_DOC);
  const variant = ANATOMY_VARIANTS.find((v) => v.id === variantId);
  if (!variant) {
    throw new Error(`buildAnatomy: unknown variant "${variantId}" (have: ${ANATOMY_VARIANTS.map((v) => v.id).join(", ")})`);
  }
  return compileAnatomy(applyVariant(NORMAL_DOC, variant));
}
