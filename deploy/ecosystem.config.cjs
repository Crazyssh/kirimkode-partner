const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
if (path.basename(appRoot) !== "kirimkode-partner") {
  throw new Error("Refusing PM2 config outside the kirimkode-partner app root");
}

module.exports = {
  apps: [
    {
      name: "kirimkode-partner",
      cwd: appRoot,
      script: "scripts/start-partner.mjs",
      interpreter: process.execPath,
      node_args: ["--env-file=/etc/kirimkode-partner/partner.env"],
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      time: true,
      out_file: "/var/log/kirimkode-partner/app.log",
      error_file: "/var/log/kirimkode-partner/error.log",
      pid_file: "/var/run/kirimkode-partner/kirimkode-partner.pid",
      env: {
        NODE_ENV: "production",
        PARTNER_ENVIRONMENT: "production",
        PARTNER_RUNTIME_ID: "kirimkode-partner",
        PARTNER_PORT: "3001",
        PORT: "3001",
      },
    },
  ],
};
