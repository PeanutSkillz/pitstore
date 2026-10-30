# SPDX-License-Identifier: LGPL-2.1-or-later
#
# Based on cockpit-project/starter-kit, reduced to the Debian packaging flow.

PACKAGE_NAME := pitstore
VERSION := $(shell awk -F'"' '/"version":/ {print $$4; exit}' package.json)
PREFIX ?= /usr/local
# stamp file to check for node_modules/
NODE_MODULES_TEST=node_modules/.package-lock.json
# build.js ran in non-watch mode
DIST_TEST=runtime-npm-modules.txt
# one example file in pkg/lib to check if it was already checked out
COCKPIT_REPO_STAMP=pkg/lib/cockpit-po-plugin.js

all: $(DIST_TEST)

# checkout common files from Cockpit repository required to build this project;
# this has no API stability guarantee, so pin a commit and update it from time to time
COCKPIT_REPO_FILES = \
	pkg/lib \
	test/common \
	tools/node-modules \
	$(NULL)

COCKPIT_REPO_URL = https://github.com/cockpit-project/cockpit.git
COCKPIT_REPO_COMMIT = 35a30182a213ea1490563b7ec36aa8b9f201d51e # 369 + 76 commits

$(COCKPIT_REPO_FILES): $(COCKPIT_REPO_STAMP)
COCKPIT_REPO_TREE = '$(strip $(COCKPIT_REPO_COMMIT))^{tree}'
$(COCKPIT_REPO_STAMP): Makefile
	@git rev-list --quiet --objects $(COCKPIT_REPO_TREE) -- 2>/dev/null || \
	    git fetch --no-tags --no-write-fetch-head --depth=1 $(COCKPIT_REPO_URL) $(COCKPIT_REPO_COMMIT)
	git archive $(COCKPIT_REPO_TREE) -- $(COCKPIT_REPO_FILES) | tar x

# the lockfile is committed and authoritative: never regenerate it here
$(NODE_MODULES_TEST): package.json package-lock.json
	env -u NODE_ENV npm ci --ignore-scripts

$(DIST_TEST): $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP) $(shell find src/ -type f) package.json build.js
	NODE_ENV=$(NODE_ENV) ./build.js

watch: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	NODE_ENV=$(NODE_ENV) ./build.js --watch

check: $(NODE_MODULES_TEST) $(COCKPIT_REPO_STAMP)
	npm run eslint
	npm run stylelint
	npm run typecheck
	npm test
	npm run test:helper

clean:
	rm -rf dist/
	rm -f metafile.json runtime-npm-modules.txt

install: $(DIST_TEST) install-dist

# install an already built dist/ without touching node or the network;
# used by debian/rules
install-dist:
	test -f dist/manifest.json
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	cp -r dist/* $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)
	rm -f $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)/*.LEGAL.txt
	mkdir -p $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)/helper/pitstore
	install -m 0755 helper/pitstore-helper $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)/helper/
	install -m 0644 helper/pitstore/*.py $(DESTDIR)$(PREFIX)/share/cockpit/$(PACKAGE_NAME)/helper/pitstore/

# this requires a built source tree and avoids having to install anything system-wide
devel-install: $(DIST_TEST)
	mkdir -p ~/.local/share/cockpit
	ln -s `pwd`/dist ~/.local/share/cockpit/$(PACKAGE_NAME)

# assumes that there was symlink set up using the above devel-install target,
# and removes it
devel-uninstall:
	rm -f ~/.local/share/cockpit/$(PACKAGE_NAME)

print-version:
	@echo "$(VERSION)"

# build the binary .deb from a production dist/; output goes to ../
deb: export NODE_ENV=production
deb:
	rm -rf dist/ $(DIST_TEST)
	$(MAKE) $(DIST_TEST)
	node test/check-bundle.js
	dpkg-buildpackage -b -us -uc
	lintian --fail-on error,warning ../$(PACKAGE_NAME)_$(VERSION)_all.deb

.PHONY: all watch check clean install install-dist devel-install devel-uninstall print-version deb
