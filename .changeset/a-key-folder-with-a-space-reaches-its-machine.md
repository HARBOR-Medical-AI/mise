---
"@fnndsc/stratus": patch
"@fnndsc/brasa": patch
---

A machine whose key sits in a folder with a space, a quote or a percent sign in its name can be reached.

`vm shell` prints a line that works as printed.

How: the arguments stratus gives `ssh`, and the line `vm shell` prints, wrote the key and host-key paths bare, three readers deep: OpenSSH's own option words, its percent expansion, and the shell it hands `ProxyCommand` to. Each is now written for its reader (`packages/stratus/src/vm/quoting.ts`): an option value in OpenSSH's double quotes with its percents doubled, each word of the proxy command quoted for the shell and its percents doubled again, the tokens that are meant (`%h:%p`) left as they are. The key is named by `-o IdentityFile=` and the bastion's port by `-o Port=22`; `-i` cannot carry a path with a percent in it. A path holding `${` is refused by name: OpenSSH expands it from the environment and offers no way to write it literally. The printed line is the engine's own arguments, each written as a word of a shell. A plugin source or ref that holds shell grammar reaches `plugin sync` as one value. The two copies of the VM-shell quoting in stratus and the two of the host-shell quoting in brasa are one each.
