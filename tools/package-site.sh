#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
destination=${1:?usage: sh tools/package-site.sh NEW_OUTPUT_DIRECTORY}
mkdir "$destination"
cp ./*.html ./*.svg llms.txt llms-full.txt site-metadata.json "$destination/"
cp -R assets "$destination/assets"
