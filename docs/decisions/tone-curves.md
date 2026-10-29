# Tone curves: tables, scoring and the validation gate

**Status:** implemented behind `tonemap_auto` (off). Measured 29 Oct 2026 on the production host (ffmpeg 7.0.2,
torch 2.15 CPU, pyiqa 0.1.16) and locally (ffmpeg 8).

## Decision

HDR videos encode through the verified Hable chain (handoff §8.4) unless automatic selection is switched on **and**
the validation gate has passed (`luts/gate.json`). With both, the worker scores the four candidate curves on 8 frames
before encoding, encodes through the winner's 65³ table, and keeps the scored frames and scores for Item details.

## Corrections to handoff §8.5

The handoff's formulas were checked against the sources they cite and against what ffmpeg actually does. Four were wrong:

| Handoff says | What we do | Why |
|---|---|---|
| PU21 is $a(\log_2 L - \log_2 0.005)^2 + b(\ldots)$, $a=0.001908$, $b=0.0078$ | Mantiuk & Azimi's PU21 ("banding + glare" parameters), divided by its value at 10 000 cd/m² | The quadratic is not PU21. It puts 100 cd/m² at half the scale; PU21 puts it at ≈ 0.43 with a different shape. Test: `test_pu21_is_mantiuk_azimi_banding_glare`. |
| Reference = original "in absolute nits" | HLG: inverse OETF + BT.2100 OOTF for a 1000 cd/m² display (γ 1.2, by luminance). PQ: its EOTF | HLG is relative; it has no absolute nits without the display OOTF. Greys agree (0.75 → 203 cd/m²); saturated colours don't. |
| ε is the BT.709 OETF | BT.1886 display gamma, $V = L^{1/2.4}$ | That is what zscale writes for `t=bt709`, so it is what the Hable chain the table must match produces. |
| `npl=203` decodes with reference white at 203 | Yes, but zimg's HLG decode raises each channel to 1.2 separately, and ffmpeg's `tonemap` normalises Hable at peak 10 | The tables reproduce zimg exactly so `hable203` matches the encoder's fallback chain. |

Also fixed while wiring it in: the table filter used to run `zscale=t=bt709` on a frame zscale still thought was
BT.2020/HLG, converting colour a second time (mean error > 10 code values); it now declares
`tin=bt709:pin=bt709`.

## What was measured

- **Table vs chain** (`hable203`, the acceptance test): mean 0.042 code values on IMG_4515.MOV, 0.09 / 0.10 on
  HLG / PQ test patterns (limit 2). Near black the 65³ grid is coarser (p99.9 5–6, max 21–48 on synthetic
  patterns); 129³ halves that but is 8× the size. A linear-output table with exact gamma afterwards is worse.
- **Cost of scoring** one HDR video: 8 frames × 4 curves at a 1024 px long edge took 5.6 min and 1.9 GB RSS
  (768 px: 2.9 min, 1.5 GB; same choice). The ETA uses 340 s as the fixed HDR cost while automatic selection is on,
  then follows the measured time (`app_settings.score_seconds`).
- **The chapter clip** (IMG_4515.MOV) scored `bt2446a` first, `hable203` second, at both sizes.

## The validation gate

The reviewed clips are 10 s cut from 5 s into IMG_4515.MOV (`gate.DEFAULT_CLIPS.offset`); without the offset the
frames don't line up (PSNR 13.7 dB; 36.2 dB with it).

With the corrected formulas the scorer ranks `hable_100` first and `hable_203` second (sum 2 vs 4); Reinhard beats
Möbius at npl 100 and ties it at 203. The reviewers picked `hable_203`; the chapter accepted `hable_100` too (29 Oct 2026), so the gate
passes when either Hable clip ranks first. See *Paper formulas vs corrected* below for whether the handoff's own formulas would have passed.

### Paper formulas vs corrected

Same 8 frames, same scorer, each reference × each perceptual scale (sum of the two metric ranks, lower is better):

| Reference | Scale | 1st | 2nd | hable_100 | hable_203 |
|---|---|---|---|---|---|
| BT.2100 OOTF (ours) | PU21 (ours) | hable_100 | hable_203 | 2 | 4 |
| BT.2100 OOTF | handoff quadratic | hable_100 (tie-break) | hable_203 | 3 | 3 |
| zimg decode | PU21 | hable_100 | hable_203 | 2 | 4 |
| zimg decode | handoff quadratic | hable_100 (tie-break) | hable_203 | 3 | 3 |

No combination puts `hable_203` first, so the corrections are not why the gate fails. The metrics prefer npl 100 by a
small margin, and the rest of the order (Hable, then Möbius/Reinhard 203, then the npl-100 variants) is the same in
every case. That is why the gate accepts either Hable clip first.

## Consequences

- Nothing changes for uploads until someone switches `tonemap_auto` on and the gate passes on the server.
- Admin overrides (`toneCurve` on a reprocess) work today, with or without the gate.
- `pyiqa` 0.1.16 is licensed PolyForm Noncommercial 1.0.0, with parts under the S-Lab License 1.0 (also
  non-commercial); checked from the installed package's `licenses/`, 29 Oct 2026. Both allow this use: an
  educational, non-commercial chapter library, with pyiqa installed from PyPI and not redistributed. It is pinned,
  because a new version could change the licence or the scores the gate validated. Commercial reuse of this repo's
  automatic selection would need the authors' permission; the rest of the repo is MIT and doesn't include pyiqa.
