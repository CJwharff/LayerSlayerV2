const MIN_ELEMENTS_PER_LAYER = 1;

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertPositive(value, label) {
  assertFiniteNumber(value, label);
  if (value <= 0) {
    throw new Error(`${label} must be > 0.`);
  }
}

function assertNonNegative(value, label) {
  assertFiniteNumber(value, label);
  if (value < 0) {
    throw new Error(`${label} must be >= 0.`);
  }
}

function normalizeHistory(history, label) {
  if (typeof history === "number") {
    assertFiniteNumber(history, label);
    return { type: "constant", value: history };
  }
  if (typeof history === "function") {
    return { type: "function", fn: history };
  }
  if (!history || typeof history !== "object") {
    throw new Error(`${label} must be a number, function, or history object.`);
  }

  const type = (history.type || "constant").toLowerCase();
  if (type === "constant") {
    assertFiniteNumber(history.value, `${label}.value`);
    return { type, value: history.value };
  }
  if (type === "linear") {
    assertFiniteNumber(history.initial, `${label}.initial`);
    assertFiniteNumber(history.final, `${label}.final`);
    assertNonNegative(history.tStart ?? 0, `${label}.tStart`);
    assertPositive(history.tEnd, `${label}.tEnd`);
    if ((history.tStart ?? 0) >= history.tEnd) {
      throw new Error(`${label}.tEnd must be greater than ${label}.tStart.`);
    }
    return {
      type,
      initial: history.initial,
      final: history.final,
      tStart: history.tStart ?? 0,
      tEnd: history.tEnd,
    };
  }
  if (type === "exponential") {
    assertFiniteNumber(history.initial, `${label}.initial`);
    assertFiniteNumber(history.final, `${label}.final`);
    assertPositive(history.tau, `${label}.tau`);
    return { type, initial: history.initial, final: history.final, tau: history.tau };
  }
  if (type === "step") {
    assertFiniteNumber(history.before ?? 0, `${label}.before`);
    assertFiniteNumber(history.after, `${label}.after`);
    assertNonNegative(history.tStep ?? 0, `${label}.tStep`);
    return {
      type,
      before: history.before ?? 0,
      after: history.after,
      tStep: history.tStep ?? 0,
    };
  }
  if (type === "piecewiselinear") {
    if (!Array.isArray(history.points) || history.points.length < 1) {
      throw new Error(`${label}.points must include at least one point.`);
    }
    const points = history.points.map((point, index) => {
      if (!point || typeof point !== "object") {
        throw new Error(`${label}.points[${index}] must be an object.`);
      }
      assertNonNegative(point.time, `${label}.points[${index}].time`);
      assertFiniteNumber(point.value, `${label}.points[${index}].value`);
      return { time: point.time, value: point.value };
    });
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].time <= points[i - 1].time) {
        throw new Error(`${label}.points times must be strictly increasing.`);
      }
    }
    return { type: "piecewiseLinear", points };
  }

  throw new Error(`${label}.type "${history.type}" is not supported.`);
}

function normalizeInitialCondition(initial, label) {
  if (typeof initial === "number") {
    assertFiniteNumber(initial, label);
    return { type: "uniform", value: initial };
  }
  if (!initial || typeof initial !== "object") {
    return { type: "uniform", value: 0 };
  }

  const type = (initial.type || "uniform").toLowerCase();
  if (type === "uniform") {
    assertFiniteNumber(initial.value, `${label}.value`);
    return { type, value: initial.value };
  }
  if (type === "linear") {
    assertFiniteNumber(initial.bottom, `${label}.bottom`);
    assertFiniteNumber(initial.top, `${label}.top`);
    return { type, bottom: initial.bottom, top: initial.top };
  }
  throw new Error(`${label}.type "${initial.type}" is not supported.`);
}

function normalizeLayer(layer, index) {
  if (!layer || typeof layer !== "object") {
    throw new Error(`layers[${index}] must be an object.`);
  }
  const prefix = `layers[${index}]`;
  assertPositive(layer.h, `${prefix}.h`);
  assertPositive(layer.diffusivity, `${prefix}.diffusivity`);
  const elements = layer.elements == null ? 10 : layer.elements;
  if (!Number.isInteger(elements) || elements < MIN_ELEMENTS_PER_LAYER) {
    throw new Error(`${prefix}.elements must be an integer >= ${MIN_ELEMENTS_PER_LAYER}.`);
  }
  const source = layer.source == null ? 0 : layer.source;
  assertFiniteNumber(source, `${prefix}.source`);
  const reactionRate = layer.reactionRate == null ? 0 : layer.reactionRate;
  assertNonNegative(reactionRate, `${prefix}.reactionRate`);
  const storageCoefficient = layer.storageCoefficient == null ? 1 : layer.storageCoefficient;
  assertPositive(storageCoefficient, `${prefix}.storageCoefficient`);

  return {
    name: layer.name || `Layer ${index + 1}`,
    h: layer.h,
    diffusivity: layer.diffusivity,
    elements,
    source,
    reactionRate,
    storageCoefficient,
    initial: normalizeInitialCondition(layer.initial, `${prefix}.initial`),
  };
}

