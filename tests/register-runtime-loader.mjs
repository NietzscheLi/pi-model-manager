import { register } from "node:module";

if (!process.env.PI_TEST_RUNTIME_ROOT) throw new Error("Set PI_TEST_RUNTIME_ROOT to the installed pi-coding-agent package directory");
process.env.PI_MODEL_MANAGER_REAL_RUNTIME = "1";
register("./pi-runtime-loader.mjs", import.meta.url, { data: { root: process.env.PI_TEST_RUNTIME_ROOT } });
