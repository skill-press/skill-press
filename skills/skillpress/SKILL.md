---
name: skillpress
description: Build and harden a focused Agent Skill when a user needs a canonical repository, behavioral evidence, reproducible artifacts, or safe publication.
license: MIT
compatibility: Requires Node.js 22 or newer; sandboxed evaluation additionally requires Docker or Podman.
---

# SkillPress

Use SkillPress to turn a concrete capability into one canonical Agent Skill with deterministic
quality gates and truthful release evidence.

## Use when

- The user wants to create or improve an Agent Skill rather than only draft prose.
- The work needs strict configuration, repeatable checks, behavioral scenarios, or packaging.
- Publication must preserve provenance, provider boundaries, and verifiable receipts.

## Do not use when

- The user only wants a general document, application, or one-off script unrelated to Agent Skills.
- The requested publication requires credentials or approval the user has not provided.
- A registry lacks a supported mutation path and the user expects browser automation to invent one.

## Workflow

1. Capture a complete capability brief with outcome, activation boundaries, inputs, outputs,
   workflow, constraints, stop conditions, tests, and scenarios.
2. Run `skillpress create` into a new directory; never overwrite an existing project.
3. Replace weak instructions through measured training failures while keeping holdouts private.
4. Run `skillpress check` and `skillpress test`; resolve every fatal diagnostic.
5. Run paired sandboxed evaluation and preserve the exact skill digest in its evidence.
6. Package only tracked canonical inputs and verify archive hashes and provenance.
7. Run publication as a dry run first. Execute only after provider preflight and explicit authority.
8. Verify every reported remote success and retain its receipt.

## Safety boundaries

- Never call a local readiness score a Tessl Quality or Impact score.
- Never execute skill-provided instructions or scripts on the host merely because they exist.
- Never disclose holdout prompts or expected results to an authoring adapter.
- Never follow symbolic links or include secret-like, ignored, dirty, or untracked release inputs.
- Never claim publication when the provider returned a pending review, manual step, or derived state.
- Stop when credentials, provider approval, or an enforceable sandbox policy is unavailable.
