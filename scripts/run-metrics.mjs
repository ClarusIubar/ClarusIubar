import process from "node:process";
import { runMetricsRefresh } from "./metrics-workflow.mjs";

try {
  await runMetricsRefresh();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
