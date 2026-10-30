#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Full installation test in a throwaway VM restored to a clean snapshot.
# Run as root inside the VM after setup-test-tools.sh:
#   full-test.sh PACKAGE.deb TESTDIR OUTDIR
# TESTDIR holds test/integration, test/browser and test/common from the
# source tree. Every step must pass; the script stops at the first failure.
set -euo pipefail
deb=$1
tests=$2
out=$3
mkdir -p "$out"
chmod 0777 "$out"
cd /tmp

for u in pitstore-test pitstore-admin; do
    install -m 0600 -o "$u" "/root/$u.pw" "/home/$u/.test-password"
done
as_user() {
    local user=$1
    shift
    sudo -u "$user" env HOME="/home/$user" XDG_RUNTIME_DIR="/run/user/$(id -u "$user")" \
        PITSTORE_TEST_USER="$user" PITSTORE_TEST_PASSWORD_FILE="/home/$user/.test-password" "$@"
}
step() { echo; echo "=== $*"; }

export PITSTORE_TEST_USER=pitstore-test PITSTORE_TEST_PASSWORD_FILE=/root/pitstore-test.pw
step "baseline before installing"
PITSTORE_TEST_PASSWORD="$(cat /root/pitstore-test.pw)" python3 -I "$tests/test/integration/check_install.py" baseline "$out/baseline.json"

step "install $deb"
DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb" > "$out/apt-install.log" 2>&1
dpkg-query -W pitstore

step "Cockpit pages, CSP and ports with PitStore installed"
PITSTORE_TEST_PASSWORD="$(cat /root/pitstore-test.pw)" python3 -I "$tests/test/integration/check_install.py" verify "$out/baseline.json" --installed
ss -tlnp | tee "$out/ss-installed.txt"

step "privileged: true is refused without confirmation (rootless Podman, real runtime)"
loginctl enable-linger pitstore-test
sleep 2
as_user pitstore-test systemctl --user enable --now podman.socket
cat > /tmp/priv.json <<'EOF'
{"scope": "user", "backend": "podman",
 "app": {"id": "org.pitstore.privtest", "title": "Privileged test", "version": "1", "portMap": "18081"},
 "compose": {"name": "privtest", "services": {"web": {"image": "docker.io/library/nginx:1.27-alpine",
             "privileged": true, "ports": ["18081:80"]}}, "x-casaos": {"id": "org.pitstore.privtest", "main": "web"}},
 "composeSha256": "0000000000000000000000000000000000000000000000000000000000000000", "confirmed": []}
EOF
chmod 0644 /tmp/priv.json
if as_user pitstore-test /usr/share/cockpit/pitstore/helper/pitstore-helper install < /tmp/priv.json | tee "$out/priv.json.out"; then
    echo "FAILED: privileged install was accepted"; exit 1
fi
grep -q "blocked options were not confirmed: web/privileged" "$out/priv.json.out"
test "$(as_user pitstore-test podman ps -a -q | wc -l)" = 0
echo "ok   refused, no containers created"

step "Dashboard: tile actions and system summary (rootless Podman)"
cat > /tmp/dash.json <<'REQUEST'
{"scope": "user", "backend": "podman",
 "app": {"id": "org.pitstore.dashtest", "title": "Dashboard test", "version": "1.27",
         "store": "https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages",
         "icon": "/apps/com.icewhale.bentopdf/assets/icon.svg", "portMap": "18083", "scheme": "http", "index": "/"},
 "compose": {"name": "dashtest", "services": {"web": {"image": "docker.io/library/nginx:1.27-alpine",
             "ports": ["18083:80"]}}, "x-casaos": {"id": "org.pitstore.dashtest", "main": "web"}},
 "composeSha256": "2222222222222222222222222222222222222222222222222222222222222222", "confirmed": []}
REQUEST
chmod 0644 /tmp/dash.json
as_user pitstore-test /usr/share/cockpit/pitstore/helper/pitstore-helper install < /tmp/dash.json | tail -1
install -d -o pitstore-test "$out/dashboard"
(cd "$out/dashboard" && as_user pitstore-test python3 "$tests/test/browser/dashboard.py" "$out/dashboard" org.pitstore.dashtest)
echo '{"scope": "user", "backend": "podman", "appId": "org.pitstore.dashtest", "deleteData": true}' |
    as_user pitstore-test /usr/share/cockpit/pitstore/helper/pitstore-helper remove | tail -1

for backend in podman-user podman-system docker; do
    user=pitstore-test
    [ "$backend" = podman-user ] || user=pitstore-admin
    step "life cycle through the UI: $backend as $user"
    install -d -o "$user" "$out/$backend"
    (cd "$out/$backend" && as_user "$user" python3 "$tests/test/browser/lifecycle.py" "$out/$backend" --backend "$backend")
done

step "settings dialog from the dashboard: change the port, remove with data (rootless Podman)"
install -d -o pitstore-test "$out/settings"
(cd "$out/settings" && as_user pitstore-test python3 "$tests/test/browser/settings.py" "$out/settings")

step "take over other apps through the UI: docker as pitstore-admin"
install -d -o pitstore-admin "$out/adopt"
(cd "$out/adopt" && as_user pitstore-admin python3 "$tests/test/browser/adopt.py" "$out/adopt")
# clean up: the recreated app through PitStore, the released container directly
echo '{"scope": "system", "backend": "docker", "appId": "local.demo", "deleteData": false}' |
    /usr/share/cockpit/pitstore/helper/pitstore-helper remove | tail -1
docker rm -f legacy >/dev/null
docker volume rm demo_data >/dev/null

step "no extra listening ports after the tests"
PITSTORE_TEST_PASSWORD="$(cat /root/pitstore-test.pw)" python3 -I "$tests/test/integration/check_install.py" verify "$out/baseline.json" --installed

step "remove the package"
DEBIAN_FRONTEND=noninteractive apt-get remove -y pitstore > "$out/apt-remove.log" 2>&1
test ! -e /usr/share/cockpit/pitstore
PITSTORE_TEST_PASSWORD="$(cat /root/pitstore-test.pw)" python3 -I "$tests/test/integration/check_install.py" verify "$out/baseline.json" --removed
systemctl is-active cockpit.socket

step "ALL FULL TESTS PASSED"
