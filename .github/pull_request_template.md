## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `make check` passes locally
- [ ] Tests added or updated (required for policy, validation or helper changes)
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] No new dependency, or the new dependency is justified below (purpose, license, maintenance)
- [ ] No inline scripts, `eval`, external resources or CSP changes
- [ ] No shell command strings; runtime access goes through the API socket
- [ ] Commits are signed off (`git commit -s`)

## Security impact

<!-- Does this touch a trust boundary from docs/threat-model.md? Which one, and how is it tested? -->
