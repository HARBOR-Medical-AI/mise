import { spawnSync } from 'node:child_process';
// JavaScript under scripts/ is read as code.
spawnSync('chell', ['x@y', '-p', process.env.PW, '-c', 'version']);
