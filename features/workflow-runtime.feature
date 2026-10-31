Feature: GitHub Actions workflow runtime

  Rule: Every completed workflow run in this repository must finish in under 60 seconds
    Measure the run-level interval from run_started_at to updated_at after status is completed.
    Apply this rule to every workflow. Do not use a metrics-function timer as a substitute.

    Scenario: A completed workflow run below the limit is accepted
      Given a completed GitHub Actions run started at "2026-11-01T00:00:00.000Z" and last updated at "2026-11-01T00:00:59.999Z"
      When the repository-wide workflow duration rule evaluates the run
      Then the workflow run duration is 59999 milliseconds
      And the workflow run is accepted by the under-60-second rule

    Scenario: A completed workflow run at the limit is rejected
      Given a completed GitHub Actions run started at "2026-11-01T00:00:00.000Z" and last updated at "2026-11-01T00:01:00.000Z"
      When the repository-wide workflow duration rule evaluates the run
      Then the workflow run duration is 60000 milliseconds
      And the workflow run is rejected by the under-60-second rule

    Scenario: An unfinished workflow run cannot pass the duration rule
      Given a GitHub Actions run with status "in_progress" started at "2026-11-01T00:00:00.000Z" and no final update
      When the repository-wide workflow duration rule evaluates the run
      Then the workflow run duration is unavailable
      And the workflow run is rejected as unmeasurable
