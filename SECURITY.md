# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Security" tab → "Report a vulnerability"), or by e-mail to
webmaster@rcontentdesign.nl.

Please include:

* the affected version (`dpkg -s pitstore`) and the Ubuntu and Cockpit versions,
* a description of the issue and its impact,
* steps to reproduce, or a proof of concept,
* whether the issue is already public.

What happens next:

1. We confirm receipt within **5 working days**.
2. We assess the report and share our severity rating (CVSS 3.1) within
   **14 days**.
3. We develop a fix in a private advisory. You can review it if you like.
4. We release the fix and publish a GitHub Security Advisory, and request a
   CVE where appropriate. Unless you prefer otherwise, you are credited.

We aim to fix critical and high issues within 30 days, and others with the
next regular release.

## Scope

In scope: the PitStore package (frontend, helper, packaging), its handling of
catalog content, and the published APT repository.

Out of scope: vulnerabilities in Cockpit, Podman, Docker, the Linux kernel,
the catalog's container images, or the catalog content itself. Please report
those upstream. However, a way for catalog content to bypass PitStore's
security filter **is** in scope.

See [docs/threat-model.md](docs/threat-model.md) for the trust boundaries.
