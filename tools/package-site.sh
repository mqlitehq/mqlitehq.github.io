#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
destination=${1:?usage: sh tools/package-site.sh NEW_OUTPUT_DIRECTORY}
node tools/site-index.mjs package "$destination"
