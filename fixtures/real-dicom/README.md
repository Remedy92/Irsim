# Optional real-DICOM acceptance fixture

IRsim does not commit medical images to this repository. The manifest in this directory pins an
opt-in public series and the expected non-synthetic browser-review evidence.

The current series is one portal-venous contrast-enhanced abdominal CT from the
[TCIA Pancreas-CT collection](https://www.cancerimagingarchive.net/collection/pancreas-ct/), licensed
under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). It is a real-pixel DICOM decoding,
source-image, and overlay-regression fixture. It is **not** arterial-phase CTA, vascular ground truth,
or clinical validation.

Review the collection license and TCIA data-usage policy, then run:

```bash
npm run fixture:dicom:fetch -- --accept-license
npm run dev
npm run browser:dicom:real
```

The fetcher downloads directly from TCIA, requires explicit license acceptance, retains the archive's
`LICENSE`, and verifies a content fingerprint over the sorted DICOM payload. TCIA creates ZIP archives
with current timestamps, so the manifest pins the DICOM content rather than the nondeterministic ZIP
bytes. The browser gate asserts the identifier-free volume summary, the expected acquisition slice,
a bounded compact overlay immediately anterior to the vertebral body, the proposal load block, zero
browser storage, and same-origin network silence. It also seeds that compact component and requires a
long, topology-passing tracked trunk while keeping the load button blocked pending separate attestation.

Required attribution:

> Roth H, Farag A, Turkbey EB, Lu L, Liu J, Summers RM. Data From Pancreas-CT (Version 2). The Cancer
> Imaging Archive, 2016. https://doi.org/10.7937/K9/TCIA.2016.tNB1kqBU

Do not treat this fixture as proof that the tracker identifies the aorta or any other named vessel.
The next real-data milestone is a license-safe arterial-phase CTA with expert-confirmed vascular
landmarks and seeded-trunk expectations.

## JPEG 2000 Lossless interoperability objects

`jpeg2000-ct-interoperability.json` pins two small real-pixel CT objects from `pydicom-data`, their
repository license, and pydicom's upstream fixture notes. Downloading remains explicit and opt-in:

```bash
npm run fixture:dicom:j2k:fetch -- --accept-license
npm run fixture:dicom:j2k:verify
```

The verifier checks the exact DICOM, encoded-frame, and fragment hashes; original DS geometry;
populated and empty Basic Offset Tables; exact HU/geometry against a paired uncompressed object or an
independently generated digest; a deterministic three-fragment empty-BOT derivative; and bounded
truncation failures. One object reports DCMTK 3.6.2 and intentionally exercises a known
16-bit-header/14-bit-codestream mismatch; the other is a GDCM 3.0.4 transcode of a TCIA-origin image.
The opt-in fetcher requires HTTPS, validates safe filenames plus exact byte/hash bounds while
streaming, and refuses to replace an unrecognized output directory.
They are real-pixel transcodes, not scanner-originated compressed series, and provide no clinical,
segmentation, named-vessel, or multivendor claim.

The already opt-in 538-slice AortaSeg-derived study can additionally exercise the lazy production
processor intake budget:

```bash
npm run fixture:cta:budget
```

That gate is native Explicit VR Little Endian evidence. It verifies the pinned study fingerprint,
one-at-a-time reads, clearing of each prior source buffer, 282,066,944 canonical HU bytes, and broad
sampled Node runtime/memory ceilings. It is not a compressed-study or browser-worker benchmark.
