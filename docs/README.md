# mise architecture and project docs

Architecture, design reasoning, and active project context for the mise stack —
what has shipped, where the project is going, and why. This is not primarily user
documentation; for using the shell and the packages, see the per-package READMEs (start with
[packages/chell](../packages/chell/README.md)).

- **[principles.adoc](principles.adoc)** — the load-bearing beliefs, and the only
  normative document here: a principle wins over a conflicting design decision, or
  it is explicitly revised. Records what mise inherits from CUBE versus what it
  owns, why a workaround may never be silent, the boundary between an intent and
  a surface's own view state, and the six violations known today. Several
  principles are enforced mechanically; the rest are cited in review. It states
  the rules and deliberately does not argue for them.

- **[lineage.adoc](lineage.adoc)** — the companion essay to the above: what each
  principle descends from (Seeheim and Arch, Jupyter and LSP, Unix and the Monad
  manifesto, `emacs` and Acme, Plan 9, BTRON), the failure modes those
  precedents documented, an honest account of what in this architecture is
  actually particular rather than inherited, and the interaction-DAG direction
  that is not yet built. Nothing here binds. Sources are traced to primary
  literature, with the claim-to-source map and its qualifications — including
  what was verified only secondarily — recorded in
  **[principles-references.md](principles-references.md)**.

- **[mise.adoc](mise.adoc)** — the scientific architecture paper: ChRIS and
  CUBE's historical context, the Collection+JSON intent gap, mise's taxonomic
  placement and state model, adversarial analysis of the multilayer design, and
  the concrete backend capabilities that mise's edges suggest CUBE should add.
  Supporting source verification is recorded in
  **[mise-references.md](mise-references.md)**.

- **[history.adoc](history.adoc)** — the narrative history of the stack: how mise
  grew from a single adapter that tamed Collection+JSON into a layered command
  substrate, then a shell, then a hostable engine a daemon can serve to many
  surfaces — and why each layer exists. Start here for the story; the documents
  below are the forward design.

- **[intent-kernel.adoc](intent-kernel.adoc)** — a reference for client authors:
  what mise offers a client that is not the shell — a single contract of *intent
  in, receipt out*, reachable in-process (brasa as a library) or over the wire
  (a calypso session), so no client ever speaks Collection+JSON. Marks what exists
  today versus what is forward work, and records why ChELL remains subordinate
  to a general shell for loops, branching, concurrency, and other programming.

- **[envelope-model.adoc](envelope-model.adoc)** — the contract that makes the
  above real: every command returns a `CommandEnvelope`, and the move from
  envelopes that carry *text* to envelopes that carry a typed *model* — with the
  rendered string demoted to one view. Includes worked examples (`ls`,
  `feed list`) and the per-command migration recipe.

- **[calypso.adoc](calypso.adoc)** — **CALYPSO**: an intent-interpretation layer
  and session daemon that separates the chell engine from its display and serves
  it over a WebSocket, so remote and web surfaces can drive the same deterministic
  ChRIS command layer — with an eventual natural-language layer that only ever
  *proposes* commands the deterministic shell validates and runs. Includes the
  doctrine, the wire contract, and the staged engineering plan.

- **[surfaces.adoc](surfaces.adoc)** — a companion essay: once server-state
  synchronization is deleted from the client, UI framework choice is demoted from
  architecture to taste, and every surface — framework-based or bespoke — attaches
  to the daemon as a sibling.

- **[argus.adoc](argus.adoc)** — **ARGUS**, an LCARS-based web surface built
  around an indwelling CALYPSO terminal. Defines its place outside the package
  stack and its five operator domains: Files, Runs, Tools, Sources, and Compute.

- **[structured-progress.md](structured-progress.md)** — the implementation
  contract for CALYPSO structured progress: progress events are facts emitted
  through the sink and daemon wire; terminal bars are renderings of those facts.

- **[session-supervisor.adoc](session-supervisor.adoc)** — the shipped
  identity-keyed local daemon model and the deferred network-facing `porter`
  tier: one isolated CALYPSO process per CUBE identity, resolved through berths.

