Implement the feature spec below in this repository.

Work like this:
1. Read CLAUDE.md and the existing code in {{writableDirs}} to learn the conventions.
2. Plan the change before editing.
3. Implement it with Vitest tests that cover every acceptance criterion. Each criterion has an ID (AC1, AC2, ...). Start the name of each test that covers a criterion with its ID, e.g. `it("AC3: refills fractional tokens", ...)`, so a reviewer can trace every criterion to its tests. Keep the change focused on the spec.
4. Call the run_checks tool. If it fails, fix the problem and call it again, until it passes.

Rules:
- Only create or edit files under: {{writableDirs}}. Writes elsewhere are denied.
- You have no shell. run_checks is the only way to lint, typecheck and run tests.
- Do not commit, branch or push. The harness handles git and opens the PR after you finish.
- If the spec is ambiguous, choose the simplest reasonable interpretation and record it in notes.

{{prTemplate}}

<spec path="{{specPath}}">
{{specBody}}
</spec>
