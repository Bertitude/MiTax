# Release governance checklist

This repository should treat release tags and release assets as immutable production artifacts.

## Required repository settings

Configure these in GitHub repository settings before merging this branch:

1. Protect `main` with:
   - Require a pull request before merging.
   - Require at least one approving review.
   - Require status checks: `Unit tests` and `Full dependency install`.
   - Require branches to be up to date before merging.
   - Dismiss stale approvals when new commits are pushed.
   - Restrict who can push directly to `main`.
2. Protect `v*` tags with a tag ruleset:
   - Only release maintainers or the release workflow may create/update tags.
   - Reject tag deletion and force updates.
3. Create a `production-release` GitHub Environment with required reviewers.
4. Enable “Require review from Code Owners” for `main`.
5. Keep Actions default permissions read-only; grant `contents: write` only to the tag/release publication jobs.

## Release invariants

- A release tag must be an annotated tag and must match `package.json` exactly.
- A release workflow must never delete/recreate an existing release automatically.
- Build jobs should have read-only repository permissions and publish only through a final, reviewed publication job.
- Existing release assets should not be overwritten during a rerun.
- Release signing and updater signature verification must be enabled before automatic installation is enabled.

## Workflow update note

The release workflow should be updated to enforce these invariants: serialize runs by tag, validate the exact tag checkout, refuse an existing release, build with `--publish never`, upload artifacts, and publish them from a separate least-privilege job. The current GitHub connection could add repository files and CODEOWNERS but could not update the existing workflow file; apply this checklist and the corresponding workflow change before merging.
