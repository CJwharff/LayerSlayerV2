import { evaluateHistory, validateAndNormalizeTransientInput } from "./transientTransportModel.js";

const TIME_TOLERANCE = 1e-10;

function zeros(rows, cols = rows) {
  return Array.from({ length: rows }, () => Array(cols).fill(0));
}

function addElementMatrices(
  globalMass,
  globalStiffness,
  globalSource,
  left,
  right,
  length,
  diffusivity,
  source,
  reactionRate,
  storageCoefficient
) {
  const massScale = length / 6;
  const storageMassScale = storageCoefficient * massScale;
  const stiffnessScale = diffusivity / length;
  const reactionScale = reactionRate * massScale;
  const sourceScale = (source * length) / 2;

  globalMass[left][left] += 2 * storageMassScale;
  globalMass[left][right] += storageMassScale;
  globalMass[right][left] += storageMassScale;
  globalMass[right][right] += 2 * storageMassScale;

  globalStiffness[left][left] += stiffnessScale + 2 * reactionScale;
  globalStiffness[left][right] += -stiffnessScale + reactionScale;
  globalStiffness[right][left] += -stiffnessScale + reactionScale;
  globalStiffness[right][right] += stiffnessScale + 2 * reactionScale;

  globalSource[left] += sourceScale;
  globalSource[right] += sourceScale;
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function addVectors(a, b) {
  return a.map((value, index) => value + b[index]);
}

function applyDirichlet(matrix, rhs, index, value) {
  for (let row = 0; row < matrix.length; row += 1) {
    if (row !== index) {
      rhs[row] -= matrix[row][index] * value;
      matrix[row][index] = 0;
    }
  }
  matrix[index].fill(0);
  matrix[index][index] = 1;
  rhs[index] = value;
}

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivotRow][col])) {
        pivotRow = row;
      }
    }
    if (Math.abs(a[pivotRow][col]) < 1e-30) {
      throw new Error("Transient transport solve failed: singular matrix.");
    }
    if (pivotRow !== col) {
      [a[pivotRow], a[col]] = [a[col], a[pivotRow]];
    }

    const pivot = a[col][col];
    for (let entry = col; entry <= n; entry += 1) {
      a[col][entry] /= pivot;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let entry = col; entry <= n; entry += 1) {
        a[row][entry] -= factor * a[col][entry];
      }
    }
  }

  return a.map((row) => row[n]);
}

function initialValue(initial, localFraction) {
  if (initial.type === "uniform") return initial.value;
  return initial.bottom + localFraction * (initial.top - initial.bottom);
}

function buildMesh(layers) {
  const nodes = [{ index: 0, y: 0, layerIndex: 0, localFraction: 0, layerName: layers[0].name }];
  const elements = [];
  let y = 0;

  layers.forEach((layer, layerIndex) => {
    const dy = layer.h / layer.elements;
    for (let localElement = 0; localElement < layer.elements; localElement += 1) {
      const left = nodes.length - 1;
      y += dy;
      const isTopOfLayer = localElement === layer.elements - 1;
      nodes.push({
        index: nodes.length,
        y,
        layerIndex,
        localFraction: (localElement + 1) / layer.elements,
        layerName: layer.name,
        isInterface: isTopOfLayer && layerIndex < layers.length - 1,
      });
      elements.push({
        left,
        right: nodes.length - 1,
        length: dy,
        diffusivity: layer.diffusivity,
        source: layer.source,
        reactionRate: layer.reactionRate,
        storageCoefficient: layer.storageCoefficient,
        layerIndex,
        layerName: layer.name,
      });
    }
  });

  return { nodes, elements, totalThickness: y };
}

function buildSystem(layers, mesh) {
  const mass = zeros(mesh.nodes.length);
  const stiffness = zeros(mesh.nodes.length);
  const source = Array(mesh.nodes.length).fill(0);

  mesh.elements.forEach((element) => {
    addElementMatrices(
      mass,
      stiffness,
      source,
      element.left,
      element.right,
      element.length,
      element.diffusivity,
        element.source,
        element.reactionRate,
        element.storageCoefficient
    );
  });

  const initialValues = mesh.nodes.map((node) => {
    const layer = layers[node.layerIndex];
    return initialValue(layer.initial, node.localFraction);
  });

  return { mass, stiffness, source, values: initialValues };
}

function buildBaseStepMatrix(mass, stiffness, dt) {
  return mass.map((row, i) => row.map((value, j) => value + dt * stiffness[i][j]));
}

