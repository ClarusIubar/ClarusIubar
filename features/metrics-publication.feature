Feature: Publish generated metrics through the protected default branch
  Generated metric files stay in the repository. When the default branch requires
  pull requests, the workflow must publish through a pull request and must not
  report completion until GitHub confirms the merge.

  Scenario: Changed metrics are published through a merged pull request
    Given the metrics workflow runs on "main" with run ID "12345"
    And generated README and metrics files have changed
    When the workflow publishes the generated metrics
    Then it stages only "README.md" and "metrics/"
    And it pushes the publication branch "metrics/update-12345-1"
    And it opens a pull request targeting "main"
    And it merges that pull request with "squash"
    And publication is reported as "merged"

  Scenario: Unchanged metrics do not create a branch or pull request
    Given the metrics workflow runs on "main" with run ID "12346"
    And no generated metric files have changed
    When the workflow publishes the generated metrics
    Then publication is reported as "unchanged"
    And no remote branch or pull request is created

  Scenario: An earlier open metrics pull request prevents duplicate publication
    Given the metrics workflow runs on "main" with run ID "12351"
    And an open metrics pull request "https://github.com/ClarusIubar/ClarusIubar/pull/98" already exists
    And generated README and metrics files have changed
    When the workflow publishes the generated metrics
    Then publication fails at "pending metrics pull request"
    And the failure identifies the existing pull request for recovery
    And no remote branch or pull request is created

  Scenario: Pull request creation failure does not report publication success
    Given the metrics workflow runs on "main" with run ID "12347"
    And generated README and metrics files have changed
    And GitHub rejects pull request creation
    When the workflow publishes the generated metrics
    Then publication fails at "pull request creation"
    And the pull request is not merged
    And it removes the temporary publication branch

  Scenario: Pull request diagnostics never expose the workflow credential
    Given the metrics workflow runs on "main" with run ID "12350"
    And generated README and metrics files have changed
    And GitHub rejects pull request creation with a diagnostic containing the credential
    When the workflow publishes the generated metrics
    Then publication fails at "pull request creation"
    And the failure does not contain the workflow credential

  Scenario: Pull request merge failure remains an explicit failure
    Given the metrics workflow runs on "main" with run ID "12348"
    And generated README and metrics files have changed
    And GitHub rejects pull request merging
    When the workflow publishes the generated metrics
    Then publication fails at "pull request merge"
    And the failure identifies the open pull request for recovery

  Scenario: A non-main dispatch cannot publish to the default branch
    Given the metrics workflow runs on "feature/test" with run ID "12349"
    And generated README and metrics files have changed
    When the workflow publishes the generated metrics
    Then publication fails at "unsupported branch"
    And no remote branch or pull request is created
