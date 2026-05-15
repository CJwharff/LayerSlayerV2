# LayerSlayerV2

Computational mechanics workspace for multilayer stress, curvature, delamination driving force, and transient transport analysis. Developed as part of MAT263 coursework following the methods in *The Mechanics and Reliability of Films, Multilayers and Coatings* by Begley & Hutchinson.

---

## Running the Application

**No installation required.** Open the single-file build in any modern browser (Chrome, Edge, or Firefox):

```
dist/LayerSlayerV2.html
```

Double-click the file or drag it into a browser window. All solver logic is bundled inline — no internet connection is needed after the page loads (CDN libraries such as Chart.js are fetched on first open).

> The root-level `LayerSlayerV2.html` is the development source and requires a local HTTP server to load its linked `.js` modules. Use `dist/LayerSlayerV2.html` for standalone use.

---

## Features

### Custom Multilayer Analysis — Steady State
Solves the multilayer plate problem for N bonded layers under thermal or direct mismatch strain loading. Outputs:
- Mid-plane strain ε₀ and curvature κ (plane strain and equi-biaxial)
- Layer stress distributions σ(y)
- Interfacial delamination energy release rate G at every interface (classic, plane strain, biaxial)
- Temperature profile (thermal mode)

Methodology follows Chapters 5, 13, and 14 of Begley & Hutchinson.

### Multilayer Transient Transport
Solves the 1D transient diffusion equation through N bonded layers with:
- Arbitrary constant diffusivity and storage coefficient per layer
- Constant volumetric source and first-order reaction/sink per layer
- Dirichlet, no-flux, or convective (Robin) boundary conditions
- Time-dependent boundary histories: constant, linear ramp, exponential, step, piecewise linear
- Optional swelling mismatch stress coupling to the Milestone 1 stress solver

The solver uses linear finite elements (Galerkin) for spatial discretization and backward Euler for time integration, following the transient framework in Chapter 15 of Begley & Hutchinson.

> The solver is unit-agnostic. All inputs must be supplied in a single self-consistent unit system. The UI labels (μm, hr, mol/μm³) are the recommended default system; SI (m, s, K) values may also be entered directly as long as all fields are consistent.

---

## Source Files

| File | Description |
|------|-------------|
| `app.js` | UI logic, state management, chart rendering |
| `solver.js` | Steady-state multilayer mechanics (stress, curvature, ERR) |
| `model.js` | Input validation for steady-state solver |
| `transientTransportSolver.js` | Transient FEM solver (mesh, assembly, time stepping) |
| `transientTransportModel.js` | Input validation and time-history evaluation |
| `transportStressCoupling.js` | Maps transport profiles to mismatch strain for stress solver |
| `LayerSlayerV2.html` | Source HTML (requires local server) |
| `build-distributable.mjs` | Build script — bundles all modules into `dist/` |

---

## Running the Tests

Requires [Node.js](https://nodejs.org) (v18 or later).

```bash
node --test tests/solver.test.js tests/transientTransportSolver.test.js
```

19 tests cover:
- Steady-state Stoney formula verification and Chapter 14 benchmarks
- Single-layer erfc step-boundary solution (early and late time)
- Reaction-diffusion steady and transient solutions (Thiele modulus, Danckwerts)
- Bilayer interface flux continuity during transient
- Transport-to-stress coupling end-to-end

---

## Rebuilding the Distributable

```bash
node build-distributable.mjs
```

This bundles `model.js`, `transientTransportModel.js`, `solver.js`, `transientTransportSolver.js`, `transportStressCoupling.js`, and `app.js` into a single inline `<script>` in `dist/LayerSlayerV2.html`.

---

## Verifications

Three verifications confirm solver accuracy:

1. **Single-layer erfc step boundary** — concentration profile at several times compared against the classical complementary error function solution and Fourier series for a finite slab with Dirichlet boundary conditions.

2. **Begley & Hutchinson Chapter 15 bilayer** — transient temperature profiles for a ceramic coating on a steel substrate with convective top boundary reproduced and compared against Figure 15.3, verifying thermal flux continuity at the interface and correct approach to the analytical steady state.

3. **Transport-to-stress coupling** — concentration profile from the transient solver fed into the Milestone 1 stress solver via swelling mismatch strain θ = β_swell · (c − c_ref). Stress distribution at several times confirms zero initial stress and physically correct stress evolution as concentration diffuses through the bilayer.
