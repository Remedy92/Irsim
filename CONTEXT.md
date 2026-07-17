# IRsim Domain Context

This glossary names the concepts that cross module boundaries. Architecture and delivery status live
in `docs/ARCHITECTURE.md`; implementation guidance lives in `CLAUDE.md`.

- **Built-in public demo** — the generic, zero-file anatomy that remains active until a reviewed
  local case is explicitly committed.
- **Local DICOM session** — one browser-tab lifetime in which a dedicated worker owns the canonical
  diagnostic volume, proposal, reviewed labelmap, and source-image rendering state.
- **Canonical diagnostic volume** — the worker-internal, identifier-free interface to the session's
  sole decoded HU representation, patient geometry, borrowed slice views, voxel-to-LPS transform,
  and best-effort disposal. Decoder or codec changes must replace its implementation rather than
  create a second full pixel cache.
- **Slice-decoder session** — a short-lived worker intake Adapter shared across selected files. Native
  pixels or a lazily loaded JPEG 2000 Lossless decoder copy directly into the final HU slice; codec
  views and decoder objects are released before segmentation and never become a second volume.
- **Axial source review** — review of the original CT acquisition plane. It is not MPR and carries no
  inferred patient-left/right display labels.
- **Patient-axis MPR** — a fixed axial/coronal/sagittal LPS frame rendered on demand from the same
  canonical HU volume. HU uses trilinear interpolation, sparse labelmap membership stays discrete,
  display orientation uses explicit R/L/A/P/H/F labels, and tilted-volume padding is invalid. It is
  an engineering review view, not a validated diagnostic workstation or arbitrary oblique/curved MPR.
- **Source review frame** — one worker-rendered acquisition-source or patient-axis RGBA frame. React
  receives only an opaque bounded frame token; display-point-to-source-voxel mapping stays inside the
  worker and tokens expire on revision change or bounded eviction.
- **Automatic proposal** — the deterministic threshold path shown only to help choose a source-image
  seed. It is never loadable by itself.
- **Vascular seed** — an operator-selected voxel inside the intended contrast-filled vessel.
- **Seed-confirmed segmentation** — bidirectional threshold tracking anchored to the selected
  connected component. It remains a single-trunk prototype, not a complete vascular tree.
- **Editable sparse labelmap** — the worker-owned per-slice row-span representation of the reviewed
  single trunk. A clinician can replace one tracked slice, add/remove a bounded physical 3D sphere
  across intersecting tracked slices from any displayed plane, and undo the change without creating a
  second full-volume representation.
- **Segmentation edit record** — an identifier-free, monotonically revised session record of a
  labelmap replacement, seed-preserving endpoint trim, or undo. It is review provenance, not a durable
  regulated audit trail.
- **Topology blocker** — a deterministic discontinuity, abrupt radius change, missing component, or
  source-slice gap that prevents review attestation and loading until corrected or undone.
- **Review attestation** — the explicit, separate confirmation required after seed tracking and before
  the derived `AnatomyDoc` can replace the simulator anatomy. It stays disabled until the current
  revision's bounded acquisition-source set and both seed-aligned patient-MPR context frames have rendered.
- **AnatomyDoc seam** — the identifier-free, strictly validated document shared by built-in,
  sidecar, and local-DICOM anatomy sources.
