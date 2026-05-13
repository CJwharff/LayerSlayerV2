import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const htmlPath = path.join(root, "LayerSlayerV2.html");
const modelPath = path.join(root, "model.js");
const transientModelPath = path.join(root, "transientTransportModel.js");
const solverPath = path.join(root, "solver.js");
const transientSolverPath = path.join(root, "transientTransportSolver.js");
const transportStressPath = path.join(root, "transportStressCoupling.js");
const appPath = path.join(root, "app.js");
const distDir = path.join(root, "dist");
const distHtmlPath = path.join(distDir, "LayerSlayerV2.html");

function stripModuleSyntax(source, kind) {
  let output = source;
  if (kind === "solver") {
    output = output.replace('import { validateAndNormalizeInput } from "./model.js";\n\n', "");
  }
  if (kind === "transientSolver") {
    output = output.replace(
      'import { evaluateHistory, validateAndNormalizeTransientInput } from "./transientTransportModel.js";\n\n',
      ""
    );
  }
  if (kind === "transportStress") {
    output = output.replace('import { computeStresses, solveDeformation } from "./solver.js";\n\n', "");
  }
  if (kind === "app") {
    output = output
      .replace('import { computeGvsPositionSubdivided, computeMultilayerResponse } from "./solver.js";\n', "")
      .replace('import { solveTransientTransport } from "./transientTransportSolver.js";\n', "")
      .replace('import { computeStressHistoryFromTransport } from "./transportStressCoupling.js";\n\n', "");
  }
  return output.replace(/^export\s+/gm, "");
}

const html = fs.readFileSync(htmlPath, "utf8");
const model = stripModuleSyntax(fs.readFileSync(modelPath, "utf8"));
const transientModel = stripModuleSyntax(fs.readFileSync(transientModelPath, "utf8"));
const solver = stripModuleSyntax(fs.readFileSync(solverPath, "utf8"), "solver");
const transientSolver = stripModuleSyntax(fs.readFileSync(transientSolverPath, "utf8"), "transientSolver");
const transportStress = stripModuleSyntax(fs.readFileSync(transportStressPath, "utf8"), "transportStress");
const app = stripModuleSyntax(fs.readFileSync(appPath, "utf8"), "app");

const bundledScript = `<script type="module">\n${model}\n\n${transientModel}\n\n${solver}\n\n${transientSolver}\n\n${transportStress}\n\n${app}\n</script>`;
const standaloneHtml = html.replace(
  '  <script type="module" src="./app.js"></script>',
  bundledScript
);

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(distHtmlPath, standaloneHtml);

console.log(`Wrote ${distHtmlPath}`);
