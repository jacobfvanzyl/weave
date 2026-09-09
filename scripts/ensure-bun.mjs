const expectedPackageManager = 'bun';
const userAgent = process.env.npm_config_user_agent ?? '';
const packageManager = userAgent.split('/')[0];

if (packageManager !== expectedPackageManager || typeof Bun === 'undefined' || Bun.version !== '1.3.14') {
  console.error('Weave dependencies must be installed with Bun 1.3.14. Run `bun install` from the repository root.');
  process.exit(1);
}
