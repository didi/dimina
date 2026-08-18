<p align="right">
  <a href="./CONTRIBUTING.md">中文 →</a>
</p>

# Contribution Guidelines

Thanks for your interest in contributing to Dimina. Issues, pull requests, and design discussions are all welcome.

## Pull Requests

Before sending a pull request, please follow these guidelines:

1. Base branch: open pull requests against the `main` branch.
2. Scope: keep each pull request focused on one bug fix, feature, or documentation change.
3. Coding style: follow the existing style in the package or platform module you are changing.
4. Commit message: use clear English and check spelling.
5. Tests: run the relevant tests or sample build before submitting.

When the change affects runtime behavior, include the platform, device model, OS/API version, related logs, screenshots or screen recordings, and the commands you used for verification.

Common verification commands:

```sh
# Frontend packages
cd fe
pnpm test

# Android sample and SDK modules
cd android
./gradlew build
```

NOTE: We assume all contributions can be licensed under the [Apache License 2.0](https://github.com/didi/dimina/blob/main/LICENSE).

## Issues

We love clearly described issues.

The following information can help us resolve the issue faster:

- Platform and device model
- OS/API version
- Dimina SDK or compiler version
- Steps to reproduce
- Expected behavior and actual behavior
- Logs, screenshots, or a minimal reproduction project
