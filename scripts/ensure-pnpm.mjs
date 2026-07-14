const expectedPackageManager = 'pnpm';
const userAgent = process.env.npm_config_user_agent ?? '';
const packageManager = userAgent.split('/')[0];

if (packageManager !== expectedPackageManager) {
  console.error('Weave dependencies must be installed with pnpm. Run `corepack enable` and `pnpm install` from the repository root.');
  process.exit(1);
}
