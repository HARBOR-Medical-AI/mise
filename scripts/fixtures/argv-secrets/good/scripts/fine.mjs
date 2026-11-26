// The checker's own kind of file: it may name the options as words to look for.
const LONG = String.raw`--password|--token|--auth-token|--adminPassword`;
console.log(['--password', '--token'].join(', '));
