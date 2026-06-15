---
name: ralph-opencode-loop
description: Run an autonomous Open Ralph Wiggum coding loop using OpenCode with the currently configured model.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔁",
        "homepage": "https://github.com/Th0rgal/open-ralph-wiggum",
        "requires": { "bins": ["opencode", "ralph", "git"] },
      },
  }
user-invocable: true
---

## What this skill does

This skill runs an autonomous **Ralph Wiggum** coding loop using the `ralph` CLI with OpenCode as the agent provider.

It repeatedly executes the same coding prompt until:

- The success criteria are met, OR
- The completion promise is printed, OR
- Max iterations are reached

Uses the **currently configured model** in OpenCode — no `--model` flag needed.

---

## When to use

Use this skill when you want autonomous coding execution such as:

- Fixing failing tests
- Implementing scoped features
- Refactoring codebases
- Resolving lint/type errors
- Running build-fix loops
- Multi-iteration debugging

You MUST be inside a git repository before running Ralph.

---

## How to run the loop

Run:

ralph "<TASK PROMPT>

Success criteria:

- <list verifiable checks>
- Build passes
- Tests pass

Completion promise:
<promise>COMPLETE</promise>" \
 --agent opencode \
 --completion-promise "COMPLETE" \
 --max-iterations 20

Do NOT pass `--model`. Ralph will use whatever model OpenCode has configured.

---

## Tasks mode (for large projects)

For multi-step execution:

ralph "<BIG TASK PROMPT>" \
 --agent opencode \
 --tasks \
 --max-iterations 50

---

## Plugin troubleshooting

If OpenCode plugins interfere with loop execution, rerun with:

--no-plugins

---

## Safety notes

- Always run inside a git repo
- Set iteration limits to avoid runaway loops
- Ensure prompts contain verifiable success criteria
- Review diffs before merging autonomous changes

---

## Example usage

Fix failing TypeScript errors:

ralph "Fix all TypeScript errors in the repo.

Success criteria:

- tsc passes
- Build succeeds

Completion promise:
<promise>COMPLETE</promise>" \
 --agent opencode \
 --completion-promise "COMPLETE" \
 --max-iterations 20
