#!/bin/sh
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Prepare a throwaway test VM (never a real server) after restoring it to a
# clean snapshot: a login user for the tests and a headless browser.
# Run as root inside the VM.
set -eu
export DEBIAN_FRONTEND=noninteractive

# login user for Cockpit; the random password is readable by root only
if ! id pitstore-test >/dev/null 2>&1; then
    useradd -m -s /bin/bash pitstore-test
    umask 077
    openssl rand -hex 16 | tr -d '\n' > /root/pitstore-test.pw
    printf 'pitstore-test:%s\n' "$(cat /root/pitstore-test.pw)" | chpasswd
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends python3-aiohttp unzip curl \
    libnss3 libatk-bridge2.0-0t64 libgbm1 libasound2t64 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libpango-1.0-0 libcups2t64 libxfixes3 fonts-dejavu-core fonts-liberation >/dev/null

# Chrome for Testing (headless shell + chromedriver); the Ubuntu chromium is a snap
mkdir -p /opt/cft
cd /opt/cft
if [ ! -x chrome-headless-shell-linux64/chrome-headless-shell ]; then
    v=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["channels"]["Stable"]["version"])')
    for z in chrome-headless-shell chromedriver; do
        curl -fsSLO "https://storage.googleapis.com/chrome-for-testing-public/$v/linux64/$z-linux64.zip"
        unzip -qo "$z-linux64.zip"
    done
fi
ln -sf /opt/cft/chrome-headless-shell-linux64/chrome-headless-shell /usr/bin/chromium
ln -sf /opt/cft/chromedriver-linux64/chromedriver /usr/local/bin/chromedriver

# Ubuntu 24.04 restricts unprivileged user namespaces; allow them for this
# browser only, so its sandbox stays enabled
cat > /etc/apparmor.d/cft-chrome <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile cft-chrome /opt/cft/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,
  include if exists <local/cft-chrome>
}
PROFILE
apparmor_parser -r /etc/apparmor.d/cft-chrome
chromium --version
