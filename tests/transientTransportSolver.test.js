import test from "node:test";
import assert from "node:assert/strict";
import { sampleProfileAt, solveTransientTransport } from "../transientTransportSolver.js";
import { computeStressHistoryFromTransport } from "../transportStressCoupling.js";

function relErr(value, reference) {
  if (Math.abs(reference) < 1e-14) {
    return Math.abs(value);
  }
  return Math.abs((value - reference) / reference);
}

function expectClose(value, reference, tolerance, label) {
  const error = relErr(value, reference);
  assert.ok(
    error <= tolerance,
    `${label} outside tolerance. value=${value}, ref=${reference}, relErr=${error}, tol=${tolerance}`
  );
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z));
  return sign * y;
}

function erfc(x) {
  return 1 - erf(x);
}

function slabDirichletStepSolution(y, length, diffusivity, time, terms = 240) {
  let sum = y / length;
  for (let n = 1; n <= terms; n += 1) {
    sum +=
      (2 * (-1) ** n) /
      (n * Math.PI) *
      Math.sin((n * Math.PI * y) / length) *
      Math.exp((-diffusivity * n * n * Math.PI * Math.PI * time) / (length * length));
  }
  return sum;
}

function semiInfiniteTopStepSolution(y, length, diffusivity, time) {
  return erfc((length - y) / (2 * Math.sqrt(diffusivity * time)));
}

function finiteReactionSteadySolution(y, length, diffusivity, reactionRate, surfaceValue = 1) {
  const phi = length * Math.sqrt(reactionRate / diffusivity);
  return surfaceValue * Math.cosh((phi * y) / length) / Math.cosh(phi);
}

function finiteReactionSeriesSolution(y, length, diffusivity, reactionRate, time, terms = 80) {
  const eta = y / length;
  const tau = (diffusivity * time) / (length * length);
  const phi = length * Math.sqrt(reactionRate / diffusivity);
  let sum = Math.cosh(phi * eta) / Math.cosh(phi);
  for (let n = 0; n < terms; n += 1) {
    const lambda = (n + 0.5) * Math.PI;
    sum -=
      ((2 * lambda * (-1) ** n) / (phi * phi + lambda * lambda)) *
      Math.cos(lambda * eta) *
      Math.exp(-(lambda * lambda + phi * phi) * tau);
  }
  return sum;
}

function semiInfiniteReactionSolution(yFromSurface, diffusivity, reactionRate, time, surfaceValue = 1) {
  const root = Math.sqrt(reactionRate / diffusivity);
  return (
    (surfaceValue / 2) *
    (Math.exp(-yFromSurface * root) *
      erfc(yFromSurface / (2 * Math.sqrt(diffusivity * time)) - Math.sqrt(reactionRate * time)) +
      Math.exp(yFromSurface * root) *
        erfc(yFromSurface / (2 * Math.sqrt(diffusivity * time)) + Math.sqrt(reactionRate * time)))
  );
}

test("single layer transient diffusion approaches analytical Dirichlet step solution", () => {
  const length = 1;
  const diffusivity = 0.2;
  const time = 0.25;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Layer",
        h: length,
        diffusivity,
        elements: 80,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichlet",
      bottom: 0,
      top: 1,
    },
    time: { dt: 0.001, tMax: time, outputTimes: [time] },
  });

  const profile = response.finalProfile;
  [0.25, 0.5, 0.75].forEach((y) => {
    const value = sampleProfileAt(profile, y);
    const reference = slabDirichletStepSolution(y, length, diffusivity, time);
    expectClose(value, reference, 0.01, `Dirichlet transient value at y=${y}`);
  });
});

test("single layer early-time step boundary matches classical error-function solution", () => {
  const length = 1;
  const diffusivity = 0.02;
  const time = 0.05;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Semi-infinite approximation",
        h: length,
        diffusivity,
        elements: 100,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichlet",
      bottom: 0,
      top: 1,
    },
    time: { dt: 0.0005, tMax: time, outputTimes: [0.005, 0.02, time] },
  });

  const profile = response.finalProfile;
  [0.9, 0.94, 0.97].forEach((y) => {
    const value = sampleProfileAt(profile, y);
    const reference = semiInfiniteTopStepSolution(y, length, diffusivity, time);
    expectClose(value, reference, 0.035, `Error-function step solution at y=${y}`);
  });
});

