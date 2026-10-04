# Security

## Reporting a vulnerability

Report a vulnerability in the Zapier integration privately, through GitHub's private
vulnerability reporting: the **Report a vulnerability** button on this
repository's **Security** tab. Please do not open a public issue or pull request
for it.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge the report, keep you informed while we investigate, and
credit you in the fix unless you ask us not to.

## Scope

This repository covers the Zapier integration: how the integration authenticates and calls the Lenz API. The Lenz API itself and the lenz.io
site are out of scope here; report issues with them the same way and we will
route them.

## Supported versions

Fixes land on `main` and ship in the next release. While the 1.x integration is
still the one Zapier users install, security fixes are also made on the
`release/1.x` branch. Older releases are not patched.
