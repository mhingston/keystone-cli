import { detectShellInjectionRisk } from '../src/runner/executors/shell-executor';

const safeCommands = [
  'echo hello',
  'ls -la',
  'git status',
  'docker build .',
  'npm run test',
  'echo hello_world', // underscore allowed
];

const unsafeCommands = [
  'echo "hello"', // quotes now disallowed in secure mode
  "echo 'hello'",
  'ls; rm -rf /',
  'echo $(whoami)',
  'cat /etc/passwd > output.txt',
  'echo hello | grep world',
];

let failed = false;
for (const cmd of safeCommands) {
  const isRisky = detectShellInjectionRisk(cmd);
  if (isRisky) {
    failed = true;
  } else {
  }
}
for (const cmd of unsafeCommands) {
  const isRisky = detectShellInjectionRisk(cmd);
  if (!isRisky) {
    failed = true;
  } else {
  }
}

if (failed) {
  process.exit(1);
} else {
  process.exit(0);
}
