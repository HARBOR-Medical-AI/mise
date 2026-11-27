// A long option joined to its value in one argument.
args.push(`--password=${env.password}`);
args.push('--token=' + token);
args.push(
  "--auth-token",
  token,
);