function applyBoundaryConditions(stepMatrix, rhs, boundaryConditions, time, dt, topIndex) {
  if (boundaryConditions.type === "dirichlet") {
    applyDirichlet(stepMatrix, rhs, 0, evaluateHistory(boundaryConditions.bottom, time));
    applyDirichlet(stepMatrix, rhs, topIndex, evaluateHistory(boundaryConditions.top, time));
    return;
  }
  if (boundaryConditions.type === "dirichletTopNoFluxBottom") {
    applyDirichlet(stepMatrix, rhs, topIndex, evaluateHistory(boundaryConditions.top, time));
    return;
  }

  const h = boundaryConditions.transferCoefficient;
  const ambient = evaluateHistory(boundaryConditions.ambient, time);
  stepMatrix[topIndex][topIndex] += dt * h;
  rhs[topIndex] += dt * h * ambient;
  applyDirichlet(stepMatrix, rhs, 0, evaluateHistory(boundaryConditions.bottom, time));
}

function captureProfile(time, values, nodes) {
  return {
    time,
    values: values.slice(),
    points: nodes.map((node, index) => ({
      y: node.y,
      value: values[index],
      layerIndex: node.layerIndex,
      layerName: node.layerName,
      isInterface: !!node.isInterface,
    })),
  };
}

function shouldCapture(time, outputTimes, nextOutputIndex) {
  return nextOutputIndex < outputTimes.length && Math.abs(time - outputTimes[nextOutputIndex]) <= TIME_TOLERANCE;
}

export function solveTransientTransport(rawInput) {
  const input = validateAndNormalizeTransientInput(rawInput);
  const mesh = buildMesh(input.layers);
  const system = buildSystem(input.layers, mesh);
  const profiles = [];
  const topIndex = mesh.nodes.length - 1;
  const outputTimes = input.time.outputTimes;
  let nextOutputIndex = 0;
  let time = 0;
  let values = system.values.slice();

  if (input.boundaryConditions.type === "dirichlet") {
    values[0] = evaluateHistory(input.boundaryConditions.bottom, 0);
    values[topIndex] = evaluateHistory(input.boundaryConditions.top, 0);
  } else if (input.boundaryConditions.type === "dirichletTopNoFluxBottom") {
    values[topIndex] = evaluateHistory(input.boundaryConditions.top, 0);
  } else {
    values[0] = evaluateHistory(input.boundaryConditions.bottom, 0);
  }

  while (shouldCapture(time, outputTimes, nextOutputIndex)) {
    profiles.push(captureProfile(outputTimes[nextOutputIndex], values, mesh.nodes));
    nextOutputIndex += 1;
  }

  while (time < input.time.tMax - TIME_TOLERANCE) {
    const nextRequestedOutput =
      nextOutputIndex < outputTimes.length ? outputTimes[nextOutputIndex] : input.time.tMax;
    const nextTime = Math.min(time + input.time.dt, nextRequestedOutput, input.time.tMax);
    const dt = nextTime - time;
    const rhs = addVectors(multiplyMatrixVector(system.mass, values), system.source.map((value) => dt * value));
    const stepMatrix = buildBaseStepMatrix(system.mass, system.stiffness, dt);

    applyBoundaryConditions(stepMatrix, rhs, input.boundaryConditions, nextTime, dt, topIndex);
    values = solveLinearSystem(stepMatrix, rhs);
    time = nextTime;

    while (shouldCapture(time, outputTimes, nextOutputIndex)) {
      profiles.push(captureProfile(outputTimes[nextOutputIndex], values, mesh.nodes));
      nextOutputIndex += 1;
    }
  }

  return {
    nodes: mesh.nodes,
    elements: mesh.elements,
    profiles,
    finalProfile: profiles[profiles.length - 1] || captureProfile(time, values, mesh.nodes),
    diagnostics: {
      scheme: "backward-euler",
      elementType: "continuous-linear-1d",
      nodeCount: mesh.nodes.length,
      elementCount: mesh.elements.length,
      totalThickness: mesh.totalThickness,
      boundaryConditionType: input.boundaryConditions.type,
    },
  };
}

export function sampleProfileAt(profile, y) {
  const points = profile.points;
  if (y <= points[0].y) return points[0].value;
  for (let i = 1; i < points.length; i += 1) {
    if (y <= points[i].y) {
      const left = points[i - 1];
      const right = points[i];
      if (Math.abs(right.y - left.y) < 1e-30) return right.value;
      const fraction = (y - left.y) / (right.y - left.y);
      return left.value + fraction * (right.value - left.value);
    }
  }
  return points[points.length - 1].value;
}
