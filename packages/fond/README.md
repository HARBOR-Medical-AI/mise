# @fnndsc/fond

The pieces every layer of mise needs, whatever the backend: the small, generic base that the engine (`@fnndsc/brasa`), the session host (`@fnndsc/calypso`) and a backend's own packages all stand on.

The name is from the kitchen, like the rest of the stack: *fonds de cuisine* are the base stocks a kitchen cooks everything else from.

```
npm install @fnndsc/fond
```

## Why it exists

A backend such as ChRIS (CUBE) brings its own client and its own world. The pieces every layer needs, whatever the backend, live here rather than in a backend's package, so a layer that is not about CUBE can use them without loading CUBE (see [docs/backend-neutral.adoc](https://github.com/HARBOR-Medical-AI/mise/blob/main/docs/backend-neutral.adoc)).

fond's one rule: **it depends on nothing in `@fnndsc`**. CI holds it to that (`npm run lint:fond`). Its one dependency is `chalk`, for the listing views.

## What's in it

| Export | What it is |
| --- | --- |
| `Result<T>`, `Ok`, `Err`, `result_isOk`, `result_isErr` | An explicit success-or-failure value. A function returns `Result<T>` rather than `T \| null`, and TypeScript will not let a caller read `.value` until it has checked `.ok`. |
| `errorStack` | The process-wide message stack that failures are reported on, with context-isolated scopes and checkpoints. |
| `errorStack_configure`, `errorStack_getAllOfType`, `StackMessage` | Configuration, a convenience reader, and the message type. |
| `VFSProvider`, `VFSItem`, `CpOptions` | The virtual filesystem's contracts: a mount that claims a path prefix and lists, copies and (optionally) reads, writes, makes, removes and renames under it; the items it lists. |
| `VFSDispatcher` | Routes each filesystem request to the mount that owns the path, or to a fallback. It knows no backend: a backend registers its mounts and names its fallback. |
| `vfsItems_sort` | Sorts a listing's items by name, size, date or owner without changing the array given. |
| `grid_render`, `long_render`, `size_format` | A listing as a terminal shows it: `ls`'s grid and `ls -l`'s long view, and sizes for people. |
| `ListingLook`, `ItemKindLook`, `LISTING_CORE_KINDS`, `LISTING_LOOK_PLAIN` | How a listing shows: the core's kinds (file, folder, link, mount) and a backend's beside them, each with its long-view mark, and how a name is coloured. |
| `listingItems_sort` | Sorts a listing by one field; a reversed sort keeps equal items in their order. |

## Using `Result`

A failure carries no payload of its own: the reason goes on the error stack, where a surface can show it, and the `Result` says only that it failed.

```typescript
import { Ok, Err, errorStack, type Result } from '@fnndsc/fond';

async function config_read(path: string): Promise<Result<Config>> {
  const text: string | null = await file_read(path);
  if (text === null) {
    errorStack.stack_push('error', `No configuration at ${path}.`);
    return Err();
  }
  return Ok(config_parse(text));
}

const config: Result<Config> = await config_read('~/.config/app.yml');
if (!config.ok) {
  // config.value does not exist here; TypeScript says so.
  return;
}
config_apply(config.value);
```

## Using the error stack

`errorStack` is a single instance for the whole process. Each message is stamped with the name of the function that pushed it:

```typescript
errorStack.stack_push('error', 'CUBE refused the login');
errorStack.stack_pop();
// { type: 'error', message: '[login_run                               ] | CUBE refused the login' }
```

Reading and clearing:

| Method | Does |
| --- | --- |
| `stack_push(type, message)` | Pushes an `error` or a `warning`. |
| `stack_pop()`, `stack_getAll()` | Takes the newest message; lists them all. |
| `stack_search(text)`, `messagesOfType_search(type, text)` | Finds messages containing some text. |
| `allOfType_get(type)`, `messages_has()`, `messagesOfType_has(type)` | Reads by type; asks whether anything is there. |
| `stack_clear()`, `type_clear(type)` | Empties the stack, or one type. |

Two features keep concurrent work from mixing up its errors:

* **Scopes.** Work run inside `errorStack.scope_run(fn)` pushes to and pops from its own isolated stack, carried by Node's `AsyncLocalStorage` through every `await` inside it. Background work (cache warming, refreshes) runs in a scope so its failures never land in a foreground command's report.
* **Checkpoints.** A command calls `checkpoint_mark()` before it works and `checkpoint_drain(mark)` after, and gets exactly the messages pushed in between.

```typescript
const mark: number = errorStack.checkpoint_mark();
const answer: Result<Listing> = await listing_fetch(path);
const reasons: StackMessage[] = errorStack.checkpoint_drain(mark);
```

`errorStack_configure({ functionNamePadWidth })` sets how wide the function-name stamp is padded.

## The virtual filesystem

A session's filesystem is a tree of mounts. Each mount (a `VFSProvider`) claims a path prefix and answers for everything at or under it; the longest prefix that matches at a segment boundary wins, so `/proc/jobs` takes precedence over `/proc`, and `/procs` is not under `/proc`. A path no mount claims goes to the fallback.

```typescript
import { VFSDispatcher, type VFSProvider } from '@fnndsc/fond';

const dispatcher: VFSDispatcher = new VFSDispatcher(filesFallback);   // what no mount claims
dispatcher.provider_register(notesMount);                             // prefix '/notes'
dispatcher.provider_register(jobsMount);                              // prefix '/proc/jobs'

await dispatcher.list('/proc');        // the mounts beneath it ('jobs'), beside what the fallback holds there
await dispatcher.read('/notes/today'); // notesMount.read('/notes/today')
```

Every operation a mount does not offer is refused by name (`mkdir: cannot create directory '/x': Read-only file system`), never silently ignored. A dispatcher built without a fallback refuses any path no mount claims, rather than answering with an empty folder. `pathResolver_register` adds a hook that maps a path to the fallback's own form before the fallback sees it; a copy whose path cannot be resolved fails rather than guessing. A mount that stands for a folder of the fallback (a job's `data` under `/proc/jobs` is that job's output folder) says so with `storePath_resolve`: the fallback path a path under it means, or null for a path the mount holds itself. A session asks it, and the fallback's links on the answer, before every read and listing (brasa's `storePath_resolve`).

## One instance, whoever loads it

The error stack only works if the whole process shares one. fond is built as CommonJS, so packages that `require` it (cumin) and packages that `import` it (salsa, brasa, calypso) load the same module and so the same stack. `@fnndsc/cumin` re-exports fond's `Result` and `errorStack` rather than keeping copies, so code that imports them from cumin shares that stack too. If you bundle code that uses fond, keep it to one copy.

## Where it sits

```
  brasa (engine)    calypso (session host)    cumin, salsa (the ChRIS backend)
        │                     │                          │
        └─────────────────────┼──────────────────────────┘
                              ▼
                      ┌───────────────┐
                      │     fond      │   depends on nothing in @fnndsc
                      └───────────────┘
```

## License

MIT. Part of [mise](https://github.com/HARBOR-Medical-AI/mise).