test("surface step initial state is represented as a boundary discontinuity", () => {
  const response = solveTransientTransport({
    layers: [{ name: "Clean slab", h: 1, diffusivity: 0.1, elements: 20, initial: 0 }],
    boundaryConditions: {
      type: "dirichletTopNoFluxBottom",
      top: 1,
    },
    time: { dt: 0.01, tMax: 0.02, outputTimes: [0] },
  });

  const initial = response.profiles[0];
  assert.equal(initial.points[initial.points.length - 1].value, 1);
  initial.points.slice(0, -1).forEach((point, index) => {
    assert.equal(point.value, 0, `Interior node ${index} should remain clean at t=0.`);
  });
});

test("delayed step boundary stays inactive before tStep and snaps on after", () => {
  const tStep = 0.05;
  const response = solveTransientTransport({
    layers: [{ name: "Slab", h: 1, diffusivity: 0.1, elements: 30, initial: 0 }],
    boundaryConditions: {
      type: "dirichletTopNoFluxBottom",
      top: { type: "step", before: 0, after: 1, tStep },
    },
    time: { dt: 0.005, tMax: 0.2, outputTimes: [0.02, 0.05, 0.1, 0.2] },
  });

  const beforeStep = response.profiles.find((p) => Math.abs(p.time - 0.02) < 1e-9);
  beforeStep.points.forEach((point, index) => {
    assert.ok(
      Math.abs(point.value) < 1e-10,
      `Profile should still be clean at t=0.02 before step at node ${index}, got ${point.value}.`
    );
  });

  const afterStep = response.profiles.find((p) => Math.abs(p.time - 0.1) < 1e-9);
  const topValue = afterStep.points[afterStep.points.length - 1].value;
  assert.equal(topValue, 1, "Top node should be at after-step value once tStep has passed.");
  const interiorMax = Math.max(...afterStep.points.slice(0, -1).map((p) => Math.abs(p.value)));
  assert.ok(interiorMax > 0, "Interior should be responding to the step BC after tStep.");
});

test("course-note finite reaction steady state matches cosh Thiele solution", () => {
  const length = 1;
  const diffusivity = 1;
  const reactionRate = 4;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Reactive slab",
        h: length,
        diffusivity,
        reactionRate,
        elements: 80,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichletTopNoFluxBottom",
      top: 1,
    },
    time: { dt: 0.002, tMax: 2, outputTimes: [2] },
  });

  [0, 0.25, 0.5, 0.75, 1].forEach((y) => {
    const value = sampleProfileAt(response.finalProfile, y);
    const reference = finiteReactionSteadySolution(y, length, diffusivity, reactionRate);
    expectClose(value, reference, 0.01, `Thiele steady-state solution at y=${y}`);
  });
});

test("course-note finite reaction transient matches series solution", () => {
  const length = 1;
  const diffusivity = 1;
  const reactionRate = 1;
  const time = 0.12;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Reactive slab",
        h: length,
        diffusivity,
        reactionRate,
        elements: 100,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichletTopNoFluxBottom",
      top: 1,
    },
    time: { dt: 0.0005, tMax: time, outputTimes: [time] },
  });

  [0.2, 0.5, 0.8].forEach((y) => {
    const value = sampleProfileAt(response.finalProfile, y);
    const reference = finiteReactionSeriesSolution(y, length, diffusivity, reactionRate, time);
    expectClose(value, reference, 0.018, `Finite reaction series solution at y=${y}`);
  });
});

test("course-note semi-infinite reaction benchmark matches Danckwerts solution before back face responds", () => {
  const length = 3;
  const diffusivity = 0.2;
  const reactionRate = 0.5;
  const time = 0.08;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Long reactive slab",
        h: length,
        diffusivity,
        reactionRate,
        elements: 180,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichletTopNoFluxBottom",
      top: 1,
    },
    time: { dt: 0.0005, tMax: time, outputTimes: [time] },
  });

  [0.04, 0.08, 0.14].forEach((depthFromSurface) => {
    const y = length - depthFromSurface;
    const value = sampleProfileAt(response.finalProfile, y);
    const reference = semiInfiniteReactionSolution(depthFromSurface, diffusivity, reactionRate, time);
    expectClose(value, reference, 0.035, `Danckwerts semi-infinite solution at depth=${depthFromSurface}`);
  });
});

