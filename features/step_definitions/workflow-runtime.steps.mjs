import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { evaluateWorkflowRunDuration } from "../support/workflow-runtime-policy.mjs";

Given("a completed GitHub Actions run started at {string} and last updated at {string}", function (runStartedAt, updatedAt) {
  this.workflowRun = { status: "completed", run_started_at: runStartedAt, updated_at: updatedAt };
});

Given("a GitHub Actions run with status {string} started at {string} and no final update", function (status, runStartedAt) {
  this.workflowRun = { status, run_started_at: runStartedAt, updated_at: null };
});

When("the repository-wide workflow duration rule evaluates the run", function () {
  this.workflowDuration = evaluateWorkflowRunDuration(this.workflowRun);
});

Then("the workflow run duration is {int} milliseconds", function (durationMs) {
  assert.equal(this.workflowDuration.measured, true, "completed run timestamps must be measurable");
  assert.equal(this.workflowDuration.durationMs, durationMs);
});

Then("the workflow run duration is unavailable", function () {
  assert.equal(this.workflowDuration.measured, false);
  assert.equal(this.workflowDuration.durationMs, null);
});

Then("the workflow run is accepted by the under-60-second rule", function () {
  assert.equal(this.workflowDuration.accepted, true);
});

Then("the workflow run is rejected by the under-60-second rule", function () {
  assert.equal(this.workflowDuration.accepted, false);
  assert.equal(this.workflowDuration.reason, "workflow run reached the duration limit");
});

Then("the workflow run is rejected as unmeasurable", function () {
  assert.equal(this.workflowDuration.accepted, false);
  assert.match(this.workflowDuration.reason, /not completed/);
});