- **[backend-neutral.adoc](backend-neutral.adoc)** — the design (in review, issue #977) for making menu, calypso, brasa's core and ARGUS's frame backend-neutral: the neutral package `fond`, one backend per session, a command registry, tasks for long-running steps, ARGUS compositions; behaviour for chell and ARGUS unchanged throughout.

- **[linux-metaphor.adoc](linux-metaphor.adoc)** — mise read as an ordinary Linux machine, with the figure: the bastion as the host, `porter` the login manager, `calypso` the session, `brasa` core bash and coreutils, `fond` defining the VFS, a backend (`chris`, `stratus`) the filesystem driver that keeps the mount table; surfaces (chell, ARGUS) attach over a wire (`menu`) and are not layers; followed down across the network to CUBE (CFS, the register of apps, jobs as processes) and the OpenShift and Kubernetes cluster under it, and out to the original ChRIS UI (a vendor's console) and ARGUS (a desktop session). Explains; does not bind.
- **[proc.adoc](proc.adoc)** — `/proc` as CUBE's runtime state: `/proc/jobs`, `/proc/tags`, and the deprecated `/proc/workflows` (why it was built for folder downloads, what 51k workflows cost, how the run questions are answered by CUBE searches and `/proc/jobs` instead).
- **[trek.adoc](trek.adoc)** — trek, the BSD trek(6) port: `bsd-trek` on npm (name, licence, saves, publishing by hand first), the boundary that keeps it free of mise's internals (`lint:trek`), typed asks from its questions, and the ARGUS bridge that takes the whole screen (header of ship state, stations that follow the question); the first package built as if from outside, and what is deferred until a second consumer.
- **[stratus.adoc](stratus.adoc)** — the substrate backend: a cloud tenancy mounted under `/net`, clouds as drivers inside one backend, `domain` verbs over build steps as tasks, the TD controller, and a fleet of Trusted Domains later.
- **[architecture/overview.adoc](architecture/overview.adoc)** — every architecture figure in one place, in reading order, with a paragraph on how to read each: mise as a Linux machine, ChRIS as a machine, CUBE as blocks, the Hub bastion, the spoke bastion. The two ChRIS figures have their own documents beside it: **[architecture/chris-as-a-machine.adoc](architecture/chris-as-a-machine.adoc)** (the stack with the CUBE card opened: API server, workers, `beat`, PostgreSQL, file storage, the PACS gateway `pfdcm` and `oxidicom`, `pfcon` as the whole compute resource, OpenShift, the substrate) and **[architecture/cube.adoc](architecture/cube.adoc)** (the same server as blocks: who talks to whom, in-network and out-of-network `pfcon`, and the four places CUBE touches OpenShift). Both figures are rendered from HTML sources beside their PNGs in `images/`.

- **[bastion.adoc](bastion.adoc)** — the bastion: the mise stack as the Trusted Domain builder. The Hub bastion as the cloud controller (one host, one path to its shell, three layers through three doors) the spoke bastion as a runner over a cohort (`/incoming`, `/outgoing`, open or sealed policy) for code shipped from a Hub dev bastion; both figures, and what it corrects in stratus.adoc.
- **[redhat-fl.adoc](redhat-fl.adoc)** — edit at one OpenShift, run in many: HARBOR's basic need stated precisely, what Red Hat ships against it product by product (RHACM/OCM, GitOps, Dev Spaces, OpenShift AI, the federated-learning patterns on OCM), the gap, and HARBOR's two mechanisms, ship the app and ship the code; a dated survey with sources.
- **[dev-bastion.adoc](dev-bastion.adoc)** — the dev bastion as a coding surface over a cohort: the cadence problem that the plugin path cannot solve, three bastions with disjoint key rings, the logical view (`~/project/`, `/incoming`, `/outgoing`, `run`), the wire from a Hub dev bastion to N spoke bastions, and the policy, open or sealed, with the reasons for each rule; related work and open questions.
- **[berths.adoc](berths.adoc)** — a berth: one person's mise session in a container of its own behind a spoke's door; the words (CUBE the server, the mise stack its client, porter the host, a berth one client in its own walls, the berth image), the topology (a wire per berth to porter, one `cube-net` for the API), a person's own files versus cohort work, the settled build decisions (launcher, image, token, cohort copy, `pl-berth` return, limits, lifecycle), the launcher as built, and what is open.

- **[feed-dag-viewer.adoc](feed-dag-viewer.adoc)** — the shipped cache-first
  feed and pipeline diagram model, including shallow trees, topological joins,
  SignalFlow YAML emission, dynamic `/bin` pipeline aliases, and the forward
  contract for per-node pipeline parameter bindings and serializable overlays.

- **[handoff.md](handoff.md)** — the active handoff between sessions and models: where the stratus epic and the bastion work stand, the house rules with pointers, the recipes (private fake daemon, pty chell, CDP screenshots), the follow-ups, and the plan for the next steps with files, tests and acceptance. Read first; updated at the end of every slice.