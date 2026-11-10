# ChELL Stack Makefile
#
# One kitchen for the whole sandwich: cumin, salsa, chili, brasa, calypso, chell.
#
# In the old poly-repo days each package had its own Makefile that ran around
# cloning siblings and hand-linking them. In the monorepo all six live in
# packages/ and npm workspaces wires them together — so the metaphor stays, but
# the plumbing is now a single `npm install` at the root.
#
# The Menu (main commands):
#   make shop    - Freshen the pantry (git pull)
#   make prep    - Install dependencies (one install links all workspaces)
#   make cook    - Build all packages in dependency order (menu->cumin->salsa->chili->brasa->calypso->chell)
#   make taste   - Run the full test suite (all workspaces)
#   make serve   - Link `chell` and `porter` globally so you can run them from anywhere
#   make scrub   - Clean the kitchen (remove dist/ and node_modules)
#
# The Special:
#   make taco    - The full course: scrub -> prep -> cook -> taste -> serve
#                  (`make meal` is a synonym)
#
# Extras:
#   make taste-flight - Run tests with coverage (Istanbul provider)
#   make run          - Build chell and launch the shell (local, in-process)
#   make login        - Build and connect to a CUBE (prompts for password)
#   make daemon       - Build and run the CALYPSO session daemon
#   make remote       - Build and attach to a running daemon as a surface
#
# Front of house (git + GitHub operations; need an authenticated `gh`):
#   make branch BR=name - Start a new branch off the current HEAD
#   make save MSG=".." - Commit tracked changes with the given message
#   make push          - Push the current branch to origin (sets upstream)
#   make pr            - Push, then open a PR against main
#   make ci-watch      - Wait for the current PR's required checks to settle
#   make merge         - Merge the current branch's PR once checks are green
#   make publish       - Approve, green-wait, and merge the Version Packages PR
#   make verify-npm    - Compare local package versions against the registry
#   make lockfile      - Regenerate package-lock.json with CI's pinned npm
#   make ci-dispatch   - Manually fire the CI workflow (Actions event lag)
#   make release-dispatch - Publish main to npm by hand (the publisher run)
#   make sync          - Return to main and fast-forward it
#   make tidy BR=name  - Delete a merged branch locally and on origin
#
# Standard aliases (muscle memory):
#   make install -> prep   make build -> cook   make test -> taste
#   make clean   -> scrub  make link  -> serve  make connect -> login

# Connection defaults for `make login`, overridable on the command line:
#   make login CUBE_URL=http://my-cube:8000/api/v1/ CUBE_USER=me
CUBE_URL  ?= http://localhost:8000/api/v1/
CUBE_USER ?= chris

# The npm version CI installs in every job (ci.yml, release.yml). Lockfiles
# written by a different npm major can omit optional peer entries, and
# `npm ci` then fails with EUSAGE. Everything here that touches the lockfile
# uses this pin.
CI_NPM ?= 11.19.0

# The branch under the knife, for the git-facing targets below.
BRANCH = $(shell git branch --show-current)

.DEFAULT_GOAL := help
.PHONY: help shop prep cook taste taste-flight serve scrub run binaries deploy smoke-report smoke-upgrade \
        login connect daemon remote porter porter-status taco meal install build test clean link all \
        branch save push pr ci-watch merge publish vp-approve verify-npm \
        lockfile ci-dispatch release-dispatch sync tidy

