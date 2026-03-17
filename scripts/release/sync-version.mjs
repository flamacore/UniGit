import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!version) {
  throw new Error("Expected a semantic version argument.");
}

execFileSync("npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

const tauriConfigPath = new URL("../../src-tauri/tauri.conf.json", import.meta.url);
const cargoTomlPath = new URL("../../src-tauri/Cargo.toml", import.meta.url);

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;
writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

const cargoToml = readFileSync(cargoTomlPath, "utf8");
const cargoVersionPattern = /^version = ".*"$/m;

if (!cargoVersionPattern.test(cargoToml)) {
  throw new Error("Failed to locate version in src-tauri/Cargo.toml.");
}

const updatedCargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`);

writeFileSync(cargoTomlPath, updatedCargoToml);