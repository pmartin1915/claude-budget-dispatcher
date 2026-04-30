# Handoff: Dispatcher Phase 2 - Task 1 (Overseer Intelligence)

## Objective
Implement AST Entropy calculation and Mutation Validation in the Overseer to prevent Agentic Conformity Bias (hallucinated structure and weak assertions) during autonomous PR merges.

## Context
Currently, `scripts/overseer.mjs` merges LLM-generated PRs if they pass shallow unit tests. We need deeper semantic validation. You are responsible for upgrading `overseer.mjs` to statically analyze the proposed diffs and reject PRs that exhibit topological hallucinations or low assertion density.

## Planning Requirements
1. **Structural Cross-Entropy (SCE):**
   - Integrate `@babel/parser` into `scripts/overseer.mjs`.
   - Parse the AST of the baseline file (using `gh pr view` base commit) and the proposed PR file.
   - Calculate an entropy score based on the depth and divergence of node types between the two ASTs. 
   - Reject the PR if the SCE exceeds a configured threshold.

2. **Mutation Testing & Assertion Density:**
   - Integrate `StrykerJS` in incremental mode to parse test ASTs.
   - Statically calculate Jest `expect` assertion density to ensure new tests aren't simply "tautological" (e.g., `expect(true).toBe(true)`).
   - Block PR merges if the mutation score or assertion density is suspiciously low.

## Auditing & Safety Constraints
- **Fail-Soft Philosophy:** If `@babel/parser` or `StrykerJS` encounters a fatal error (e.g., malformed syntax that crashes the parser), log a warning and default to `abstain`. Do NOT crash the host Node process.
- **Dependency Management:** Limit new heavy global dependencies. If needed, install via `npm install @babel/parser` and `npm install -D @stryker-mutator/core`.
- **Review:** Validate the logic against a controlled mock PR. Ensure the cross-entropy threshold is generous enough to allow legitimate refactors but strict enough to catch wild hallucinations.

## Getting Started
- Read `scripts/overseer.mjs` to understand the current review process (`evaluateCoolingOff`, `createDefaultGitHubClient`).
- You can test your AST parsing against dummy JS files using a localized sandbox script before integrating it into `overseer.mjs`.
