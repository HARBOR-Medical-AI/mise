# @fnndsc/stratus

## 0.12.1

### Patch Changes

- 7f6e01c: A ChRIS deployed with `--porter` now runs porter 0.9.11, with the ARGUS whose SIZE seat declares and builds.

## 0.12.0

### Minor Changes

- 352794c: A session reads Oracle's price list once and prices every VM from it, and a build line says what a build would change.

  `vm cost` used to fetch the whole price list (about 200 KB) two to four times for each answer; the session now reads it on the first price, says so in that answer, and keeps it (a failed read is not kept), and the `vm cost` model carries `pricesRead`. A build keeps the spec it made the tenancy match (`builtSpec` on the VM's record), so `play --status` says `declared, not built: disk 50 → 180` for a size declared since; a build that grows the data volume alone now counts as built. Under `stratus --fake` the fake tenancy answers what the fake builder applied, so `vm status` no longer marks a VM it built as gone.

### Patch Changes

- Updated dependencies [352794c]
  - @fnndsc/menu@0.36.0
  - @fnndsc/brasa@0.52.5
  - @fnndsc/calypso@0.29.2

## 0.11.1

### Patch Changes

- 012bbe7: A session signed in as the ChRIS admin, `chris`, no longer reports WARM-UP FAILED: FEEDS. CUBE makes `chris` with no home folder, so every `chris deploy` now gives it the home a sign-up gives any account (its groups, `/home/chris/uploads` and `/home/chris/feeds`, and the `public` and `shared` links), leaving any already there as they are.
- 0c57bc8: A ChRIS deployed with `--porter` now runs porter 0.9.10, with the chell, calypso and ARGUS it brings, instead of 0.9.2.
- 1a10768: A deploy no longer fails at its second step when the VM's bastion session is brand new. Every line sent to a VM is tried again (six tries, ten seconds apart) when ssh itself failed to carry it; a line the VM ran is never repeated.

## 0.11.0

### Minor Changes

- 289c9f8: A password on a ChRIS stratus deployed can be changed, with `chris passwd [<user>] [--on <vm>]`. The admin's (`chris`, the default) changes on the host, in `cube.env` on the VM and in CUBE together: CUBE sets `chris`'s password from `cube.env` at every start, so a change made in CUBE alone does not last. The operator is asked first, since CUBE starts again and is down for a minute or so; the new password is typed twice (empty: generated and shown once), checked by signing in, and kept in the tenancy. A run stopped part way finishes when asked again with the same password. Any other account's password is set in CUBE alone and never kept.
- 2c02bd2: Every session on every host now sees and manages the same VMs. The tenancy keeps each VM's SSH key and ChRIS passwords; a host's records are only a cache. A VM's secrets go into one vault per region in the tenancy (`mise`), written before its machine is built, after each `chris deploy`, and by the new `vm keep <name>` for a VM built before. `vm status` fills and corrects this host's cache from the tenancy, so a VM built from a terminal reads whole from a porter session, and one resized or torn down elsewhere is read again.
- 2c02bd2: A VM that stands can be resized: `vm new` with new sizes, then `vm build`. More vCPUs or memory change the machine in place, and the question before the apply says it reboots and what goes down with it; a grown boot disk or data volume has its filesystem grown afterwards over the bastion, so the space appears. A shrink, a new OS or a replaced volume is still refused unless `--allow-alter`.

### Patch Changes

- 274ef4c: Acting on a VM another session built takes its records over from the cloud, so it can be unlocked and torn down here.

  `vm protect` and `vm teardown` on a VM the tenancy runs that this session keeps no record of read its stacks back (its spec, its handles, its addresses) and keep it here, born protected, so the lock and the name typed back stay its guards. Plan, build, shell and `chris deploy` refuse it, since the session that built it keeps its SSH key. A VM made outside stratus is never taken over.

- 28a2e89: A VM's teardown is watched step by step, and `chris deploy` says on the machine itself what it put there.

  A VM teardown's two parts (the machine, then the data or its keeping) are steps on its record, each sent as the VM's row as it begins and ends, so a screen draws it going and gone. `chris deploy` tags the VM's instance with the CUBE API's address and porter's name, and a VM found in the tenancy reads them back, so a session that keeps no record of it still knows what runs on it.

- Updated dependencies [2c02bd2]
- Updated dependencies [28a2e89]
- Updated dependencies [274ef4c]
  - @fnndsc/menu@0.35.0
  - @fnndsc/brasa@0.52.4
  - @fnndsc/calypso@0.29.1

## 0.10.6

### Patch Changes

- 3e54496: The VMs and networks the tenancy runs are listed, not only those this session keeps.

  A session entered through porter keeps its own records, so the store VM built from another session read "no VMs" while it ran and served cube.chrisproject.org. The tenancy is now the truth: `vm status` lists every instance the tenancy runs outside a cluster (found in one Resource Search, then each holding compartment read for shape, size and addresses), named by stratus's tag or else the cloud's name, and a tagged VM whose data stands without a machine; `net status` lists the networks carrying stratus's tag. A VM this session keeps no record of reads as found (`vm <name>` shows it), and `vm new` refuses its name, since declaring it here would build a second machine beside it.

- Updated dependencies [3e54496]
  - @fnndsc/menu@0.34.3

## 0.10.5

### Patch Changes

- fe0d525: A teardown step an earlier pass did without keeping it lands on the record when the next pass passes over it.

  Harbor's record predated the steps: its destroy, read done from the empty stack, was passed over and never written, so the seat drew that block as still standing beside six gone. The pass over a step now writes it when nothing of it was kept, and keeps the earlier pass's time and words when it was.

## 0.10.4

### Patch Changes

- 4089a9b: A teardown is seven steps kept on the record as each ends, so it is watched step by step and resumes where it stopped.

  A teardown was one job with seven removals inside it, and the record learned only the final `gone`: a teardown that stopped part way (the daemon restarted under it) left a record that still read SERVING. Now each removal is a step (destroy, dns, image, volumes, stack, compartment, installer, in that order), begun and ended on the record with its time and what went, the state shown after each so a surface watching redraws; `cluster <name>` lists them. A cluster with steps done and no `gone` reads PARTLY TORN, bills nothing once the destroy is done, and refuses build, plan and verify; `cluster teardown` on it lists what an earlier pass finished and resumes at the first step not done, asking the name again.

- Updated dependencies [4089a9b]
  - @fnndsc/menu@0.34.2

## 0.10.3

### Patch Changes

- bf7b94d: A teardown is seen running: its condition, its task to follow, and the Resource Manager log streaming as it goes.

  The operator tore harbor down and saw nothing for the quarter hour the destroy took. Three causes. The Resource Manager log was read paged, and that read answers `invalid pagination token` a few thousand lines in, on every ten-second poll, so no line of the destroy was ever passed on (the read was forgiven, not shown); the log is now read as one text. The cluster's state only ever looked for the build's task, so a teardown was never `running` and the condition never moved; the state now carries the teardown's task (`/proc/steps/<name>-teardown`, step `teardown`) and the condition TEARING DOWN, and `cluster teardown` shows the state as the task starts and as it ends (GONE), so a surface watching redraws without asking.

- Updated dependencies [bf7b94d]
  - @fnndsc/menu@0.34.1

## 0.10.2

### Patch Changes

- 4287745: Tearing down a cluster torn down before, but still tagged in the tenancy, removes what is left.

  An earlier teardown could leave a cluster's empty stack, its image bucket and its compartment behind (quay, 2026-10-25), so the tenancy search kept finding it as GONE and the dashboard kept listing it. The record is rewritten to what the tenancy still holds, the line asks for the name typed back, and the leftovers go; with nothing of it left in the tenancy the answer says so.

## 0.10.1

### Patch Changes

- 5ebb2b5: A cluster torn down with nothing of it left in the tenancy leaves every listing; `cluster status` names it in a last line.

  Its record stays on disk. The mode (READ, MANAGE) is no longer carried as a refusal in `cluster status`: what the cluster is refuses a verb; the session's mode is the surface's to draw, which asks the password in READ (docs/stratus.adoc, D14, D15).

## 0.10.0

### Minor Changes

- 1e3f235: A session's refusal in READ says what the operator chose and how MANAGE is had, never the tier's name; the halted condition is PLANNED or PARTLY BUILT, never STOPPED; `vm status` carries a model.

  `net build`, `vm build`, `chris deploy`, `chris user add`, every teardown and the plans say `entered as READ, so nothing outside this host changes; MANAGE asks your password once`; `cluster status` carries that hold on BUILD, ADOPT and TEAR DOWN for the controller. A cluster whose build halted reads PLANNED before anything bills and PARTLY BUILT after, since nothing ran that could stop. `vm status` answers `stratus.vm.status` beneath its text, a row per VM with its state, addresses, lock and the ChRIS on it (docs/stratus.adoc, D14, D16, D17).

### Patch Changes

- Updated dependencies [fa14453]
- Updated dependencies [fa14453]
  - @fnndsc/calypso@0.29.0
  - @fnndsc/menu@0.34.0
  - @fnndsc/brasa@0.52.2

## 0.9.0

### Minor Changes

- e887cbf: A cluster script replays: `cluster new` on a kept cluster compares, and `play --status` reads the cluster lines.

  `cluster new <name>` on a cluster already kept reads unchanged, or rewrites the spec and says what changed (the kept spec as its base; the zone and the compartment are the cluster's for life and another is refused). `play --status` reads `cluster new`, `plan`, `build` and `verify` from the record: not yet, ready, done or changed, and the build or plan task running now (docs/stratus.adoc, D17; infra's `chrisproject/harbor.mise`).

## 0.8.1

### Patch Changes

- 7eaf6d6: A script's status names the task running a line now, so a surface can follow a build instead of holding it.

  `play --status` reads it for a `net build`, `vm build` or `chris deploy` whose job runs under `/proc/steps/`, and for a `chris user add` whose add job names its user (docs/stratus.adoc, D17).

- Updated dependencies [7eaf6d6]
- Updated dependencies [7eaf6d6]
- Updated dependencies [7eaf6d6]
  - @fnndsc/brasa@0.52.1
  - @fnndsc/calypso@0.28.5
  - @fnndsc/menu@0.33.1

## 0.8.0

### Minor Changes

- 05ed375: A script's `net`, `vm` and `chris` lines say where they stand to `play --status`, from the kept records alone.

  `net new` and `vm new` read done when the line matches what is declared and changed with the difference; `net build` and `vm build` read not yet until what they stand on is declared and built, done once built, and changed when the spec was declared again since (every record now carries `declared`); `chris deploy` reads not yet until the VM is built, changed when the profile, compute, host or porter differ from what was deployed or the VM moved under it, ready while a host waits on DNS, done once deployed; `chris user add` reads not yet without a ChRIS and ready otherwise (CUBE is asked only when it runs). `vm cost` and `chris status` read as a dash: they keep nothing.

- 6f3df8a: Scripts live in a library mounted at `/scripts`: git repositories named by `scripts add`, cloned on this host.

  `scripts add <name> <repo> [--folder <folder>]` names a repository of scripts (the whole of it, or one folder) and clones it under stratus's state; `scripts` lists the sources with each clone's head; `scripts pull [<name>]` brings a clone up to date, fast-forward only, cloning again one that is gone; `scripts remove <name>` forgets a source and removes its clone. Each source is read at `/scripts/<name>/`, read-only and without its `.git`, so `ls`, `cat`, `play /scripts/<name>/<file>.mise` and `play --status` name one path the script screen (D17) reads too; `/scripts/mine/` is this host's own folder, written to, where a step's edits land as working copies. The sources are kept in `scripts.json` beside the session's configuration.

- 7943b0e: What a VM would cost is a question of its own: `vm cost`, in `vm new`'s words, declaring nothing.

  `vm cost <name>` with `vm new`'s options says what that VM bills at list price, an hour and a month, and what its data alone keeps billing after a teardown. On a declared VM the options given change its spec for the answer and the difference is said (`vm cost store --memory 16`: `$0.052 → $0.068 an hour, … (+$11.68 a month)`); on a name not declared they are the whole spec, and `--net` is not needed, the price being the session's region's. Bare, `vm cost` prices every declared VM. Nothing is declared or saved.

- dde6635: What the cloud sells a VM is one question, `vm limits`, answered in the spec's own words.

  `vm limits` reads the shape VMs are built from in the session's region and says, in `vm new`'s words, what it allows: vCPUs from the least to the most in the cloud's steps (OCI sells E5.Flex by the OCPU, two vCPUs at a time), memory in GiB and per vCPU where the cloud bounds it, the disks' floors and ceilings. A slider in the script screen (D17) takes its ends and steps from this answer and never from a page; the per-vCPU memory range comes to `CloudShape` as `memoryPerVcpuGib`.

- ecc91e9: A VM's cost and the shape's limits travel as models under their text, so a surface prices a step as its levers move.

  `vm cost` answers `stratus.vm.cost`: a row per VM priced with its spec, its rate (the machine and the data apart), whether it is declared, what the line changed and the declared rate before the change. `vm limits` answers `stratus.vm.limits`: the shape's ends and steps in the spec's words (docs/stratus.adoc, D17).

### Patch Changes

- Updated dependencies [05ed375]
- Updated dependencies [ecc91e9]
- Updated dependencies [ecc91e9]
  - @fnndsc/brasa@0.52.0
  - @fnndsc/menu@0.33.0
  - @fnndsc/calypso@0.28.4

## 0.7.0

### Minor Changes

- da946ab: ChRIS goes on a built VM with `chris deploy <vm> --profile minimal`. Over the network's bastion, as a task, it writes CUBE 6.11.0's production compose (CUBE under uvicorn, its workers and scheduler, Postgres, Dragonfly, NATS, pfcon 5.3.1 in-network running plugins through the VM's Docker, Caddy in front) to the data volume, starts it, waits for CUBE, registers the compute resource (`--compute`, default the VM's name) and checks `chris` sees the admin API. The internal secrets are generated once and kept on this host; the admin password is asked once (empty: generated and shown once) or read from `--admin-password-file`. A VM below the profile's floor is refused and told by how much. With `--host`, it waits for public DNS to give the name the VM's address and for the certificate, and a replay resumes there. `chris status` says what is deployed where.
- 1f4503f: A deployed ChRIS gets its own door to mise, porter, under a name of its own: `chris deploy --porter <name>`.

  porter (with the chell, calypso and ARGUS it brings) runs as one more service in the VM's compose project, its image built on the VM from Node and the pinned npm release (porter 0.9.2), its session folders in a volume on the data volume. Caddy serves porter's name with its own certificate, and answers to CUBE's name inside the network, so porter's sessions log in to CUBE by its public name without leaving the VM. The registrar is asked for porter's name as for the host's, and the deploy waits for its DNS and its door (`/login`) over HTTPS; a replay resumes. `--porter` needs `--host` and a name of its own. porter's cookie secret is made by the first deploy with a porter and kept beside the others.

- ab459ee: A ChRIS stratus deployed gets its users from `chris user add <name> --email <address>`, on the VM.

  Every deploy turns CUBE's own sign-up off (`DISABLE_USER_ACCOUNT_CREATION`), so CUBE's API makes no account, the admin's included. `chris user add` makes it on the VM instead, over the bastion path, in the CUBE container, with CUBE's own user model, so the account gets its groups and home folders as a sign-up gives them. It acts on the ChRIS `--on <vm>` names, or the only one this stratus deployed; more than one and no `--on` is refused with their names. `--email` is needed. The password is asked (empty: generated and shown once) or read from `--password-file`, given on stdin, and never kept on this host. A name already there with the same email is left as it is, so a script replays; with another email, or an email another account has, it is refused.

- f6790b6: The OpenShift cluster's verbs are `cluster` now, freeing `domain` for the Trusted Domain recipe. They are `cluster new`, `plan`, `build`, `status`, `verify`, `adopt`, `teardown`, `protect`, `size` and `attach` (docs/stratus.adoc, D16). The tenancy's folder is `clusters/`, the tag that finds a cluster in the tenancy is `mise-cluster=<name>`, the expect subject is `cluster`, the launcher's checkout flag is `--cluster NAME=CHECKOUT`, and the state event is `stratus.cluster.state`. A daemon starting where the old `stratus/domains/` folder stands and `stratus/clusters/` does not moves it once. The Kubernetes driver's folder is `src/kube/`. Clusters built before this carry `mise-domain`; retag their stacks and compartments to `mise-cluster` so the session finds them.
- 68e0136: Networks for VMs are declared, built and torn down with `net`. `net new <name> --cidr <range>` declares a network and builds nothing; on one already declared it prints `unchanged` or the change. `net build` plans as a task, says the counts and asks, then applies; a plan that touches what exists is refused unless `--allow-alter`. On OCI a network is a compartment of its name (an empty one is adopted), a VCN, an internet gateway, the default route and security list (SSH only from inside), one public subnet and an OCI Bastion admitting only this host's public address, all from a Terraform module stratus keeps, run in Resource Manager and tagged `mise-net=<name>`. `net teardown` refuses while anything stands in the compartment, then asks for the name typed back.
- 8183f6c: A ChRIS's name is pointed at its VM at GoDaddy by `chris deploy --host`, asked first. When public DNS does not yet give the name the VM's address and the zone's name servers are GoDaddy's, it reads the name's records through GoDaddy's v3 API with the token kept in `~/.config/stratus/godaddy`, says what it would change (`remove CNAME cube → …, add A cube → <address> (TTL 600)`) and asks; on yes it makes the change, then waits for public DNS and the certificate as before. Without the token, or for a zone kept elsewhere, it says where to point the name by hand.
- b227791: VMs are declared, built, reached and torn down with `vm`. `vm new <name> --net <network> --vcpu --memory --disk --data --os [--open 80,443] [--data-backup daily]` declares a VM in portable words and builds nothing; on one already declared it prints `unchanged` or the change. `vm build` plans its two stacks as tasks (its data: the volume, daily backups and a reserved address; its machine: the instance, boot disk, a security group and the volume's attachment), says the counts and the cost an hour and a month and asks, applies both and points the address at the machine. On OCI the machine is an E5.Flex from the newest image of the OS, pinned at the first build; cloud-init puts Docker's data on the volume at `/srv/data`. `vm shell` opens a session on the network's OCI Bastion for the VM's own key and prints the SSH line. A VM is born protected (`vm protect <name> off`); `vm teardown` removes the machine and keeps the data and address, `--all` takes those too on the name typed back.

### Patch Changes

- Updated dependencies [f6790b6]
  - @fnndsc/menu@0.32.0
  - @fnndsc/brasa@0.51.2
  - @fnndsc/calypso@0.28.3

## 0.6.1

### Patch Changes

- Updated dependencies [8fd7226]
- Updated dependencies [ec2d610]
- Updated dependencies [68d09fc]
- Updated dependencies [71f3c63]
  - @fnndsc/brasa@0.51.0
  - @fnndsc/calypso@0.28.2

## 0.6.0

### Minor Changes

- 9a58e99: A Trusted Domain found in the tenancy is shown as the cloud says it, before anyone adopts it; an adopted one can be torn down; a teardown removes what carried the domain's tag.

  Found domains (docs/stratus.adoc, D15) used to read FOUND · NOT ADOPTED with no address, no spec, no steps and STOPPED, whatever their state, until `domain adopt`: through porter every user but the builder saw every domain that way. Now `domain status` reads each found domain from the cloud: its address and spec from its stack's variables, its condition from what lives in its compartment and what the stack still holds (UP, STOPPED, or GONE when nothing is left but its tag), its steps as far as the cloud attests them. Adoption stays what `plan`, `verify`, `build` and `teardown` wait on.

  A found domain with nothing left of it but its tag takes `domain teardown <name>` without an adoption: nothing a lock would keep. An adopted domain is torn down as a built one is, once `domain protect <name> off` has been said and the name is typed back; it used to be refused by name.

  A teardown now also removes the stack itself (it carried the tag, so the domain was found again), any block volume left in the domain's own compartment with the attribution tag, and the compartment with the image bucket in it when stratus made them (`domains/<name>`); a compartment that is not stratus's keeps itself and loses the tag. A domain with no zone known has no records looked for.

## 0.5.1

### Patch Changes

- 90c17b3: Reading capacity or spend no longer holds the session, so a console attaching mid-read gets its prompt at once. The limits `capacity` reads are kept for ten minutes and read four at a time, so a repaint or the CAPACITY pane answers from what was read.

## 0.5.0

### Minor Changes

- 4568c64: A stratus session lists every domain its tenancy holds, found by the `mise-domain` tag, not only its folder's (#1286). One the host keeps nothing of reads FOUND · NOT ADOPTED and answers reads only; `domain adopt <name>` with no checkout keeps it here from what its stack says, and the build verbs refuse it by name until then. The driver gains `domains_find`; the builder `stack_describe`.

### Patch Changes

- 6323634: Reading capacity with no family named lists every family the region offers, instead of refusing (#1284). Before, a session whose domains' specs named no family was told to name one.
- Updated dependencies [f086bc6]
- Updated dependencies [4568c64]
  - @fnndsc/calypso@0.28.1
  - @fnndsc/menu@0.31.1

## 0.4.3

### Patch Changes

- Updated dependencies [41769da]
- Updated dependencies [0efbb7c]
- Updated dependencies [7a10507]
- Updated dependencies [b8bc519]
- Updated dependencies [56debd5]
  - @fnndsc/brasa@0.50.0
  - @fnndsc/calypso@0.28.0
  - @fnndsc/menu@0.31.0

## 0.4.2

### Patch Changes

- a5a0d6d: A domain teardown now finishes, and runs again where it stopped (#1270). The first real teardown (quay) removed everything that bills, then failed: Red Hat would not delete the installer's infra-env while its 3 hosts were registered to it. The installer's hosts are now deregistered first, then the infra-env, then the cluster.

  A teardown that stopped part way can be run again. When the stack holds nothing (an earlier pass destroyed it, and the cluster with it), it runs no destroy job and does not ask the gone cluster for its volumes, which used to refuse the run; the preview says so. The DNS records, the image and the installer's records are removed again, and each is no error when it is already gone.

## 0.4.1

### Patch Changes

- Updated dependencies [e9ea847]
- Updated dependencies [e12598c]
- Updated dependencies [f8b07e0]
- Updated dependencies [26df4e2]
  - @fnndsc/brasa@0.49.0
  - @fnndsc/calypso@0.27.1

## 0.4.0

### Minor Changes

- f27596d: A domain's build now puts ChRIS on its cluster and checks it end to end, once the cluster has settled.

  The steps after the install are no longer placeholders. `verify` runs the ten checks and asks again each minute, for up to 30, while a new cluster's operators settle. `chris-deploy` installs the fnndsc/chris chart with `helm`, pinned to one node. `chris-seed` makes the test user and the smoke plugins through chrisomatic. `smoke` runs miniChRIS-OKD's journey against the public Route. BUILD and `tenant.mise` now build all the way through `smoke`, and the Kubernetes client waits out the 429 a settling API answers.

- fd1711f: A domain whose build stopped part way reads STOPPED, not SIZING · NOTHING BUILT.

  The new condition covers steps done with none running and the domain not up. The line under it reads PLANNED · NOTHING BILLED when the next step is the first that bills, as after NO at the billing question, and NOT FINISHED otherwise.

- 02c20bf: Every function name now says what it does: the 462 that put a preposition where the verb goes are renamed (#1227).

  The style guide names a function `<subject>[Qualifier]_<verb>[Adverb]`. Names such as `answerRows_of`, `seriesUID_ofPath`, `options_toParams` and `ask_onPane` put a preposition in the verb's place, which names the result without saying whether the function derives, parses, builds or renders it. They are now `answerRows_derive`, `seriesUID_parse`, `options_convertToParams` and `askOnPane_await`. A preposition may still qualify the verb (`x_readFromCache`) or the object (`askOnPane_await`); it may not start the method.

  `npm run lint:rpn` (`scripts/rpn-prepositions.mjs`) refuses a function, `const` function or underscored method whose method is, or starts with, `of`, `to`, `with`, `from`, `for`, `by`, `as`, `in`, `on` or `at`, and CI runs it. The exported names change with no aliases kept: nothing outside this repository imports them.

- 55e2041: A new domain finds its DNS zone in the tenancy: the only one by default, else one chosen on SIZE or named.

  `domain new` and `domain size` read the tenancy's DNS zones; a named `--base-domain` must be one of them, and with several and none named `domain new` refuses, listing them. The size model carries `dnsZones`. In ARGUS, SIZE shows a ZONE choice and COMMIT stays dark until a zone is set.

### Patch Changes

- a61f844: The `compartment` step waits out a just-made `domains` compartment that OCI does not yet find, instead of failing.

  Found live building quay: the parent read ACTIVE while creating a compartment inside it answered not found. The step now retries a not-found, making the compartment inside it or reading a new one's state, for up to ten minutes, logging that it waits; the `iso` step does the same for an image copied into a bucket just made.

- 68d496d: Pressing the DOMAINS tile now opens the TD controller, and an adopted domain shows the ChRIS steps it already did.

  Before, the tile opened the files listing, so the controller could only be reached by typing `domain`. An adopted domain read as unfinished because adoption carried only the machine's steps. Adopting a domain again catches it up from its checkout.

- 4bc9d87: The dashboard and every other line keep working while a long build is being followed.

  Following a task (`domain build`, `wait`) steps out of the session's turn between the task's lines, as a question already did, so a pane's reads run meanwhile; STOP still reaches the follow. A line whose browser has closed can now be stopped from any surface. A line typed in one browser never opens on another.

- 5731276: A built domain's last check now reads as a short verdict, such as "pass · 7 steps · 17 s", instead of raw output.
- Updated dependencies [fd1711f]
- Updated dependencies [4bc9d87]
- Updated dependencies [5602a4f]
- Updated dependencies [c58c3a6]
- Updated dependencies [02c20bf]
- Updated dependencies [55e2041]
  - @fnndsc/menu@0.30.0
  - @fnndsc/brasa@0.48.0
  - @fnndsc/calypso@0.27.0
  - @fnndsc/fond@0.6.0

## 0.3.0

### Minor Changes

- b4cd618: Every session can play a manifest and make claims again: each backend registers what can be claimed about its world. `expect` keeps its grammar, `--within` and `path exists|count` in the core; ChRIS registers `gather`, `feed`, `run` and `path … tags`, and stratus registers `domain` (`step <name>`, `verify`, `class`, `cost`), so a tenant's manifest can assert its domain. `play` reads a manifest through the backend's files, then the engine's disk. A play no longer stops at its first line when an earlier command in the session had failed: each line is judged on its own status (#1056, stratus.adoc D14).
- 9b328dc: A domain gets its own compartment and is born protected. The build's first step, `compartment`, makes `domains/<name>` (and `domains` once) tagged `mise-domain=<name>`, so a second tenant needs nothing made by hand; the shared zone and the `openshift-tags` namespace are found wherever the tenancy keeps them. `domain teardown` refuses a protected domain until `domain protect <name> off`, a line of its own. `domain build` asks for Red Hat's service account when it will need one and none is kept, and keeps it on the host, mode 600 (stratus.adoc D14).
- 05ec948: A domain now says everything the TD controller draws: where it stands in one word, what it costs, what is refused on it. `domain status` answers each domain with its condition (SIZING, ASKING, BUILDING, UP, SERVING, FAILED, GONE), whether it bills, whether it was built here, adopted or read from a checkout, what is refused on it and why, its spec, each step with its times, the build's running task, the last plan counted with drift apart, and the last verify check by check. `domain build` shows its domain as a `stratus.domain.state` event at its start, on each line it logs, and before each question. `domain size [--family F]` reads what a new domain is sized against: each zone's free cores and memory, the family's shape and price, and the starting spec. `domain verify` keeps its checks beside the plan, and `domain <name>` reads that one domain.
- dd0b518: A tenant is a manifest: `~/tenant.mise` builds a domain from its written spec through the install and verifies it.

  stratus ships `tenant.mise` and shows it in the session's home beside the domains; `play ~/tenant.mise --param NAME=quay` runs `domain build --through run`, `domain verify` and their claims, answering the domain's status. The session's files can now be read by `play` and a surface. In ARGUS, the TD controller's COMMIT writes the spec and then plays the tenant on BUILD.

### Patch Changes

- a1a7fc5: An adopted domain counts its compartment step as done. It came with a compartment of its own, and one adopted before the step existed reads the same.
- Updated dependencies [e1d052d]
- Updated dependencies [b4cd618]
- Updated dependencies [6a766d2]
- Updated dependencies [52b9691]
- Updated dependencies [9c9ec38]
- Updated dependencies [05ec948]
- Updated dependencies [d6cdb13]
- Updated dependencies [caff86a]
- Updated dependencies [46bc80d]
  - @fnndsc/brasa@0.47.0
  - @fnndsc/menu@0.29.0
  - @fnndsc/calypso@0.26.2

## 0.2.1

### Patch Changes

- Updated dependencies [f2180c1]
- Updated dependencies [c90b8a2]
- Updated dependencies [243aafa]
- Updated dependencies [0a52833]
  - @fnndsc/brasa@0.46.0
  - @fnndsc/calypso@0.26.1

## 0.2.0

### Minor Changes

- cd9c77e: A domain harbor-oci built can now be adopted and planned against from the session. `domain adopt <name> --from <checkout>` keeps its ids, spec, step evidence and secrets (mode 600, never served) with the domain's own state; with the `tasks` tier it also makes an OCI Resource Manager stack of Oracle's pinned `create-cluster-v1.6.1.zip`, tagged with the domain's name, and imports the Terraform state the checkout kept. `domain plan` with the tier then runs a plan job against that stack and reads the plan back as JSON, counting `Oracle-Tags` drift apart from real change. An adopted domain is never built on, and a domain kept here stands in for its checkout in the tree. Every Resource Manager job's log follows into the step's, and a stop cancels the job without forcing it.

  A plan's line counts a resource destroyed and made again as replaced, naming the kinds, so a re-plan of the live domain reads "0 to create, 21 to replace (loadbalancers), 0 to change and 24 Oracle-Tags drift, 0 to destroy". Adopting again finds the stack already tagged with the domain's name and takes it, rather than making a second. A Resource Manager log that cannot be read while the job writes it no longer fails the step: it is read again on the next poll.

- 4a2a561: A Trusted Domain can now be built on OCI from the session, and torn down. The build runs through Resource Manager and Red Hat's Assisted Installer, as harbor-oci proved it. `domain new --compartment` names where it goes. Preflight reads the credential, the compartment, the attribution tag, the room in each availability domain, the load balancers free, the zone's delegation and the SSH key, and refuses a spec with workers, since only the compact cluster is proven. The discovery image is copied into a private bucket and linked for a week; the link is kept as a secret. A new stack's variables come from the spec, the apply's outputs give the load balancers and the platform manifest, and the three A records are written in the zone. The installer takes a service account's token without a scope, fetches the pull secret each time, waits for every host to be known, and starts the install when the cluster is ready; the kubeconfig and the administrator's password are kept on the host. `domain teardown <name>` reads the cluster's own volumes, shows what goes, asks for the domain's name, then destroys the stack's resources and removes the records, the image and its link, those volumes and the installer's records; it refuses an adopted domain or one read from a checkout. New launch flags: --redhat-account and --ssh-key.
- 49ccdfd: The stratus prompt says where in the substrate a session stands: cloud, tenancy, region, user, domain, directory.

  The domain segment appears when the working directory is inside one.

  Sent as the wire's backend-neutral segments (docs/stratus.adoc, D9). Disconnected, the leader reads `OCI ✗` as an alert. The user is the identity as the cloud writes it, never shortened by the daemon; a surface short of room truncates it from the left.

- 14f8fc1: What each domain costs can now be read from the session: spend prices its machines, volumes and load balancers. Machines are priced by vCPU and memory while they run, volumes by size and performance, load balancers by the hour and their minimum bandwidth, as harbor-oci's burn did. Each line gives the rate an hour and what it has come to since the resource was made, then the domain's total; it is an estimate, not the bill. `domain status` carries the same cost in a line and in its model. The OCI driver now reads an instance's OCPUs and memory, a volume's performance units and a load balancer's minimum bandwidth, and the storage and balancer parts of Oracle's price list.
- 2a5a921: A Trusted Domain can now be made, priced and built from the session, over the fake cloud for now. `domain new <name>` writes a spec in `harbor-oci`'s shape and nothing else, kept with the domain's state under `$XDG_STATE_HOME/stratus/domains/<name>/`. `domain plan` reads only: the fit per availability domain, the hourly cost of compute and memory, where the steps stand; the infrastructure plan itself needs the `tasks` tier. `domain build` runs the steps (preflight to run) as a task, `/proc/steps/<name>-build`, written once over the cloud's build half and the installer; it stops before the first step that bills and asks, with the plan's counts and the cost, and refuses a plan that alters what exists. The build outlives every surface and a daemon restart, which picks it up from its first step not done. A built domain shows under `~` and in `domain status` beside those read from checkouts. A real cloud's build half comes with step 4b; `stratus --fake` builds over a fake cloud and installer on a clock.
- 5c90e5a: A domain built by harbor-oci shows under the session home; `domain status` says where each build step stands.

  `stratus --domain harbor=~/src/harbor-oci` puts `domains/harbor/` under the tenancy: `spec.yaml`, `settings` (no credentials), `state.json` (the ISO link's URL withheld), `steps/<nn-name>/` with each step's `state` and the `evidence` it rests on (`unknown` where the host keeps none), and `auth/`, whose files are refused with their host path. `domain status [<name>]` prints the same with the compartment's live resource counts; a verb that would start a host program is refused by name.

- 93fb6a4: A tenancy's instances, networks, load balancers, volumes, buckets and DNS zones list under each compartment.

  Every container level holds a kind folder per resource kind for the session's region, counted by one Resource Search. A resource is a folder of field files (`name id state region created tags info.json`, plus an instance's `shape zone ips`, a volume's `size attached`, a load balancer's `ip shape`); a network nests `subnets/` and `securitygroups/`; a bucket shows `links` and its `objects/` as files (small ones readable); a DNS zone shows `records/`, a file per name. `ls -l` marks each kind and shows its lifecycle state, coloured. Duplicate names wear `~<id6>`, answers are cached a minute.

- dcdc6cd: A stratus dashboard shows DOMAINS (each domain's last build step) and CAPACITY (what each zone has free).

  DOMAINS reads `domain status` and CAPACITY reads the new `capacity` command, through the wire's new `stratus.domains` and `stratus.capacity` models (menu). `capacity [<family>…]` lists, for the shape families named or those the domains' specs name, each limit their shapes draw on per zone, permitted and free; a shape now names its limit service. A domain with a step gone wrong shows in red.

- 0778c63: A domain's cluster can now be verified from the session, by harbor-oci's ten checks, without `oc` or `dig`. Its ten checks are the API's `/readyz`, the cluster version, nodes Ready, the OCI cloud controller (providerIDs, shapes, zones), operators settled, the default storage class, the three DNS records from a public resolver, the console over the router's CA, CPU headroom for a plugin job, and a block-volume probe. Nine only read; the probe makes a 50 GiB claim and a pod and deletes them, so it runs only under the `tasks` tier and otherwise says so. The kubeconfig is read on the host and never leaves it. The result is kept as the domain's verify step, so `domain status` and the DOMAINS tile show it. Adoption now keeps the load balancers' addresses from the state's outputs. A `--fake` daemon verifies against a fake healthy cluster.

### Patch Changes

- 49501d4: stratus now takes --host-control tasks with a space as well as with an equals sign, and its usage names the tasks tier.
- 1037628: A domain's verify, plan and build are refused as verbs not yet written, no longer as host programs. The build steps become the driver's own code, with Terraform run through OCI Resource Manager; harbor-oci is the specification they are ported from, never a program stratus runs (docs/stratus.adoc, D3).
- Updated dependencies [0388f12]
- Updated dependencies [01fcb59]
- Updated dependencies [49ccdfd]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [49501d4]
- Updated dependencies [14f8fc1]
- Updated dependencies [2a5a921]
- Updated dependencies [dcdc6cd]
  - @fnndsc/calypso@0.26.0
  - @fnndsc/brasa@0.45.0
  - @fnndsc/fond@0.5.1
  - @fnndsc/menu@0.28.0

## 0.1.0

### Minor Changes

- 1e637f1: stratus: a session over the cloud substrate a Trusted Domain runs on, reading a tenancy.

  The first slice of docs/stratus.adoc: one backend, clouds as drivers. The package holds the driver interface, a fake cloud that runs the driver contract, and the OCI driver over Oracle's SDK (identity, compartments, regions, availability domains, limits, shapes, list prices). A session mounts its tenancy under /net/oci/<tenancy>/: compartments nest as the cloud nests them, a duplicate name wears ~<id6> and the plain name refuses, regions/ holds each region's zones, limits, shapes and prices as folders of field files, domains/ is the home. Every answer is kept for a minute. The stratus command hosts the session as a calypso daemon on the bastion; --fake hosts the fake cloud. CI boots it with no ChRIS package loaded and a ratchet keeps oci-\* imports inside the OCI driver.

### Patch Changes

- Updated dependencies [1e637f1]
  - @fnndsc/fond@0.5.0
  - @fnndsc/brasa@0.44.1
