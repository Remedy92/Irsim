/**
 * Keyboard control mapping for the two coaxial instruments.
 *
 * The wire and the sheath are driven by SEPARATE key clusters that are both always live
 * (no focus switching): the guidewire on the letter cluster (WASD / ZQSD), the sheath on the
 * arrow keys. This pure module is the single source of truth for that mapping so the React
 * key handler and the on-screen "keyboard deck" stay in lockstep, and so the layout behavior
 * is unit-testable without a DOM.
 *
 * AZERTY vs QWERTY only re-letters the WIRE cluster: on an AZERTY keyboard the gaming-standard
 * equivalent of WASD is ZQSD (the physical W→Z and A→Q swaps), so we listen for z/q instead of
 * w/a. The sheath stays on the arrow keys (layout-independent), and the global keys F/C/R sit at
 * the same character on both layouts. We match against the produced character (`KeyboardEvent.key`)
 * so a native AZERTY keyboard reports 'z'/'q' exactly where we expect them.
 */

export type KeyLayout = "qwerty" | "azerty";
export type DeviceId = "wire" | "sheath";
export type DeviceControl = "feed" | "torque";

/** A resolved keyboard action: either drive one device, or a global command. */
export type ControlAction =
  | { type: "device"; device: DeviceId; control: DeviceControl; sign: 1 | -1 }
  | { type: "view" }
  | { type: "inject" }
  | { type: "reset" };

interface WireKeys {
  advance: string;
  retract: string;
  torqueMinus: string;
  torquePlus: string;
}

/**
 * The WIRE letter cluster per layout. QWERTY uses WASD; AZERTY uses ZQSD (W↔Z, A↔Q swap,
 * S and D unchanged). Lower-case because we match against `key.toLowerCase()`.
 */
const WIRE_KEYS: Record<KeyLayout, WireKeys> = {
  qwerty: { advance: "w", retract: "s", torqueMinus: "a", torquePlus: "d" },
  azerty: { advance: "z", retract: "s", torqueMinus: "q", torquePlus: "d" }
};

/** The SHEATH cluster — the arrow keys, identical on every layout. */
const SHEATH_KEYS = {
  advance: "arrowup",
  retract: "arrowdown",
  torqueMinus: "arrowleft",
  torquePlus: "arrowright"
} as const;

/** Global commands. These characters occupy the same key on AZERTY and QWERTY. */
const GLOBAL_KEYS = { view: "f", inject: "c", reset: "r" } as const;

/**
 * Resolve a raw `KeyboardEvent.key` (any case) under the active layout into a control action,
 * or null if the key is unbound. Modifier-chord filtering (Ctrl/Meta/Alt) is the caller's job
 * so this stays a pure string map.
 */
export function resolveAction(layout: KeyLayout, rawKey: string): ControlAction | null {
  const k = rawKey.toLowerCase();
  const wk = WIRE_KEYS[layout];

  if (k === wk.advance) return { type: "device", device: "wire", control: "feed", sign: 1 };
  if (k === wk.retract) return { type: "device", device: "wire", control: "feed", sign: -1 };
  if (k === wk.torqueMinus) return { type: "device", device: "wire", control: "torque", sign: -1 };
  if (k === wk.torquePlus) return { type: "device", device: "wire", control: "torque", sign: 1 };

  if (k === SHEATH_KEYS.advance) return { type: "device", device: "sheath", control: "feed", sign: 1 };
  if (k === SHEATH_KEYS.retract) return { type: "device", device: "sheath", control: "feed", sign: -1 };
  if (k === SHEATH_KEYS.torqueMinus) return { type: "device", device: "sheath", control: "torque", sign: -1 };
  if (k === SHEATH_KEYS.torquePlus) return { type: "device", device: "sheath", control: "torque", sign: 1 };

  if (k === GLOBAL_KEYS.view) return { type: "view" };
  if (k === GLOBAL_KEYS.inject) return { type: "inject" };
  if (k === GLOBAL_KEYS.reset) return { type: "reset" };

  return null;
}

/** The glyph shown on a keycap for one device control, under the active layout. */
export interface DeviceKeyGlyphs {
  advance: string;
  retract: string;
  torqueMinus: string;
  torquePlus: string;
}

/** Display glyphs for the on-screen deck. Wire follows the layout; sheath shows arrow glyphs. */
export interface KeyHints {
  wire: DeviceKeyGlyphs;
  sheath: DeviceKeyGlyphs;
  view: string;
  inject: string;
  reset: string;
}

export function keyHints(layout: KeyLayout): KeyHints {
  const wk = WIRE_KEYS[layout];
  return {
    wire: {
      advance: wk.advance.toUpperCase(),
      retract: wk.retract.toUpperCase(),
      torqueMinus: wk.torqueMinus.toUpperCase(),
      torquePlus: wk.torquePlus.toUpperCase()
    },
    sheath: { advance: "↑", retract: "↓", torqueMinus: "←", torquePlus: "→" },
    view: GLOBAL_KEYS.view.toUpperCase(),
    inject: GLOBAL_KEYS.inject.toUpperCase(),
    reset: GLOBAL_KEYS.reset.toUpperCase()
  };
}
