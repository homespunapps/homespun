# Contributing

Thank you for looking. Please read this first, because the workflow is not the
usual one.

## This repository is a mirror

The code here is developed in a private monorepo alongside the Homespun relay,
which is not open source. This repository is a snapshot of the client side,
published on each release.

**That means a pull request opened here cannot be merged.** The next sync would
overwrite it. This is a property of the mirror, not a judgement about the
change.

## How to contribute

**Open an issue.** Bug reports, unexpected behaviour, missing or wrong
documentation, and feature requests are all welcome and are read.

A good report usually has: what you ran, what you expected, what happened, and
the version (`homespun --version`).

**Patches are welcome as issues too.** If you have a fix, open an issue with
the diff or a description of it. It gets applied upstream with credit, and
lands here on the next sync. It is a slower loop than a merged pull request,
and it is the honest one given how the code is developed.

If contribution volume ever makes this awkward, the right answer is to move
these packages out of the monorepo for real rather than pretend the mirror
accepts patches.

## Security

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting instead: the **Security** tab of
this repository, then **Report a vulnerability**. That opens a private thread
visible only to the maintainers, and needs no email address on either side.

If the relay itself is affected rather than the client code here, say so in the
report. The relay is not in this repository, so a fix lands upstream and reaches
you in a later release.

## What is not here

The relay (the hosted server) is proprietary and is not in this repository, so
issues about server behaviour are still welcome but cannot be fixed by a patch
here.