help:
	@echo "ChELL Stack Kitchen"
	@echo ""
	@echo "The Menu:"
	@echo "  make shop          - Freshen the pantry (git pull)"
	@echo "  make prep          - Install dependencies (links all workspaces)"
	@echo "  make cook          - Build all packages in dependency order"
	@echo "  make plate         - Build just the web surface (argus)"
	@echo "  make taste         - Run the full test suite"
	@echo "  make serve         - Link 'chell' and 'porter' globally"
	@echo "  make scrub         - Clean dist/ and node_modules everywhere"
	@echo ""
	@echo "The Special:"
	@echo "  make taco          - Full course: scrub, prep, cook, taste, serve"
	@echo ""
	@echo "Extras:"
	@echo "  make taste-flight  - Tests with coverage (Istanbul provider)"
	@echo "  make run           - Build chell and launch the shell (local)"
	@echo "  make login         - Build and connect to a CUBE (prompts for password)"
	@echo "                       override: make login CUBE_URL=... CUBE_USER=..."
	@echo "  make daemon        - Build and run the CALYPSO session daemon"
	@echo "  make remote        - Build and attach to a running daemon"
	@echo "  make porter        - Build and open the door: the PORTER display manager"
	@echo "                       on http://127.0.0.1:4180/login (override:"
	@echo "                       make porter CUBE_URL=... PORTER_PORT=...)"
	@echo "  make porter-status - What sessions the porter's state directory holds"
	@echo "  make binaries      - Build standalone chell executables (no Node needed)"
	@echo ""
	@echo "Front of house (git + GitHub; needs an authenticated 'gh'):"
	@echo "  make branch BR=name - Start a new branch off the current HEAD"
	@echo "  make save MSG=\"..\" - Commit tracked changes with MSG as the message"
	@echo "                       (.changeset/ is always staged too; other new"
	@echo "                        files need an explicit 'git add' first)"
	@echo "  make push          - Push the current branch to origin, setting upstream"
	@echo "  make pr            - Push, then open a PR against main (body from commits)"
	@echo "  make ci-watch      - Wait for this branch's PR checks (audit, node 22/24)"
	@echo "  make merge         - ci-watch, then merge this branch's PR (merge commit)"
	@echo "  make publish       - The release step: approve the Version Packages PR's"
	@echo "                       bot CI runs, wait for green, merge, then run the"
	@echo "                       publisher and watch it push to npm (IRREVERSIBLE)."
	@echo "  make verify-npm    - Local package.json versions vs the npm registry"
	@echo "  make lockfile      - Regenerate package-lock.json with npm@$(CI_NPM)"
	@echo "                       (CI's pin) and prove it with a dry-run 'npm ci'"
	@echo "  make ci-dispatch   - Fire CI by hand on this branch (when GitHub's"
	@echo "                       push/PR events lag and no run appears)"
	@echo "  make release-dispatch - Run the publisher on main by hand (to retry a"
	@echo "                       publish; publishing is idempotent)"
	@echo "  make sync          - Checkout main, fast-forward, prune stale remotes"
	@echo "  make tidy BR=name  - Delete a merged branch locally and on origin"
	@echo ""
	@echo "Aliases: install=prep  build=cook  test=taste  clean=scrub  link=serve  connect=login"

# --- Shop (freshen the pantry) ---
# Nothing to clone anymore — every ingredient is vendored in packages/.
# A shop run just pulls the latest monorepo.
shop:
	@echo "Freshening the pantry (git pull)..."
	@git pull --rebase --autostash || echo "Could not pull. Resolve manually (offline is fine)."

# --- Prep (install dependencies) ---
# One install hydrates every workspace AND links them to each other.
# Uses CI's pinned npm ($(CI_NPM), matching "packageManager" in package.json):
# an install with a different npm major rewrites the lockfile in a shape
# `npm ci` under the CI pin then refuses (EUSAGE, missing optional peers).
prep:
	@echo "Prepping all packages (npm install, npm@$(CI_NPM))..."
	npx --yes npm@$(CI_NPM) install

# --- Cook (build) ---
# Root build script already enforces topological order: menu->cumin->salsa->chili->brasa->calypso->chell.
cook:
	@echo "Cooking the whole stack (dependency order)..."
	npm run build

# --- Plate (build just the surface) ---
# The web surface alone, for when only argus changed. A running daemon
# serves apps/argus/dist from the checkout it was started in, so this plus
# a browser refresh is the whole loop — no restart, since the surface is
# read per request while the kernel is loaded once at start.
# `make cook` builds the whole stack (argus included) and is what to run
# when anything under packages/ moved.
plate:
	@echo "Plating the surface (argus only)..."
	npm run build -w @fnndsc/argus

# --- Taste (test) ---
taste:
	@echo "Tasting (running all tests)..."
	npm test

# Coverage flight (not part of taco)
taste-flight:
	@echo "Tasting flight (coverage, istanbul provider)..."
	npm test --workspaces --if-present -- --coverage

# --- Serve (link chell globally) ---
serve:
	@echo "Serving — linking 'chell' and 'porter' globally..."
	cd packages/chell && npm link
	# From the root, workspace-aware: `npm link` run inside apps/porter treated
	# it as a lone package, installed a stray node_modules there, and took the
	# brasa and calypso dists with it.
	npm link -w @fnndsc/porter
	@echo "Done. Run 'chell' or 'porter' from anywhere."

