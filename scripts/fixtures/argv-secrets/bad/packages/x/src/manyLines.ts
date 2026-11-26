// A list laid out as a formatter lays one out: the option and its value on lines of their own.
const child = spawn(process.execPath, [
  'dist/index.js',
  '--remote',
  '--attach',
  url,
  '--token',
  target.token,
], { stdio: 'inherit' });
