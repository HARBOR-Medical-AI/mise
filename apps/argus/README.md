# ARGUS

ARGUS is an LCARS-based web console and terminal surface for mise. It is one possible ChRIS user experience, not the canonical or exclusive UI.

ARGUS attaches to a CALYPSO session and presents an indwelling terminal surrounded by graphical instruments. Those instruments organize the operational domain into Files, Runs, Tools, Sources, and Compute. They consume CALYPSO's public wire contract and do not speak directly to CUBE or `chrisapi`. The terminal is xterm.js drawing a chell the daemon runs for the page under a pseudo-terminal; on a host where node-pty did not build, the console falls back to the deprecated transcript (see [docs/architecture.adoc](docs/architecture.adoc)).

The first implementation increment is live: the LCARS frame, the terminal as a retractable drawer attached over the wire, and the Files instrument repainting from `fs.listing` envelope models. Typing `ls` in the terminal updates the Files panel as data, and activating a directory row in the panel lowers to the same `cd` and `ls` commands an operator could type. Two projections of one session, in both directions.

## Running the demo

ARGUS needs no download: its frame, font and LCARS sounds are all in the repository.

Build the workspace from the repository root and start a daemon from that same root:

```sh
npm install
npm run build
node packages/chell/dist/index.js <user>@<cube-url> -p <password> --daemon
```

The daemon serves the built ARGUS bundle from the same loopback port as the wire and prints the URL to open, token included:

```
[+] ARGUS web surface at http://127.0.0.1:<port>/?token=<token>
```

The bundle is discovered from `apps/argus/dist` relative to the daemon's working directory; set `CALYPSO_WEB_ROOT` to serve a bundle from anywhere else. Without a token in the URL, the page offers a paste form. During UI development `npm run dev -w @fnndsc/argus` starts a Vite dev server; pass `?ws=ws://127.0.0.1:<port>` to point it at a running daemon across origins. The daemon takes an attach from a page only when the page is its own or its operator named the page's origin, so start that daemon with `CALYPSO_ORIGINS=http://localhost:5173` (the address the dev server prints).

## The faces it wears

The look is switched in the page and remembered per browser. There are two kinds of choice on that control.

**LCARS**, in four colour schemes on one frame: curved elbows, a coloured gutter, Antonio set hard right.

| scheme | |
|---|---|
| **MEDICAL** *(default)* | Clinical blues. What a PACS pane sits in all day. |
| **LOWER DECKS** | The original, warm and loud. |
| **CERRITOS GOLD** | Gold and orange. |
| **NEMESIS** | Cool and dark. |

**PHAROS** is not a scheme but a theme of its own on the same tokens: ARGUS's own visual language, the lighthouse, flat. Square corners, one curve in one seat, set in Chakra Petch. Owing nothing to anyone.

The chrome is borrowed fiction; the design under it is not. [docs/aegis.adoc](docs/aegis.adoc) (AEGIS) is the interface standard every pane answers to, and both looks are held to a **canon**, the computed style of every element of the frame, committed under `tests/smoke/canon/`, so neither drifts by accident. A change to the frame either matches the canon exactly, or says out loud that it meant to change it.

### On TheLCARS.com

ARGUS grew inside that template and no longer uses any of it. The frame is written from ARGUS's own canon. The typeface is **Antonio**, vendored here under the SIL Open Font License; it is the Antonio Project's, and the template only carried a copy. The four sounds are synthesised by `scripts/sounds_make.mjs`.

The attribution stays, and should: the footer credits the template as the inspiration it was. Full reasoning, including the trade-dress question, is in [the mise-level ARGUS design](../../docs/argus.adoc).

## Structure and boundaries

See [docs/architecture.adoc](docs/architecture.adoc) for the approved structure and [the mise-level ARGUS design](../../docs/argus.adoc) for its place in the wider system, including the LCARS licensing position (the genuine Lower Decks theme is materialized per machine from the author's own download, never redistributed from this repository). The forward design for local IDE, filesystem, terminal, and workspace capabilities is recorded in [docs/operator-companion.adoc](docs/operator-companion.adoc). The surface's design language is [docs/aegis.adoc](docs/aegis.adoc) (AEGIS: the laws, machine-checked), and the component reference beneath it is [docs/components.adoc](docs/components.adoc), one section per thing a pane declares into.

This package is published as `@fnndsc/argus` and rides the monorepo's install, build, and CI; `calypso` serves its built bundle. Browser code imports only `@fnndsc/calypso/protocol`, the published wire contract; the execution stack stays out of the bundle by rule.