function initialBottom(initial) {
  return initial.type === "uniform" ? initial.value : initial.bottom;
}

function initialTop(initial) {
  return initial.type === "uniform" ? initial.value : initial.top;
}

function assertContinuousInitialProfile(layers) {
  for (let i = 0; i < layers.length - 1; i += 1) {
    const lowerTop = initialTop(layers[i].initial);
    const upperBottom = initialBottom(layers[i + 1].initial);
    if (Math.abs(lowerTop - upperBottom) > 1e-10 * Math.max(1, Math.abs(lowerTop), Math.abs(upperBottom))) {
      throw new Error(
        `Initial profile must be continuous at interface ${i + 1}: layers[${i}].top != layers[${i + 1}].bottom.`
      );
    }
  }
}

function normalizeBoundaryConditions(boundaryConditions) {
  if (!boundaryConditions || typeof boundaryConditions !== "object") {
    throw new Error("boundaryConditions must be an object.");
  }
  const type = boundaryConditions.type;
  if (type === "dirichlet") {
    return {
      type,
      bottom: normalizeHistory(boundaryConditions.bottom, "boundaryConditions.bottom"),
      top: normalizeHistory(boundaryConditions.top, "boundaryConditions.top"),
    };
  }
  if (type === "dirichletTopNoFluxBottom") {
    return {
      type,
      top: normalizeHistory(boundaryConditions.top, "boundaryConditions.top"),
    };
  }
  if (type === "convectiveTop") {
    assertPositive(boundaryConditions.transferCoefficient, "boundaryConditions.transferCoefficient");
    return {
      type,
      bottom: normalizeHistory(boundaryConditions.bottom, "boundaryConditions.bottom"),
      transferCoefficient: boundaryConditions.transferCoefficient,
      ambient: normalizeHistory(boundaryConditions.ambient, "boundaryConditions.ambient"),
    };
  }
  throw new Error('boundaryConditions.type must be "dirichlet", "dirichletTopNoFluxBottom", or "convectiveTop".');
}

function normalizeTime(time) {
  if (!time || typeof time !== "object") {
    throw new Error("time must be an object.");
  }
  assertPositive(time.dt, "time.dt");
  assertPositive(time.tMax, "time.tMax");
  if (time.dt > time.tMax) {
    throw new Error("time.dt must be <= time.tMax.");
  }

  const outputTimes = time.outputTimes == null ? [0, time.tMax] : time.outputTimes;
  if (!Array.isArray(outputTimes) || outputTimes.length < 1) {
    throw new Error("time.outputTimes must include at least one time.");
  }
  const normalizedOutputTimes = outputTimes.map((value, index) => {
    assertNonNegative(value, `time.outputTimes[${index}]`);
    if (value > time.tMax + 1e-12) {
      throw new Error(`time.outputTimes[${index}] must be <= time.tMax.`);
    }
    return value;
  });

  return {
    dt: time.dt,
    tMax: time.tMax,
    outputTimes: Array.from(new Set([0, ...normalizedOutputTimes])).sort((a, b) => a - b),
  };
}

export function evaluateHistory(history, time) {
  if (history.type === "constant") return history.value;
  if (history.type === "function") {
    const value = history.fn(time);
    assertFiniteNumber(value, "history function result");
    return value;
  }
  if (history.type === "linear") {
    if (time <= history.tStart) return history.initial;
    if (time >= history.tEnd) return history.final;
    const fraction = (time - history.tStart) / (history.tEnd - history.tStart);
    return history.initial + fraction * (history.final - history.initial);
  }
  if (history.type === "exponential") {
    return history.final + (history.initial - history.final) * Math.exp(-time / history.tau);
  }
  if (history.type === "step") {
    return time < history.tStep ? history.before : history.after;
  }
  if (history.type === "piecewiseLinear") {
    const points = history.points;
    if (time <= points[0].time) return points[0].value;
    for (let i = 1; i < points.length; i += 1) {
      if (time <= points[i].time) {
        const left = points[i - 1];
        const right = points[i];
        const fraction = (time - left.time) / (right.time - left.time);
        return left.value + fraction * (right.value - left.value);
      }
    }
    return points[points.length - 1].value;
  }
  throw new Error(`Unsupported history type "${history.type}".`);
}

export function validateAndNormalizeTransientInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Input must be an object.");
  }
  if (!Array.isArray(input.layers) || input.layers.length < 1) {
    throw new Error("Input must include a non-empty layers array.");
  }
  const layers = input.layers.map(normalizeLayer);
  assertContinuousInitialProfile(layers);

  return {
    layers,
    boundaryConditions: normalizeBoundaryConditions(input.boundaryConditions),
    time: normalizeTime(input.time),
  };
}
