// None of this puts a secret on a command line.
/* Not even this: spawn(exec, ['--token', token]); */
const SECRET_OPTIONS: ReadonlyArray<string> = ['--password', '--adminPassword', '--token', '--auth-token'];
const named = [
  '--password',
  '--token',
];
spawn(exec, [...prefix, '--remote', identity, '--attach', url], { env: { ...process.env, CHELL_ATTACH_TOKEN: target.token } });
args.push(`${env.user}@${env.url}`, '--auth-token-stdin');
program.option('--token <token>', 'Attach token, when the --attach URL does not carry one');
const help = 'pass --token, or paste the URL';
spawnSync('mkdir', ['-p', folder]);
spawn('ssh', [
  '-o', 'BatchMode=yes',
  '-p', String(port),
  host,
]);
const flags = ['-p'];
const said = `--token <the token kept in ${kept}>`;
