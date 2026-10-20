# Asura Balbalta (asrbbt_web)

[한국어](README.md)

> This document was written by Claude (an AI by Anthropic) from the repository contents and reviewed by @nanangqq. Public documents in this repository carry this notice unless written by a person.

A WebGPU viewer that renders Korean terrain, buildings and roads in 3D in the browser and exports them. Pick an area on the map, and the app
downloads the 1K map sheets inside it, builds a terrain TIN, and drapes buildings and roads on top. You can walk around in first person and export
to STL, SKP, 3DM or GLB. It runs from static files with no server of its own.

## Features

| Area | What it does |
| --- | --- |
| Map | OpenLayers. Stadia / CARTO basemaps, light and dark, address and place search (VWorld), current location |
| Area selection | Click, move, click (drag on touch), 1K sheet grid, up-front limit check by sheet count |
| Terrain | Points and lines from static R2 files (TTP), constrained Delaunay triangulation in the browser (integer mm). Smooth TIN or stepped (contour model) mode, absolute-elevation color ramp |
| Buildings | Footprints, use, structure, height, floors, names. Building table (13 attributes), crosshair building HUD |
| Roads | Carriageway polygons cut along terrain triangles and draped, bridges interpolated along the centerline, tunnels hidden |
| 3D | Custom WebGPU renderer. Pan, orbit, zoom, cascaded shadows, SSAO, procedural sky, outlines. Guidance screen when WebGPU is unavailable |
| Walk mode | First-person movement, sheet streaming, radius culling, memory management |
| Export | STL, SKP (openskp + patch), 3DM (rhino3dm), GLB. Stacked-slab terrain, one group/solid/node per building, attribution metadata |
| UI | Fluent UI controls, mobile layout, liquid glass (Chromium) |

## Requirements

- A browser with WebGPU. Verified on current Chrome. Without WebGPU the app shows a guidance screen.
- Node.js 22 (verified with `v22.21`) and npm.

## Run

```bash
git clone https://github.com/asura-balbalta/asura-balbalta.github.io.git
cd asura-balbalta.github.io
npm install            # postinstall applies the openskp patch in patches/
npm run build          # esbuild → dist/ (prebuild copies the rhino3dm wasm into dist/export/)
npx serve dist -l 3000 # http://localhost:3000
```

While developing, keep `npm run dev` (esbuild watch) running and serve `dist/` the same way. Type checking is `npm run typecheck` (TypeScript pinned to 6.0.3).

Terrain, building and road data come from the public bucket `https://layers.asrbbt.world`, which allows CORS from `localhost`. A fresh clone therefore
runs against the same data as the deployed site.

## Data and attribution

| Layer | Source | Terms |
| --- | --- | --- |
| Terrain | National Geographic Information Institute (NGII) base map: contours, spot heights, stream boundaries, sheet index | KOGL Type 1 (attribution) |
| Buildings | VWorld integrated GIS building data, supplemented with the Building Register (height, floors, names) | CC BY 4.0 · no usage restriction |
| Roads | NGII base map carriageway polygons and road centerlines | KOGL Type 1 (attribution) |

All sources allow commercial use and derivative works with attribution. The full notices and links are on the app's attribution page (`#/attribution`)
and in `src/attribution.ts`, and are embedded in exported files. The server-side code that converts the sources into per-sheet static files
(TTP, BFP, RDS1) is not in this repository. `TERRAIN_API` (`localhost:8000`) in `src/terrainData.ts` is a development path used only when that
server runs locally.

## Keys and external services

This is a static SPA, so keys ship in the bundle and are restricted by allowed domains on each service. To fork and host elsewhere, replace the keys
with your own and register your domain.

| File | Constant | Service |
| --- | --- | --- |
| `src/config.ts` | `VWORLD_KEY` | VWorld search API (addresses, places). Empty key: the search panel only shows a notice |
| `src/basemap.ts` | `CARTO_API_KEY` | CARTO basemap tiles. Without a key the tiles carry a watermark |
| `src/basemap.ts` | — | Stadia Maps: no key in the code. The free plan is non-commercial with a monthly credit limit (Stadia terms) |
| `src/fb.ts` | Firebase web config | Initial scaffolding. The app does not call it; `firebase.json` and `.firebaserc` are for Firebase Hosting deploys from the private working repository |

## Debug pages and verification scripts

- `#/debug/walk?bbox=…&spawn=…&yaw=…&pitch=…`: pins area, position, angle and effect switches (`ao=0`, `shadow=0`, `sky=0`, `roads=0`, …) in the URL so the same scene can be reopened. The parameter table is in [`src/webgpu/VERIFY.md`](src/webgpu/VERIFY.md), section 4.
- `#/debug/app?gpu=0&glass=0`: emulates browser environments such as no WebGPU or liquid glass off.
- `npm run render-check`: captures the baseline scenes with the installed Chrome, writes metrics (`index.json`) and PNGs, and compares before/after. Also `npm run band-check` (sheet-boundary band measurement) and `scripts/export-check.mjs` (export, re-read and compare).
- The procedure for rendering fixes (reproduce → narrow down → measure → fix, before/after comparison) is in `src/webgpu/VERIFY.md`.

## About this repository

- Development happens in a private working repository; commits are replayed into this one one at a time. The author date is when the work was done, the committer date is when it was replayed.
- References in commit messages and comments such as `docs/…`, "계획서 N절" (plan, section N) or "보고서" (report) point to the private working notes (plans, measurements, captures). They are not in this repository. `by @nanangqq` in code comments names the person who made that decision or check.
- Commit messages are in Korean, in the form `type(scope): one sentence`.
- Deployment: pushing a `v*` tag makes GitHub Actions build and publish to GitHub Pages (`.github/workflows/pages.yml`). Pushing to main does not deploy.
- Issues are welcome. Pull requests are applied by hand in the private repository and arrive here as replayed commits, so they land as equivalent commits rather than merge commits.

## License

Code is [MIT](LICENSE). Third-party code and licenses are listed in [`THIRD_PARTY.md`](THIRD_PARTY.md). Data follows the terms in "Data and attribution" above.
