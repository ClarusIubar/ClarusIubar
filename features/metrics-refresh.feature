Feature: GitHub Metrics refresh
  The workflow publishes metrics only when GitHub returns a complete response for
  the configured profile. Failed refreshes keep the previous asset set and fail
  the Actions job with safe diagnostic evidence.

  Scenario: A complete response for the configured account publishes fresh metrics
    Given the metrics refresh targets "ClarusIubar"
    And GitHub authenticates the request as "ClarusIubar"
    And the owned repository and contribution responses are complete
    And a previous metrics asset set exists
    When the full metrics refresh runs
    Then the refresh succeeds with a fresh generated timestamp
    And the new complete asset set replaces the previous asset set once

  Scenario: A GraphQL 401 fails with request evidence and preserves all assets
    Given the metrics refresh targets "ClarusIubar"
    And the selected credential source is "METRICS_TOKEN"
    And GitHub rejects the contribution request with HTTP 401 and request ID "REQ-401"
    And the same credential can read the REST identity "ClarusIubar"
    And a previous metrics asset set exists
    When the full metrics refresh runs
    Then the refresh fails at stage "contribution calendar"
    And the previous asset set remains byte-identical
    And the failure reports source "METRICS_TOKEN" and request ID "REQ-401"
    And the rejection cause is reported as undetermined
    And the rejected GraphQL request is not retried
    And the diagnostic contains no credential value

  Scenario: An unexpected authenticated account is rejected before repository reads
    Given the metrics refresh targets "ClarusIubar"
    And GitHub authenticates the request as "different-account"
    And a previous metrics asset set exists
    When the full metrics refresh runs
    Then the refresh fails at stage "repository listing"
    And no repository tree or contribution request is made
    And the previous asset set remains byte-identical

  Scenario: Exhausted rate-limit retries do not report stale assets as success
    Given the metrics refresh targets "ClarusIubar"
    And GitHub returns HTTP 429 for every repository-listing attempt
    And the retry limit is 3 attempts
    And a previous metrics asset set exists
    When the full metrics refresh runs
    Then the refresh fails at stage "repository listing"
    And exactly 3 repository-listing attempts are made
    And the previous asset set remains byte-identical
    And the previous timestamp is not reported as a successful refresh

  Scenario: Partial GraphQL data with errors is rejected before publishing
    Given the metrics refresh targets "ClarusIubar"
    And GitHub authenticates the request as "ClarusIubar"
    And the repository response contains partial data and GraphQL errors
    And a previous metrics asset set exists
    When the full metrics refresh runs
    Then the refresh fails at stage "repository listing"
    And no metrics asset is written
    And the previous asset set remains byte-identical

  Scenario: An empty private tree is accepted only for the exact verified tree object
    Given the metrics refresh targets "ClarusIubar"
    And GitHub authenticates the request as "ClarusIubar"
    And an owned private repository has root tree "EMPTY-TREE-SHA"
    And the REST tree request returns HTTP 404
    And GraphQL confirms that exact tree object has no entries
    And the contribution response is complete
    When the full metrics refresh runs
    Then the refresh succeeds
    And the private repository is included with zero source files
    And the GraphQL check uses tree "EMPTY-TREE-SHA"

  Scenario: Forks and generated Obsidian bundles stay excluded from language totals
    Given the metrics refresh targets "ClarusIubar"
    And GitHub authenticates the request as "ClarusIubar"
    And an original repository contains source, build output, and Obsidian plugin bundles
    And the repository response includes an owned fork with source files
    And the contribution response is complete
    When the full metrics refresh runs
    Then the original source file contributes to the language totals
    And build output and Obsidian plugin bundles contribute zero bytes
    And the fork tree is never fetched
