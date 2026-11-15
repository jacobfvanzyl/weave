/**
 * The app's type scale (WVE-235): the roles `styles.css` defines as `text-<role>`, the only sizes
 * its text has. What each is for is written beside them there.
 */
export const TYPE_ROLES = ['body', 'meta', 'heading-1', 'heading-2', 'heading-3'] as const;

export type TypeRole = (typeof TYPE_ROLES)[number];
