import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PARTNER_PORT = "3001";
const configuredPort = process.env.PARTNER_PORT;

if (configuredPort !== PARTNER_PORT) {
  console.error("Invalid Partner process configuration: PARTNER_PORT must equal 3001");
  process.exitCode = 1;
} else {
  const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
  const child = spawn(
    process.execPath,
    [nextBin, "start", "--port", configuredPort],
    { env: { ...process.env, PORT: configuredPort }, stdio: "inherit" },
  );

  child.once("error", () => { process.exitCode = 1; });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