test("uniform pore-storage coefficient slows the transient by the expected time scale", () => {
  const base = solveTransientTransport({
    layers: [{ name: "Base", h: 1, diffusivity: 0.2, elements: 60, initial: 0 }],
    boundaryConditions: { type: "dirichletTopNoFluxBottom", top: 1 },
    time: { dt: 0.001, tMax: 0.05, outputTimes: [0.05] },
  });
  const stored = solveTransientTransport({
    layers: [
      {
        name: "Stored",
        h: 1,
        diffusivity: 0.2,
        storageCoefficient: 2,
        elements: 60,
        initial: 0,
      },
    ],
    boundaryConditions: { type: "dirichletTopNoFluxBottom", top: 1 },
    time: { dt: 0.001, tMax: 0.1, outputTimes: [0.1] },
  });

  [0.85, 0.92, 0.98].forEach((y) => {
    expectClose(
      sampleProfileAt(stored.finalProfile, y),
      sampleProfileAt(base.finalProfile, y),
      0.015,
      `Storage time scaling at y=${y}`
    );
  });
});

test("constant source approaches the steady parabolic profile", () => {
  const length = 1;
  const diffusivity = 0.5;
  const source = 2;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Source layer",
        h: length,
        diffusivity,
        source,
        elements: 60,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichlet",
      bottom: 0,
      top: 0,
    },
    time: { dt: 0.005, tMax: 4, outputTimes: [4] },
  });

  [0.25, 0.5, 0.75].forEach((y) => {
    const value = sampleProfileAt(response.finalProfile, y);
    const reference = (source * y * (length - y)) / (2 * diffusivity);
    expectClose(value, reference, 0.015, `Source steady value at y=${y}`);
  });
});

test("two layer steady limit preserves concentration and flux continuity", () => {
  const lower = { h: 0.4, diffusivity: 0.1 };
  const upper = { h: 0.6, diffusivity: 0.5 };
  const resistance = lower.h / lower.diffusivity + upper.h / upper.diffusivity;
  const gradientFlux = 1 / resistance;
  const interfaceValue = (gradientFlux * lower.h) / lower.diffusivity;

  const response = solveTransientTransport({
    layers: [
      {
        name: "Slow",
        h: lower.h,
        diffusivity: lower.diffusivity,
        elements: 50,
        initial: { type: "linear", bottom: 0, top: interfaceValue },
      },
      {
        name: "Fast",
        h: upper.h,
        diffusivity: upper.diffusivity,
        elements: 50,
        initial: { type: "linear", bottom: interfaceValue, top: 1 },
      },
    ],
    boundaryConditions: {
      type: "dirichlet",
      bottom: 0,
      top: 1,
    },
    time: { dt: 0.01, tMax: 2, outputTimes: [2] },
  });

  const profile = response.finalProfile;
  expectClose(sampleProfileAt(profile, lower.h), interfaceValue, 0.005, "Interface concentration");

  const leftValue = sampleProfileAt(profile, lower.h - 0.02);
  const interfaceNodeValue = sampleProfileAt(profile, lower.h);
  const rightValue = sampleProfileAt(profile, lower.h + 0.02);
  const lowerFlux = lower.diffusivity * (interfaceNodeValue - leftValue) / 0.02;
  const upperFlux = upper.diffusivity * (rightValue - interfaceNodeValue) / 0.02;
  expectClose(lowerFlux, upperFlux, 0.02, "Interface flux");
});

