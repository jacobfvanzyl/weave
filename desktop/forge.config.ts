import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const appName = 'Weave';
const appBundleId = 'com.veezee.weave';
const shouldSignMacBuild = process.platform === 'darwin' && process.env.WEAVE_DESKTOP_CODESIGN === '1';
const findMacCodeSignIdentity = () => {
  const explicit = process.env.WEAVE_DESKTOP_CODESIGN_IDENTITY?.trim();
  if (explicit) return explicit;
  if (!shouldSignMacBuild) return undefined;

  const result = spawnSync('security', ['find-identity', '-p', 'codesigning', '-v'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const identities = result.stdout
    .split('\n')
    .map(line => line.match(/"([^"]+)"/)?.[1])
    .filter((identity): identity is string => Boolean(identity));
  return (
    identities.find(identity => identity.startsWith('Developer ID Application:')) ??
    identities.find(identity => identity.startsWith('Apple Development:'))
  );
};
const macCodeSignIdentity = findMacCodeSignIdentity();
if (shouldSignMacBuild && !macCodeSignIdentity) {
  throw new Error(
    'No Apple code signing identity was found. Set WEAVE_DESKTOP_CODESIGN_IDENTITY or install an Apple Development certificate.',
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId,
    executableName: appName,
    extraResource: [
      path.join(workspaceRoot, 'portal/dist/portal'),
      ...(process.platform === 'darwin' ? [path.join(workspaceRoot, 'portal/dist/weave-window-stream-native')] : []),
    ],
    icon: 'assets/icon',
    name: appName,
    ...(shouldSignMacBuild
      ? {
          osxSign: {
            identity: macCodeSignIdentity,
            continueOnError: false,
            ignore: filePath => /\.(?:pak|bin|dat)$/.test(filePath) || filePath.includes('/Versions/Current/'),
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      name: appName,
      overwrite: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
