#!/bin/sh
# Optional project-local Node runtime for development.
if ! command -v node >/dev/null 2>&1 && [ -x "$PWD/runtime/dsh/bin/node" ]; then
  export PATH="$PWD/runtime/dsh/bin:$PATH"
fi
export npm_config_cache="$PWD/.cache/npm"