test("Begley-Hutchinson Chapter 15 style bilayer preserves interface flux during transient", () => {
  const substrate = { h: 0.002, diffusivity: 50 / 4e6 };
  const coating = { h: 0.0005, diffusivity: 25 / 2.5e6 };
  const interfaceY = substrate.h;
  const response = solveTransientTransport({
    layers: [
      {
        name: "Layer 1 substrate",
        h: substrate.h,
        diffusivity: substrate.diffusivity,
        elements: 32,
        initial: 20,
      },
      {
        name: "Layer 2 coating",
        h: coating.h,
        diffusivity: coating.diffusivity,
        elements: 16,
        initial: 20,
      },
    ],
    boundaryConditions: {
      type: "convectiveTop",
      bottom: 20,
      transferCoefficient: 8000 / 2.5e6,
      ambient: {
        type: "piecewiseLinear",
        points: [
          { time: 0, value: 20 },
          { time: 0.5, value: 520 },
          { time: 2, value: 520 },
          { time: 2.5, value: 20 },
          { time: 4, value: 20 },
        ],
      },
    },
    time: { dt: 0.002, tMax: 0.5, outputTimes: [0.1, 0.25, 0.5] },
  });

  response.profiles.slice(1).forEach((profile) => {
    const dyLower = substrate.h / 32;
    const dyUpper = coating.h / 16;
    const interfaceValue = sampleProfileAt(profile, interfaceY);
    const lowerValue = sampleProfileAt(profile, interfaceY - dyLower);
    const upperValue = sampleProfileAt(profile, interfaceY + dyUpper);
    const lowerFlux = substrate.diffusivity * (interfaceValue - lowerValue) / dyLower;
    const upperFlux = coating.diffusivity * (upperValue - interfaceValue) / dyUpper;
    expectClose(lowerFlux, upperFlux, 0.08, `B&H-style interface flux at t=${profile.time}`);
  });
});

test("fixed bottom with convective top remains at equilibrium when ambient matches initial state", () => {
  const response = solveTransientTransport({
    layers: [
      {
        name: "Layer",
        h: 1,
        diffusivity: 0.25,
        elements: 40,
        initial: 20,
      },
    ],
    boundaryConditions: {
      type: "convectiveTop",
      bottom: 20,
      initialTop: 20,
      transferCoefficient: 5,
      ambient: 20,
    },
    time: { dt: 0.01, tMax: 1, outputTimes: [1] },
  });

  response.finalProfile.values.forEach((value, index) => {
    expectClose(value, 20, 1e-12, `Equilibrium node ${index}`);
  });
});

test("transport profile can drive swelling mismatch stresses through Milestone 1 solver", () => {
  const response = solveTransientTransport({
    layers: [
      {
        name: "Substrate",
        h: 0.002,
        diffusivity: 2e-5,
        elements: 20,
        initial: 0,
      },
      {
        name: "Coating",
        h: 0.0005,
        diffusivity: 6e-6,
        elements: 12,
        initial: 0,
      },
    ],
    boundaryConditions: {
      type: "dirichlet",
      bottom: 0,
      top: {
        type: "piecewiseLinear",
        points: [
          { time: 0, value: 0 },
          { time: 0.01, value: 1 },
          { time: 0.08, value: 1 },
        ],
      },
    },
    time: { dt: 0.002, tMax: 0.08, outputTimes: [0, 0.02, 0.08] },
  });

  const stressHistory = computeStressHistoryFromTransport(
    response,
    [
      { name: "Substrate", E: 200e9, nu: 0.3, swellingCoefficient: 1e-3 },
      { name: "Coating", E: 80e9, nu: 0.24, swellingCoefficient: 4e-3 },
    ],
    { condition: "planestrain", referenceValue: 0 }
  );

  assert.equal(stressHistory.length, 3);
  stressHistory.forEach((item) => {
    assert.equal(item.diagnostics.sublayerCount, 32);
    item.stresses.forEach((stress) => {
      assert.ok(Number.isFinite(stress.stressBot));
      assert.ok(Number.isFinite(stress.stressTop));
    });
  });

  const initialMaxStress = Math.max(
    ...stressHistory[0].stresses.flatMap((stress) => [Math.abs(stress.stressBot), Math.abs(stress.stressTop)])
  );
  const finalMaxStress = Math.max(
    ...stressHistory[2].stresses.flatMap((stress) => [Math.abs(stress.stressBot), Math.abs(stress.stressTop)])
  );
  assert.ok(initialMaxStress < 1e-3, `Initial stress should be near zero, got ${initialMaxStress}`);
  assert.ok(finalMaxStress > 1e5, `Transient swelling should generate stress, got ${finalMaxStress}`);
});
