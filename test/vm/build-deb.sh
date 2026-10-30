#!/bin/sh
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Build the .deb from a source tarball that already contains dist/, and run
# lintian. For a throwaway build VM; run as a normal user with sudo.
#   build-deb.sh SOURCE.tar.gz OUTDIR
set -eu
src=$1
out=$2
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    build-essential debhelper lintian >/dev/null
work=$(mktemp -d)
tar xzf "$src" -C "$work"
cd "$work/pitstore"
dpkg-buildpackage -b -us -uc >/dev/null
cd ..
lintian --version
lintian --fail-on error,warning --display-info pitstore_*_all.deb
mkdir -p "$out"
cp pitstore_*_all.deb "$out/"
ls -l "$out"
