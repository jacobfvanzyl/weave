const expectedPackageManager = 'bun';
const userAgent = process.env.npm_config_user_agent ?? '';
const packageManager = userAgent.split('/')[0];

if (packageManager !== expectedPackageManager) {
  console.error('Weave dependencies must be installed with Bun. Run `bun install` from the repository root.');
  process.exit(1);
}