# --- Scrub (clean) ---
scrub:
	@echo "Scrubbing the kitchen..."
	rm -rf node_modules
	rm -rf packages/*/node_modules packages/*/dist packages/*/types
	@echo "Kitchen is clean."

# --- Run (build + launch local shell) ---
run: cook
	@echo "Launching chell..."
	node packages/chell/dist/index.js

# --- Login (build + connect to a CUBE) ---
# Connect mode: prompts for the password, then drops into the shell already
# connected (the refreshed token is saved). Override the target CUBE with
# CUBE_URL / CUBE_USER, e.g. `make login CUBE_URL=http://my-cube/api/v1/ CUBE_USER=me`.
login connect: cook
	@echo "Connecting to $(CUBE_USER)@$(CUBE_URL) (you'll be prompted for a password)..."
	node packages/chell/dist/index.js --user $(CUBE_USER) $(CUBE_URL)

# --- Daemon (build + host the engine over WebSocket) ---
# Starts the CALYPSO session daemon on loopback and writes its discovery file
# (URL + attach token). Attach from another terminal with `make remote`.
daemon: cook
	@echo "Starting the CALYPSO session daemon (attach with 'make remote')..."
	node packages/calypso/dist/calypso.js

# --- Remote (build + attach to a running daemon) ---
# Reads the daemon's discovery file and attaches as a remote surface. Run
# `make daemon` in one terminal first, then `make remote` in another.
remote: cook
	@echo "Attaching to the CALYPSO daemon as a remote surface..."
	node packages/chell/dist/index.js --remote

# --- Porter (build + open the door) ---
# The display manager: a login page that trades a CUBE password for a session
# on this host and shows the browser to ARGUS under /s/<key>/, holding the
# attach token itself. One CUBE per porter, named by CUBE_URL (the same
# variable `make login` uses). Sessions and their state live under
# PORTER_STATE_DIR; the first login of an identity boots cold against CUBE,
# every later one boots warm from that directory. Loopback by default: put
# TLS in front before binding wider (apps/porter/deploy/).
PORTER_PORT      ?= 4180
PORTER_STATE_DIR ?= $(HOME)/.local/state/porter
porter: cook
	@echo "Opening the door for $(CUBE_URL) on http://127.0.0.1:$(PORTER_PORT)/login ..."
	PORTER_CUBE_URL=$(CUBE_URL) PORTER_PORT=$(PORTER_PORT) PORTER_STATE_DIR=$(PORTER_STATE_DIR) \
		node apps/porter/dist/porter.js

porter-status:
	@PORTER_STATE_DIR=$(PORTER_STATE_DIR) node apps/porter/dist/porter.js --status

# --- Binaries (standalone executables, no Node required on the target) ---
binaries: cook
	@echo "Building standalone chell executables (esbuild bundle -> pkg)..."
	npm run binaries -w @fnndsc/chell
	@echo "Binaries in packages/chell/build/bin/"

# ---------------------------------------------------------------------------
# Front of house: the git and GitHub chores of getting work merged and
# published, encoded so the flow does not depend on anyone (or any LLM)
# remembering it. Everything below the commit itself needs an authenticated
# `gh`. The flow, end to end:
#
#   make save MSG=".." -> make pr -> make merge -> make publish -> make verify-npm
# ---------------------------------------------------------------------------

# A new branch off the current HEAD; work never starts on protected main.
branch:
ifndef BR
	$(error BR is required: make branch BR=feature-name)
endif
	git checkout -b $(BR)

# Commit tracked changes only (`git add -u`): untracked scratch files never
# ride along by accident. Stage new files explicitly before saving.
save:
ifndef MSG
	$(error MSG is required: make save MSG="what changed and why")
endif
	git add -u
	git add .changeset
	git commit -m "$(MSG)"
	@untracked=$$(git status --porcelain | grep '^??' | grep -v 'claude.resume' || true); \
	if [ -n "$$untracked" ]; then \
	  echo ""; \
	  echo "WARNING: untracked files NOT in this commit (git add them if they belong):"; \
	  echo "$$untracked" | sed 's/^?? /  /'; \
	fi

push:
	git push -u origin $(BRANCH)

# Opens the PR against main with title and body drawn from the branch's
# commits (--fill). Edit on GitHub afterwards if the autogenerated body
# undersells it.
pr: push
	gh pr create --base main --fill

# Waits for the required contexts (audit, check 22, check 24) on this
# branch's PR. The first loop covers the gap before GitHub registers any
# checks at all; --watch then follows them to a verdict.
ci-watch:
	@gh pr view --json number >/dev/null || { echo "No PR for $(BRANCH); run 'make pr' first."; exit 1; }
	@echo "Waiting for required checks on the $(BRANCH) PR..."
	@until gh pr checks --required 2>/dev/null | grep -q .; do sleep 15; done
	@gh pr checks --watch --interval 30 --required

# Rebases this branch onto origin/main and pushes it (force-with-lease: only
# over what was last pushed). A branch left BEHIND main cannot merge under
# strict protection, and GitHub's "update branch" button is what this is
# from the terminal.
rebase:
	git fetch origin
	git rebase origin/main
	git push --force-with-lease -u origin $(BRANCH)

# Merges this branch's PR once its required checks pass. Main is protected
# with strict status checks: a branch that fell BEHIND main (another PR
# landed while this one waited) is refused with nothing said that a shell
# loop would notice, so the branch is rebased and re-pushed first, and once
# more if main moved again while the checks ran. Two rounds, then it stops
# and says so rather than chase a busy main forever.
merge:
	@gh pr view --json number >/dev/null || { echo "No PR for $(BRANCH); run 'make pr' first."; exit 1; }
	@for round in 1 2 3; do \
		state=$$(gh pr view --json mergeStateStatus --jq .mergeStateStatus); \
		if [ "$$state" = "BEHIND" ] || [ "$$state" = "DIRTY" ]; then \
			if [ $$round -eq 3 ]; then echo "Still $$state after two rebases; main is moving — try again."; exit 1; fi; \
			echo "Branch is $$state main; rebasing and pushing..."; \
			$(MAKE) --no-print-directory rebase || exit 1; \
			sleep 10; \
		fi; \
		$(MAKE) --no-print-directory ci-watch || exit 1; \
		state=$$(gh pr view --json mergeStateStatus --jq .mergeStateStatus); \
		if [ "$$state" = "BEHIND" ]; then echo "Main moved while the checks ran."; continue; fi; \
		gh pr merge --merge && break || exit 1; \
	done
	@echo "Merged. 'make sync' fast-forwards local main; 'make publish' releases"
	@echo "any pending changesets via the Version Packages PR."

# Bot-opened PRs (the changesets Version Packages PR) get their CI runs
# parked as action_required; this approves them so the checks can run.
# A run held for approval reports status=completed with conclusion
# action_required, NOT status=action_required — asking for the latter matched
# nothing, so this approved nothing and `publish` then waited forever on
# checks that were never going to start. Both spellings are selected here,
# since a run held before it starts reports status=waiting instead.
vp-approve:
	@for id in $$(gh api "repos/{owner}/{repo}/actions/runs?branch=changeset-release/main&per_page=20" --jq '.workflow_runs[] | select(.conclusion == "action_required" or .status == "waiting") | .id'); do \
		echo "Approving CI run $$id..."; \
		gh api -X POST "repos/{owner}/{repo}/actions/runs/$$id/approve" >/dev/null; \
	done

# A bot-opened run waits for approval, and its run may not exist yet when
# publish starts (the Version Packages PR is still being rewritten): publish
# re-approves on every pass of its wait, not once before it.
# The release step. Merging the Version Packages PR triggers the Release
# workflow on main, which publishes every bumped package to npm — an
# irreversible, outward-facing act, which is why it is its own target and
# never chained onto `merge`.
publish: vp-approve
	@pr=$$(gh pr list --head changeset-release/main --state open --json number --jq '.[0].number'); \
	if [ -z "$$pr" ]; then echo "No open Version Packages PR (nothing to publish)."; exit 1; fi; \
	echo "Version Packages PR #$$pr — waiting for required checks..."; \
	until gh pr checks $$pr --required 2>/dev/null | grep -q .; do $(MAKE) --no-print-directory vp-approve; sleep 15; done; \
	gh pr checks $$pr --watch --interval 30 --required && \
	gh pr merge $$pr --merge
	@echo "Version Packages merged; publishing main to npm from $(PUBLISHER_REPO)."
	@$(MAKE) --no-print-directory release-dispatch
	@echo "Confirm with: make verify-npm"

# Publishes what main holds and puts it on the hosts, in the order that cannot
# leave a host empty (scripts/deploy.sh): every version porter runs proven on npm
# first, install before remove, pangea then titan. HOSTS= narrows; SKIP_PUBLISH=1
# installs a release already on npm.
deploy:
	@bash scripts/deploy.sh

# The nightly smoke's ledger: one line per run, its reds beneath (scripts/smoke-nightly.sh,
# fired by the mise-smoke.timer user unit on pangea). A red is never "pre-existing".
# The upgrade path, live: a daemon on the previous published chell, a porter
# from this checkout, two logins (one restart, then attach). One ledger line.
smoke-upgrade:
	bash scripts/smoke-upgrade.sh

smoke-report:
	@tail -n 40 $$HOME/.local/state/mise/smoke/ledger.txt 2>/dev/null || echo "no nightly has run yet"

# Local package.json versions against what the registry serves, one line
# per package. After a publish the two columns must agree.
verify-npm:
	@for p in cumin salsa chili brasa calypso chell; do \
		printf "%-8s local %-8s npm %s\n" $$p \
			"$$(node -p "require('./packages/$$p/package.json').version")" \
			"$$(npm view @fnndsc/$$p version 2>/dev/null || echo '?')"; \
	done

# Regenerates the lockfile with CI's npm pin and proves the result with a
# dry-run `npm ci` — the exact command CI runs first.
lockfile:
	@echo "Regenerating package-lock.json with npm@$(CI_NPM) (CI's pin)..."
	npx --yes npm@$(CI_NPM) install --package-lock-only
	@echo "Verifying with a dry-run npm ci..."
	@npx --yes npm@$(CI_NPM) ci --dry-run >/dev/null && echo "Lockfile in sync."

# GitHub's push/pull_request event delivery occasionally lags for minutes
# and no workflow run appears; these fire the workflows by hand.
ci-dispatch:
	gh workflow run ci.yml --ref $(BRANCH)
	@echo "CI dispatched on $(BRANCH); follow with 'make ci-watch'."

# The publisher: npm rejects this repository's OIDC tokens since its transfer
# (immutable subject, npm/cli#9969), so the packages are published by a
# workflow in a repository that keeps the name-based subject, and every
# package names it as its trusted publisher. It checks out main and runs
# `changeset publish`; versions already on npm are skipped.
PUBLISHER_REPO ?= FNNDSC/chrisproject.org
PUBLISHER_WORKFLOW ?= publish-mise.yml

release-dispatch:
	@before=$$(gh run list -R $(PUBLISHER_REPO) --workflow $(PUBLISHER_WORKFLOW) --limit 1 --json databaseId --jq '.[0].databaseId // 0'); \
	gh workflow run $(PUBLISHER_WORKFLOW) -R $(PUBLISHER_REPO) --ref master -f ref=main || exit 1; \
	run=""; for i in $$(seq 1 20); do sleep 3; run=$$(gh run list -R $(PUBLISHER_REPO) --workflow $(PUBLISHER_WORKFLOW) --limit 1 --json databaseId --jq '.[0].databaseId // 0'); [ "$$run" != "$$before" ] && break; done; \
	[ "$$run" != "$$before" ] || { echo "No publisher run appeared in $(PUBLISHER_REPO)"; exit 1; }; \
	echo "Publisher run $$run in $(PUBLISHER_REPO): watching"; \
	gh run watch $$run -R $(PUBLISHER_REPO) --exit-status --interval 15 >/dev/null && echo "Published (run $$run)." || { echo "Publisher run $$run failed: gh run view $$run -R $(PUBLISHER_REPO) --log-failed"; exit 1; }

sync:
	git checkout main
	git pull --ff-only
	git fetch --prune

tidy:
ifndef BR
	$(error BR is required: make tidy BR=branch-name)
endif
	git branch -d $(BR)
	git push origin --delete $(BR) || echo "(remote branch already gone)"

# --- The Big One ---
taco: scrub prep cook taste serve
meal: taco

# --- Standard Aliases ---
install: prep
build: cook
surface: plate
test: taste
clean: scrub
link: serve
all: taco
