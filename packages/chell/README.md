# ChELL: ChELL Executes Layered Logic

**The Interactive Shell for ChRIS**

ChELL is a command-line shell that presents a ChRIS distributed-computing platform as a familiar Unix filesystem. If you know `bash` or `zsh`, you already know most of ChELL.

## Installation

```bash
npm install -g @fnndsc/chell
```

Requires Node.js ≥ 20.12. This installs the `chell` command — see [Getting Started](#getting-started) to connect to a CUBE.

## The Concept

ChRIS stores data, analysis tools, and results behind a REST API. ChELL maps all of that onto paths:

- your data lives under `/home/<user>/`
- every registered plugin and Pipeline is a virtual executable in `/bin`
- system configuration is readable at `/etc`
- PACS query results surface under `/net/pacs/queries/`

You navigate with `cd`, inspect with `ls`, read files with `cat`, and run analyses by invoking plugin names — the same muscle memory you use on any Unix system.

PACS retrieval can also establish the input of a new analysis directly:

```bash
pacs query AccessionNumber:12345678
pacs pull /net/pacs/queries/.../Study_... --new-feed "Brain MRI"
```

`--new-feed` waits for the complete selected series set, creates one feed rooted
at `pl-dircopy`, and prints the feed ID, root job ID, and feed path. Without the
flag, `pacs pull` only retrieves data into CUBE storage.

Running over what was pulled is a line of its own: `gather process <plugin|pipeline>`
runs once over the whole cohort, off its feed's root. See
[PACS Query / Retrieve / Resolve](docs/pacsqr.adoc#planned-analysis-attachment).

---

## The Virtual Filesystem

The ChELL filesystem has two kinds of paths:

- **CFS (CubeFS)** — real ChRIS storage: files you upload, feed outputs, symlink files. Readable, writable, persistent.
- **VFS (Virtual)** — synthesised on the fly from API resources: plugins, config, PACS results. Read-only views, no stored bytes.

| Path | Type | What you see |
|------|:----:|-------------|
| `/home/<user>/` | CFS | Your uploaded files and directories |
| `/home/<user>/feeds/` | CFS | Your analysis feeds and their output trees |
| `/PIPELINES/` | CFS | Shared pipeline output data |
| `/PUBLIC/` | CFS | Publicly accessible files |
| `/SERVICES/` | CFS | Service-level data |
| `/SHARED/` | CFS | Cross-user shared data |
| `*.chrislink` | CFS | Symbolic links to other ChRIS paths |
| `/bin` | VFS | Every plugin and Pipeline registered in this CUBE |
| `/usr/bin` | VFS | Built-in shell commands (`id`, `whoami`, `whereami`, …) |
| `/etc/` | VFS | Config: compute environments, groups, users, CUBE info |
| `/net/pacs/queries/` | VFS | PACS query result sets |
| `/proc/jobs/` | VFS | Job monitoring — live status of all plugin instances |

```bash
cd /etc
cat compute.yaml          # inspect available compute environments
cat group                 # list groups and their current CUBE users

cd /bin
ls pl-mri*                # browse MRI-related plugins

cd /home/chris/feeds
ls -l                     # see your analysis feeds
```

### Symlinks (`.chrislink` files)

ChRIS uses `.chrislink` files as symbolic links. `ls -l` renders them as `l` entries; `cd` and `cat` follow them transparently. The link target is resolved through the VFS dispatcher — it can point anywhere in the virtual tree.

---

## Running Plugins

Because plugins live in `/bin` as virtual executables, you invoke them **directly by name** — exactly like running a local binary. ChELL uses your **current working directory** to determine context automatically, so you never need to supply a `--previous_id` by hand.

### Case 1 — Starting a new analysis from a data directory

```bash
cd /home/chris/uploads/SAG-anon
pl-fshack-v1.2.0 --inputFile brain.mgz --outputFile brain.nii
```

ChELL detects you are **outside a feed**. It:
1. Automatically runs `pl-dircopy` on the current directory to stage the data into a new feed
2. Attaches your plugin to that dircopy instance as the next step

A new feed is created for you — no boilerplate.

### Case 2 — Continuing an existing analysis

```bash
cd /home/chris/feeds/feed_123/pl-fshack_456/data
pl-segmentation-v1.0.0 --threshold 0.5
```

ChELL detects you are **inside a feed**. It extracts the plugin instance ID from the path (`456`) and uses it as `previous_id` automatically. The new plugin node is wired into the existing computation DAG.

### Naming feeds and instances

Use `--` to separate plugin parameters from feed-level context:

```bash
pl-fshack-v1.2.0 --inputFile brain.mgz -- feed_title="Brain MRI Study" instance_title="FreeSurfer recon"
```

Everything before `--` goes to the plugin; everything after sets ChRIS metadata.

### Inspecting a versioned plugin

The executable itself exposes help, parameters, and repository documentation:

```bash
pl-fshack-v1.2.0 --help
pl-fshack-v1.2.0 --parameters
pl-fshack-v1.2.0 --readme
pl-fshack-v1.2.0 --readme --raw > pl-fshack-README.md
```

Markdown READMEs are styled for terminal display, while reStructuredText is
preserved as written. `--raw` returns only the original README content, making
it safe for pipes and redirection. These forms behave the same in local and
remote sessions.

### Monitoring

```bash
job inspect <instance_id>
jobs list --feed <feed_id>
```

### Installing new plugins

```bash
# Search the public peer store
store search simplefs

# Install (auto-discovers compute resources)
store install pl-simplefsapp

# Install pinned to specific compute
store install pl-simplefsapp --compute ares,argentum
```

`store install` (and `plugin add`) runs a three-phase resolution:
1. Already in this CUBE → reports that it is already registered
2. Found in the peer store (`store set` chooses it; cube.chrisproject.org by default) → imports via admin API
3. Not found → Docker extraction and registration

`plugin add` also takes a plugin URL in another CUBE, which CUBE fetches itself, and `--json <file>`, one descriptor file.

### Filling a CUBE from the plugin index

```bash
plugin sync --plan        # what FNNDSC/chris-plugins would add, skip and report here
sudo plugin sync          # the plan, one question, then the adds
plugin validate ./plugins # check descriptors without a CUBE
```

`plugin sync` never deletes or changes a plugin already there; see [docs/plugins.adoc](docs/plugins.adoc).

When registration needs escalation, ChELL reports the original failure and
suggests the explicit retry, for example `sudo store install pl-simplefsapp`.
`sudo` prompts for administrator credentials with a hidden password and uses
the resulting CUBE identity only for that nested command. In a remote session
those prompts and their guidance stay on the originating client surface.

---

## Running Pipelines

A **pipeline** is a registered template — a named, reusable graph of plugins with their parameter defaults wired together. Pipelines are static definitions; they do not run on their own.

A **workflow** is a live instantiation of a pipeline, attached to a specific feed node. Creating a workflow is the act of "running" a pipeline: ChRIS schedules each plugin step in order, feeding outputs of one into the inputs of the next.

```bash
# Browse registered pipeline templates
pipeline list
pipeline info <name|id>

# Inspect or draw a registered template
pipeline manifest <name|id|slug>
pipeline diagram <name|id>

# Run by invoking its /bin name in the current context
brain-segmentation
brain-segmentation --segmentation.threshold 0.5
brain-segmentation --paramFile ~/experiments/run-1.yaml

# Equivalent explicit form
pipeline run brain-segmentation --previous <instance_id>

# Monitor all the jobs it spawns
jobs list --feed <feed_id>
```

`<pipeline> --manifest` is the direct alias for the complete registered
invocation YAML, including piping IDs, stored values, compute placement, resource
controls, and topology. `cat /bin/<pipeline>` intentionally remains immediate:
it prints only a cached executable summary pointing to the manifest command.

`<pipeline> --diagram` is the direct drawing alias; add `--withargs` for stored
defaults or `--signalflow` for SignalFlow YAML. Pipeline parameters and execution
controls use `--<node>.<field> <value>`, while `--paramFile <cfs-file>` reads one
sparse overlay from durable CFS. ChELL resolves the current context automatically;
`--previous <instance_id>` selects an explicit attachment point.

---

## Monitoring Jobs: `/proc/jobs/`

Because every plugin runs asynchronously in ChRIS, `/proc/jobs/` is where you come back to see what happened. It exposes all your visible feeds and their plugin instances as a navigable DAG — the same tree structure the computation actually ran in.

```
/proc/jobs/
└── feed_123/
    ├── status                        ← aggregate feed status
    ├── title                         ← feed name
    └── pl-dircopy_456/               ← root node (j = job type in ls -l)
        ├── status                    ← finishedSuccessfully
        ├── params
        ├── log
        └── pl-fshack_789/
            ├── status                ← started
            └── pl-segmentation_1011/
                └── status            ← scheduled
```

```bash
ls -l /proc/jobs/feed_123            # see all nodes with colour-coded status
cat /proc/jobs/feed_123/pl-fshack_789/status   # terminal cached; active refreshed
cat /proc/jobs/feed_123/pl-fshack_789/log      # stdout/stderr
cat /proc/jobs/feed_123/pl-fshack_789/params   # what it ran with

# The whole feed as one DAG view
feed tree 123                         # collapsed, status-coloured tree (⋈ marks joins)
feed tree 123 --focus 789             # scope to one node's subtree
feed diagram --signalflow 123 | signalflow -   # emit the DAG; render with your own tools
pipeline diagram brain-segmentation  # shallow registered-pipeline template
brain-segmentation --diagram --withargs  # /bin alias with stored defaults
brain-segmentation --signalflow | signalflow - # direct SignalFlow alias

# Search across all jobs
tree /proc/jobs | grep 789           # find instance 789 and see its full lineage

# Cancel a running job
rm /proc/jobs/feed_123/pl-fshack_789

# Cancel all jobs in a feed (requires -r)
rm -r /proc/jobs/feed_123
```

Status colours in `ls -l`: green = `finishedSuccessfully`, yellow = `started`/`running`, gray = `scheduled`/`cancelled`, red = `finishedWithError`.

Connected startup indexes the visible feed list and warms job topology in the
background. A daemon first restores its identity-scoped local checkpoint,
validates that its feeds are still visible, and serves that usable topology
while reconciling it with CUBE. Terminal statuses can be restored; active
statuses and logs remain live. Inspect freshness and feed scope with `proc stat`:

```bash
proc stat                 # feed scope, loaded jobs, sweep and checkpoint state
proc stat feed_123        # cached detail for one feed
proc retry                # resume a failed topology sweep at its failed page
proc refresh              # rebuild all and start one replacement topology sweep
proc refresh feed_123     # scope to one feed
```

If startup prefetch is disabled, first access builds the index lazily. Run a
full `proc refresh` after activity from another client or the web GUI; CUBE is
always authoritative.

Since `/proc` paths encode the instance ID, you can also **continue an analysis from any node** just by `cd`-ing into it:

```bash
cd /proc/jobs/feed_123/pl-dircopy_456
pl-fshack-v1.2.0 --inputFile brain.mgz   # attaches here, no --previous_id needed
```

---

## Key Commands

### Filesystem
```bash
ls [-l] [-h] [-a]       # list directory
cd <path>               # change directory (follows .chrislinks)
cat <file>              # print file content
edit <file>             # open in $EDITOR, save back to ChRIS
cp / mv / rm            # copy, move, delete
mkdir / touch           # create directory or empty file
upload <local> <remote> # upload local file or directory tree
download <remote> <local>
tree                    # recursive listing
du                      # disk usage
```

### Resources
```bash
plugin list / search / inspect / run
plugins list [--search <term>] [--all]
<plugin>-v<version> --help / --parameters / --readme [--raw]
feed list / inspect
feeds list [--user <name>] [--all]
feed note <id>          # read feed note
feed note edit <id>     # edit feed note in $EDITOR
feed comments <id>      # list comments
pipeline list / info / manifest / run / source / diagram
workflow list / create
job inspect <id>
compute list            # list compute environments
```

### Store
```bash
store list              # browse peer store
store search <query>
store install <plugin>  # install with admin escalation if needed
store inspect           # show current peer store URL
store set <url>         # override peer store
```

### System
```bash
id                      # CUBE UID, projected primary GID, and memberships
whoami                  # current CUBE user
whereami                # current CUBE URL (use pwd for working directory)
prompt list             # list prompt themes
prompt default          # compact single-line prompt
prompt p10k             # vivid two-line powerline prompt
connect --user <u> --password <p> <url>
logout
proc stat               # show /proc feed scope, freshness, and checkpoint
proc retry              # resume failed /proc reconciliation without starting over
proc refresh            # rebuild /proc job cache and restart topology warm-up
proc refresh feed_123   # scope rebuild to one feed
```

Both prompt themes display the authenticated user's home directory as `~`, so
`/home/chris/uploads` appears as `~/uploads`. The `default` and `p10k` themes
share a vivid truecolor palette; `p10k` adds background-filled powerline
segments, high-contrast Font Awesome icons, and optional status information.
The icons and separators require a Nerd Font. Use `prompt --show` to preview
the active prompt.

The p10k prompt orders PACS, CUBE URL, user, path, and `/proc` from left to
right; the optional physical-mode indicator and command telemetry follow that
core sequence. A visible `/proc` segment distinguishes cold indexing, cached
refresh, and refresh failure; it disappears once the CUBE-authoritative index
is current.

---

## Getting Started

```bash
# Start the shell, then connect interactively
chell
> connect --user chris --password chris1234 http://localhost:8000/api/v1/

# Connect via flags
chell -u chris -p chris1234 http://localhost:8000/api/v1/

# Compact user@host form (password prompted if omitted)
chell chris@localhost:8000/api/v1/
chell -p chris1234 chris@localhost:8000/api/v1/
```

### Scripting

```bash
# Non-interactive: single command via -c
chell -c "ls -l /home/user/study" > study_contents.txt
chell -c "store install pl-dircopy"

# Run a script file
chell -f my_workflow.chell
```

---

## Architecture

ChELL is the presentation layer of the "Sandwich Model":

1. **ChELL** — REPL, builtins, tab completion, prompt
2. **ChILI** — typed commands, views, CLI controllers
3. **Salsa** — business logic, VFS dispatcher, intent layer
4. **Cumin** — connection, context persistence, state
5. **`@fnndsc/chrisapi`** — raw ChRIS REST client

---

## Further Reading

| Document | Topic |
|----------|-------|
| [docs/vfs.adoc](docs/vfs.adoc) | VFS architecture — providers, dispatch, path resolution |
| [docs/pluginrun.adoc](docs/pluginrun.adoc) | Running a plugin — new feed vs continue feed, the wait, naming the run |
| [docs/store.adoc](docs/store.adoc) | Store install — three-phase resolution, admin escalation |
| [docs/plugins.adoc](docs/plugins.adoc) | Registering plugins — `plugin add`, filling a CUBE from an index (`plugin sync`), `plugin validate`, `plugin index` |
| [docs/login.adoc](docs/login.adoc) | Connection and authentication options |
| [docs/execution.adoc](docs/execution.adoc) | How chell is invoked: REPL, `-c`, scripts, flags |
| [../../docs/manifest.adoc](../../docs/manifest.adoc) | The script and manifest language: `@param`, variables, `expect`, `play` |
| [docs/commands.adoc](docs/commands.adoc) | Full command reference |
| [docs/pacsqr.adoc](docs/pacsqr.adoc) | PACS query and retrieve |
| [docs/physicalMode.adoc](docs/physicalMode.adoc) | Physical vs logical filesystem mode |
| [docs/gotchas.adoc](docs/gotchas.adoc) | Known edge cases and workarounds |
| [docs/architecture.adoc](docs/architecture.adoc) | Full architecture deep-dive |
| [CONTEXT.md](CONTEXT.md) | Domain glossary — ChRIS concepts, permission model, resource contract |

---

## License

Part of the [ChRIS Project](https://chrisproject.org).

---
*ChELL is part of the ChRIS Project.*

---
_-30-_
