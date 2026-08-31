# Project Context

Before implementing features, fixing bugs, or conducting code reviews, always read:

- docs/Experience-Review.md

This file contains historical project experience, architecture decisions, common pitfalls, and best practices.

## SDK compatibility

- Preserve the binary and source signatures of published constructors and methods. A default value on a new Kotlin parameter does not preserve old JVM call sites; keep an explicit old overload.
- Keep serialization-only fields out of existing public constructors when possible. Test both legacy signatures and deserialization from real configuration artifacts.

## Asynchronous platform requests

- Track request submission, platform acceptance, and the resulting state change separately. A resolved promise or completion does not prove that window geometry has changed.
- Register any required host-state restoration when a request is submitted. Route restoration through the same scheduler even if ownership ends before the request completes.
- Propagate current-request failures, roll back only the state owned by that request, and allow retries. Ignore side effects from stale generations.
- Coalesce identical in-flight requests and serialize different values so an older completion cannot overwrite newer state.
