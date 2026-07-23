import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const prismaImportPatterns = [
  "@prisma/**",
  "prisma",
  "prisma/**",
  "@/generated/prisma/**",
  "@generated/prisma/**",
  "**/generated/prisma/**",
];

const applicationBypassPatterns = [
  "@/domain/**",
  "@domain/**",
  "@/infrastructure/**",
  "@infrastructure/**",
  "**/domain/**",
  "**/infrastructure/**",
];

export const appBoundaryRules = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: [...prismaImportPatterns, "@/infrastructure/**", "@infrastructure/**", "**/infrastructure/**"],
          message:
            "App routes and UI must use application commands/queries; Prisma and infrastructure adapters are not transport dependencies.",
        },
      ],
    },
  ],
};

export const routeBoundaryRules = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: [...prismaImportPatterns, ...applicationBypassPatterns],
          message:
            "Route modules may reach business behavior only through the application layer.",
        },
      ],
    },
  ],
};

export const domainBoundaryRules = {
  "no-restricted-globals": [
    "error",
    {
      name: "process",
      message: "Pure domain code must receive configuration as input.",
    },
    {
      name: "fetch",
      message: "Pure domain code must use an application-owned network port.",
    },
    {
      name: "WebSocket",
      message: "Pure domain code must use an application-owned network port.",
    },
    {
      name: "EventSource",
      message: "Pure domain code must use an application-owned network port.",
    },
  ],
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: [
            ...prismaImportPatterns,
            "@/app/**",
            "@app/**",
            "@/application/**",
            "@application/**",
            "@/infrastructure/**",
            "@infrastructure/**",
            "**/app/**",
            "**/application/**",
            "**/infrastructure/**",
            "next",
            "next/**",
            "node:*",
            "pg",
            "pg/**",
            "undici",
            "undici/**",
          ],
          message:
            "Pure domain code cannot depend on transport, application orchestration, database, network, or runtime infrastructure.",
        },
      ],
    },
  ],
};

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: appBoundaryRules,
  },
  {
    files: ["src/app/**/route.{ts,tsx}"],
    rules: routeBoundaryRules,
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: domainBoundaryRules,
  },
  {
    files: ["deploy/**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([
    ".partner-next/**",
    ".partner-cache/**",
    "node_modules/**",
    "src/generated/prisma/**",
    "next-env.d.ts",
  ]),
]);
