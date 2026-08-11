# Third-party notices

## adaptive-toolsmith

The dormant plugin under `plugins/adaptive-toolsmith/` is copied from local
source commit `e81705c081557e057215d9453db47c420a6a0ffa` and is licensed under the
MIT License. Its upstream license text is retained at
`plugins/adaptive-toolsmith/LICENSE`.

## OpenTUI

The optional primary TUI renderer uses `@opentui/core`, licensed under the MIT
License. When its native FFI backend is unavailable, TMSH uses its built-in ANSI
fallback instead.

## Inquirer

The local API onboarding wizard uses `@inquirer/prompts`, licensed under the
MIT License, for masked secret input, provider selection, and model
multi-selection.

## Bun

Bun is an optional external runtime used to initialize OpenTUI's native
renderer. It is not vendored into this repository. Bun is distributed under
the MIT License; see <https://github.com/oven-sh/bun>.
