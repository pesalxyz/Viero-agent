#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

npm run check

version="$(node -p "require('./package.json').version")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$root_dir/dist/viero-agent-${version}-${stamp}.tar.gz"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
release="$staging/viero-release"

mkdir -p "$release"
cp -R build config deploy docs "$release/"
cp package.json package-lock.json README.md LICENSE "$release/"
find "$release/deploy" -type f -name '*.sh' -exec chmod 0755 {} +
mkdir -p "$root_dir/dist"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$staging" -czf "$archive" viero-release

printf '%s\n' "$archive"
