Implement the feature spec below in this repository.

Work like this:
1. Read CLAUDE.md and the existing code in {{writableDirs}} to learn the conventions.
2. Plan the change before editing.
3. Implement it with Vitest tests that cover every acceptance criterion. Each criterion has an ID (AC1, AC2, ...). Start the name of each test that covers a criterion with its ID, e.g. `it("AC3: refills fractional tokens", ...)`, so a reviewer can trace every criterion to its tests. Keep the change focused on the spec.
4. Run the checks, as the tools rule below says. If they fail, fix the problem and run them again, until they pass.

Rules:
- Only create or edit files under: {{writableDirs}}. Writes elsewhere are denied.
- {{tools}}
- Do not commit, branch or push. The harness handles git and opens the PR after you finish.
- If the spec is ambiguous, choose the simplest reasonable interpretation and record it in notes.

{{prTemplate}}

<spec path="{{specPath}}">
{{specBody}}
</spec>
