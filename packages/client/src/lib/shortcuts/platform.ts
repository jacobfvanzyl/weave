import type { ShortcutPlatform } from './types';

type NavigatorLike = {
  platform?: string;
  userAgent?: string;
  userAgentData?: {
    platform?: string;
  };
  maxTouchPoints?: number;
};

const getNavigatorLike = () => (typeof navigator === 'undefined' ? undefined : navigator as NavigatorLike);

export const resolveShortcutPlatform = (navigatorLike: NavigatorLike | undefined = getNavigatorLike()): ShortcutPlatform => {
  const platform = `${navigatorLike?.userAgentData?.platform ?? navigatorLike?.platform ?? ''}`.toLowerCase();
  const userAgent = `${navigatorLike?.userAgent ?? ''}`.toLowerCase();

  if (/iphone|ipad|ipod/.test(platform) || /iphone|ipad|ipod/.test(userAgent)) return 'ios';
  if (platform.includes('mac')) {
    return navigatorLike?.maxTouchPoints && navigatorLike.maxTouchPoints > 1 && userAgent.includes('safari')
      ? 'ios'
      : 'mac';
  }
  if (platform.includes('win')) return 'windows';
  if (platform.includes('android') || userAgent.includes('android')) return 'android';
  if (platform.includes('linux')) return 'linux';
  return 'unknown';
};

export const isAppleLikeShortcutPlatform = (platform: ShortcutPlatform) => platform === 'mac' || platform === 'ios';
