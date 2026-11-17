#!/bin/bash
# Seeds the workspace through the shared scaffold (test/plugin-evals/scaffold.sh).
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scaffold.sh" full
